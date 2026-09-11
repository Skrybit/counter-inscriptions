// Counter-Inscriptions backend — Deno-native (INFRA-281 / ADR-049).
//
// Ported from the Express/Node backend (index.js). Deno-native throughout:
//   express        -> Deno.serve + a small path router
//   cors           -> explicit CORS headers + OPTIONS preflight
//   multer          -> Request.formData() (multipart AND urlencoded)
//   axios          -> fetch
//   Buffer          -> Uint8Array + @std/encoding/hex
//   js-yaml         -> @std/yaml
//   mime-types      -> @std/media-types
//
// Behaviour matches the fixed Node backend (971f773): taproot inscriptions are
// TWO transactions — the wallet signs+broadcasts the commit (psbt), then the
// node-signed reveal (signed_reveal_rawtransaction) is broadcast via
// /api/broadcast; the connected wallet is always the compose SOURCE (signer +
// holder), destinationWallet maps to transfer_destination (asset owner) only;
// chunk assets use consecutive numeric ids; batch mint issues quantity = wallet
// count then distributes via an MPMA send (/api/send-batch).
import { parse as parseYaml } from "@std/yaml";
import { typeByExtension } from "@std/media-types";
import { encodeHex, decodeHex } from "@std/encoding/hex";
import { extname } from "@std/path";

// ─── Config ──────────────────────────────────────────────────────────────────
// In Docker: counterparty runs at counterparty-server:4000
// Locally:   set COUNTERPARTY_URL=http://localhost:4000
const COUNTERPARTY_URL = Deno.env.get("COUNTERPARTY_URL") ||
  "http://counterparty-server:4000";
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Counterparty has ~380KB hex payload limit per issuance description field.
// We chunk at 350KB binary → ~700KB hex (well under limit after URL encoding
// overhead).
const MAX_CHUNK_BYTES = 350 * 1024;

// Directory holding openapi-spec.yaml (next to this module).
const MODULE_DIR = new URL(".", import.meta.url).pathname;

// ─── CORS ──────────────────────────────────────────────────────────────────
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// A validation/precondition failure that maps to a specific 4xx (mirrors the
// Node version's `error.clientStatus`).
class ClientError extends Error {
  clientStatus: number;
  constructor(status: number, message: string) {
    super(message);
    this.clientStatus = status;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chunkBytes(buf: Uint8Array, maxBytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < buf.length) {
    chunks.push(buf.subarray(offset, offset + maxBytes));
    offset += maxBytes;
  }
  return chunks.length === 0 ? [buf] : chunks;
}

// The multipart fileFilter from the Node version: accept only known top-level
// MIME families.
function mimeAllowed(mimetype: string): boolean {
  const base = (mimetype || "").split(";")[0].trim();
  if (!base) return false;
  return ["text/", "image/", "audio/", "video/", "application/", "font/", "model/"]
    .some((p) => base.startsWith(p));
}

function detectMime(file: File): string {
  const fromName = file.name ? typeByExtension(extname(file.name)) : null;
  const fromForm = file.type ? file.type.split(";")[0].trim() : null;
  return fromName || fromForm || "application/octet-stream";
}

// Numeric: A + 17..20 digits (Counterparty range is checked server-side).
// Named: 4–12 uppercase, not starting with A.
function isValidAssetName(asset: string): boolean {
  return /^A\d{17,20}$/.test(asset) || /^[B-Z][A-Z]{3,11}$/.test(asset);
}

interface TxBundle {
  psbt: string | null;
  rawtransaction: string | null;
  signed_reveal_rawtransaction: string | null;
  envelope_script: string | null;
  input_count: number | null;
  btc_in: number | null;
  btc_out: number | null;
  btc_change: number | null;
  btc_fee: number | null;
  signed_tx_estimated_size: number | null;
  warnings: unknown[];
}

/**
 * Normalize a Counterparty compose result (verbose=true) into the bundle the
 * wallet needs. Taproot inscriptions are TWO transactions:
 *   1. commit  — unsigned; the wallet signs `psbt` and broadcasts it
 *   2. reveal  — `signed_reveal_rawtransaction`, already signed by the node with
 *                an ephemeral key; broadcast it AFTER the commit (POST /api/broadcast)
 * Without the reveal the inscription content never lands on-chain.
 */
// deno-lint-ignore no-explicit-any
function normalizeCompose(result: any): TxBundle {
  const r = result?.result ?? result ?? {};
  return {
    psbt: r.psbt || null, // base64 (bitcoind converttopsbt)
    rawtransaction: r.rawtransaction || null, // unsigned commit tx hex
    signed_reveal_rawtransaction: r.signed_reveal_rawtransaction || null,
    envelope_script: r.envelope_script || null,
    input_count: Array.isArray(r.inputs_values) ? r.inputs_values.length : null,
    btc_in: r.btc_in ?? null,
    btc_out: r.btc_out ?? null,
    btc_change: r.btc_change ?? null,
    btc_fee: r.btc_fee ?? null,
    signed_tx_estimated_size: r.signed_tx_estimated_size || null,
    warnings: r.warnings || [],
  };
}

type ComposeField = string | number | undefined | null;

/**
 * POST a compose to Counterparty with verbose=true. Fields are URL-encoded;
 * `rawSuffix` (the large hex description) is appended raw (hex is pure ASCII) to
 * avoid re-encoding cost — byte-for-byte what the Node version built with
 * Buffer.concat. Throws an axios-shaped error on non-2xx so handleXcpError maps it.
 */
async function xcpCompose(
  source: string,
  kind: string,
  fields: Record<string, ComposeField>,
  rawSuffix?: { key: string; value: string },
): Promise<TxBundle> {
  const prefix = Object.entries({ ...fields, verbose: "true" })
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const body = rawSuffix ? `${prefix}&${rawSuffix.key}=${rawSuffix.value}` : prefix;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(
      `${COUNTERPARTY_URL}/v2/addresses/${encodeURIComponent(source)}/compose/${kind}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body,
        signal: controller.signal,
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { response: { status: res.status, data }, message: `HTTP ${res.status}` };
    return normalizeCompose(data);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compose one issuance. `source` is the CONNECTED wallet: it pays fees, signs the
 * commit, and — per Counterparty issuance semantics — receives the issued units and
 * the inscribed sat. `transferDestination` (optional) makes another address the
 * asset OWNER (issuer); it does not move the units. Use a send/MPMA for that.
 */
function composeIssuance(
  { source, asset, mimeType, hexData, satPerVbyte = 2.01, encoding = "taproot", quantity = 1, transferDestination }: {
    source: string;
    asset: string;
    mimeType: string;
    hexData: string;
    satPerVbyte?: number;
    encoding?: string;
    quantity?: number;
    transferDestination?: string;
  },
): Promise<TxBundle> {
  return xcpCompose(source, "issuance", {
    asset,
    quantity,
    divisible: "false",
    encoding,
    inscription: "true",
    mime_type: mimeType,
    sat_per_vbyte: satPerVbyte,
    transfer_destination: transferDestination && transferDestination !== source ? transferDestination : undefined,
  }, { key: "description", value: hexData });
}

/** Compose an MPMA send of `quantityEach` units of `asset` from `source` to each destination. */
function composeMpma(
  { source, asset, destinations, quantityEach = 1, satPerVbyte = 2.01 }: {
    source: string;
    asset: string;
    destinations: string[];
    quantityEach?: number;
    satPerVbyte?: number;
  },
): Promise<TxBundle> {
  return xcpCompose(source, "mpma", {
    assets: destinations.map(() => asset).join(","),
    destinations: destinations.join(","),
    quantities: destinations.map(() => String(quantityEach)).join(","),
    sat_per_vbyte: satPerVbyte,
  });
}

/** Returns the asset record if it already exists on Counterparty, else null. */
// deno-lint-ignore no-explicit-any
async function lookupAsset(asset: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${COUNTERPARTY_URL}/v2/assets/${encodeURIComponent(asset)}`, { signal: controller.signal });
    if (res.status === 404) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { response: { status: res.status, data }, message: `HTTP ${res.status}` };
    return data?.result || null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chunk asset names must themselves be valid Counterparty asset names.
 * Numeric assets: consecutive ids A<base>, A<base+1>, … (all free).
 * Named assets cannot be chunked (there is no valid derived name and each would
 * cost 0.5 XCP).
 */
function chunkAssetNames(asset: string, count: number): string[] {
  if (count === 1) return [asset];
  if (!/^A\d{17,20}$/.test(asset)) {
    throw new ClientError(400, "Files that need more than one chunk must use a numeric asset name (A…). Use the Auto button.");
  }
  const base = BigInt(asset.slice(1));
  const max = (1n << 64n) - 1n;
  const names: string[] = [];
  for (let i = 0n; i < BigInt(count); i++) {
    const id = base + i;
    if (id > max) {
      throw new ClientError(400, "Numeric asset id overflows the Counterparty range when chunked — pick a lower number.");
    }
    names.push(`A${id.toString()}`);
  }
  return names;
}

async function assertAssetsAvailable(names: string[]): Promise<void> {
  for (const name of names) {
    const existing = await lookupAsset(name);
    if (existing) {
      throw new ClientError(409, `Asset ${name} already exists (issuer ${existing.issuer || "unknown"}). Choose another name.`);
    }
  }
}

// deno-lint-ignore no-explicit-any
function handleXcpError(error: any): Response {
  if (error instanceof ClientError) return json({ error: error.message }, error.clientStatus);

  const raw = error?.response?.data;
  const msg = raw && typeof raw === "object"
    ? JSON.stringify(raw)
    : (raw || error?.message || "Unknown error");
  console.error("[XCP Error]", msg);

  if (String(msg).includes("insufficient funds")) {
    return json({ error: "Insufficient funds", details: "Check BTC balance for fees + 0.5 XCP for named asset registration" }, 402);
  }
  // fetch surfaces connection failures as a TypeError, not an errno code.
  if (error?.code === "ECONNREFUSED" || error?.code === "ENOTFOUND" ||
      error instanceof TypeError) {
    return json({ error: "Counterparty server unreachable", url: COUNTERPARTY_URL }, 503);
  }
  if (String(msg).match(/413|too large|Request Entity Too Large/i)) {
    return json({ error: "Payload too large", hint: "File will be auto-chunked — retry with /api/mint" }, 413);
  }
  if (String(msg).match(/mime|Unrecognized.*MIME/i)) {
    return json({ error: "Unsupported MIME type", details: msg, hint: "Ensure patch_mime.py has been applied to the Counterparty server" }, 422);
  }
  return json({ error: msg }, 500);
}

// Pull a file (if any) + plain fields out of a multipart/urlencoded body, or a
// JSON body. Array values (e.g. destinationWallets) are comma-joined.
async function readParams(
  req: Request,
): Promise<{ fields: Record<string, string>; file: File | null }> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      fields[k] = Array.isArray(v) ? v.join(",") : String(v);
    }
    return { fields, file: null };
  }
  const form = await req.formData();
  const fields: Record<string, string> = {};
  let file: File | null = null;
  for (const [k, v] of form.entries()) {
    if (v instanceof File) {
      if (k === "file") file = v;
    } else {
      fields[k] = v;
    }
  }
  return { fields, file };
}

/** Resolve file bytes + MIME from a multipart `file` or legacy hex `description`. */
async function resolvePayload(
  fields: Record<string, string>,
  file: File | null,
): Promise<{ fileBytes: Uint8Array; resolvedMime: string }> {
  if (file) {
    if (!mimeAllowed(file.type)) throw new ClientError(422, `Unsupported MIME type: ${file.type || "(none)"}`);
    if (file.size > MAX_FILE_SIZE_BYTES) throw new ClientError(413, `File exceeds ${MAX_FILE_SIZE_MB}MB limit`);
    return { fileBytes: new Uint8Array(await file.arrayBuffer()), resolvedMime: fields.mime_type || detectMime(file) };
  }
  if (fields.description) {
    return { fileBytes: decodeHex(fields.description), resolvedMime: fields.mime_type || "application/octet-stream" };
  }
  throw new ClientError(400, "No file or description payload provided");
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// deno-fmt-ignore
const SWAGGER_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><title>Counter-Inscription Minter API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.4/swagger-ui.css">
<style>body{margin:0;padding:20px;background:#0a0a0f}
.swagger-ui{max-width:1400px;margin:0 auto;background:#121216;padding:20px;border-radius:8px}</style>
</head><body><div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.4/swagger-ui-bundle.js"></script>
<script src="https://unpkg.com/swagger-ui-dist@5.17.4/swagger-ui-standalone-preset.js"></script>
<script>
window.onload = function() {
  fetch('/openapi-spec.json').then(function(r) { return r.json(); }).then(function(spec) {
    SwaggerUIBundle({
      spec: spec,
      dom_id: '#swagger-ui',
      deepLinking: true,
      validatorUrl: null,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      plugins: [SwaggerUIBundle.plugins.DownloadUrl],
      layout: 'StandaloneLayout'
    });
  });
};
</script>
</body></html>`;

/**
 * POST /api/mint — single file → issuance(s) signed by the connected wallet.
 * Auto-chunks large files. The issued units + inscribed sat go to `walletAddress`
 * (the signer); `destinationWallet`, if different, becomes the asset OWNER via
 * transfer_destination. Move units with POST /api/send-batch after confirmation.
 */
async function mint(req: Request): Promise<Response> {
  try {
    const { fields, file } = await readParams(req);
    const {
      asset,
      quantity = "1",
      encoding = "taproot",
      sat_per_vbyte = "2.01",
      walletAddress,
      destinationWallet,
    } = fields;

    const source = walletAddress?.trim();
    const owner = destinationWallet?.trim() || source;
    if (!asset || !source) {
      return json({ error: "Missing required: asset, walletAddress (and optionally destinationWallet)" }, 400);
    }
    const assetName = String(asset).trim().toUpperCase();
    if (!isValidAssetName(assetName)) {
      return json({ error: `Invalid asset name "${assetName}". Use A + 17–20 digits (free) or 4–12 uppercase letters not starting with A (0.5 XCP).` }, 400);
    }
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) return json({ error: "quantity must be a positive integer" }, 400);
    const feeRate = parseFloat(sat_per_vbyte);
    if (!(feeRate > 0)) return json({ error: "sat_per_vbyte must be a positive number" }, 400);

    const { fileBytes, resolvedMime } = await resolvePayload(fields, file);

    const chunks = chunkBytes(fileBytes, MAX_CHUNK_BYTES);
    const names = chunkAssetNames(assetName, chunks.length);
    await assertAssetsAvailable(names);

    const transactions = [];
    for (let i = 0; i < chunks.length; i++) {
      const tx = await composeIssuance({
        source,
        asset: names[i],
        mimeType: resolvedMime,
        hexData: encodeHex(chunks[i]),
        satPerVbyte: feeRate,
        encoding,
        quantity: qty,
        transferDestination: owner !== source ? owner : undefined,
      });
      transactions.push({ asset: names[i], chunk: i + 1, total_chunks: chunks.length, chunk_bytes: chunks[i].length, tx });
    }

    return json({
      success: true,
      asset: assetName,
      chunk_assets: names,
      signer: source,
      holder: source,
      owner,
      total_chunks: chunks.length,
      file_size_bytes: fileBytes.length,
      mime_type: resolvedMime,
      transactions,
      next_steps: [
        "For each transaction: sign `tx.psbt` with the wallet and broadcast the commit.",
        "Then POST /api/broadcast with `tx.signed_reveal_rawtransaction` — the inscription is not on-chain until the reveal confirms.",
        owner !== source ? `Issued units stay with ${source}; ${owner} becomes the asset owner. Use POST /api/send-batch to move units.` : null,
      ].filter(Boolean),
    });
  } catch (error) {
    return handleXcpError(error);
  }
}

/**
 * POST /api/mint-batch — one file → many wallets (airdrop). Composes ONE issuance
 * of quantity = wallet count from the connected wallet. Distribute with
 * POST /api/send-batch once it has confirmed. File must fit in one chunk (<350KB).
 */
async function mintBatch(req: Request): Promise<Response> {
  try {
    const { fields, file } = await readParams(req);
    const {
      asset,
      encoding = "taproot",
      sat_per_vbyte = "2.01",
      walletAddress,
      destinationWallets,
    } = fields;

    const source = walletAddress?.trim();
    if (!asset || !source || !destinationWallets) {
      return json({ error: "Missing required: asset, walletAddress, destinationWallets" }, 400);
    }
    const assetName = String(asset).trim().toUpperCase();
    if (!isValidAssetName(assetName)) return json({ error: `Invalid asset name "${assetName}".` }, 400);
    const wallets = [...new Set(destinationWallets.split(",").map((w) => w.trim()).filter(Boolean))];
    if (wallets.length === 0) return json({ error: "No valid wallet addresses" }, 400);
    const feeRate = parseFloat(sat_per_vbyte);
    if (!(feeRate > 0)) return json({ error: "sat_per_vbyte must be a positive number" }, 400);

    const { fileBytes, resolvedMime } = await resolvePayload(fields, file);

    if (fileBytes.length > MAX_CHUNK_BYTES) {
      return json({
        error: `File too large for batch mint (${(fileBytes.length / 1024).toFixed(0)}KB > ${MAX_CHUNK_BYTES / 1024}KB).`,
        hint: "Use /api/mint with chunking support for large files, or reduce file size.",
      }, 413);
    }

    await assertAssetsAvailable([assetName]);

    const tx = await composeIssuance({
      source,
      asset: assetName,
      mimeType: resolvedMime,
      hexData: encodeHex(fileBytes),
      satPerVbyte: feeRate,
      encoding,
      quantity: wallets.length,
    });

    return json({
      success: true,
      asset: assetName,
      signer: source,
      quantity: wallets.length,
      destinations: wallets,
      mime_type: resolvedMime,
      file_size_bytes: fileBytes.length,
      tx,
      next_steps: [
        "Sign `tx.psbt`, broadcast the commit, then POST /api/broadcast with `tx.signed_reveal_rawtransaction`.",
        `Once the issuance has confirmed, POST /api/send-batch with the same asset and destinations to airdrop one unit to each of the ${wallets.length} wallets in a single MPMA transaction.`,
      ],
    });
  } catch (error) {
    return handleXcpError(error);
  }
}

/**
 * POST /api/send-batch — one MPMA send from the connected wallet. The asset must
 * already be confirmed and held by walletAddress, else Counterparty reports
 * insufficient funds. Accepts form or JSON (destinationWallets: "a,b,c" | [..]).
 */
async function sendBatch(req: Request): Promise<Response> {
  try {
    const { fields } = await readParams(req);
    const { walletAddress, asset, destinationWallets, quantity_each = "1", sat_per_vbyte = "2.01" } = fields;
    const source = walletAddress?.trim();
    if (!source || !asset || !destinationWallets) {
      return json({ error: "Missing required: walletAddress, asset, destinationWallets" }, 400);
    }
    const wallets = [...new Set(String(destinationWallets).split(",").map((w) => w.trim()).filter(Boolean))];
    if (wallets.length === 0) return json({ error: "No valid wallet addresses" }, 400);
    const qtyEach = parseInt(quantity_each, 10);
    if (!Number.isInteger(qtyEach) || qtyEach < 1) return json({ error: "quantity_each must be a positive integer" }, 400);

    const assetName = String(asset).trim().toUpperCase();
    const tx = await composeMpma({
      source,
      asset: assetName,
      destinations: wallets,
      quantityEach: qtyEach,
      satPerVbyte: parseFloat(sat_per_vbyte),
    });
    return json({ success: true, asset: assetName, signer: source, destinations: wallets, quantity_each: qtyEach, tx });
  } catch (error) {
    return handleXcpError(error);
  }
}

/**
 * POST /api/broadcast — proxy to Counterparty's bitcoind sendrawtransaction. Used
 * for the reveal transaction (already node-signed) and for wallets that cannot
 * push raw hex themselves.
 */
async function broadcast(req: Request): Promise<Response> {
  try {
    const { fields } = await readParams(req);
    const signedhex = (fields.signedhex || fields.rawtx || "").trim();
    if (!/^[0-9a-fA-F]+$/.test(signedhex) || signedhex.length < 20) {
      return json({ error: "signedhex must be a hex-encoded signed transaction" }, 400);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(
        `${COUNTERPARTY_URL}/v2/bitcoin/transactions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
          body: `signedhex=${signedhex}`,
          signal: controller.signal,
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw { response: { status: res.status, data }, message: `HTTP ${res.status}` };
      // deno-lint-ignore no-explicit-any
      return json({ success: true, txid: (data as any)?.result ?? data });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return handleXcpError(error);
  }
}

/** GET /api/tx/:hash — Counterparty view of a transaction (null result until parsed). */
async function txStatus(hash: string): Promise<Response> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${COUNTERPARTY_URL}/v2/transactions/${encodeURIComponent(hash)}`, { signal: controller.signal });
      if (res.status === 404) return json({ result: null });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw { response: { status: res.status, data }, message: `HTTP ${res.status}` };
      return json(data);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return handleXcpError(error);
  }
}

/** GET /api/asset/:asset — availability check. */
async function assetInfo(name: string): Promise<Response> {
  try {
    const asset = decodeURIComponent(name).toUpperCase();
    const existing = await lookupAsset(asset);
    return json({ asset, available: !existing, valid: isValidAssetName(asset), existing });
  } catch (error) {
    return handleXcpError(error);
  }
}

/** POST /api/upload — pre-flight file analysis. */
async function upload(req: Request): Promise<Response> {
  const { file } = await readParams(req);
  if (!file) return json({ error: "No file uploaded" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const resolvedMime = detectMime(file);
  const chunks = chunkBytes(bytes, MAX_CHUNK_BYTES);
  return json({
    success: true,
    originalName: file.name,
    mimeType: resolvedMime,
    sizeBytes: bytes.length,
    sizeKB: (bytes.length / 1024).toFixed(1),
    totalChunks: chunks.length,
    needsChunking: chunks.length > 1,
    hexPreview: encodeHex(bytes.subarray(0, 256)),
  });
}

/** GET /api/balance/:address */
async function balance(address: string): Promise<Response> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const r = await fetch(`${COUNTERPARTY_URL}/v2/addresses/${encodeURIComponent(address)}/balances`, { signal: controller.signal });
    clearTimeout(timer);
    return json(await r.json());
  } catch (error) {
    return json({ error: "Failed to fetch balance", details: (error as Error).message }, 500);
  }
}

/** GET /api/health */
async function health(): Promise<Response> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const r = await fetch(`${COUNTERPARTY_URL}/v2/`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    // deno-lint-ignore no-explicit-any
    const d = data as any;
    return json({ status: "ok", counterparty: "reachable", counterparty_url: COUNTERPARTY_URL, version: d?.result?.version ?? d?.version });
  } catch (error) {
    return json({ status: "degraded", counterparty: "unreachable", counterparty_url: COUNTERPARTY_URL, error: (error as Error).message });
  }
}

const MIME_TYPES = {
  supported: {
    image: ["image/png","image/jpeg","image/gif","image/webp","image/svg+xml","image/bmp","image/avif","image/tiff","image/heic","image/jxl","image/x-icon"],
    audio: ["audio/mpeg","audio/ogg","audio/ogg;codecs=opus","audio/wav","audio/flac","audio/aac","audio/mp4","audio/webm","audio/midi","audio/x-aiff","audio/x-m4a"],
    video: ["video/mp4","video/webm","video/ogg","video/quicktime","video/x-matroska","video/x-msvideo","video/mpeg","video/3gpp","video/x-flv"],
    text: ["text/plain","text/html","text/css","text/javascript","text/markdown","text/csv","text/xml","text/yaml","text/x-python","text/x-rust","text/x-go","text/x-solidity","text/x-sh","text/x-lua","text/x-swift","text/x-kotlin","text/x-java","text/x-ruby","text/x-php","text/x-toml"],
    application: ["application/json","application/pdf","application/wasm","application/octet-stream","application/epub+zip","application/x-sqlite3","application/zip","application/gzip","application/x-7z-compressed","application/geo+json","application/ld+json","application/pgp-signature","application/vnd.ms-excel","application/msword","application/x-chess-pgn","application/vnd.google-earth.kml+xml","application/x-shockwave-flash","chemical/x-mdl-molfile"],
    model: ["model/gltf+json","model/gltf-binary","model/stl","model/obj","model/vrml","model/vnd.usdz+zip","application/x-blender"],
    font: ["font/ttf","font/otf","font/woff","font/woff2"],
  },
  max_chunk_kb: MAX_CHUNK_BYTES / 1024,
  max_file_mb: MAX_FILE_SIZE_MB,
};

function readSpecYaml(): string {
  return Deno.readTextFileSync(`${MODULE_DIR}openapi-spec.yaml`);
}

// ─── Router ───────────────────────────────────────────────────────────────────
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const { method } = req;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // POST routes
  if (method === "POST") {
    if (pathname === "/api/mint") return await mint(req);
    if (pathname === "/api/mint-batch") return await mintBatch(req);
    if (pathname === "/api/send-batch") return await sendBatch(req);
    if (pathname === "/api/broadcast") return await broadcast(req);
    if (pathname === "/api/upload") return await upload(req);
    return json({ error: "Not found" }, 404);
  }

  // GET routes
  if (method === "GET") {
    if (pathname === "/") return new Response(null, { status: 302, headers: { Location: "/swagger-ui.html", ...CORS_HEADERS } });
    if (pathname === "/swagger-ui.html") {
      return new Response(SWAGGER_HTML, { headers: { "Content-Type": "text/html", ...CORS_HEADERS } });
    }
    if (pathname === "/api/mime-types") return json(MIME_TYPES);
    if (pathname === "/api/health") return await health();
    const balMatch = pathname.match(/^\/api\/balance\/(.+)$/);
    if (balMatch) return await balance(decodeURIComponent(balMatch[1]));
    const assetMatch = pathname.match(/^\/api\/asset\/(.+)$/);
    if (assetMatch) return await assetInfo(assetMatch[1]);
    const txMatch = pathname.match(/^\/api\/tx\/(.+)$/);
    if (txMatch) return await txStatus(decodeURIComponent(txMatch[1]));

    if (["/openapi-spec.json", "/api/openapi-spec.json", "/swagger-spec.json"].includes(pathname)) {
      try {
        return json(parseYaml(readSpecYaml()));
      } catch {
        return json({ error: "Cannot serve spec" }, 500);
      }
    }
    if (pathname === "/openapi-spec.yaml") {
      try {
        return new Response(readSpecYaml(), { headers: { "Content-Type": "text/x-yaml", ...CORS_HEADERS } });
      } catch {
        return json({ error: "Cannot serve spec" }, 500);
      }
    }
    return json({ error: "Not found" }, 404);
  }

  return json({ error: "Method not allowed" }, 405);
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(Deno.env.get("PORT") || "3001");
Deno.serve({ port: PORT, hostname: "0.0.0.0" }, handler);
console.log(`✓ Backend running on http://0.0.0.0:${PORT}`);
console.log(`✓ Swagger UI: http://localhost:${PORT}/swagger-ui.html`);
console.log(`✓ Counterparty URL: ${COUNTERPARTY_URL}`);
console.log(`✓ Max file size: ${MAX_FILE_SIZE_MB}MB | Chunk size: ${MAX_CHUNK_BYTES / 1024}KB`);

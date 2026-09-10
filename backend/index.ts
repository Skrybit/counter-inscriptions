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
// Behaviour is a faithful 1:1 with the Node version: same routes, same
// chunking (350 KiB), same compose-issuance wire format, same error mapping.
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

const encoder = new TextEncoder();

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

/**
 * POST one issuance to Counterparty exactly as mint_collection.sh does:
 *   asset=...&quantity=1&...&description=<hex>
 * The prefix is ASCII and hex is ASCII, so a plain string body is byte-for-byte
 * what the Node version built with Buffer.concat.
 */
async function composeIssuance(
  { walletAddress, asset, mimeType, hexData, satPerVbyte = 2.01, encoding = "taproot", quantity = 1 }: {
    walletAddress: string;
    asset: string;
    mimeType: string;
    hexData: string;
    satPerVbyte?: number;
    encoding?: string;
    quantity?: number;
  },
): Promise<unknown> {
  const prefix = [
    `asset=${encodeURIComponent(asset)}`,
    `quantity=${quantity}`,
    `divisible=false`,
    `encoding=${encoding}`,
    `inscription=true`,
    `mime_type=${encodeURIComponent(mimeType)}`,
    `sat_per_vbyte=${satPerVbyte}`,
    `description=`,
  ].join("&");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(
      `${COUNTERPARTY_URL}/v2/addresses/${walletAddress}/compose/issuance`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body: prefix + hexData,
        signal: controller.signal,
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Mirror axios throwing on non-2xx so handleXcpError can map it.
      throw { response: { status: res.status, data }, message: `HTTP ${res.status}` };
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// deno-lint-ignore no-explicit-any
function handleXcpError(error: any): Response {
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

// Pull a file (if any) + plain fields out of a multipart/urlencoded body.
async function readForm(
  req: Request,
): Promise<{ fields: Record<string, string>; file: File | null }> {
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

/** POST /api/mint — single file → one wallet, auto-chunks large files. */
async function mint(req: Request): Promise<Response> {
  try {
    const { fields, file } = await readForm(req);
    const {
      asset,
      quantity = "1",
      mime_type,
      encoding = "taproot",
      sat_per_vbyte = "2.01",
      walletAddress,
      destinationWallet,
    } = fields;

    const mintTo = destinationWallet?.trim() || walletAddress?.trim();
    if (!asset || !mintTo) {
      return json({ error: "Missing required: asset, walletAddress (and optionally destinationWallet)" }, 400);
    }

    let fileBytes: Uint8Array;
    let resolvedMime: string;
    if (file) {
      if (!mimeAllowed(file.type)) return json({ error: "Unsupported MIME type", details: file.type || "(none)" }, 422);
      if (file.size > MAX_FILE_SIZE_BYTES) return json({ error: `File exceeds ${MAX_FILE_SIZE_MB}MB limit` }, 413);
      fileBytes = new Uint8Array(await file.arrayBuffer());
      resolvedMime = mime_type || detectMime(file);
    } else if (fields.description) {
      fileBytes = decodeHex(fields.description);
      resolvedMime = mime_type || "application/octet-stream";
    } else {
      return json({ error: "No file or description payload provided" }, 400);
    }

    const chunks = chunkBytes(fileBytes, MAX_CHUNK_BYTES);
    const transactions = [];
    for (let i = 0; i < chunks.length; i++) {
      const hexData = encodeHex(chunks[i]);
      const chunkAsset = chunks.length > 1 ? `${asset}_${i + 1}` : asset;
      const data = await composeIssuance({
        walletAddress: mintTo,
        asset: chunkAsset,
        mimeType: resolvedMime,
        hexData,
        satPerVbyte: parseFloat(sat_per_vbyte),
        encoding,
        quantity: parseInt(quantity),
      });
      transactions.push({ asset: chunkAsset, chunk: i + 1, total_chunks: chunks.length, data });
    }

    return json({
      success: true,
      asset,
      wallet: mintTo,
      total_chunks: chunks.length,
      file_size_bytes: fileBytes.length,
      mime_type: resolvedMime,
      transactions,
    });
  } catch (error) {
    return handleXcpError(error);
  }
}

/** POST /api/mint-batch — one file → multiple destination wallets. */
async function mintBatch(req: Request): Promise<Response> {
  try {
    const { fields, file } = await readForm(req);
    const {
      asset,
      mime_type,
      encoding = "taproot",
      sat_per_vbyte = "2.01",
      walletAddress,
      destinationWallets,
    } = fields;

    if (!asset || !walletAddress || !destinationWallets) {
      return json({ error: "Missing required: asset, walletAddress, destinationWallets" }, 400);
    }

    const wallets = destinationWallets.split(",").map((w) => w.trim()).filter(Boolean);
    if (wallets.length === 0) return json({ error: "No valid wallet addresses" }, 400);

    let fileBytes: Uint8Array;
    let resolvedMime: string;
    if (file) {
      if (!mimeAllowed(file.type)) return json({ error: "Unsupported MIME type", details: file.type || "(none)" }, 422);
      if (file.size > MAX_FILE_SIZE_BYTES) return json({ error: `File exceeds ${MAX_FILE_SIZE_MB}MB limit` }, 413);
      fileBytes = new Uint8Array(await file.arrayBuffer());
      resolvedMime = mime_type || detectMime(file);
    } else if (fields.description) {
      fileBytes = decodeHex(fields.description);
      resolvedMime = mime_type || "application/octet-stream";
    } else {
      return json({ error: "No file or description payload provided" }, 400);
    }

    if (fileBytes.length > MAX_CHUNK_BYTES) {
      return json({
        error: `File too large for batch mint (${(fileBytes.length / 1024).toFixed(0)}KB > ${MAX_CHUNK_BYTES / 1024}KB).`,
        hint: "Use /api/mint with chunking support for large files, or reduce file size.",
      }, 413);
    }

    const hexData = encodeHex(fileBytes);
    const results = [];
    for (const dest of wallets) {
      try {
        const data = await composeIssuance({
          walletAddress: dest,
          asset,
          mimeType: resolvedMime,
          hexData,
          satPerVbyte: parseFloat(sat_per_vbyte),
          encoding,
          quantity: 1,
        });
        results.push({ wallet: dest, status: "success", data });
      } catch (err) {
        // deno-lint-ignore no-explicit-any
        const e = err as any;
        const errMsg = e?.response?.data || e?.message;
        results.push({ wallet: dest, status: "failed", error: typeof errMsg === "object" ? JSON.stringify(errMsg) : errMsg });
      }
    }

    const succeeded = results.filter((r) => r.status === "success").length;
    return json({ success: true, total: wallets.length, succeeded, failed: wallets.length - succeeded, results });
  } catch (error) {
    return handleXcpError(error);
  }
}

/** POST /api/upload — pre-flight file analysis. */
async function upload(req: Request): Promise<Response> {
  const { file } = await readForm(req);
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
    const r = await fetch(`${COUNTERPARTY_URL}/v2/addresses/${address}/balances`, { signal: controller.signal });
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
    return json({ status: "ok", counterparty: "reachable", counterparty_url: COUNTERPARTY_URL, version: (data as any)?.version });
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
    if (pathname === "/api/upload") return await upload(req);
    return json({ error: "Not found" }, 404);
  }

  // GET routes
  if (method === "GET") {
    if (pathname === "/" ) return new Response(null, { status: 302, headers: { Location: "/swagger-ui.html", ...CORS_HEADERS } });
    if (pathname === "/swagger-ui.html") {
      return new Response(SWAGGER_HTML, { headers: { "Content-Type": "text/html", ...CORS_HEADERS } });
    }
    if (pathname === "/api/mime-types") return json(MIME_TYPES);
    if (pathname === "/api/health") return await health();
    const balMatch = pathname.match(/^\/api\/balance\/(.+)$/);
    if (balMatch) return await balance(decodeURIComponent(balMatch[1]));

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

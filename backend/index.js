const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const yaml = require('js-yaml');
const mime = require('mime-types');

// ─── Config ──────────────────────────────────────────────────────────────────
// In Docker: counterparty runs at counterparty-server:4000
// Locally:   set COUNTERPARTY_URL=http://localhost:4000
const COUNTERPARTY_URL = process.env.COUNTERPARTY_URL || 'http://counterparty-server:4000';
const MAX_FILE_SIZE_MB = 50;

// Counterparty has ~380KB hex payload limit per issuance description field.
// We chunk at 350KB binary → ~700KB hex (well under limit after URL encoding overhead).
const MAX_CHUNK_BYTES = 350 * 1024;

const app = express();
app.use(cors());
app.use('/api/', express.json({ limit: '100mb' }));
app.use('/api/', express.urlencoded({ extended: true, limit: '100mb' }));

// ─── Multer ───────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const baseMime = (file.mimetype || '').split(';')[0].trim();
    if (!baseMime) return cb(new Error('No MIME type detected'), false);
    const ok = ['text/', 'image/', 'audio/', 'video/', 'application/', 'font/', 'model/'].some(p => baseMime.startsWith(p));
    cb(null, ok);
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bufToHex(buf) {
  return buf.toString('hex');
}

function chunkBuffer(buf, maxBytes) {
  const chunks = [];
  let offset = 0;
  while (offset < buf.length) {
    chunks.push(buf.slice(offset, offset + maxBytes));
    offset += maxBytes;
  }
  return chunks.length === 0 ? [buf] : chunks;
}

function detectMime(file) {
  const fromName = file.originalname ? mime.lookup(file.originalname) : null;
  const fromMulter = file.mimetype ? file.mimetype.split(';')[0].trim() : null;
  return fromName || fromMulter || 'application/octet-stream';
}

/**
 * Normalize a Counterparty compose result (verbose=true) into the bundle the
 * wallet needs. Taproot inscriptions are TWO transactions:
 *   1. commit  — unsigned; the wallet signs `psbt` and broadcasts it
 *   2. reveal  — `signed_reveal_rawtransaction`, already signed by the node with
 *                an ephemeral key; broadcast it AFTER the commit (POST /api/broadcast)
 * Without the reveal the inscription content never lands on-chain.
 */
function normalizeCompose(result) {
  const r = result?.result || result || {};
  return {
    psbt: r.psbt || null,                                   // base64 (bitcoind converttopsbt)
    rawtransaction: r.rawtransaction || null,               // unsigned commit tx hex
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

async function xcpCompose(source, kind, fields, { rawSuffix } = {}) {
  const prefix = Object.entries({ ...fields, verbose: 'true' })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

  // Large hex payloads are appended raw (hex is pure ASCII) to avoid re-encoding cost.
  const body = rawSuffix
    ? Buffer.concat([Buffer.from(`${prefix}&${rawSuffix.key}=`, 'utf8'), Buffer.from(rawSuffix.value, 'utf8')])
    : Buffer.from(prefix, 'utf8');

  const response = await axios.post(
    `${COUNTERPARTY_URL}/v2/addresses/${encodeURIComponent(source)}/compose/${kind}`,
    body,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 180_000,
    }
  );
  return normalizeCompose(response.data);
}

/**
 * Compose one issuance. `source` is the CONNECTED wallet: it pays fees, signs the
 * commit, and — per Counterparty issuance semantics — receives the issued units and
 * the inscribed sat. `transferDestination` (optional) makes another address the
 * asset OWNER (issuer); it does not move the units. Use a send/MPMA for that.
 */
async function composeIssuance({ source, asset, mimeType, hexData, satPerVbyte = 2.01, encoding = 'taproot', quantity = 1, transferDestination }) {
  return xcpCompose(source, 'issuance', {
    asset,
    quantity,
    divisible: 'false',
    encoding,
    inscription: 'true',
    mime_type: mimeType,
    sat_per_vbyte: satPerVbyte,
    transfer_destination: transferDestination && transferDestination !== source ? transferDestination : undefined,
  }, { rawSuffix: { key: 'description', value: hexData } });
}

/** Compose an MPMA send of `quantity` units of `asset` from `source` to each destination. */
async function composeMpma({ source, asset, destinations, quantityEach = 1, satPerVbyte = 2.01 }) {
  return xcpCompose(source, 'mpma', {
    assets: destinations.map(() => asset).join(','),
    destinations: destinations.join(','),
    quantities: destinations.map(() => quantityEach).join(','),
    sat_per_vbyte: satPerVbyte,
  });
}

/** Returns the asset record if it already exists on Counterparty, else null. */
async function lookupAsset(asset) {
  try {
    const r = await axios.get(`${COUNTERPARTY_URL}/v2/assets/${encodeURIComponent(asset)}`, { timeout: 10_000 });
    return r.data?.result || null;
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

function isValidAssetName(asset) {
  // Numeric: A + 17..20 digits (Counterparty range is checked server-side). Named: 4–12 uppercase, not starting with A.
  return /^A\d{17,20}$/.test(asset) || /^[B-Z][A-Z]{3,11}$/.test(asset);
}

function handleXcpError(res, error) {
  const raw = error.response?.data;
  const msg = raw && typeof raw === 'object' ? JSON.stringify(raw) : (raw || error.message || 'Unknown error');
  console.error('[XCP Error]', msg);

  if (String(msg).includes('insufficient funds')) {
    return res.status(402).json({ error: 'Insufficient funds', details: 'Check BTC balance for fees + 0.5 XCP for named asset registration' });
  }
  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    return res.status(503).json({ error: 'Counterparty server unreachable', url: COUNTERPARTY_URL });
  }
  if (String(msg).match(/413|too large|Request Entity Too Large/i)) {
    return res.status(413).json({ error: 'Payload too large', hint: 'File will be auto-chunked — retry with /api/mint' });
  }
  if (String(msg).match(/mime|Unrecognized.*MIME/i)) {
    return res.status(422).json({ error: 'Unsupported MIME type', details: msg, hint: 'Ensure patch_mime.py has been applied to the Counterparty server' });
  }
  return res.status(500).json({ error: msg });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Swagger UI
app.get('/swagger-ui.html', (req, res) => {
  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html><html lang="en"><head>
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
</body></html>`);
});

/** Resolve file bytes + MIME from multipart `file` or legacy hex `description`. */
function resolvePayload(req) {
  const { mime_type } = req.body;
  if (req.file) {
    return { fileBuffer: req.file.buffer, resolvedMime: mime_type || detectMime(req.file) };
  }
  if (req.body.description) {
    return { fileBuffer: Buffer.from(req.body.description, 'hex'), resolvedMime: mime_type || 'application/octet-stream' };
  }
  return null;
}

/**
 * Chunk asset names must themselves be valid Counterparty asset names.
 * Numeric assets: consecutive ids A<base>, A<base+1>, … (all free).
 * Named assets cannot be chunked (there is no valid derived name and each would cost 0.5 XCP).
 */
function chunkAssetNames(asset, count) {
  if (count === 1) return [asset];
  if (!/^A\d{17,20}$/.test(asset)) {
    const err = new Error('Files that need more than one chunk must use a numeric asset name (A…). Use the Auto button.');
    err.clientStatus = 400;
    throw err;
  }
  const base = BigInt(asset.slice(1));
  const max = (1n << 64n) - 1n;
  const names = [];
  for (let i = 0n; i < BigInt(count); i++) {
    const id = base + i;
    if (id > max) {
      const err = new Error('Numeric asset id overflows the Counterparty range when chunked — pick a lower number.');
      err.clientStatus = 400;
      throw err;
    }
    names.push(`A${id.toString()}`);
  }
  return names;
}

async function assertAssetsAvailable(names) {
  for (const name of names) {
    const existing = await lookupAsset(name);
    if (existing) {
      const err = new Error(`Asset ${name} already exists (issuer ${existing.issuer || 'unknown'}). Choose another name.`);
      err.clientStatus = 409;
      throw err;
    }
  }
}

/**
 * POST /api/mint
 * Single file → issuance(s) signed by the connected wallet. Auto-chunks large files.
 * Accepts multipart/form-data (file field) OR application/x-www-form-urlencoded with hex in `description`.
 *
 * Counterparty issuance semantics: issued units and the inscribed sat go to `walletAddress`
 * (the signer). `destinationWallet`, if different, becomes the asset OWNER via
 * transfer_destination. To move the units use POST /api/send-batch after confirmation.
 */
app.post('/api/mint', upload.single('file'), async (req, res) => {
  try {
    const {
      asset,
      quantity = 1,
      encoding = 'taproot',
      sat_per_vbyte = 2.01,
      walletAddress,
      destinationWallet,
    } = req.body;

    const source = walletAddress?.trim();
    const owner = destinationWallet?.trim() || source;

    if (!asset || !source) {
      return res.status(400).json({ error: 'Missing required: asset, walletAddress (and optionally destinationWallet)' });
    }
    const assetName = String(asset).trim().toUpperCase();
    if (!isValidAssetName(assetName)) {
      return res.status(400).json({ error: `Invalid asset name "${assetName}". Use A + 17–20 digits (free) or 4–12 uppercase letters not starting with A (0.5 XCP).` });
    }
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'quantity must be a positive integer' });
    const feeRate = parseFloat(sat_per_vbyte);
    if (!(feeRate > 0)) return res.status(400).json({ error: 'sat_per_vbyte must be a positive number' });

    const payload = resolvePayload(req);
    if (!payload) return res.status(400).json({ error: 'No file or description payload provided' });
    const { fileBuffer, resolvedMime } = payload;

    const chunks = chunkBuffer(fileBuffer, MAX_CHUNK_BYTES);
    const names = chunkAssetNames(assetName, chunks.length);
    await assertAssetsAvailable(names);

    const transactions = [];
    for (let i = 0; i < chunks.length; i++) {
      const tx = await composeIssuance({
        source,
        asset: names[i],
        mimeType: resolvedMime,
        hexData: bufToHex(chunks[i]),
        satPerVbyte: feeRate,
        encoding,
        quantity: qty,
        transferDestination: owner !== source ? owner : undefined,
      });
      transactions.push({ asset: names[i], chunk: i + 1, total_chunks: chunks.length, chunk_bytes: chunks[i].length, tx });
    }

    return res.json({
      success: true,
      asset: assetName,
      chunk_assets: names,
      signer: source,
      holder: source,
      owner,
      total_chunks: chunks.length,
      file_size_bytes: fileBuffer.length,
      mime_type: resolvedMime,
      transactions,
      next_steps: [
        'For each transaction: sign `tx.psbt` with the wallet and broadcast the commit.',
        'Then POST /api/broadcast with `tx.signed_reveal_rawtransaction` — the inscription is not on-chain until the reveal confirms.',
        owner !== source ? `Issued units stay with ${source}; ${owner} becomes the asset owner. Use POST /api/send-batch to move units.` : null,
      ].filter(Boolean),
    });
  } catch (error) {
    if (error.clientStatus) return res.status(error.clientStatus).json({ error: error.message });
    return handleXcpError(res, error);
  }
});

/**
 * POST /api/mint-batch
 * One file → many wallets (airdrop). Composes ONE issuance of quantity = wallet count
 * from the connected wallet. Distribute with POST /api/send-batch once it has confirmed.
 * File must fit in one chunk (<350KB).
 */
app.post('/api/mint-batch', upload.single('file'), async (req, res) => {
  try {
    const { asset, encoding = 'taproot', sat_per_vbyte = 2.01, walletAddress, destinationWallets } = req.body;
    const source = walletAddress?.trim();

    if (!asset || !source || !destinationWallets) {
      return res.status(400).json({ error: 'Missing required: asset, walletAddress, destinationWallets' });
    }
    const assetName = String(asset).trim().toUpperCase();
    if (!isValidAssetName(assetName)) {
      return res.status(400).json({ error: `Invalid asset name "${assetName}".` });
    }
    const wallets = [...new Set(destinationWallets.split(',').map(w => w.trim()).filter(Boolean))];
    if (wallets.length === 0) return res.status(400).json({ error: 'No valid wallet addresses' });
    const feeRate = parseFloat(sat_per_vbyte);
    if (!(feeRate > 0)) return res.status(400).json({ error: 'sat_per_vbyte must be a positive number' });

    const payload = resolvePayload(req);
    if (!payload) return res.status(400).json({ error: 'No file or description payload provided' });
    const { fileBuffer, resolvedMime } = payload;

    if (fileBuffer.length > MAX_CHUNK_BYTES) {
      return res.status(413).json({
        error: `File too large for batch mint (${(fileBuffer.length / 1024).toFixed(0)}KB > ${MAX_CHUNK_BYTES / 1024}KB).`,
        hint: 'Use /api/mint with chunking support for large files, or reduce file size.',
      });
    }

    await assertAssetsAvailable([assetName]);

    const tx = await composeIssuance({
      source,
      asset: assetName,
      mimeType: resolvedMime,
      hexData: bufToHex(fileBuffer),
      satPerVbyte: feeRate,
      encoding,
      quantity: wallets.length,
    });

    return res.json({
      success: true,
      asset: assetName,
      signer: source,
      quantity: wallets.length,
      destinations: wallets,
      mime_type: resolvedMime,
      file_size_bytes: fileBuffer.length,
      tx,
      next_steps: [
        'Sign `tx.psbt`, broadcast the commit, then POST /api/broadcast with `tx.signed_reveal_rawtransaction`.',
        `Once the issuance has confirmed, POST /api/send-batch with the same asset and destinations to airdrop one unit to each of the ${wallets.length} wallets in a single MPMA transaction.`,
      ],
    });
  } catch (error) {
    if (error.clientStatus) return res.status(error.clientStatus).json({ error: error.message });
    return handleXcpError(res, error);
  }
});

/**
 * POST /api/send-batch  (JSON or form)
 * { walletAddress, asset, destinationWallets: "a,b,c" | [..], quantity_each?: 1, sat_per_vbyte? }
 * Composes one MPMA send from the connected wallet. The asset must already be confirmed
 * and held by walletAddress, otherwise Counterparty reports insufficient funds.
 */
app.post('/api/send-batch', upload.none(), async (req, res) => {
  try {
    const { walletAddress, asset, destinationWallets, quantity_each = 1, sat_per_vbyte = 2.01 } = req.body;
    const source = walletAddress?.trim();
    if (!source || !asset || !destinationWallets) {
      return res.status(400).json({ error: 'Missing required: walletAddress, asset, destinationWallets' });
    }
    const list = Array.isArray(destinationWallets) ? destinationWallets : String(destinationWallets).split(',');
    const wallets = [...new Set(list.map(w => String(w).trim()).filter(Boolean))];
    if (wallets.length === 0) return res.status(400).json({ error: 'No valid wallet addresses' });
    const qtyEach = parseInt(quantity_each, 10);
    if (!Number.isInteger(qtyEach) || qtyEach < 1) return res.status(400).json({ error: 'quantity_each must be a positive integer' });

    const tx = await composeMpma({
      source,
      asset: String(asset).trim().toUpperCase(),
      destinations: wallets,
      quantityEach: qtyEach,
      satPerVbyte: parseFloat(sat_per_vbyte),
    });
    return res.json({ success: true, asset: String(asset).trim().toUpperCase(), signer: source, destinations: wallets, quantity_each: qtyEach, tx });
  } catch (error) {
    return handleXcpError(res, error);
  }
});

/**
 * POST /api/broadcast  { signedhex }
 * Proxies to Counterparty's bitcoind sendrawtransaction. Used for the reveal transaction
 * (already signed by the node) and for wallets that cannot push raw hex themselves.
 */
app.post('/api/broadcast', upload.none(), async (req, res) => {
  try {
    const signedhex = (req.body.signedhex || req.body.rawtx || '').trim();
    if (!/^[0-9a-fA-F]+$/.test(signedhex) || signedhex.length < 20) {
      return res.status(400).json({ error: 'signedhex must be a hex-encoded signed transaction' });
    }
    const r = await axios.post(
      `${COUNTERPARTY_URL}/v2/bitcoin/transactions`,
      `signedhex=${signedhex}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, timeout: 30_000 }
    );
    return res.json({ success: true, txid: r.data?.result ?? r.data });
  } catch (error) {
    return handleXcpError(res, error);
  }
});

/** GET /api/tx/:hash — Counterparty view of a transaction (null result until it is parsed). */
app.get('/api/tx/:hash', async (req, res) => {
  try {
    const r = await axios.get(`${COUNTERPARTY_URL}/v2/transactions/${encodeURIComponent(req.params.hash)}`, { timeout: 10_000 });
    return res.json(r.data);
  } catch (error) {
    if (error.response?.status === 404) return res.json({ result: null });
    return handleXcpError(res, error);
  }
});

/** GET /api/asset/:asset — availability check. */
app.get('/api/asset/:asset', async (req, res) => {
  try {
    const name = req.params.asset.toUpperCase();
    const existing = await lookupAsset(name);
    return res.json({ asset: name, available: !existing, valid: isValidAssetName(name), existing });
  } catch (error) {
    return handleXcpError(res, error);
  }
});

/**
 * POST /api/upload
 * Pre-flight file analysis. Returns mime, size, chunk count, hex preview.
 */
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const resolvedMime = detectMime(req.file);
  const chunks = chunkBuffer(req.file.buffer, MAX_CHUNK_BYTES);
  return res.json({
    success: true,
    originalName: req.file.originalname,
    mimeType: resolvedMime,
    sizeBytes: req.file.size,
    sizeKB: (req.file.size / 1024).toFixed(1),
    totalChunks: chunks.length,
    needsChunking: chunks.length > 1,
    hexPreview: bufToHex(req.file.buffer.slice(0, 256)),
  });
});

/** GET /api/balance/:address */
app.get('/api/balance/:address', async (req, res) => {
  try {
    const r = await axios.get(`${COUNTERPARTY_URL}/v2/addresses/${encodeURIComponent(req.params.address)}/balances`, { timeout: 10_000 });
    return res.json(r.data);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch balance', details: error.message });
  }
});

/** GET /api/health */
app.get('/api/health', async (req, res) => {
  try {
    const r = await axios.get(`${COUNTERPARTY_URL}/v2/`, { timeout: 5_000 });
    return res.json({ status: 'ok', counterparty: 'reachable', counterparty_url: COUNTERPARTY_URL, version: r.data?.result?.version || r.data?.version });
  } catch (error) {
    return res.json({ status: 'degraded', counterparty: 'unreachable', counterparty_url: COUNTERPARTY_URL, error: error.message });
  }
});

/** GET /api/mime-types — full supported MIME type list */
app.get('/api/mime-types', (req, res) => {
  return res.json({
    supported: {
      image: ['image/png','image/jpeg','image/gif','image/webp','image/svg+xml','image/bmp','image/avif','image/tiff','image/heic','image/jxl','image/x-icon'],
      audio: ['audio/mpeg','audio/ogg','audio/ogg;codecs=opus','audio/wav','audio/flac','audio/aac','audio/mp4','audio/webm','audio/midi','audio/x-aiff','audio/x-m4a'],
      video: ['video/mp4','video/webm','video/ogg','video/quicktime','video/x-matroska','video/x-msvideo','video/mpeg','video/3gpp','video/x-flv'],
      text: ['text/plain','text/html','text/css','text/javascript','text/markdown','text/csv','text/xml','text/yaml','text/x-python','text/x-rust','text/x-go','text/x-solidity','text/x-sh','text/x-lua','text/x-swift','text/x-kotlin','text/x-java','text/x-ruby','text/x-php','text/x-toml'],
      application: ['application/json','application/pdf','application/wasm','application/octet-stream','application/epub+zip','application/x-sqlite3','application/zip','application/gzip','application/x-7z-compressed','application/geo+json','application/ld+json','application/pgp-signature','application/vnd.ms-excel','application/msword','application/x-chess-pgn','application/vnd.google-earth.kml+xml','application/x-shockwave-flash','chemical/x-mdl-molfile'],
      model: ['model/gltf+json','model/gltf-binary','model/stl','model/obj','model/vrml','model/vnd.usdz+zip','application/x-blender'],
      font: ['font/ttf','font/otf','font/woff','font/woff2'],
    },
    max_chunk_kb: MAX_CHUNK_BYTES / 1024,
    max_file_mb: MAX_FILE_SIZE_MB,
  });
});

// OpenAPI spec
const serveSpec = (req, res) => {
  try {
    const jsonSpec = yaml.load(fs.readFileSync(path.join(__dirname, 'openapi-spec.yaml'), 'utf8'));
    res.set('Content-Type', 'application/json').json(jsonSpec);
  } catch (e) { res.status(500).json({ error: 'Cannot serve spec' }); }
};
['openapi-spec.json', 'api/openapi-spec.json', 'swagger-spec.json'].forEach(p => app.get('/' + p, serveSpec));

app.get('/openapi-spec.yaml', (req, res) => {
  try { res.set('Content-Type', 'text/x-yaml').send(fs.readFileSync(path.join(__dirname, 'openapi-spec.yaml'), 'utf8')); }
  catch (e) { res.status(500).json({ error: 'Cannot serve spec' }); }
});

app.get('/', (req, res) => res.redirect('/swagger-ui.html'));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
if (require.main === module) app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Backend running on http://0.0.0.0:${PORT}`);
  console.log(`✓ Swagger UI: http://localhost:${PORT}/swagger-ui.html`);
  console.log(`✓ Counterparty URL: ${COUNTERPARTY_URL}`);
  console.log(`✓ Max file size: ${MAX_FILE_SIZE_MB}MB | Chunk size: ${MAX_CHUNK_BYTES / 1024}KB`);
});

module.exports = app;
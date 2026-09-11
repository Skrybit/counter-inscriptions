# Counter-Inscriptions

Mint **any MIME type** as Ordinals via the Counterparty protocol.  
Taproot inscriptions · UniSat + Xverse wallet support · Batch / airdrop minting · Auto-chunking for large files.

---

## Architecture

```
┌─────────────────────────────────────┐
│  Browser (port 3000)                │
│  React SPA — nginx-served           │
│  - UniSat / Xverse wallet connect   │
│  - Single mint + Batch/airdrop UI   │
│  - Testnet / Mainnet toggle         │
│  - File pre-flight + chunk preview  │
│  - Progress bar + TXID results      │
└──────────────┬──────────────────────┘
               │ /api/* proxied by nginx → backend:3001
┌──────────────▼──────────────────────┐
│  Backend API (port 3001)            │
│  Node.js / Express                  │
│  - POST /api/mint        (single)   │
│  - POST /api/mint-batch  (airdrop 1)│
│  - POST /api/send-batch  (airdrop 2)│
│  - POST /api/broadcast   (reveal)   │
│  - POST /api/upload      (preflight)│
│  - GET  /api/asset/:name            │
│  - GET  /api/tx/:hash               │
│  - GET  /api/balance/:addr          │
│  - GET  /api/mime-types             │
│  - GET  /api/health                 │
│  - GET  /swagger-ui.html            │
│  Max file: 50MB                     │
│  Chunk size: 350KB binary           │
└──────────────┬──────────────────────┘
               │ HTTP — service DNS: counterparty-server:4000
┌──────────────▼──────────────────────┐
│  Counterparty API (port 4000)       │
│  counterparty-core + patch_mime.py  │
│  - 100+ MIME types registered       │
│  - 50MB body limit                  │
│  - API-only mode (no Bitcoin node)  │
└─────────────────────────────────────┘
```

The nginx config inside the frontend container proxies all `/api/` traffic to `backend:3001`, so the browser only ever talks to one origin (port 3000).

---

## Repository Structure

```
.
├── backend/
│   ├── Dockerfile
│   ├── index.js                  # Express API server
│   ├── openapi-spec.yaml         # OpenAPI 3.0 spec (served at /swagger-ui.html)
│   ├── frontend-build-fallback/
│   │   └── index.html            # Minimal fallback if React build is missing
│   └── package.json
├── config/
│   ├── server.conf               # Active Counterparty config
│   └── server.conf.example       # Template — copy and edit
├── data/                         # Gitignored runtime data
│   ├── counterparty/             # counterparty.db, state.db
│   └── counterparty-cache/
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf                # Serves SPA + proxies /api/ to backend
│   ├── src/App.js                # Full React UI
│   └── package.json
├── patch_mime.py                 # Patches counterparty-core MIME registry at build time
├── entrypoint.sh                 # Counterparty startup script (api-only mode)
├── xcp-api-mime-Dockerfile       # Builds the patched Counterparty image
├── docker-compose.yml
└── Makefile
```

---

## Quick Start

### 1. Clone & configure

```bash
git clone <repo>
cd counterinscriptions
cp config/server.conf.example config/server.conf
# Edit config/server.conf as needed
```

### 2. Start all services

```bash
make          # runs docker compose up --build
# or directly:
docker compose up --build
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API + Swagger | http://localhost:3001/swagger-ui.html |
| Counterparty API | http://localhost:4000/v2/ |

### 3. Expose publicly (for mobile wallet testing)

```bash
docker compose --profile tunnel up
# URL appears in the container logs:
docker logs counterinscriptions-tunnel
```

---

## Makefile

```bash
make          # docker compose up --build
make down     # docker compose down
make clean    # delete counterparty.db and state.db from data/
make reset    # down + clean + up
```

---

## Minting Flow

### Commit + reveal (every inscription)

A Counterparty **taproot** inscription is two Bitcoin transactions. The backend asks Counterparty
to compose with `verbose=true` and returns both in a normalised `tx` object:

| Field | What it is | Who signs / broadcasts |
|-------|------------|------------------------|
| `tx.psbt` | Unsigned **commit** as a base64 PSBT | Connected wallet signs and broadcasts |
| `tx.signed_reveal_rawtransaction` | **Reveal** carrying the ord envelope, already signed by the node with an ephemeral key | Frontend posts it to `POST /api/broadcast` right after the commit |

The inscription content is not on-chain until the reveal confirms. The commit output prefunds the reveal fee,
so `tx.btc_fee` is the commit fee only.

### Who receives what

Counterparty issuance semantics, which the API follows:

- `walletAddress` (the connected wallet) is the **source**: it signs the commit, pays fees, and receives the
  issued units and the inscribed sat.
- `destinationWallet` (optional) becomes the asset **owner** via `transfer_destination`. It does not receive
  the units. To move units use `/api/send-batch`.

### Single Mint (with auto-chunking)

```
File → detect MIME → chunk(350KB) → POST /api/mint
     → per chunk: compose issuance (verbose) → sign PSBT in wallet → broadcast commit
                                              → POST /api/broadcast (reveal)
```

Files larger than **350KB binary** are split into multiple issuances. Chunk asset names must be valid
Counterparty names, so chunks use **consecutive numeric assets**: `A<n>`, `A<n+1>`, `A<n+2>` …
Named assets (`MYTOKEN`) cannot be chunked; the API returns 400 and tells you to use a numeric name.
Reassembly is handled at the application/viewer layer.

The backend checks every chunk name against `GET /v2/assets/<asset>` before composing and returns 409 if
one already exists.

### Batch Mint (airdrop) — two steps, two signatures

```
Step 1  File → POST /api/mint-batch   → ONE issuance, quantity = number of wallets
                                       → sign commit + broadcast reveal (same as single)
        …wait for the issuance to confirm…
Step 2  POST /api/send-batch           → ONE MPMA send: 1 unit to each wallet
                                       → sign PSBT in wallet ("Distribute" button in the UI)
```

File must be **≤350KB**.

---

## API Reference

Full interactive docs at `http://localhost:3001/swagger-ui.html` (spec in `backend/openapi-spec.yaml`).

### `POST /api/mint`
Single file → issuance(s) signed by the connected wallet. Accepts `multipart/form-data`.

| Field | Required | Description |
|-------|----------|-------------|
| `file` | yes | File to inscribe (max 50MB) |
| `asset` | yes | `A` + 17–20 digits (free) or 4–12 uppercase letters not starting with `A` (0.5 XCP) |
| `walletAddress` | yes | Connected wallet: signs, pays fees, receives units + inscribed sat |
| `destinationWallet` | no | Becomes asset owner (`transfer_destination`). Does not receive units |
| `mime_type` | no | Override auto-detected MIME type |
| `quantity` | no | Units to issue (default `1`) |
| `sat_per_vbyte` | no | Fee rate (default: `2.01`) |
| `encoding` | no | `taproot` (default) |

Returns `transactions[]`, one per chunk, each with `asset`, `chunk`, `total_chunks` and a `tx` bundle
(`psbt`, `rawtransaction`, `signed_reveal_rawtransaction`, `envelope_script`, `input_count`, `btc_fee`, …).

Errors: `400` invalid name / named asset needing chunks, `402` insufficient funds, `409` asset exists,
`422` unsupported MIME, `503` Counterparty unreachable.

### `POST /api/mint-batch`
Airdrop step 1. Same fields as `/api/mint` plus `destinationWallets` (comma-separated). Composes **one**
issuance with `quantity` = number of distinct wallets. Returns a single `tx` bundle. File must be ≤350KB.

### `POST /api/send-batch`
Airdrop step 2. JSON or form: `walletAddress`, `asset`, `destinationWallets` (array or comma-separated),
optional `quantity_each`, `sat_per_vbyte`. Composes one MPMA send and returns a `tx` bundle (no reveal).
Fails with 402 until the issuance has confirmed.

### `POST /api/broadcast`
`{ "signedhex": "<hex>" }` → proxies to Counterparty `sendrawtransaction`. Used for the reveal.

### `GET /api/asset/:name`
`{ valid, available, existing }` — validity per Counterparty naming rules and whether it already exists.

### `GET /api/tx/:hash`
Counterparty's record of a transaction (`result: null` until parsed).

### `POST /api/upload`
Pre-flight analysis — no minting. Returns MIME type, size, chunk count, and hex preview.

### `GET /api/balance/:address`
Proxies to Counterparty `/v2/addresses/:address/balances`.

### `GET /api/health`
Returns backend status and whether Counterparty is reachable.

### `GET /api/mime-types`
Full list of supported MIME types, max chunk size, and max file size.

---

## Wallet Signing

Both wallets sign the base64 PSBT that Counterparty returns; neither can sign a raw unsigned transaction.

### UniSat
PSBT is converted base64 → hex, signed with `signPsbt(hex, { autoFinalized: true, toSignInputs })`, and
broadcast with `pushPsbt`. The reveal goes through `POST /api/broadcast`.

### Xverse
`signPsbt` with the base64 PSBT, `signInputs: { [address]: [0..n-1] }` (n = `tx.input_count`) and
`broadcast: true`. The reveal goes through `POST /api/broadcast`.

Both wallets support Testnet/Mainnet toggle from the UI. Switching networks in the UI also switches the
active UniSat network. The backend points at a single `COUNTERPARTY_URL`; run one stack per network.

---

## Supported MIME Types

See `GET /api/mime-types` for the live list.

**Images:** `image/png` `image/jpeg` `image/gif` `image/webp` `image/svg+xml` `image/bmp` `image/avif` `image/tiff` `image/heic` `image/jxl` `image/x-icon`

**Audio:** `audio/mpeg` `audio/ogg` `audio/ogg;codecs=opus` `audio/wav` `audio/flac` `audio/aac` `audio/mp4` `audio/webm` `audio/midi` `audio/x-aiff` `audio/x-m4a`

**Video:** `video/mp4` `video/webm` `video/ogg` `video/quicktime` `video/x-matroska` `video/x-msvideo` `video/mpeg` `video/3gpp` `video/x-flv`

**Text / Code:** `text/plain` `text/html` `text/css` `text/javascript` `text/markdown` `text/csv` `text/xml` `text/yaml` `text/x-python` `text/x-rust` `text/x-go` `text/x-solidity` `text/x-sh` `text/x-lua` `text/x-swift` `text/x-kotlin` `text/x-java` `text/x-ruby` `text/x-php` `text/x-toml`

**App / Data:** `application/json` `application/pdf` `application/wasm` `application/octet-stream` `application/epub+zip` `application/x-sqlite3` `application/zip` `application/gzip` `application/x-7z-compressed` `application/geo+json` `application/ld+json` `application/pgp-signature` `application/vnd.ms-excel` `application/msword` `application/x-chess-pgn` `application/vnd.google-earth.kml+xml` `application/x-shockwave-flash` `chemical/x-mdl-molfile`

**3D / Model:** `model/gltf+json` `model/gltf-binary` `model/stl` `model/obj` `model/vrml` `model/vnd.usdz+zip` `application/x-blender`

**Fonts:** `font/ttf` `font/otf` `font/woff` `font/woff2`

---

## Asset Naming

| Type | Format | Cost |
|------|--------|------|
| Free (numeric) | `A17<timestamp><random>` | 0 XCP |
| Named | `MYTOKEN` (4–12 chars, uppercase) | 0.5 XCP |

Use the **Auto** button in the UI to generate a free numeric asset name.

---

## Local Development (no Docker)

The Counterparty server must still run in Docker. Everything else can run locally.

```bash
# Terminal 1 — Counterparty only
docker compose up counterparty-server

# Terminal 2 — Backend
cd backend
npm install
COUNTERPARTY_URL=http://localhost:4000 node index.js

# Terminal 3 — Frontend
cd frontend
npm install
REACT_APP_API_URL=http://localhost:3001/api npm start
```

---

## Configuration

### `config/server.conf`

Copy from `server.conf.example` and adjust:

```ini
network=counterinscriptions
port=4000
host=0.0.0.0
enable_all_protocol_changes=true
max_message_size=52428800   # 50MB
api_enabled=true
ordinals_enabled=true
```

### Environment variables

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| `COUNTERPARTY_URL` | backend | `http://counterparty-server:4000` | Counterparty API endpoint |
| `PORT` | backend | `3001` | Backend listen port |
| `REACT_APP_API_URL` | frontend | `http://localhost:3001/api` | API base URL seen by the browser |
| `FORCE` | counterparty | `0` | Pass `--force` to counterparty-server |
| `ENABLE_ALL_PROTOCOL_CHANGES` | counterparty | `1` | Enable MIME + taproot support |

---

## How `patch_mime.py` Works

At Docker build time, `patch_mime.py` patches the installed `counterparty-core` Python package to:

1. Register 100+ MIME types in the Counterparty MIME registry
2. Increase the API body size limit to 50MB
3. Strip MIME parameters (e.g. `audio/ogg;codecs=opus` → `audio/ogg`) where required

The patched image is built via `xcp-api-mime-Dockerfile` with the repo root as the build context, then used as the `counterparty-server` service in docker-compose.

---

## Limitations

- **Chunk reassembly** is handled at the application layer — viewers must know to combine `A<n>`, `A<n+1>`, … in order.
- **Chunked files need a numeric asset name**; named assets cannot be chunked.
- **Batch mint** requires files ≤350KB and two signatures (issuance, then MPMA send after confirmation).
- **UTXO contention**: several composes from one wallet in a row (chunks) rely on Counterparty's short-lived UTXO locks; a wallet with a single UTXO can only fund the first one until it confirms.
- **Wallet signing** requires the UniSat or Xverse browser extension.
- **Counterparty still needs a Bitcoin backend for UTXOs in api-only mode** — `config/server.conf` points `backend-connect` at a public RPC by default; run your own node for anything beyond testing.

import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

// Network-aware API bases. The unified UI is served by a Caddy that
// path-routes /m/* → the mainnet backend and /t/* → the testnet backend
// (same-origin, no CORS). The Network toggle selects which one each request
// uses, so a single UI drives both cp-servers. Overridable at build time.
const MAINNET_API = process.env.REACT_APP_MAINNET_API || '/m/api';
const TESTNET_API = process.env.REACT_APP_TESTNET_API || '/t/api';
const MAX_FILE_SIZE_MB = 50;
const MAX_CHUNK_KB = 350;

// ─── MIME type categories for display ────────────────────────────────────────
const MIME_GROUPS = {
  'Images': [
    { type: 'image/png' }, { type: 'image/jpeg' }, { type: 'image/gif' },
    { type: 'image/webp' }, { type: 'image/svg+xml' }, { type: 'image/bmp' },
    { type: 'image/avif' }, { type: 'image/tiff', new: true },
    { type: 'image/heic', new: true }, { type: 'image/jxl', new: true },
    { type: 'image/x-icon', new: true },
  ],
  'Audio': [
    { type: 'audio/mpeg' }, { type: 'audio/ogg' }, { type: 'audio/ogg;codecs=opus' },
    { type: 'audio/wav' }, { type: 'audio/flac' }, { type: 'audio/aac' },
    { type: 'audio/mp4' }, { type: 'audio/webm', new: true },
    { type: 'audio/midi', new: true }, { type: 'audio/x-aiff', new: true },
    { type: 'audio/x-m4a', new: true },
  ],
  'Video': [
    { type: 'video/mp4' }, { type: 'video/webm' }, { type: 'video/ogg' },
    { type: 'video/quicktime' }, { type: 'video/x-matroska', new: true },
    { type: 'video/x-msvideo', new: true }, { type: 'video/mpeg', new: true },
    { type: 'video/3gpp', new: true }, { type: 'video/x-flv', new: true },
  ],
  'Text / Code': [
    { type: 'text/plain' }, { type: 'text/html' }, { type: 'text/css' },
    { type: 'text/javascript' }, { type: 'text/markdown' }, { type: 'text/csv' },
    { type: 'text/xml', new: true }, { type: 'text/yaml', new: true },
    { type: 'text/x-python', new: true }, { type: 'text/x-rust', new: true },
    { type: 'text/x-go', new: true }, { type: 'text/x-solidity', new: true },
    { type: 'text/x-sh', new: true }, { type: 'text/x-lua', new: true },
    { type: 'text/x-swift', new: true }, { type: 'text/x-kotlin', new: true },
    { type: 'text/x-java', new: true }, { type: 'text/x-ruby', new: true },
    { type: 'text/x-php', new: true }, { type: 'text/x-toml', new: true },
  ],
  'App / Data': [
    { type: 'application/json' }, { type: 'application/pdf' },
    { type: 'application/wasm' }, { type: 'application/octet-stream' },
    { type: 'application/epub+zip', new: true }, { type: 'application/x-sqlite3', new: true },
    { type: 'application/zip', new: true }, { type: 'application/gzip', new: true },
    { type: 'application/x-7z-compressed', new: true },
    { type: 'application/geo+json', new: true }, { type: 'application/ld+json', new: true },
    { type: 'application/pgp-signature', new: true },
    { type: 'application/vnd.ms-excel', new: true },
    { type: 'application/msword', new: true },
    { type: 'application/x-chess-pgn', new: true },
    { type: 'application/vnd.google-earth.kml+xml', new: true },
    { type: 'application/x-shockwave-flash', new: true },
    { type: 'chemical/x-mdl-molfile', new: true },
  ],
  '3D / Model': [
    { type: 'model/gltf+json' }, { type: 'model/gltf-binary' }, { type: 'model/stl' },
    { type: 'model/obj', new: true }, { type: 'model/vrml', new: true },
    { type: 'model/vnd.usdz+zip', new: true }, { type: 'application/x-blender', new: true },
  ],
  'Fonts': [
    { type: 'font/ttf', new: true }, { type: 'font/otf', new: true },
    { type: 'font/woff', new: true }, { type: 'font/woff2', new: true },
  ],
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  root: { minHeight:'100vh', background:'#08080d', color:'#ddd', fontFamily:'system-ui,-apple-system,sans-serif', padding:'32px 16px', display:'flex', flexDirection:'column', alignItems:'center' },
  hdr: { textAlign:'center', marginBottom:'40px' },
  title: { fontSize:'2.6rem', fontWeight:200, background:'linear-gradient(135deg,#7c6fff 0%,#a855f7 100%)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', margin:0 },
  sub: { fontSize:'0.85rem', color:'#555', margin:'8px 0 0', fontFamily:'monospace', letterSpacing:'0.5px' },
  card: { background:'#101015', border:'1px solid #1e1e28', borderRadius:'16px', padding:'24px', marginBottom:'16px', maxWidth:'520px', width:'100%' },
  sec: { fontSize:'0.7rem', textTransform:'uppercase', letterSpacing:'2px', color:'#7c6fff', marginBottom:'16px', fontWeight:600 },
  row: { marginBottom:'16px' },
  lbl: { display:'block', fontSize:'0.75rem', color:'#555', marginBottom:'8px' },
  inp: { width:'100%', background:'#080810', border:'1px solid #222', borderRadius:'8px', padding:'10px 12px', color:'#ddd', fontSize:'0.9rem', outline:'none', boxSizing:'border-box' },
  btn: { background:'linear-gradient(135deg,#7c6fff,#a855f7)', color:'#fff', border:'none', padding:'13px 20px', borderRadius:'10px', fontSize:'0.95rem', cursor:'pointer', fontWeight:500, width:'100%' },
  btnSm: { background:'#1a1a25', color:'#888', border:'1px solid #222', padding:'8px 14px', borderRadius:'7px', fontSize:'0.8rem', cursor:'pointer' },
  btnTab: (active) => ({ background: active ? '#7c6fff' : '#1a1a25', color: active ? '#fff' : '#888', border:'none', padding:'9px 18px', borderRadius:'8px', fontSize:'0.85rem', cursor:'pointer', fontWeight: active ? 600 : 400 }),
  ok: { background:'#0c1a0c', border:'1px solid #1e401e', color:'#7cbc7c', borderRadius:'10px', padding:'12px', fontSize:'0.85rem', lineHeight:1.5 },
  err: { background:'#1a0c0c', border:'1px solid #4a1e1e', color:'#f87171', borderRadius:'10px', padding:'12px', fontSize:'0.85rem', lineHeight:1.5 },
  info: { background:'#0c0c1a', border:'1px solid #1e1e4a', color:'#888', borderRadius:'10px', padding:'12px', fontSize:'0.85rem', lineHeight:1.5 },
  mono: { fontFamily:'monospace', fontSize:'0.78rem', wordBreak:'break-all', color:'#666' },
  tag: { display:'inline-block', background:'#1a1a25', border:'1px solid #2a2a40', borderRadius:'5px', padding:'3px 8px', fontSize:'0.75rem', color:'#888', marginRight:'4px', marginBottom:'4px' },
  net: (active) => ({ background: active ? '#1a2a1a' : '#1a1a25', border: `1px solid ${active ? '#2a4a2a' : '#222'}`, color: active ? '#7cbc7c' : '#888', padding:'7px 14px', borderRadius:'7px', fontSize:'0.8rem', cursor:'pointer' }),
  progress: { background:'#1a1a25', borderRadius:'8px', height:'6px', overflow:'hidden', marginTop:'8px' },
  progressFill: (pct) => ({ height:'100%', width:`${pct}%`, background:'linear-gradient(90deg,#7c6fff,#a855f7)', borderRadius:'8px', transition:'width 0.3s' }),
  divider: { border:'none', borderTop:'1px solid #1e1e28', margin:'16px 0' },
  mimeGrid: { display:'flex', flexWrap:'wrap', gap:'4px', marginTop:'8px' },
  link: { color:'#7c6fff', textDecoration:'none' },
  footer: { marginTop:'32px', textAlign:'center', fontSize:'0.75rem', color:'#333' },
};

// ─── Wallet helpers ───────────────────────────────────────────────────────────
//
// A Counterparty taproot inscription is TWO transactions:
//   commit — returned as a PSBT; the connected wallet signs and broadcasts it
//   reveal — already signed by the Counterparty node (ephemeral key); we broadcast it
//            through the backend right after the commit. Without it nothing is inscribed.

function b64ToHex(b64) {
  const bin = atob(b64);
  let hex = '';
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return hex;
}

async function broadcastViaBackend(apiUrl, signedhex) {
  const r = await axios.post(`${apiUrl}/broadcast`, { signedhex });
  return r.data?.txid;
}

/** Sign `tx.psbt` (base64, from Counterparty verbose compose) with the wallet and broadcast. */
async function signAndBroadcastCommit(wallet, tx) {
  if (!tx?.psbt) throw new Error('Backend did not return a PSBT for this transaction');
  const inputIdx = Array.from({ length: tx.input_count || 1 }, (_, i) => i);

  if (wallet.type === 'UniSat') {
    const signedHex = await window.unisat.signPsbt(b64ToHex(tx.psbt), {
      autoFinalized: true,
      toSignInputs: inputIdx.map(index => ({ index, address: wallet.address })),
    });
    const txid = await window.unisat.pushPsbt(signedHex);
    return { txid, method: 'unisat.signPsbt+pushPsbt' };
  }
  if (wallet.type === 'Xverse') {
    const resp = await window.BitcoinProvider.request('signPsbt', {
      psbt: tx.psbt,
      signInputs: { [wallet.address]: inputIdx },
      broadcast: true,
    });
    const txid = resp?.result?.txid || resp?.txid;
    if (!txid) throw new Error('Xverse did not return a txid (request rejected?)');
    return { txid, method: 'xverse.signPsbt' };
  }
  throw new Error('No supported wallet connected');
}

/** Commit via wallet, then reveal via backend. */
async function signAndBroadcastInscription(apiUrl, wallet, tx) {
  const commit = await signAndBroadcastCommit(wallet, tx);
  let revealTxid = null;
  if (tx.signed_reveal_rawtransaction) {
    revealTxid = await broadcastViaBackend(apiUrl, tx.signed_reveal_rawtransaction);
  }
  return { ...commit, revealTxid };
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [wallet, setWallet] = useState(null);         // { address, type }
  const [network, setNetwork] = useState('mainnet');  // mainnet | testnet
  const [file, setFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);     // { name, mime, sizeKB, chunks }
  const [asset, setAsset] = useState('');
  const [mode, setMode] = useState('single');         // single | batch
  const [destWallet, setDestWallet] = useState('');
  const [batchWallets, setBatchWallets] = useState('');
  const [feeRate, setFeeRate] = useState(2.01);
  const [status, setStatus] = useState(null);         // { type: ok|err|info, msg }
  const [txResults, setTxResults] = useState([]);
  const [minting, setMinting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showMimes, setShowMimes] = useState(false);
  const [health, setHealth] = useState(null);
  const [batchDrop, setBatchDrop] = useState(null); // { asset, wallets } after a batch issuance is broadcast
  const [distributing, setDistributing] = useState(false);

  // API base follows the Network toggle → the unified UI drives both backends.
  const API_URL = network === 'testnet' ? TESTNET_API : MAINNET_API;

  // Health check on mount and whenever the network changes.
  useEffect(() => {
    axios.get(`${API_URL}/health`).then(r => setHealth(r.data)).catch(() => setHealth({ status: 'degraded' }));
  }, [API_URL]);

  const connectWallet = async () => {
    setStatus({ type: 'info', msg: 'Connecting wallet...' });
    try {
      if (window.unisat) {
        if (network === 'testnet') await window.unisat.switchNetwork('testnet');
        const accounts = await window.unisat.requestAccounts();
        setWallet({ address: accounts[0], type: 'UniSat' });
        setStatus({ type: 'ok', msg: `UniSat connected` });
      } else if (window.BitcoinProvider) {
        const resp = await window.BitcoinProvider.request('getAccounts', {
          purposes: ['ordinals', 'payment'],
        });
        const addr = resp.find(a => a.purpose === 'ordinals')?.address || resp[0]?.address;
        setWallet({ address: addr, type: 'Xverse' });
        setStatus({ type: 'ok', msg: `Xverse connected` });
      } else {
        alert('Please install UniSat or Xverse wallet extension.');
      }
    } catch (e) {
      setStatus({ type: 'err', msg: 'Connection failed: ' + e.message });
    }
  };

  const onFileChange = useCallback(async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      setStatus({ type: 'err', msg: `File too large (${(f.size/1048576).toFixed(1)}MB > ${MAX_FILE_SIZE_MB}MB max)` });
      return;
    }
    setFile(f);
    // Pre-flight upload to get MIME + chunk analysis
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await axios.post(`${API_URL}/upload`, fd);
      setFileInfo(r.data);
      if (r.data.needsChunking) {
        setStatus({ type: 'info', msg: `File will be split into ${r.data.totalChunks} chunks (${r.data.totalChunks} separate Counterparty issuances). Asset names: ${asset || 'ASSET'}_1 … _${r.data.totalChunks}` });
      } else {
        setStatus({ type: 'ok', msg: `Ready: ${r.data.mimeType} · ${r.data.sizeKB}KB` });
      }
    } catch {
      // Fallback: just use browser mime
      const mimeBase = f.type.split(';')[0].trim();
      const sizeKB = (f.size / 1024).toFixed(1);
      const chunks = Math.ceil(f.size / (MAX_CHUNK_KB * 1024));
      setFileInfo({ mimeType: mimeBase, sizeKB, totalChunks: chunks, needsChunking: chunks > 1, originalName: f.name });
      setStatus({ type: 'ok', msg: `File loaded: ${mimeBase} · ${sizeKB}KB` });
    }
  }, [asset]);

  const genAsset = () => {
    // Counterparty numeric assets must be A + 18-19 digit number
    // Valid range: A1000000000000000000 to A9999999999999999999 (19 digits)
    const hi = BigInt('9999999999999999999');
    const lo = BigInt('1000000000000000000');
    const range = hi - lo;
    const rand = lo + BigInt(Math.floor(Math.random() * Number(range)));
    setAsset(`A${rand.toString()}`);
  };

  const mint = async () => {
    if (!file || !asset) return setStatus({ type: 'err', msg: 'Select a file and set an asset name' });
    if (!wallet) return setStatus({ type: 'err', msg: 'Connect a wallet first' });
    if (mode === 'batch' && !batchWallets.trim()) return setStatus({ type: 'err', msg: 'Enter destination wallet addresses for batch mint' });

    setMinting(true);
    setProgress(10);
    setTxResults([]);
    setBatchDrop(null);
    setStatus({ type: 'info', msg: 'Building inscription payload...' });

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('asset', asset);
      fd.append('walletAddress', wallet.address);
      fd.append('sat_per_vbyte', String(feeRate));
      fd.append('encoding', 'taproot');

      if (mode === 'single') {
        fd.append('destinationWallet', destWallet.trim() || wallet.address);
      }

      const endpoint = mode === 'batch' ? `${API_URL}/mint-batch` : `${API_URL}/mint`;
      if (mode === 'batch') fd.append('destinationWallets', batchWallets);

      setProgress(30);
      setStatus({ type: 'info', msg: 'Sending to Counterparty server...' });

      const resp = await axios.post(endpoint, fd, {
        timeout: 300_000,
        onUploadProgress: (e) => {
          if (e.total) setProgress(30 + Math.round((e.loaded / e.total) * 40));
        },
      });

      setProgress(75);
      const data = resp.data;

      if (mode === 'single') {
        // Sign each chunk: commit in wallet, reveal via backend
        const signed = [];
        for (let i = 0; i < data.transactions.length; i++) {
          const item = data.transactions[i];
          setStatus({ type: 'info', msg: `Signing chunk ${i + 1}/${data.transactions.length} in wallet...` });
          setProgress(75 + Math.round((i / data.transactions.length) * 20));

          let broadcastResult;
          try {
            broadcastResult = await signAndBroadcastInscription(API_URL, wallet, item.tx);
          } catch (sigErr) {
            broadcastResult = { error: sigErr.message };
          }

          signed.push({
            asset: item.asset,
            chunk: item.chunk,
            total: item.total_chunks,
            fee: item.tx?.btc_fee,
            ...broadcastResult,
            rawTx: item.tx?.rawtransaction,
          });
        }

        setTxResults(signed);
        const ok = signed.filter(s => !s.error).length;
        const ownerNote = data.owner && data.owner !== data.signer ? ` · ${data.owner} is the asset owner; units stay with your wallet (use Distribute/send to move them)` : '';
        setStatus({ type: ok === signed.length ? 'ok' : 'err', msg: `${ok}/${signed.length} chunk(s) committed & revealed${data.total_chunks > 1 ? ` (${data.total_chunks}-chunk inscription)` : ''}${ownerNote}` });

      } else {
        // Batch: ONE issuance of quantity = wallet count, then distribute after confirmation
        setStatus({ type: 'info', msg: `Signing issuance of ${data.quantity} × ${data.asset} in wallet...` });
        let broadcastResult;
        try {
          broadcastResult = await signAndBroadcastInscription(API_URL, wallet, data.tx);
        } catch (sigErr) {
          broadcastResult = { error: sigErr.message };
        }
        setTxResults([{ asset: data.asset, fee: data.tx?.btc_fee, ...broadcastResult, rawTx: data.tx?.rawtransaction }]);
        if (!broadcastResult.error) {
          setBatchDrop({ asset: data.asset, wallets: data.destinations });
          setStatus({ type: 'ok', msg: `Issuance broadcast. Once it confirms, click "Distribute" to airdrop 1 × ${data.asset} to ${data.destinations.length} wallets in one transaction.` });
        } else {
          setStatus({ type: 'err', msg: `Issuance failed: ${broadcastResult.error}` });
        }
      }

      setProgress(100);
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data || err.message;
      setStatus({ type: 'err', msg: `Mint failed: ${typeof msg === 'object' ? JSON.stringify(msg) : msg}` });
    } finally {
      setMinting(false);
    }
  };

  const distribute = async () => {
    if (!batchDrop || !wallet) return;
    setDistributing(true);
    setStatus({ type: 'info', msg: `Composing MPMA send of ${batchDrop.asset} to ${batchDrop.wallets.length} wallets...` });
    try {
      const r = await axios.post(`${API_URL}/send-batch`, {
        walletAddress: wallet.address,
        asset: batchDrop.asset,
        destinationWallets: batchDrop.wallets,
        sat_per_vbyte: feeRate,
      });
      setStatus({ type: 'info', msg: 'Signing MPMA send in wallet...' });
      const result = await signAndBroadcastCommit(wallet, r.data.tx);
      setTxResults(prev => [...prev, { asset: `${batchDrop.asset} → ${batchDrop.wallets.length} wallets (MPMA)`, fee: r.data.tx?.btc_fee, ...result, rawTx: r.data.tx?.rawtransaction }]);
      setStatus({ type: 'ok', msg: `Airdrop broadcast: ${result.txid}` });
      setBatchDrop(null);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      const hint = /insufficient|no such asset|not found/i.test(String(msg)) ? ' — the issuance probably has not confirmed yet; wait for a block and retry.' : '';
      setStatus({ type: 'err', msg: `Distribute failed: ${typeof msg === 'object' ? JSON.stringify(msg) : msg}${hint}` });
    } finally {
      setDistributing(false);
    }
  };

  const shortAddr = (a) => a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '';

  return (
    <div style={S.root}>
      <header style={S.hdr}>
        <h1 style={S.title}>Counter-Inscriptions</h1>
        <p style={S.sub}>Mint any MIME type as Ordinals via Counterparty · Taproot</p>
        {health && (
          <div style={{ marginTop: '8px', fontSize: '0.75rem', color: health.status === 'ok' ? '#4a8a4a' : '#8a4a4a' }}>
            ● XCP Server: {health.status === 'ok' ? 'Connected' : 'Unreachable'}
            {health.version ? ` v${health.version}` : ''}
          </div>
        )}
      </header>

      {/* Network Toggle */}
      <div style={{ ...S.card, padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.8rem', color: '#555' }}>Network:</span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button style={S.net(network === 'mainnet')} onClick={() => setNetwork('mainnet')}>⬤ Mainnet</button>
            <button style={S.net(network === 'testnet')} onClick={() => setNetwork('testnet')}>⬤ Testnet</button>
          </div>
        </div>
      </div>

      {/* Wallet Card */}
      <div style={S.card}>
        <div style={S.sec}>Bitcoin Wallet</div>
        {!wallet ? (
          <button style={S.btn} onClick={connectWallet}>Connect UniSat / Xverse</button>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: '0.8rem', color: '#7c6fff' }}>{wallet.type}</span>
              <span style={{ ...S.mono, marginLeft: '8px' }}>{shortAddr(wallet.address)}</span>
            </div>
            <button style={S.btnSm} onClick={() => setWallet(null)}>Disconnect</button>
          </div>
        )}
      </div>

      {/* Mint Config */}
      {wallet && (
        <div style={S.card}>
          <div style={S.sec}>Mint Configuration</div>

          {/* Asset Name */}
          <div style={S.row}>
            <label style={S.lbl}>Asset Name <span style={{ color: '#444' }}>(A… = free, named = 0.5 XCP)</span></label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input style={{ ...S.inp, flex: 1 }} value={asset} onChange={e => setAsset(e.target.value.toUpperCase())} placeholder="A96123456789 or MYASSET" />
              <button style={S.btnSm} onClick={genAsset}>Auto</button>
            </div>
          </div>

          {/* Mode Tabs */}
          <div style={{ ...S.row, display: 'flex', gap: '6px' }}>
            <button style={S.btnTab(mode === 'single')} onClick={() => setMode('single')}>Single Mint</button>
            <button style={S.btnTab(mode === 'batch')} onClick={() => setMode('batch')}>Batch / Airdrop</button>
          </div>

          {/* Destination Wallet (single) */}
          {mode === 'single' && (
            <div style={S.row}>
              <label style={S.lbl}>Mint To (leave blank = connected wallet)</label>
              <input style={S.inp} value={destWallet} onChange={e => setDestWallet(e.target.value)} placeholder={`bc1p… or empty to use ${shortAddr(wallet.address)}`} />
            </div>
          )}

          {/* Batch Wallets */}
          {mode === 'batch' && (
            <div style={S.row}>
              <label style={S.lbl}>Destination Wallets (comma-separated, max 350KB file for batch)</label>
              <textarea
                style={{ ...S.inp, minHeight: '80px', resize: 'vertical' }}
                value={batchWallets}
                onChange={e => setBatchWallets(e.target.value)}
                placeholder="bc1paddr1,bc1paddr2,bc1paddr3"
              />
              <span style={{ fontSize: '0.75rem', color: '#444' }}>
                {batchWallets ? batchWallets.split(',').filter(Boolean).length : 0} addresses
              </span>
            </div>
          )}

          {/* Fee Rate */}
          <div style={S.row}>
            <label style={S.lbl}>Fee Rate: {feeRate} sat/vbyte</label>
            <input type="range" min="1" max="50" step="0.5" value={feeRate}
              onChange={e => setFeeRate(parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: '#7c6fff' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#444' }}>
              <span>Economy</span><span>Standard</span><span>Fast</span>
            </div>
          </div>

          <hr style={S.divider} />

          {/* File Upload */}
          <div style={S.row}>
            <label style={S.lbl}>Upload File (any MIME type — max {MAX_FILE_SIZE_MB}MB)</label>
            <input type="file" onChange={onFileChange} style={{ color: '#888', fontSize: '0.85rem', width: '100%' }} accept="*/*" />
          </div>

          {/* File Info */}
          {fileInfo && (
            <div style={{ ...S.info, marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={S.mono}>{fileInfo.originalName}</span>
                <span style={{ ...S.mono, color: '#7c6fff' }}>{fileInfo.mimeType}</span>
              </div>
              <div style={{ display: 'flex', gap: '12px', fontSize: '0.78rem', color: '#555' }}>
                <span>{fileInfo.sizeKB} KB</span>
                {fileInfo.needsChunking && <span style={{ color: '#a855f7' }}>⚡ {fileInfo.totalChunks} chunks</span>}
              </div>
            </div>
          )}

          {/* MIME Types reference */}
          <div>
            <button style={{ ...S.btnSm, marginBottom: '8px' }} onClick={() => setShowMimes(!showMimes)}>
              {showMimes ? '▲' : '▼'} Supported MIME types
            </button>
            {showMimes && (
              <div style={{ fontSize: '0.75rem' }}>
                {Object.entries(MIME_GROUPS).map(([group, types]) => (
                  <div key={group} style={{ marginBottom: '8px' }}>
                    <div style={{ color: '#7c6fff', marginBottom: '4px', fontWeight: 600 }}>{group}</div>
                    <div style={S.mimeGrid}>
                      {types.map(t => (
                        <span key={t.type} style={{
                          ...S.tag,
                          borderColor: t.new ? '#a855f7' : '#2a2a40',
                          color: t.new ? '#c084fc' : '#888',
                        }}>
                          {t.type}
                          {t.new && <span style={{ marginLeft: '4px', fontSize: '0.65rem', color: '#a855f7', fontWeight: 700 }}>NEW</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <hr style={S.divider} />

          {/* Mint Button */}
          <button
            style={{ ...S.btn, opacity: (!file || !asset || minting) ? 0.5 : 1, cursor: (!file || !asset || minting) ? 'not-allowed' : 'pointer' }}
            onClick={mint}
            disabled={!file || !asset || minting}
          >
            {minting ? 'Minting...' : mode === 'batch' ? `Batch Mint (${batchWallets.split(',').filter(Boolean).length} wallets)` : 'Mint Inscription'}
          </button>

          {/* Progress */}
          {minting && (
            <div style={S.progress}>
              <div style={S.progressFill(progress)} />
            </div>
          )}
        </div>
      )}

      {/* Status */}
      {status && (
        <div style={S.card}>
          <div style={S.sec}>Status</div>
          <div style={status.type === 'ok' ? S.ok : status.type === 'err' ? S.err : S.info}>
            {status.msg}
          </div>
        </div>
      )}

      {/* Transaction Results */}
      {txResults.length > 0 && (
        <div style={S.card}>
          <div style={S.sec}>Transactions</div>
          {txResults.map((tx, i) => (
            <div key={i} style={{ ...S.info, marginBottom: '8px' }}>
              {tx.asset && <div style={{ color: '#7c6fff', fontSize: '0.8rem', marginBottom: '4px' }}>
                {tx.asset} {tx.total > 1 ? `(chunk ${tx.chunk}/${tx.total})` : ''}
              </div>}
              {tx.txid && !tx.error && (
                <div>
                  <span style={{ ...S.mono, color: '#7cbc7c' }}>✓ TXID: </span>
                  <a href={`https://mempool.space/tx/${tx.txid}`} target="_blank" rel="noopener noreferrer" style={S.link}>
                    <span style={S.mono}>{tx.txid.slice(0, 20)}…</span>
                  </a>
                  <span style={{ fontSize: '0.7rem', color: '#444', marginLeft: '8px' }}>via {tx.method}</span>
                  {tx.revealTxid && (
                    <div>
                      <span style={{ ...S.mono, color: '#7cbc7c' }}>✓ REVEAL: </span>
                      <a href={`https://mempool.space/tx/${tx.revealTxid}`} target="_blank" rel="noopener noreferrer" style={S.link}>
                        <span style={S.mono}>{tx.revealTxid.slice(0, 20)}…</span>
                      </a>
                    </div>
                  )}
                  {tx.fee != null && <span style={{ fontSize: '0.7rem', color: '#444', marginLeft: '8px' }}>commit fee {tx.fee} sat</span>}
                </div>
              )}
              {tx.error && <div style={{ color: '#f87171', fontSize: '0.8rem' }}>✗ {tx.error}</div>}
              {tx.rawTx && (
                <details style={{ marginTop: '6px' }}>
                  <summary style={{ fontSize: '0.75rem', color: '#444', cursor: 'pointer' }}>Raw TX</summary>
                  <div style={{ ...S.mono, marginTop: '4px', maxHeight: '80px', overflow: 'auto', background: '#080810', padding: '6px', borderRadius: '6px' }}>
                    {typeof tx.rawTx === 'string' ? tx.rawTx.slice(0, 200) + '…' : JSON.stringify(tx.rawTx).slice(0, 200)}
                  </div>
                </details>
              )}
            </div>
          ))}
          {batchDrop && (
            <div style={{ marginTop: '8px' }}>
              <button style={S.btn} onClick={distribute} disabled={distributing}>
                {distributing ? 'Distributing…' : `Distribute ${batchDrop.asset} to ${batchDrop.wallets.length} wallets`}
              </button>
              <div style={{ fontSize: '0.72rem', color: '#555', marginTop: '4px' }}>
                Wait for the issuance to confirm first — one MPMA send, one signature.
              </div>
            </div>
          )}
        </div>
      )}

      <footer style={S.footer}>
        Counter-Inscriptions · Counterparty + Taproot · All MIME types supported
      </footer>
    </div>
  );
}
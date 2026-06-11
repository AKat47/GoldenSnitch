// api/data.js — Fetch 400 days of daily OHLC
// Source priority: Angel One SmartAPI → Yahoo Finance (15-min delay fallback)
// GET /api/data?symbol=RELIANCE[&angelKey=...&angelClient=...]
//
// Angel One env vars (set in Vercel): ANGEL_PASSWORD, ANGEL_TOTP_SECRET
// Angel One query params (from browser): angelKey, angelClient

const https  = require('https');
const crypto = require('crypto');

// ── HTTP helpers ───────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── TOTP generator (matches Python pyotp exactly) ──────────
function b32decode(secret) {
  // 1. Clean: strip spaces, uppercase, strip trailing =
  let s = secret.trim().toUpperCase().replace(/=+$/, '');
  const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s) {
    const v = base32.indexOf(c);
    if (v < 0) continue; // skip non-base32 chars
    bits += v.toString(2).padStart(5, '0');
  }
  // 2. Pack bits into bytes (discard incomplete last byte, same as Python)
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac   = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16
                | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

function totp(secret) {
  const key     = b32decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  // Return current window code (Angel One accepts ±1 window on their side)
  return totpCode(key, counter);
}

// ── Angel One auth (with ±1 TOTP window retry) ─────────────
async function angelAuth(apiKey, clientId) {
  const password   = process.env.ANGEL_PASSWORD;
  const totpSecret = process.env.ANGEL_TOTP_SECRET;
  if (!password)   throw new Error('ANGEL_PASSWORD env var is not set in Vercel');
  if (!totpSecret) throw new Error('ANGEL_TOTP_SECRET env var is not set in Vercel');

  const headers = {
    'X-UserType':       'USER',
    'X-SourceID':       'WEB',
    'X-ClientLocalIP':  '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress':     '00:00:00:00:00:00',
    'X-PrivateKey':     apiKey
  };

  const key     = b32decode(totpSecret);
  const counter = Math.floor(Date.now() / 1000 / 30);

  // Try current window, then +1, then -1 (handles ±30s server clock drift)
  let lastBody;
  for (const delta of [0, 1, -1]) {
    const otp  = totpCode(key, counter + delta);
    const body = await httpsPost('apiconnect.angelbroking.com',
      '/rest/auth/angelbroking/user/v1/loginByPassword',
      { clientcode: clientId, password, totp: otp },
      headers
    );
    lastBody = body;
    if (body?.data?.jwtToken) return body.data.jwtToken;
    // If error is NOT totp-related, no point retrying
    const msg = (body?.message || body?.errorcode || '').toLowerCase();
    if (!msg.includes('totp') && !msg.includes('otp')) break;
  }

  // Surface the full Angel One response so the error modal shows it clearly
  const errMsg  = lastBody?.message  || 'Login failed';
  const errCode = lastBody?.errorcode || '';
  const rawJson = JSON.stringify(lastBody, null, 2);
  throw new Error(`${errMsg}${errCode ? ' ('+errCode+')' : ''}\n\nFull response from Angel One:\n${rawJson}`);
}

// ── Angel One instruments master (token lookup) ─────────────
// Cached in memory — fetched once per serverless warm instance
let _angelTokenMap = null;

async function loadAngelTokenMap() {
  if (_angelTokenMap) return _angelTokenMap;

  // Angel One publishes a complete NSE instruments file
  const url = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
  const data = await new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve([]); } });
    });
    req.on('error', reject);
    req.end();
  });

  // Build NSE symbol → token map
  // Instrument entries look like: { token:"2885", symbol:"RELIANCE-EQ", exch_seg:"NSE", ... }
  const map = {};
  for (const inst of data) {
    if (inst.exch_seg !== 'NSE') continue;
    // symbol is like "RELIANCE-EQ" — strip the "-EQ" suffix to get the plain ticker
    const ticker = (inst.symbol || '').replace(/-EQ$/i, '').trim().toUpperCase();
    if (ticker && inst.token) map[ticker] = inst.token;
    // Also store the full symbol name (e.g. "RELIANCE-EQ") as a key
    const full = (inst.symbol || '').trim().toUpperCase();
    if (full && inst.token) map[full] = inst.token;
  }
  _angelTokenMap = map;
  return map;
}

async function getAngelToken(sym) {
  const map = await loadAngelTokenMap();
  // Try plain symbol first, then with -EQ suffix
  return map[sym.toUpperCase()]
      || map[sym.toUpperCase() + '-EQ']
      || null;
}

// ── Angel One historical data ──────────────────────────────
async function fetchAngelCandles(sym, apiKey, clientId) {
  const jwt = await angelAuth(apiKey, clientId);

  // Look up instrument token from Angel One's master file
  // Angel One symbol format: "RELIANCE-EQ", token: "2885"
  const token = await getAngelToken(sym);
  if (!token) throw new Error(`Symbol ${sym} not found in Angel One instruments. Try the exact NSE ticker (e.g. RELIANCE, not RELIANCE.NS).`);

  const to   = new Date();
  const from = new Date(Date.now() - 400 * 86400000);
  const fmt  = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 09:00`;

  const hist = await httpsPost('apiconnect.angelbroking.com', '/rest/secure/angelbroking/historical/v1/getCandleData', {
    exchange: 'NSE',
    symboltoken: token,
    interval: 'ONE_DAY',
    fromdate: fmt(from),
    todate:   fmt(to)
  }, {
    'Authorization': `Bearer ${jwt}`,
    'X-PrivateKey': apiKey,
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00'
  });

  const raw = hist?.data || [];
  if (!raw.length) throw new Error('No candle data from Angel One');

  // Angel format: [timestamp, open, high, low, close, volume]
  const candles = raw.map(r => ({
    date:  r[0].split('T')[0],
    open:  r[1], high: r[2], low: r[3], close: r[4]
  })).filter(c => c.close != null);

  return { candles, source: 'angel' };
}

// ── Yahoo Finance fallback ─────────────────────────────────
async function fetchYahooCandles(sym) {
  const ticker = sym.includes('.') ? sym : sym + '.NS';
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 400 * 86400;
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${from}&period2=${to}&interval=1d&events=history`;

  const json = await httpsGet(url);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('Symbol not found on Yahoo Finance');

  const ts    = result.timestamp || [];
  const q     = result.indicators?.quote?.[0] || {};
  const meta  = result.meta || {};

  const candles = ts.map((t, i) => ({
    date:  new Date(t * 1000).toISOString().split('T')[0],
    open:  q.open?.[i], high: q.high?.[i],
    low:   q.low?.[i],  close: q.close?.[i]
  })).filter(c => c.close != null && c.open != null);

  return {
    candles,
    source: 'yahoo',
    name: meta.longName || meta.shortName || sym
  };
}

// ── Main handler ───────────────────────────────────────────
// Accepts GET /api/data?symbol=X (Yahoo only)
// or POST /api/data { symbol, angelKey, angelClient } (Angel One + Yahoo fallback)
// Credentials MUST come via POST body — never URL params (they get logged by servers/CDN)
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Support both GET (symbol in query, no creds) and POST (all in body)
  const body        = req.method === 'POST'
    ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {})
    : {};

  const sym         = ((body.symbol      || req.query.symbol      || '')).toUpperCase().trim();
  const angelKey    = (body.angelKey     || '').trim();   // POST body only — never query param
  const angelClient = (body.angelClient  || '').trim();   // POST body only — never query param

  if (!sym) return res.status(400).json({ ok: false, error: 'symbol required' });

  // Try Angel One first if credentials provided
  if (angelKey && angelClient) {
    try {
      const { candles, source } = await fetchAngelCandles(sym, angelKey, angelClient);
      return res.status(200).json({ ok: true, symbol: sym, candles, source });
    } catch (e) {
      // Return the Angel error explicitly so the browser can show it
      // Include yahoo fallback data so the chart still works
      try {
        const { candles, name } = await fetchYahooCandles(sym);
        return res.status(200).json({
          ok: true, symbol: sym, name, candles,
          source: 'yahoo',
          angelError: e.message   // ← surfaced to browser
        });
      } catch (ye) {
        return res.status(200).json({ ok: false, error: e.message + ' | Yahoo also failed: ' + ye.message });
      }
    }
  }

  // Yahoo Finance only (no Angel credentials)
  try {
    const { candles, source, name } = await fetchYahooCandles(sym);
    return res.status(200).json({ ok: true, symbol: sym, name, candles, source });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

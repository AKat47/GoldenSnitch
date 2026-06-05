// api/_angel.js — Shared Angel One SmartAPI helpers
// Used by intraday-universe, intraday-scan, intraday-backtest

const https  = require('https');
const crypto = require('crypto');

// ── HTTP ──────────────────────────────────────────────────
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
    req.write(payload); req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject); req.end();
  });
}

// ── TOTP ──────────────────────────────────────────────────
function b32decode(secret) {
  const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.trim().toUpperCase().replace(/=+$/, '')) {
    const v = b32.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i+8), 2));
  return Buffer.from(bytes);
}

function totpCode(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac   = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

// ── Auth (cached JWT per warm instance) ───────────────────
let _jwtCache = null;
let _jwtExpiry = 0;

async function authenticate(apiKey, clientId) {
  const now = Date.now();
  if (_jwtCache && now < _jwtExpiry) return _jwtCache;

  const password   = process.env.ANGEL_PASSWORD;
  const totpSecret = process.env.ANGEL_TOTP_SECRET;
  if (!password || !totpSecret) throw new Error('ANGEL_PASSWORD / ANGEL_TOTP_SECRET env vars not set');

  const key     = b32decode(totpSecret);
  const counter = Math.floor(now / 1000 / 30);
  const headers = {
    'X-UserType': 'USER', 'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': apiKey
  };

  for (const delta of [0, 1, -1]) {
    const otp  = totpCode(key, counter + delta);
    const body = await httpsPost('apiconnect.angelbroking.com',
      '/rest/auth/angelbroking/user/v1/loginByPassword',
      { clientcode: clientId, password, totp: otp }, headers);
    if (body?.data?.jwtToken) {
      _jwtCache  = body.data.jwtToken;
      _jwtExpiry = now + 55 * 60 * 1000; // cache ~55 min
      return _jwtCache;
    }
  }
  throw new Error('Angel One auth failed');
}

// ── Token map (symbol → instrument token) ────────────────
let _tokenMap = null;

async function getTokenMap() {
  if (_tokenMap) return _tokenMap;
  const data = await httpsGet('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json');
  if (!Array.isArray(data)) return {};
  const map = {};
  for (const inst of data) {
    if (inst.exch_seg !== 'NSE') continue;
    const ticker = (inst.symbol || '').replace(/-EQ$/i, '').trim().toUpperCase();
    const full   = (inst.symbol || '').trim().toUpperCase();
    if (ticker && inst.token) map[ticker] = inst.token;
    if (full   && inst.token) map[full]   = inst.token;
  }
  _tokenMap = map;
  return _tokenMap;
}

// ── Angel candle fetch (any interval) ────────────────────
// interval: 'ONE_DAY' | 'FIVE_MINUTE' | 'ONE_MINUTE' etc.
async function fetchCandles(sym, interval, fromdate, todate, jwt, apiKey) {
  const tokenMap = await getTokenMap();
  const token    = tokenMap[sym.toUpperCase()] || tokenMap[sym.toUpperCase() + '-EQ'];
  if (!token) throw new Error(`Token not found for ${sym}`);

  const headers = {
    'Authorization': `Bearer ${jwt}`,
    'X-PrivateKey': apiKey,
    'X-UserType': 'USER', 'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00'
  };

  const resp = await httpsPost('apiconnect.angelbroking.com',
    '/rest/secure/angelbroking/historical/v1/getCandleData',
    { exchange: 'NSE', symboltoken: token, interval, fromdate, todate },
    headers);

  // resp.data: [[timestamp, open, high, low, close, volume], ...]
  return (resp?.data || []).filter(r => r[4] != null);
}

// ── IST date helpers ──────────────────────────────────────
function istStr(date, timeStr = '09:15') {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d} ${timeStr}`;
}
function istNowStr() {
  const ist = new Date(Date.now() + 5.5*60*60*1000);
  const h   = String(ist.getUTCHours()).padStart(2, '0');
  const mi  = String(ist.getUTCMinutes()).padStart(2, '0');
  const y   = ist.getUTCFullYear();
  const mo  = String(ist.getUTCMonth()+1).padStart(2, '0');
  const d   = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${mi}`;
}
function daysAgoIST(n) {
  return new Date(Date.now() + 5.5*60*60*1000 - n*86400000);
}

module.exports = { authenticate, getTokenMap, fetchCandles, istStr, istNowStr, daysAgoIST };

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

// ── TOTP generator ─────────────────────────────────────────
function totp(secret) {
  const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const v = base32.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key    = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac  = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

// ── Angel One auth ─────────────────────────────────────────
async function angelAuth(apiKey, clientId) {
  const password = process.env.ANGEL_PASSWORD;
  const totpSecret = process.env.ANGEL_TOTP_SECRET;
  if (!password || !totpSecret) throw new Error('ANGEL_PASSWORD / ANGEL_TOTP_SECRET env vars not set');

  // clientId can be mobile number (e.g. 9876543210) or Angel One client ID (e.g. A123456)
  const body = await httpsPost('apiconnect.angelbroking.com', '/rest/auth/angelbroking/user/v1/loginByPassword', {
    clientcode: clientId,
    password,                          // Angel One PIN
    totp: totp(totpSecret)
  }, {
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey
  });

  if (!body?.data?.jwtToken) throw new Error(body?.message || 'Angel login failed');
  return body.data.jwtToken;
}

// ── Angel One historical data ──────────────────────────────
async function fetchAngelCandles(sym, apiKey, clientId) {
  const jwt = await angelAuth(apiKey, clientId);

  // Angel One uses numeric instrument tokens — map common NSE symbols
  // Use the smart-search endpoint to get token
  const searchRes = await httpsPost('apiconnect.angelbroking.com', '/rest/secure/angelbroking/order/v1/searchScrip', {
    exchange: 'NSE', searchscrip: sym
  }, {
    'Authorization': `Bearer ${jwt}`,
    'X-PrivateKey': apiKey,
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00'
  });

  const scrip = searchRes?.data?.find(s => s.tradingsymbol === sym && s.instrumenttype === 'AMXIDX' || s.tradingsymbol === sym);
  if (!scrip) throw new Error(`Token not found for ${sym}`);

  const to   = new Date();
  const from = new Date(Date.now() - 400 * 86400000);
  const fmt  = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 09:00`;

  const hist = await httpsPost('apiconnect.angelbroking.com', '/rest/secure/angelbroking/historical/v1/getCandleData', {
    exchange: 'NSE',
    symboltoken: scrip.symboltoken,
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
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sym        = (req.query.symbol      || '').toUpperCase().trim();
  const angelKey   = (req.query.angelKey    || '').trim();
  const angelClient= (req.query.angelClient || '').trim();

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

// api/intraday-universe.js — Pre-market daily quality filter
// POST { symbols: [] }
// Filters NSE stocks for intraday tradability:
//   1. Previous close > ₹100
//   2. 20-day average turnover > ₹20 crore
//   3. ATR% (ATR14 daily / close * 100) between 1.5% and 8%
// Returns: { ok, universe: [{ticker, name, prevClose, atrPct, avgTurnoverCr, avgDailyVol}] }

const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Wilder's smoothed ATR(14) using daily OHLC
function calcATR(highs, lows, closes, period = 14) {
  const tr = closes.map((c, i) => {
    if (i === 0) return highs[i] - lows[i];
    return Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i-1]),
      Math.abs(lows[i] - closes[i-1])
    );
  });
  let atrVal = null;
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      atrVal = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    } else {
      atrVal = (atrVal * (period - 1) + tr[i]) / period;
    }
  }
  return atrVal;
}

async function filterSymbol(sym) {
  const ticker = sym + '.NS';
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 60 * 86400; // 60 days for ATR warmup
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${from}&period2=${to}&interval=1d`;

  const json = await httpsGet(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const ts    = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const rows  = ts.map((_, i) => ({
    close:  quote.close?.[i],
    high:   quote.high?.[i],
    low:    quote.low?.[i],
    volume: quote.volume?.[i] ?? 0,
  })).filter(r => r.close != null && r.high != null && r.low != null);

  if (rows.length < 20) return null;

  const closes  = rows.map(r => r.close);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);

  const prevClose = closes[closes.length - 1];

  // Filter 1: Previous close > ₹100
  if (prevClose <= 100) return null;

  // 20-day average turnover (close × volume)
  const recent20 = rows.slice(-20);
  const avgTurnover = recent20.reduce((s, r) => s + r.close * r.volume, 0) / 20;
  const avgTurnoverCr = avgTurnover / 1e7; // in crore

  // Filter 2: 20-day avg turnover > ₹20 crore
  if (avgTurnoverCr < 20) return null;

  // ATR(14) and ATR%
  const atrVal = calcATR(highs, lows, closes, 14);
  if (!atrVal) return null;
  const atrPct = (atrVal / prevClose) * 100;

  // Filter 3: ATR% between 1.5% and 8%
  if (atrPct < 1.5 || atrPct > 8) return null;

  const avgDailyVol = recent20.reduce((s, r) => s + r.volume, 0) / 20;

  return {
    ticker:        sym,
    name:          result.meta?.longName || result.meta?.shortName || sym,
    prevClose:     +prevClose.toFixed(2),
    atrPct:        +atrPct.toFixed(2),
    atrAbs:        +atrVal.toFixed(2),
    avgTurnoverCr: +avgTurnoverCr.toFixed(1),
    avgDailyVol:   Math.round(avgDailyVol),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body    = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const symbols = (body?.symbols || []).slice(0, 150);

  const universe = [];
  for (let i = 0; i < symbols.length; i += 8) {
    const batch   = symbols.slice(i, i + 8);
    const settled = await Promise.all(batch.map(async sym => {
      try { return await filterSymbol(sym); } catch { return null; }
    }));
    for (const r of settled) if (r) universe.push(r);
  }

  return res.status(200).json({ ok: true, universe, total: universe.length });
};

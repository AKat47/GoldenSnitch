// api/intraday-universe.js — Pre-market daily quality filter
// POST { symbols: [] }
// Filters NSE stocks for intraday tradability:
//   1. Previous close > ₹100
//   2. 20-day average turnover > ₹20 crore
//   3. ATR% (ATR14 daily / close * 100) between 1.5% and 8%
// Returns: { ok, universe: [{ticker, name, prevClose, atrPct, avgTurnoverCr, avgDailyVol}] }

const https  = require('https');
const angel  = require('./_angel');

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

async function fetchDailyRows(sym, jwt, angelKey) {
  // Try Angel One first if JWT provided
  if (jwt && angelKey) {
    try {
      const from = angel.istStr(angel.daysAgoIST(65), '09:15');
      const to   = angel.istNowStr();
      const raw  = await angel.fetchCandles(sym, 'ONE_DAY', from, to, jwt, angelKey);
      if (raw.length >= 20) {
        return {
          rows: raw.map(r => ({ close: r[4], high: r[2], low: r[3], volume: r[5] ?? 0 })),
          name: sym,
          source: 'angel'
        };
      }
    } catch(e) { /* fall through */ }
  }
  // Yahoo Finance fallback
  const ticker = sym + '.NS';
  const to   = Math.floor(Date.now() / 1000), from = to - 65 * 86400;
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${from}&period2=${to}&interval=1d`;
  const json   = await httpsGet(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const ts = result.timestamp || [], q = result.indicators?.quote?.[0] || {};
  const rows = ts.map((_, i) => ({
    close: q.close?.[i], high: q.high?.[i], low: q.low?.[i], volume: q.volume?.[i] ?? 0
  })).filter(r => r.close != null && r.high != null && r.low != null);
  return { rows, name: result.meta?.longName || result.meta?.shortName || sym, source: 'yahoo' };
}

async function filterSymbol(sym, jwt, angelKey) {
  const data = await fetchDailyRows(sym, jwt, angelKey);
  if (!data || data.rows.length < 20) return null;
  const { rows, name } = data;

  const closes  = rows.map(r => r.close);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);
  const prevClose = closes[closes.length - 1];

  if (prevClose <= 100) return null;

  const recent20      = rows.slice(-20);
  const avgTurnover   = recent20.reduce((s, r) => s + r.close * r.volume, 0) / 20;
  const avgTurnoverCr = avgTurnover / 1e7;
  if (avgTurnoverCr < 20) return null;

  const atrVal = calcATR(highs, lows, closes, 14);
  if (!atrVal) return null;
  const atrPct = (atrVal / prevClose) * 100;
  if (atrPct < 1.5 || atrPct > 8) return null;

  const avgDailyVol = recent20.reduce((s, r) => s + r.volume, 0) / 20;

  return {
    ticker: sym, name,
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

  // ── Angel One (optional — Yahoo fallback) ───────────────
  const angelKey    = (body?.angelKey    || '').trim();
  const angelClient = (body?.angelClient || '').trim();
  let jwt = null, angelError = null;
  if (angelKey && angelClient) {
    try { jwt = await angel.authenticate(angelKey, angelClient); }
    catch (e) { angelError = e.message; }
  }

  const universe = [];
  for (let i = 0; i < symbols.length; i += 8) {
    const batch   = symbols.slice(i, i + 8);
    const settled = await Promise.all(batch.map(async sym => {
      try { return await filterSymbol(sym, jwt, angelKey); } catch { return null; }
    }));
    for (const r of settled) if (r) universe.push(r);
  }

  return res.status(200).json({
    ok: true, universe, total: universe.length,
    dataSource: jwt ? 'angel' : 'yahoo', angelError,
  });
};

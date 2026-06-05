// api/backtest2.js — Golden cross backtest with 10% TP / 10% SL exit
// POST /api/backtest2  body: { symbols: ['RELIANCE','TCS',...] }
//
// Strategy:
//   1. Find the most recent golden cross (50 SMA crosses above 200 SMA)
//   2. Entry price = close on cross date
//   3. Scan every subsequent day using HIGH (for TP) and LOW (for SL)
//   4. First to trigger wins:
//      - HIGH >= entry * 1.10  → Hit  (exit at +10%)
//      - LOW  <= entry * 0.90  → Miss (exit at -10%)
//   5. If neither triggered yet → Open (show current unrealised P&L)

const https = require('https');

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
    req.on('error', () => resolve(null));
    req.end();
  });
}

function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += arr[j];
    return sum / period;
  });
}

// Returns most recent golden cross index, or -1 if none
function findLastGoldenCross(closes) {
  if (closes.length < 201) return -1;
  const sma50  = sma(closes, 50);
  const sma200 = sma(closes, 200);
  let lastCross = -1;
  for (let i = 1; i < closes.length; i++) {
    if (!sma50[i] || !sma200[i] || !sma50[i-1] || !sma200[i-1]) continue;
    if (sma50[i-1] <= sma200[i-1] && sma50[i] > sma200[i]) {
      lastCross = i; // keep going to find the latest one
    }
  }
  return lastCross;
}

async function fetchOHLC(sym) {
  const ticker = sym + '.NS';
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 1200 * 86400; // ~3.3 years
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${from}&period2=${to}&interval=1d`;
  const json = await httpsGet(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const ts     = result.timestamp || [];
  const quote  = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const highs  = quote.high  || [];
  const lows   = quote.low   || [];
  const dates  = ts.map(t => new Date(t * 1000).toISOString().split('T')[0]);

  // Filter rows where all values are present
  const rows = ts.map((_, i) => ({
    date:  dates[i],
    close: closes[i],
    high:  highs[i],
    low:   lows[i],
  })).filter(r => r.close != null && r.high != null && r.low != null);

  if (rows.length < 201) return null;

  return {
    rows,
    name: result.meta?.longName || result.meta?.shortName || sym,
    ltp:  result.meta?.regularMarketPrice || rows[rows.length - 1].close,
  };
}

async function backtestSymbol(sym) {
  const data = await fetchOHLC(sym);
  if (!data) return null;

  const { rows, name, ltp } = data;
  const closes = rows.map(r => r.close);
  const crossIdx = findLastGoldenCross(closes);
  if (crossIdx < 0) return null;

  const entryPrice = closes[crossIdx];
  const entryDate  = rows[crossIdx].date;
  const tp = entryPrice * 1.10;
  const sl = entryPrice * 0.90;

  let exitDate   = null;
  let exitPrice  = null;
  let exitType   = 'open'; // 'tp' | 'sl' | 'open'
  let daysToExit = null;

  for (let i = crossIdx + 1; i < rows.length; i++) {
    const { high, low, close, date } = rows[i];
    // Check TP first (optimistic — high is checked before low on same day)
    if (high >= tp) {
      exitDate   = date;
      exitPrice  = tp;
      exitType   = 'tp';
      daysToExit = i - crossIdx;
      break;
    }
    if (low <= sl) {
      exitDate   = date;
      exitPrice  = sl;
      exitType   = 'sl';
      daysToExit = i - crossIdx;
      break;
    }
  }

  // Still open
  const currentPrice = ltp || closes[closes.length - 1];
  const openPnlPct   = exitType === 'open'
    ? +((currentPrice - entryPrice) / entryPrice * 100).toFixed(2)
    : null;

  const pnlPct = exitType === 'tp' ? 10
               : exitType === 'sl' ? -10
               : openPnlPct;

  const daysSinceEntry = Math.floor((Date.now() - new Date(entryDate).getTime()) / 86400000);

  return {
    symbol:       sym,
    name,
    entryDate,
    entryPrice:   +entryPrice.toFixed(2),
    exitDate,
    exitPrice:    exitPrice ? +exitPrice.toFixed(2) : null,
    exitType,     // 'tp' | 'sl' | 'open'
    pnlPct,
    daysToExit,
    daysSinceEntry,
    currentPrice: exitType === 'open' ? +currentPrice.toFixed(2) : null,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body    = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const symbols = (body?.symbols || []).slice(0, 150);

  const results = [];
  const batchSize = 8;

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const settled = await Promise.all(batch.map(async sym => {
      try { return await backtestSymbol(sym); } catch { return null; }
    }));
    for (const r of settled) if (r) results.push(r);
  }

  const closed = results.filter(r => r.exitType !== 'open');
  const hits   = results.filter(r => r.exitType === 'tp');
  const misses = results.filter(r => r.exitType === 'sl');
  const open   = results.filter(r => r.exitType === 'open');

  const avgDays = closed.length
    ? +(closed.reduce((s, r) => s + r.daysToExit, 0) / closed.length).toFixed(1)
    : null;

  // Equal-weight portfolio P&L: each trade returns +10%, -10%, or open unrealised
  const totalPnl = results.length
    ? +(results.reduce((s, r) => s + (r.pnlPct || 0), 0) / results.length).toFixed(2)
    : 0;

  return res.status(200).json({
    ok: true,
    results,
    summary: {
      total:    results.length,
      hits:     hits.length,
      misses:   misses.length,
      open:     open.length,
      hitRate:  closed.length ? +(hits.length / closed.length * 100).toFixed(1) : 0,
      avgDays,
      avgPnlPct: totalPnl,
    }
  });
};

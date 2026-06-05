// api/backtest.js — Golden cross backtest for a batch of symbols
// POST /api/backtest  body: { symbols: ['RELIANCE','TCS',...] }
// For each symbol, finds the most recent golden cross and computes
// hypothetical P&L if you bought at that cross and held to today.

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

// Find ALL golden cross events in the data (50 SMA crosses above 200 SMA)
function findGoldenCrosses(closes, dates) {
  if (closes.length < 201) return [];
  const sma50  = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const crosses = [];

  for (let i = 1; i < closes.length; i++) {
    if (!sma50[i] || !sma200[i] || !sma50[i-1] || !sma200[i-1]) continue;
    const prevGolden = sma50[i-1] > sma200[i-1];
    const curGolden  = sma50[i]   > sma200[i];
    // Golden cross: was below, now above
    if (!prevGolden && curGolden) {
      crosses.push({
        date:  dates[i],
        price: closes[i],
        idx:   i,
        sma50:  +sma50[i].toFixed(2),
        sma200: +sma200[i].toFixed(2),
      });
    }
  }
  return crosses;
}

async function fetchClosesYahoo(sym) {
  const ticker = sym + '.NS';
  // Fetch ~3 years to have enough data for SMA200 + meaningful cross history
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 1200 * 86400; // ~3.3 years
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${from}&period2=${to}&interval=1d`;
  const json = await httpsGet(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const ts     = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const dates  = ts.map(t => new Date(t * 1000).toISOString().split('T')[0]);
  const paired = ts.map((_, i) => ({ date: dates[i], close: closes[i] }))
                   .filter(x => x.close != null);
  if (paired.length < 201) return null;
  return {
    closes: paired.map(x => x.close),
    dates:  paired.map(x => x.date),
    name:   result.meta?.longName || result.meta?.shortName || sym,
    ltp:    result.meta?.regularMarketPrice || paired[paired.length - 1].close,
  };
}

async function backtestSymbol(sym) {
  const data = await fetchClosesYahoo(sym);
  if (!data) return null;

  const { closes, dates, name, ltp } = data;
  const crosses = findGoldenCrosses(closes, dates);
  if (crosses.length === 0) return null;

  // Most recent golden cross
  const cross = crosses[crosses.length - 1];
  const currentPrice = ltp || closes[closes.length - 1];
  const pnlPct = ((currentPrice - cross.price) / cross.price) * 100;
  const daysSince = Math.floor((Date.now() - new Date(cross.date).getTime()) / 86400000);

  // Current SMA status
  const sma50  = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const n = closes.length - 1;
  const isStillGolden = sma50[n] != null && sma200[n] != null && sma50[n] > sma200[n];

  return {
    symbol: sym,
    name,
    crossDate:   cross.date,
    entryPrice:  +cross.price.toFixed(2),
    currentPrice: +currentPrice.toFixed(2),
    pnlPct:      +pnlPct.toFixed(2),
    daysSince,
    hit:         pnlPct > 0,
    isStillGolden,
    totalCrosses: crosses.length,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body    = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const symbols = (body?.symbols || []).slice(0, 150); // cap per request

  const results = [];
  const batchSize = 8;

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const settled = await Promise.all(batch.map(async sym => {
      try { return await backtestSymbol(sym); }
      catch { return null; }
    }));
    for (const r of settled) {
      if (r) results.push(r);
    }
  }

  // Summary stats
  const hits   = results.filter(r => r.hit).length;
  const misses = results.filter(r => !r.hit).length;
  const avgPnl = results.length
    ? results.reduce((s, r) => s + r.pnlPct, 0) / results.length
    : 0;
  // Equal-weight portfolio P&L (₹1 invested per stock)
  const portfolioPnl = results.length
    ? results.reduce((s, r) => s + r.pnlPct, 0) / results.length
    : 0;

  return res.status(200).json({
    ok: true,
    results,
    summary: {
      total: results.length,
      hits,
      misses,
      hitRate: results.length ? +(hits / results.length * 100).toFixed(1) : 0,
      avgPnlPct: +avgPnl.toFixed(2),
      portfolioPnlPct: +portfolioPnl.toFixed(2),
    }
  });
};

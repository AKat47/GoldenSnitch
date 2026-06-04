// api/scan.js — Batch golden cross scan for a list of symbols
// POST /api/scan  body: { symbols: ['RELIANCE','TCS',...] }
// Returns each symbol's golden cross status

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

function analyseSymbol(closes, dates) {
  if (closes.length < 201) return null;
  const sma50  = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const n = closes.length - 1;

  // Current status
  const cur50  = sma50[n];
  const cur200 = sma200[n];
  if (!cur50 || !cur200) return null;
  const isGolden = cur50 > cur200;

  // Find last crossover
  let lastCross = null;
  for (let i = n; i > 0; i--) {
    if (!sma50[i] || !sma200[i] || !sma50[i-1] || !sma200[i-1]) continue;
    const wasBull = sma50[i-1] > sma200[i-1];
    const isBull  = sma50[i]   > sma200[i];
    if (wasBull !== isBull) {
      lastCross = { date: dates[i], type: isBull ? 'golden' : 'death', price: closes[i], i };
      break;
    }
  }

  const daysSince = lastCross
    ? Math.floor((Date.now() - new Date(lastCross.date).getTime()) / 86400000)
    : null;

  const pctSince = lastCross
    ? ((closes[n] - lastCross.price) / lastCross.price * 100)
    : null;

  return {
    isGolden,
    cur50: +cur50.toFixed(2),
    cur200: +cur200.toFixed(2),
    spread: +(((cur50 - cur200) / cur200) * 100).toFixed(2),
    lastCross,
    daysSince,
    pctSince: pctSince != null ? +pctSince.toFixed(2) : null,
    ltp: closes[n]
  };
}

async function fetchCloses(sym) {
  const ticker = sym + '.NS';
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 420 * 86400;
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${from}&period2=${to}&interval=1d`;
  const json = await httpsGet(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const ts     = result.timestamp   || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const dates  = ts.map(t => new Date(t * 1000).toISOString().split('T')[0]);
  const paired = ts.map((_, i) => ({ date: dates[i], close: closes[i] }))
                   .filter(x => x.close != null);
  return { closes: paired.map(x => x.close), dates: paired.map(x => x.date),
           name: result.meta?.longName || result.meta?.shortName || sym };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const symbols = (body?.symbols || []).slice(0, 100); // cap at 100

  // Fetch in batches of 10 (parallel)
  const results = {};
  const batchSize = 10;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    await Promise.all(batch.map(async sym => {
      try {
        const data = await fetchCloses(sym);
        if (!data || data.closes.length < 201) return;
        const analysis = analyseSymbol(data.closes, data.dates);
        if (analysis) results[sym] = { ...analysis, name: data.name };
      } catch (e) { /* skip */ }
    }));
  }

  return res.status(200).json({ ok: true, results });
};

// api/backtest2.js — Golden cross backtest with 10% TP / 10% SL exit
// POST body: { symbols, requireADX, adxMin, requireVolume, volumeMult }

const https = require('https');
const { sma, adx, avgVolume } = require('./_indicators');

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

function findLastGoldenCross(closes) {
  if (closes.length < 201) return -1;
  const sma50  = sma(closes, 50);
  const sma200 = sma(closes, 200);
  let last = -1;
  for (let i = 1; i < closes.length; i++) {
    if (!sma50[i] || !sma200[i] || !sma50[i-1] || !sma200[i-1]) continue;
    if (sma50[i-1] <= sma200[i-1] && sma50[i] > sma200[i]) last = i;
  }
  return last;
}

async function fetchOHLC(sym) {
  const ticker = sym + '.NS';
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 1200 * 86400;
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${from}&period2=${to}&interval=1d`;
  const json = await httpsGet(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const ts    = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const dates = ts.map(t => new Date(t * 1000).toISOString().split('T')[0]);
  const rows  = ts.map((_, i) => ({
    date: dates[i], close: quote.close?.[i],
    high: quote.high?.[i], low: quote.low?.[i], volume: quote.volume?.[i]
  })).filter(r => r.close != null && r.high != null && r.low != null);
  if (rows.length < 201) return null;
  return {
    rows,
    name: result.meta?.longName || result.meta?.shortName || sym,
    ltp:  result.meta?.regularMarketPrice || rows[rows.length-1].close,
  };
}

async function backtestSymbol(sym, rules) {
  const data = await fetchOHLC(sym);
  if (!data) return null;
  const { rows, name, ltp } = data;

  const closes  = rows.map(r => r.close);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume ?? 0);
  const dates   = rows.map(r => r.date);

  const crossIdx = findLastGoldenCross(closes);
  if (crossIdx < 0) return null;

  // ── Rule: ADX at cross ──
  if (rules.requireADX) {
    const adxArr = adx(highs, lows, closes, 14);
    if ((adxArr[crossIdx] ?? 0) < rules.adxMin) return null;
  }

  // ── Rule: Volume at cross ──
  if (rules.requireVolume) {
    const avgVol = avgVolume(volumes, 20);
    if (!avgVol[crossIdx] || volumes[crossIdx] < rules.volumeMult * avgVol[crossIdx]) return null;
  }

  // ── Rule: Daily traded value ──
  if (rules.requireTV) {
    if (closes[crossIdx] * volumes[crossIdx] < rules.tvMinCr * 1e7) return null;
  }

  const entryPrice = closes[crossIdx];
  const entryDate  = dates[crossIdx];
  const tp = entryPrice * 1.10;
  const sl = entryPrice * 0.90;

  let exitDate = null, exitPrice = null, exitType = 'open', daysToExit = null;
  for (let i = crossIdx + 1; i < rows.length; i++) {
    if (highs[i] >= tp) { exitDate=dates[i]; exitPrice=tp; exitType='tp'; daysToExit=i-crossIdx; break; }
    if (lows[i]  <= sl) { exitDate=dates[i]; exitPrice=sl; exitType='sl'; daysToExit=i-crossIdx; break; }
  }

  const currentPrice = ltp || closes[closes.length-1];
  const pnlPct = exitType==='tp' ? 10 : exitType==='sl' ? -10
    : +((currentPrice-entryPrice)/entryPrice*100).toFixed(2);

  return {
    symbol: sym, name, entryDate,
    entryPrice:    +entryPrice.toFixed(2),
    exitDate, exitPrice: exitPrice ? +exitPrice.toFixed(2) : null,
    exitType, pnlPct, daysToExit,
    daysSinceEntry: Math.floor((Date.now()-new Date(entryDate).getTime())/86400000),
    currentPrice:   exitType==='open' ? +currentPrice.toFixed(2) : null,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body    = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const symbols = (body?.symbols || []).slice(0, 150);
  const rules = {
    requireADX:    !!body?.requireADX,
    adxMin:        parseFloat(body?.adxMin)     || 25,
    requireVolume: !!body?.requireVolume,
    volumeMult:    parseFloat(body?.volumeMult)  || 1.5,
    requireTV:     !!body?.requireTV,
    tvMinCr:       parseFloat(body?.tvMinCr)    || 10,
  };

  const results = [];
  for (let i = 0; i < symbols.length; i += 8) {
    const batch   = symbols.slice(i, i+8);
    const settled = await Promise.all(batch.map(async sym => {
      try { return await backtestSymbol(sym, rules); } catch { return null; }
    }));
    for (const r of settled) if (r) results.push(r);
  }

  const hits   = results.filter(r => r.exitType==='tp');
  const misses = results.filter(r => r.exitType==='sl');
  const open   = results.filter(r => r.exitType==='open');
  const closed = hits.length + misses.length;
  const avgDays = closed
    ? +(results.filter(r=>r.daysToExit).reduce((s,r)=>s+r.daysToExit,0)/closed).toFixed(1) : null;

  return res.status(200).json({
    ok: true, results,
    summary: {
      total: results.length, hits: hits.length, misses: misses.length, open: open.length,
      hitRate: closed ? +(hits.length/closed*100).toFixed(1) : 0,
      avgDays,
      avgPnlPct: results.length
        ? +(results.reduce((s,r)=>s+(r.pnlPct||0),0)/results.length).toFixed(2) : 0,
    }
  });
};

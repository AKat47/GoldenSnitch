// api/optimize.js — Parameter sweep: test multiple TP/SL combos in one pass per symbol
//
// POST body: {
//   symbols:   [...],
//   tpValues:  [5, 10, 15, 20, 25, 30],   // take-profit percentages to test
//   slValues:  [3, 5, 7, 10, 15, 20],     // stop-loss percentages to test
//   // optional entry-rule flags (same as backtest3)
//   requireADX, adxMin, requireVolume, volumeMult,
//   requireTV, tvMinCr, skipPenny, minClose, requireRS
// }
//
// Response: {
//   ok: true,
//   combos: {
//     "tp10_sl5": { tp, sl, trades, hits, misses, open, winRate, avgReturn, avgDays },
//     ...
//   },
//   processed: N   // symbols that had a golden cross
// }

const https = require('https');
const { sma, adx, avgVolume, fetchNiftyMap, niftyPriceAt, threeMonthReturn } = require('./_indicators');

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
    date:   dates[i],
    close:  quote.close?.[i],
    high:   quote.high?.[i],
    low:    quote.low?.[i],
    volume: quote.volume?.[i],
  })).filter(r => r.close != null && r.high != null && r.low != null);
  if (rows.length < 201) return null;
  return { rows, ltp: result.meta?.regularMarketPrice || rows[rows.length-1].close };
}

// Test all TP/SL combos for a single symbol, return map of comboKey -> outcome
// outcome: 'tp' | 'sl' | 'open'  +  daysToExit + pnlPct
function runCombos(rows, crossIdx, tpValues, slValues) {
  const closes = rows.map(r => r.close);
  const highs  = rows.map(r => r.high);
  const lows   = rows.map(r => r.low);
  const entry  = closes[crossIdx];
  const ltp    = closes[closes.length - 1];
  const results = {};

  for (const tp of tpValues) {
    for (const sl of slValues) {
      const key    = `tp${tp}_sl${sl}`;
      const tpPrice = entry * (1 + tp / 100);
      const slPrice = entry * (1 - sl / 100);
      let exitType = 'open', daysToExit = null, pnlPct;

      for (let i = crossIdx + 1; i < rows.length; i++) {
        if (highs[i] >= tpPrice) { exitType = 'tp'; daysToExit = i - crossIdx; break; }
        if (lows[i]  <= slPrice) { exitType = 'sl'; daysToExit = i - crossIdx; break; }
      }

      pnlPct = exitType === 'tp' ?  tp
             : exitType === 'sl' ? -sl
             : +((ltp - entry) / entry * 100).toFixed(2);

      results[key] = { exitType, daysToExit, pnlPct };
    }
  }
  return results;
}

async function processSymbol(sym, rules, niftyMap, tpValues, slValues) {
  const data = await fetchOHLC(sym);
  if (!data) return null;
  const { rows } = data;

  const closes  = rows.map(r => r.close);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume ?? 0);
  const dates   = rows.map(r => r.date);

  const crossIdx = findLastGoldenCross(closes);
  if (crossIdx < 0) return null;

  // ── Entry rules (same as backtest3) ──
  if (rules.requireADX) {
    const adxArr = adx(highs, lows, closes, 14);
    if ((adxArr[crossIdx] ?? 0) < rules.adxMin) return null;
  }
  if (rules.requireVolume) {
    const avgVol = avgVolume(volumes, 20);
    if (!avgVol[crossIdx] || volumes[crossIdx] < rules.volumeMult * avgVol[crossIdx]) return null;
  }
  if (rules.requireTV) {
    if (closes[crossIdx] * volumes[crossIdx] < rules.tvMinCr * 1e7) return null;
  }
  if (rules.skipPenny && closes[crossIdx] < rules.minClose) return null;
  if (rules.requireRS && niftyMap) {
    const stockRet  = threeMonthReturn(closes, crossIdx);
    const crossDate = dates[crossIdx];
    const niftyNow  = niftyPriceAt(niftyMap, crossDate);
    const prevDate  = new Date(crossDate);
    prevDate.setDate(prevDate.getDate() - 90);
    const niftyPrev = niftyPriceAt(niftyMap, prevDate.toISOString().split('T')[0]);
    const niftyRet  = (niftyNow && niftyPrev)
      ? (niftyNow - niftyPrev) / niftyPrev * 100 : null;
    if (stockRet == null || niftyRet == null || stockRet <= niftyRet) return null;
  }

  return runCombos(rows, crossIdx, tpValues, slValues);
}

// Aggregate per-symbol combo results into running totals
function mergeInto(totals, symCombos, tpValues, slValues) {
  for (const tp of tpValues) {
    for (const sl of slValues) {
      const key = `tp${tp}_sl${sl}`;
      if (!totals[key]) totals[key] = { tp, sl, trades: 0, hits: 0, misses: 0, open: 0, totalPnl: 0, totalDays: 0, closedCount: 0 };
      const t = totals[key];
      const r = symCombos[key];
      t.trades++;
      t.totalPnl += r.pnlPct;
      if (r.exitType === 'tp') { t.hits++; t.totalDays += r.daysToExit; t.closedCount++; }
      else if (r.exitType === 'sl') { t.misses++; t.totalDays += r.daysToExit; t.closedCount++; }
      else t.open++;
    }
  }
}

function finalise(totals) {
  const combos = {};
  for (const [key, t] of Object.entries(totals)) {
    const closed = t.hits + t.misses;
    combos[key] = {
      tp:        t.tp,
      sl:        t.sl,
      trades:    t.trades,
      hits:      t.hits,
      misses:    t.misses,
      open:      t.open,
      winRate:   closed ? +(t.hits / closed * 100).toFixed(1) : 0,
      avgReturn: t.trades ? +(t.totalPnl / t.trades).toFixed(2) : 0,
      avgDays:   t.closedCount ? Math.round(t.totalDays / t.closedCount) : null,
    };
  }
  return combos;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  const symbols  = (body?.symbols  || []).slice(0, 150);
  const tpValues = (body?.tpValues || [5, 10, 15, 20, 25, 30]).map(Number).filter(v => v > 0 && v <= 200);
  const slValues = (body?.slValues || [3, 5, 7, 10, 15]).map(Number).filter(v => v > 0 && v <= 100);

  const rules = {
    requireADX:    !!body?.requireADX,
    adxMin:        parseFloat(body?.adxMin)     || 25,
    requireVolume: !!body?.requireVolume,
    volumeMult:    parseFloat(body?.volumeMult) || 1.5,
    requireTV:     !!body?.requireTV,
    tvMinCr:       parseFloat(body?.tvMinCr)    || 10,
    skipPenny:     !!body?.skipPenny,
    minClose:      parseFloat(body?.minClose)   || 100,
    requireRS:     !!body?.requireRS,
  };

  const niftyMap = rules.requireRS ? await fetchNiftyMap(httpsGet) : null;

  const totals    = {};
  let   processed = 0;

  for (let i = 0; i < symbols.length; i += 8) {
    const batch   = symbols.slice(i, i + 8);
    const settled = await Promise.all(batch.map(async sym => {
      try { return await processSymbol(sym, rules, niftyMap, tpValues, slValues); }
      catch { return null; }
    }));
    for (const r of settled) {
      if (r) { mergeInto(totals, r, tpValues, slValues); processed++; }
    }
  }

  return res.status(200).json({
    ok: true,
    combos:    finalise(totals),
    processed,
    tpValues,
    slValues,
  });
};

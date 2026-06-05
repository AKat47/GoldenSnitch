// api/intraday-scan.js — 5-minute live intraday scanner
// POST {
//   symbols: [],
//   prevCloses:    { TICKER: price },  // from universe prep
//   avgDailyVols:  { TICKER: vol },    // from universe prep
//   atrPcts:       { TICKER: pct },    // from universe prep
// }
// Returns: { ok, signals: [...ranked], scanTime, marketOpen }

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

// ── Indicators ────────────────────────────────────────────

function ema(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    if (prev == null) {
      if (i < period - 1) continue;
      // seed with SMA
      let sum = 0, count = 0;
      for (let j = i - period + 1; j <= i; j++) { if (arr[j] != null) { sum += arr[j]; count++; } }
      prev = sum / count;
      out[i] = prev;
    } else {
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(arr, period = 14) {
  const out = new Array(arr.length).fill(null);
  if (arr.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = arr[i] - arr[i-1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = 100 - 100 / (1 + avgGain / (avgLoss || 0.0001));
  for (let i = period + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i-1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 0.0001));
  }
  return out;
}

function vwap(highs, lows, closes, volumes) {
  let cumTV = 0, cumVol = 0;
  return closes.map((c, i) => {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTV  += tp * (volumes[i] || 0);
    cumVol += (volumes[i] || 0);
    return cumVol > 0 ? cumTV / cumVol : c;
  });
}

// Wilder's ATR
function atr(highs, lows, closes, period = 14) {
  const tr = closes.map((c, i) => {
    if (i === 0) return highs[i] - lows[i];
    return Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
  });
  let val = null;
  const out = new Array(tr.length).fill(null);
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) val = tr.slice(0, period).reduce((a,b)=>a+b,0)/period;
    else val = (val * (period - 1) + tr[i]) / period;
    out[i] = val;
  }
  return out;
}

// ADX (Wilder)
function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i-1], down = lows[i-1] - lows[i];
    plusDM[i]  = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
    tr[i] = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
  }
  // Smooth with Wilder
  function wilderSmooth(arr, p) {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 1; i <= p; i++) sum += arr[i];
    out[p] = sum;
    for (let i = p+1; i < arr.length; i++) out[i] = out[i-1] - out[i-1]/p + arr[i];
    return out;
  }
  const sTR = wilderSmooth(tr, period);
  const sPlus = wilderSmooth(plusDM, period);
  const sMinus = wilderSmooth(minusDM, period);
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!sTR[i] || sTR[i] === 0) continue;
    const diP = (sPlus[i]/sTR[i])*100, diM = (sMinus[i]/sTR[i])*100;
    dx[i] = Math.abs(diP - diM) / (diP + diM) * 100;
  }
  // Smooth DX to get ADX
  const adxOut = new Array(n).fill(null);
  let adxVal = null;
  for (let i = period*2; i < n; i++) {
    if (dx[i] == null) continue;
    if (adxVal == null) { adxVal = dx[i]; adxOut[i] = adxVal; continue; }
    adxVal = (adxVal * (period-1) + dx[i]) / period;
    adxOut[i] = adxVal;
  }
  return adxOut;
}

// ── Fetch 5-min candles ───────────────────────────────────
async function fetch5Min(sym) {
  const ticker = sym + '.NS';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?interval=5m&range=1d`;
  const json = await httpsGet(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const ts    = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const rows  = ts.map((t, i) => ({
    ts:     t,
    time:   new Date(t * 1000),
    open:   quote.open?.[i],
    high:   quote.high?.[i],
    low:    quote.low?.[i],
    close:  quote.close?.[i],
    volume: quote.volume?.[i] ?? 0,
  })).filter(r => r.close != null && r.high != null && r.low != null);

  return { rows, meta: result.meta, name: result.meta?.longName || result.meta?.shortName || sym };
}

// IST offset
function toIST(d) {
  return new Date(d.getTime() + 5.5*60*60*1000);
}

// ── Process one symbol ────────────────────────────────────
async function scanSymbol(sym, prevClose, avgDailyVol, stockAtrPct) {
  const data = await fetch5Min(sym);
  if (!data || !data.rows.length) return null;

  const { rows, meta, name } = data;
  if (rows.length < 5) return null;

  const opens   = rows.map(r => r.open);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const closes  = rows.map(r => r.close);
  const volumes = rows.map(r => r.volume);
  const n       = rows.length - 1;

  const ltp = closes[n];
  const dayHigh = Math.max(...highs);
  const pricePctFromHigh = ((dayHigh - ltp) / dayHigh) * 100;

  // ── Gap filter ──
  const firstOpen = opens[0];
  const gapPct    = prevClose ? ((firstOpen - prevClose) / prevClose * 100) : 0;
  if (prevClose && (gapPct < -2 || gapPct > 3)) return null;

  // ── Opening volume filter (first candle) ──
  const avgFiveMinVol = avgDailyVol ? avgDailyVol / 75 : null;
  if (avgFiveMinVol && rows.length === 1 && volumes[0] < 3 * avgFiveMinVol) return null;

  // ── Indicators on 5-min ──
  const vwapArr  = vwap(highs, lows, closes, volumes);
  const ema9Arr  = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const rsiArr   = rsi(closes, 14);
  const adxArr   = adx(highs, lows, closes, 14);
  const atr5Arr  = atr(highs, lows, closes, 14);

  const curVWAP = vwapArr[n];
  const curEMA9 = ema9Arr[n];
  const curEMA21= ema21Arr[n];
  const curRSI  = rsiArr[n];
  const curADX  = adxArr[n];
  const curATR  = atr5Arr[n];

  // Avg volume of last 20 5-min candles
  const vol20  = volumes.slice(Math.max(0, n-20), n);
  const avgVol = vol20.length ? vol20.reduce((a,b)=>a+b,0)/vol20.length : 0;
  const volRatio = avgVol > 0 ? volumes[n] / avgVol : 0;

  // IST time check
  const istNow  = toIST(new Date());
  const istMins = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const scanOK  = istMins >= 9*60+30 && istMins <= 14*60+45; // 9:30 to 14:45

  // ── REJECT conditions ──
  if (curADX != null && curADX < 20) return null;
  if (curRSI != null && curRSI > 75)  return null;
  if (avgVol > 0 && volumes[n] <= avgVol) return null;

  // ── BUY conditions ──
  const condVWAP   = curVWAP != null && ltp > curVWAP;
  const condEMA    = curEMA9 != null && curEMA21 != null && curEMA9 > curEMA21;
  const condADX    = curADX != null && curADX > 25;
  const condRSI    = curRSI != null && curRSI >= 55 && curRSI <= 70;
  const condVol    = avgVol > 0 && volumes[n] > 2 * avgVol;
  const condTime   = scanOK;

  const isBuy = condVWAP && condEMA && condADX && condRSI && condVol && condTime;

  // ── Score ──
  let score = 0;
  if (curADX != null && curADX > 30)       score += 2;
  if (volRatio > 3)                          score += 3;
  if (curRSI != null && curRSI >= 60 && curRSI <= 65) score += 2;
  if (condVWAP)                              score += 2;
  if (pricePctFromHigh < 1)                  score += 2; // near day high

  // ── Entry / SL / Target ──
  let entry = null, sl = null, target = null, trailStop = null;
  if (isBuy && curATR != null) {
    entry      = +ltp.toFixed(2);
    const risk = +(1.5 * curATR).toFixed(2);
    sl         = +(entry - risk).toFixed(2);
    target     = +(entry + 2 * risk).toFixed(2);
    trailStop  = +(entry).toFixed(2); // moves to entry when 1×risk profit hit
  }

  return {
    ticker:       sym,
    name,
    ltp:          +ltp.toFixed(2),
    prevClose:    prevClose ? +prevClose.toFixed(2) : null,
    gapPct:       +gapPct.toFixed(2),
    vwap:         curVWAP ? +curVWAP.toFixed(2) : null,
    ema9:         curEMA9  ? +curEMA9.toFixed(2)  : null,
    ema21:        curEMA21 ? +curEMA21.toFixed(2) : null,
    adx:          curADX   ? +curADX.toFixed(1)   : null,
    rsi:          curRSI   ? +curRSI.toFixed(1)   : null,
    atr5:         curATR   ? +curATR.toFixed(2)   : null,
    volRatio:     +volRatio.toFixed(2),
    volume:       volumes[n],
    dayHigh:      +dayHigh.toFixed(2),
    candles:      rows.length,
    isBuy,
    // individual conditions (for UI indicator dots)
    conds: { condVWAP, condEMA, condADX, condRSI, condVol, condTime },
    score: isBuy ? score : 0,
    entry,
    sl,
    target,
    trailStop,
    rr: entry && sl ? +((target - entry) / (entry - sl)).toFixed(2) : null,
  };
}

// ── Handler ───────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body         = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const symbols      = (body?.symbols      || []).slice(0, 150);
  const prevCloses   = body?.prevCloses    || {};
  const avgDailyVols = body?.avgDailyVols  || {};
  const atrPcts      = body?.atrPcts       || {};

  const results = [];
  for (let i = 0; i < symbols.length; i += 8) {
    const batch   = symbols.slice(i, i+8);
    const settled = await Promise.all(batch.map(async sym => {
      try {
        return await scanSymbol(
          sym,
          prevCloses[sym]    ?? null,
          avgDailyVols[sym]  ?? null,
          atrPcts[sym]       ?? null
        );
      } catch { return null; }
    }));
    for (const r of settled) if (r) results.push(r);
  }

  // Separate buy signals vs watchlist (passing conditions but not all)
  const signals   = results.filter(r => r.isBuy).sort((a,b) => b.score - a.score);
  const watchlist = results.filter(r => !r.isBuy).sort((a,b) => b.score - a.score).slice(0, 30);

  // IST scan time
  const ist = toIST(new Date());
  const hh  = String(ist.getUTCHours()).padStart(2,'0');
  const mm  = String(ist.getUTCMinutes()).padStart(2,'0');

  return res.status(200).json({
    ok: true,
    signals,
    watchlist,
    scanned:  results.length,
    scanTime: `${hh}:${mm}`,
  });
};

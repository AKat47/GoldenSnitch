// api/intraday-scan.js — Intraday Momentum Scanner v2
//
// Strategy: Volume → VWAP → Relative Strength → ORB → EMA trend
// EMA crossover is confirmation only; NOT the primary signal.
// Goal: detect stocks where institutions are creating intraday momentum.
//
// POST {
//   symbols:      [],
//   prevCloses:   { TICKER: price },   // from universe prep
//   avgDailyVols: { TICKER: vol },     // from universe prep
//   minPrice:     50,                  // optional, default 50
//   minATRpct:    0.5,                 // optional, default 0.5
// }
// Returns: { ok, signals, strong, watch, scanned, found, scanTime, marketOpen, niftyChange }

const https = require('https');
const angel = require('./_angel');

// ── HTTP ──────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve) => {
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

// ── IST helpers ───────────────────────────────────────────
function toIST(d)      { return new Date(d.getTime() + 5.5 * 60 * 60 * 1000); }
function istDateStr(d) { return toIST(d).toISOString().split('T')[0]; }
function istMinsOf(d)  { const i = toIST(d); return i.getUTCHours() * 60 + i.getUTCMinutes(); }

// ── Indicators ────────────────────────────────────────────

function emaCalc(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    if (prev == null) {
      if (i < period - 1) continue;
      let s = 0, c = 0;
      for (let j = i - period + 1; j <= i; j++) { if (arr[j] != null) { s += arr[j]; c++; } }
      prev = s / c; out[i] = prev;
    } else {
      prev = arr[i] * k + prev * (1 - k); out[i] = prev;
    }
  }
  return out;
}

function rsiCalc(arr, period = 14) {
  const out = new Array(arr.length).fill(null);
  if (arr.length <= period) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  out[period] = 100 - 100 / (1 + ag / (al || 0.0001));
  for (let i = period + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1], g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + ag / (al || 0.0001));
  }
  return out;
}

function vwapCalc(highs, lows, closes, volumes) {
  let cumTV = 0, cumVol = 0;
  return closes.map((c, i) => {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTV  += tp * (volumes[i] || 0);
    cumVol += (volumes[i] || 0);
    return cumVol > 0 ? cumTV / cumVol : c;
  });
}

function atrCalc(highs, lows, closes, period = 14) {
  const tr = closes.map((c, i) => i === 0
    ? highs[i] - lows[i]
    : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  let val = null;
  const out = new Array(tr.length).fill(null);
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) val = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else val = (val * (period - 1) + tr[i]) / period;
    out[i] = val;
  }
  return out;
}

// ── NIFTY reference data (cached per IST day) ─────────────
let _niftyCache     = null;
let _niftyCacheDate = '';

async function fetchNifty() {
  const today = istDateStr(new Date());
  if (_niftyCache && _niftyCacheDate === today) return _niftyCache;

  const url  = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=5m&range=1d';
  const json = await httpsGet(url);
  const res  = json?.chart?.result?.[0];
  if (!res) return null;

  const ts = res.timestamp || [];
  const q  = res.indicators?.quote?.[0] || {};
  const rows = ts.map((t, i) => ({ close: q.close?.[i], open: q.open?.[i] }))
                 .filter(r => r.close != null);
  if (!rows.length) return null;

  const niftyOpen    = rows[0].open || rows[0].close;
  const niftyCurrent = rows[rows.length - 1].close;
  const niftyChange  = niftyOpen ? ((niftyCurrent - niftyOpen) / niftyOpen * 100) : 0;

  _niftyCache     = { niftyOpen, niftyCurrent, niftyChange };
  _niftyCacheDate = today;
  return _niftyCache;
}

// ── Fetch 5-min candles (2 days for EMA-50 warmup) ────────
// Tries Angel One first (real-time) if jwt provided, else Yahoo (15-min delay).
async function fetch5Min(sym, jwt, angelKey) {
  if (jwt && angelKey) {
    try {
      const from = angel.istStr(angel.daysAgoIST(4), '09:15'); // 4 cal days ≈ 2 sessions incl. weekends
      const to   = angel.istNowStr();
      const raw  = await angel.fetchCandles(sym, 'FIVE_MINUTE', from, to, jwt, angelKey);
      if (raw.length >= 15) {
        const today = istDateStr(new Date());
        const rows = raw.map(r => {
          const d = new Date(r[0]); // "2026-06-12T09:15:00+05:30"
          return {
            ts:      Math.floor(d.getTime() / 1000),
            istDate: istDateStr(d),
            mins:    istMinsOf(d),
            open: r[1], high: r[2], low: r[3], close: r[4],
            volume: r[5] ?? 0,
          };
        }).filter(r => r.close != null);
        if (rows.length >= 15) return { rows, today, name: sym, source: 'angel' };
      }
    } catch (e) { /* fall through to Yahoo */ }
  }
  return fetch5MinYahoo(sym);
}

async function fetch5MinYahoo(sym) {
  const ticker = sym + '.NS';
  const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=2d`;
  const json   = await httpsGet(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const ts    = result.timestamp || [];
  const q     = result.indicators?.quote?.[0] || {};
  const today = istDateStr(new Date());

  const rows = ts.map((t, i) => {
    const d = new Date(t * 1000);
    return {
      ts:      t,
      istDate: istDateStr(d),
      mins:    istMinsOf(d),
      open:    q.open?.[i],
      high:    q.high?.[i],
      low:     q.low?.[i],
      close:   q.close?.[i],
      volume:  q.volume?.[i] ?? 0,
    };
  }).filter(r => r.close != null && r.high != null && r.low != null);

  const name = result.meta?.longName || result.meta?.shortName || sym;
  return { rows, today, name, source: 'yahoo' };
}

// ── Core symbol analysis ──────────────────────────────────
async function scanSymbol(sym, prevClose, avgDailyVol, niftyData, cfg, jwt, angelKey) {
  const data = await fetch5Min(sym, jwt, angelKey);
  if (!data || data.rows.length < 15) return null;

  const { rows, today, name } = data;

  // Today's candles only (from 9:15 IST = market open)
  const todayRows = rows.filter(r => r.istDate === today && r.mins >= 9 * 60 + 15);
  if (todayRows.length < 4) return null; // need ORB candles + at least 1 more candle

  const tn  = todayRows.length - 1;
  const ltp = todayRows[tn].close;

  // ── Price filter ───────────────────────────────────────
  if (ltp < (cfg.minPrice || 50)) return null;

  // ── Indicators on ALL rows (warmup for EMA-50 / RSI-14) ──
  const allCloses = rows.map(r => r.close);
  const allHighs  = rows.map(r => r.high);
  const allLows   = rows.map(r => r.low);
  const n = rows.length - 1;

  const ema9Arr  = emaCalc(allCloses, 9);
  const ema21Arr = emaCalc(allCloses, 21);
  const ema50Arr = emaCalc(allCloses, 50);
  const rsiArr   = rsiCalc(allCloses, 14);
  const atrArr   = atrCalc(allHighs, allLows, allCloses, 14);

  const curEMA9  = ema9Arr[n];
  const curEMA21 = ema21Arr[n];
  const curEMA50 = ema50Arr[n];
  const curRSI   = rsiArr[n];
  const curATR   = atrArr[n];

  if (!curEMA9 || !curEMA21) return null;

  const atrPct = curATR ? (curATR / ltp * 100) : 0;
  if (atrPct < (cfg.minATRpct || 0.5)) return null;

  // ── Today-only arrays (VWAP resets at market open) ─────
  const tHighs   = todayRows.map(r => r.high);
  const tLows    = todayRows.map(r => r.low);
  const tCloses  = todayRows.map(r => r.close);
  const tVolumes = todayRows.map(r => r.volume);
  const tOpens   = todayRows.map(r => r.open);

  // VWAP: cumulative from today's first candle
  const vwapArr = vwapCalc(tHighs, tLows, tCloses, tVolumes);
  const curVWAP = vwapArr[tn];

  // ── Volume analysis ────────────────────────────────────
  // Compare current candle's volume to avg of last 20 intraday candles
  const vol20  = tVolumes.slice(Math.max(0, tn - 20), tn);
  const avgVol = vol20.length
    ? vol20.reduce((a, b) => a + b, 0) / vol20.length
    : (avgDailyVol ? avgDailyVol / 75 : 0);
  const volRatio = avgVol > 0 ? tVolumes[tn] / avgVol : 0;

  // ── Opening Range (first 15 min: candles with mins < 9:30) ──
  const orbCandles = todayRows.filter(r => r.mins < 9 * 60 + 30);
  let orbHigh = null, orbLow = null;
  let orbBreakout = false, orbBreakdown = false;

  if (orbCandles.length >= 1) {
    orbHigh = Math.max(...orbCandles.map(r => r.high));
    orbLow  = Math.min(...orbCandles.map(r => r.low));
    // Require volume confirmation for ORB (at least 2× avg vol)
    const volConfirmed = avgVol > 0 && tVolumes[tn] >= 2 * avgVol;
    if (ltp > orbHigh && volConfirmed) orbBreakout  = true;
    if (ltp < orbLow  && volConfirmed) orbBreakdown = true;
  }

  // ── Gap & intraday change ──────────────────────────────
  const todayOpen = tOpens[0] || tCloses[0];
  const gapPct    = prevClose ? ((todayOpen - prevClose) / prevClose * 100) : 0;
  const changePct = todayOpen ? ((ltp - todayOpen) / todayOpen * 100) : 0;

  // ── Relative Strength vs NIFTY ─────────────────────────
  let rs = null;
  if (niftyData) rs = changePct - niftyData.niftyChange;

  // ── EMA trend ─────────────────────────────────────────
  const ema9g21  = curEMA9  > curEMA21;
  const ema21g50 = curEMA50 ? curEMA21 > curEMA50 : null;
  let emaTrend;
  if (ema9g21) {
    emaTrend = ema21g50 === true ? 'bull' : ema21g50 === false ? 'weak-bull' : 'bull';
  } else {
    emaTrend = ema21g50 === false ? 'bear' : ema21g50 === true ? 'weak-bear' : 'bear';
  }

  // ── Directional gate ──────────────────────────────────
  // Both VWAP position and EMA crossover must agree
  const aboveVWAP = curVWAP != null && ltp > curVWAP;
  const belowVWAP = curVWAP != null && ltp < curVWAP;
  const isBull = aboveVWAP && ema9g21;
  const isBear = belowVWAP && !ema9g21;

  // Must have a clear direction — no mixed signals
  if (!isBull && !isBear) return null;

  // ── RSI hard filter — avoid exhaustion zones ──────────
  if (curRSI != null && (curRSI > 80 || curRSI < 20)) return null;

  // ── Scoring engine (0-100) ────────────────────────────
  //   Volume surge    25 pts — heaviest weight; institutions leave volume footprints
  //   VWAP position   20 pts — institutional fair-value anchor
  //   Relative Str    20 pts — beats NIFTY = smart money flowing in
  //   ORB breakout    20 pts — the most reliable intraday entry trigger
  //   EMA alignment   10 pts — trend confirmation
  //   RSI zone         5 pts — momentum not overextended
  let score = 0;

  // 1. Volume — 25 pts (HARD GATE: relativeVolume < 1.5 → reject)
  //    >= 3.0 exceptional · >= 2.0 valid breakout · >= 1.5 partial credit
  if (volRatio < 1.5) return null;
  if (volRatio >= 2.0) score += 25;
  else                 score += 15;
  const volExceptional = volRatio >= 3.0;

  // 2. VWAP — 20 pts
  if (aboveVWAP && isBull) score += 20;
  if (belowVWAP && isBear) score += 20;

  // 3. Relative Strength vs NIFTY — 20 pts
  if (rs != null) {
    if      (isBull && rs >  1.0) score += 20;
    else if (isBull && rs >= 0.0) score += 12;
    else if (isBear && rs < -1.0) score += 20;
    else if (isBear && rs <= 0.0) score += 12;
  }

  // 4. Opening Range — 20 pts
  if (isBull && orbBreakout)  score += 20;
  if (isBear && orbBreakdown) score += 20;

  // 5. EMA trend alignment — 10 pts
  if (curEMA50) {
    if (isBull && curEMA9 > curEMA21 && curEMA21 > curEMA50) score += 10;
    if (isBear && curEMA9 < curEMA21 && curEMA21 < curEMA50) score += 10;
  } else {
    // EMA50 warmup not ready early in session — partial credit
    if (isBull && curEMA9 > curEMA21) score += 5;
    if (isBear && curEMA9 < curEMA21) score += 5;
  }

  // 6. RSI zone — 5 pts
  if (curRSI) {
    if (isBull && curRSI >= 50 && curRSI <= 70) score += 5;
    if (isBear && curRSI >= 30 && curRSI <= 50) score += 5;
  }

  // Only surface score >= 70
  if (score < 70) return null;

  const signalType = score >= 80 ? 'STRONG' : 'WATCH';
  const direction  = isBull ? 'BULL' : 'BEAR';

  // ── ENTRY STATE MACHINE ───────────────────────────────
  // DETECTED       score >= 70, no pullback yet — do not chase
  // WAITING_ENTRY  price has pulled near EMA9 / VWAP — arm the trigger
  // TRIGGER        pullback done + current candle breaks prev candle
  //                high (bull) / low (bear) → actionable BUY / SELL
  const PB_TOL = 1.002;                 // 0.2% proximity tolerance
  const lookback = Math.min(6, tn);     // pullback window: last 6 candles
  // global-row offset of today's first candle (for EMA9 lookup)
  const offset = n - tn;

  function nearSupport(i) {             // i = today index
    const e9 = ema9Arr[offset + i], vw = vwapArr[i];
    const r  = todayRows[i];
    if (isBull) {
      return (e9 != null && r.low <= e9 * PB_TOL) ||
             (vw != null && r.low <= vw * PB_TOL);
    }
    return (e9 != null && r.high >= e9 / PB_TOL) ||
           (vw != null && r.high >= vw / PB_TOL);
  }

  let pulledBack = false;
  for (let i = tn - lookback; i <= tn; i++) {
    if (i >= 0 && nearSupport(i)) { pulledBack = true; break; }
  }

  const prevCandle = todayRows[tn - 1];
  const brokeOut = prevCandle
    ? (isBull ? todayRows[tn].high > prevCandle.high
              : todayRows[tn].low  < prevCandle.low)
    : false;

  let entryState, tradeSignal = null;
  if (pulledBack && brokeOut) {
    entryState  = 'TRIGGER';
    tradeSignal = isBull ? 'BUY' : 'SELL';
  } else if (pulledBack || nearSupport(tn)) {
    entryState = 'WAITING_ENTRY';
  } else {
    entryState = 'DETECTED';
  }

  // ── Risk engine — ATR(14) based ───────────────────────
  const atrVal = curATR || (ltp * 0.015);
  let entry, sl, t1, t2;

  if (isBull) {
    // trigger level = break of previous candle high (or current if no prev)
    const trigHigh = prevCandle ? Math.max(prevCandle.high, todayRows[tn].high) : todayRows[tn].high;
    entry = +(trigHigh + 0.05).toFixed(2);
    sl    = +(entry - atrVal).toFixed(2);
    const risk = entry - sl;
    t1 = +(entry + 1.5 * risk).toFixed(2);
    t2 = +(entry + 2.0 * risk).toFixed(2);
  } else {
    const trigLow = prevCandle ? Math.min(prevCandle.low, todayRows[tn].low) : todayRows[tn].low;
    entry = +(trigLow - 0.05).toFixed(2);
    sl    = +(entry + atrVal).toFixed(2);
    const risk = sl - entry;
    t1 = +(entry - 1.5 * risk).toFixed(2);
    t2 = +(entry - 2.0 * risk).toFixed(2);
  }

  const rr = +(Math.abs(t2 - entry) / Math.abs(entry - sl)).toFixed(2);

  return {
    ticker:     sym,
    name,
    ltp:        +ltp.toFixed(2),
    changePct:  +changePct.toFixed(2),
    gapPct:     +gapPct.toFixed(2),
    vwap:       curVWAP  ? +curVWAP.toFixed(2)  : null,
    vwapStatus: aboveVWAP ? 'above' : 'below',
    ema9:       curEMA9  ? +curEMA9.toFixed(2)  : null,
    ema21:      curEMA21 ? +curEMA21.toFixed(2) : null,
    ema50:      curEMA50 ? +curEMA50.toFixed(2) : null,
    emaTrend,
    rsi:        curRSI   ? +curRSI.toFixed(1)   : null,
    atr:        curATR   ? +curATR.toFixed(2)   : null,
    atrPct:     +atrPct.toFixed(2),
    volRatio:   +volRatio.toFixed(2),
    volume:     tVolumes[tn],
    rs:         rs != null ? +rs.toFixed(2) : null,
    orbHigh:    orbHigh ? +orbHigh.toFixed(2) : null,
    orbLow:     orbLow  ? +orbLow.toFixed(2)  : null,
    orbStatus:  orbBreakout ? 'breakout' : orbBreakdown ? 'breakdown' : 'inside',
    score,
    signalType,
    direction,
    entryState,            // DETECTED | WAITING_ENTRY | TRIGGER
    tradeSignal,           // BUY | SELL | null
    volExceptional,
    entry, sl, t1, t2, rr,
    candles:    todayRows.length,
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
  const cfg = {
    minPrice:  parseFloat(body?.minPrice)  || 50,
    minATRpct: parseFloat(body?.minATRpct) || 0.5,
  };

  // ── Angel One (optional — real-time data; Yahoo fallback) ──
  const angelKey    = (body?.angelKey    || '').trim();
  const angelClient = (body?.angelClient || '').trim();
  let jwt = null, angelError = null;
  if (angelKey && angelClient) {
    try { jwt = await angel.authenticate(angelKey, angelClient); }
    catch (e) { angelError = e.message; }
  }

  // ── NO-TRADE WINDOW: 09:15–09:30 IST ──────────────────
  // Opening volatility trap — collect data only, no signals.
  const istNow  = toIST(new Date());
  const minsNow = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const inNoTradeWindow = minsNow >= 9 * 60 + 15 && minsNow < 9 * 60 + 30;
  if (inNoTradeWindow) {
    const hh2 = String(istNow.getUTCHours()).padStart(2, '0');
    const mm2 = String(istNow.getUTCMinutes()).padStart(2, '0');
    return res.status(200).json({
      ok: true, noTradeWindow: true,
      signals: [], strong: [], watch: [],
      scanned: 0, found: 0, scanTime: `${hh2}:${mm2}`,
      marketOpen: true, niftyChange: null,
      message: 'No-trade window (09:15–09:30 IST) — collecting data only. Scanner starts 09:30.',
    });
  }

  // Fetch NIFTY once (used for RS calculation on every symbol)
  const niftyData = await fetchNifty().catch(() => null);

  // Scan in parallel batches of 8
  const results = [];
  for (let i = 0; i < symbols.length; i += 8) {
    const batch   = symbols.slice(i, i + 8);
    const settled = await Promise.all(batch.map(async sym => {
      try {
        return await scanSymbol(sym, prevCloses[sym] ?? null, avgDailyVols[sym] ?? null, niftyData, cfg, jwt, angelKey);
      } catch { return null; }
    }));
    for (const r of settled) if (r) results.push(r);
  }

  // Sort: score desc → volRatio desc
  results.sort((a, b) => b.score - a.score || b.volRatio - a.volRatio);

  const strong = results.filter(r => r.signalType === 'STRONG');
  const watch  = results.filter(r => r.signalType === 'WATCH');

  const ist  = toIST(new Date());
  const hh   = String(ist.getUTCHours()).padStart(2, '0');
  const mm   = String(ist.getUTCMinutes()).padStart(2, '0');
  const mNow = ist.getUTCHours() * 60 + ist.getUTCMinutes();

  return res.status(200).json({
    ok:          true,
    noTradeWindow: false,
    signals:     results,          // all scored results (score >= 70), sorted
    strong,                        // score >= 80 — act now
    watch,                         // score 70-79 — monitor
    scanned:     symbols.length,
    found:       results.length,
    scanTime:    `${hh}:${mm}`,
    marketOpen:  mNow >= 9 * 60 + 15 && mNow <= 15 * 60 + 30,
    niftyChange: niftyData?.niftyChange != null ? +niftyData.niftyChange.toFixed(2) : null,
    dataSource:  jwt ? 'angel' : 'yahoo',
    angelError,
  });
};

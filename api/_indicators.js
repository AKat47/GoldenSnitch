// api/_indicators.js — Shared technical indicator helpers for backtest APIs

// Simple Moving Average
function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += arr[j];
    return sum / period;
  });
}

// Wilder's smoothing (used in ADX)
function wilderSmooth(arr, period) {
  const result = new Array(arr.length).fill(null);
  let sum = 0;
  let start = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    if (start === -1) { start = i; }
    if (i - start < period - 1) { sum += arr[i]; continue; }
    if (i - start === period - 1) { sum += arr[i]; result[i] = sum / period; continue; }
    result[i] = (result[i-1] * (period - 1) + arr[i]) / period;
  }
  return result;
}

// ADX (Average Directional Index), period typically 14
function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  const plusDM  = new Array(n).fill(null);
  const minusDM = new Array(n).fill(null);
  const tr      = new Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    const upMove   = highs[i]  - highs[i-1];
    const downMove = lows[i-1] - lows[i];
    plusDM[i]  = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i]  - closes[i-1]),
      Math.abs(lows[i]   - closes[i-1])
    );
  }

  const smoothTR    = wilderSmooth(tr, period);
  const smoothPlus  = wilderSmooth(plusDM, period);
  const smoothMinus = wilderSmooth(minusDM, period);

  const adxArr = new Array(n).fill(null);
  const diDiff = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (!smoothTR[i] || smoothTR[i] === 0) continue;
    const diPlus  = (smoothPlus[i]  / smoothTR[i]) * 100;
    const diMinus = (smoothMinus[i] / smoothTR[i]) * 100;
    diDiff[i] = Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;
  }

  const smoothDX = wilderSmooth(diDiff, period);
  for (let i = 0; i < n; i++) {
    if (smoothDX[i] != null) adxArr[i] = smoothDX[i];
  }
  return adxArr;
}

// 20-day average volume
function avgVolume(volumes, period = 20) {
  return sma(volumes, period);
}

// Fetch Nifty 50 (^NSEI) daily closes → { date: close } map
// Used for the relative-strength-vs-Nifty filter.
// Returns null if fetch fails (filter should be skipped gracefully).
function fetchNiftyMap(httpsGet) {
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 1200 * 86400;
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI`
    + `?period1=${from}&period2=${to}&interval=1d`;
  return httpsGet(url).then(json => {
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const ts     = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const map    = {};
    ts.forEach((t, i) => {
      if (closes[i] != null) {
        map[new Date(t * 1000).toISOString().split('T')[0]] = closes[i];
      }
    });
    return map;
  }).catch(() => null);
}

// Given a date→close Nifty map and a target date, find the closest available price.
function niftyPriceAt(map, date) {
  if (!map) return null;
  if (map[date]) return map[date];
  // walk back up to 5 trading days
  const d = new Date(date);
  for (let i = 1; i <= 5; i++) {
    d.setDate(d.getDate() - 1);
    const key = d.toISOString().split('T')[0];
    if (map[key]) return map[key];
  }
  return null;
}

// 3-month return of a stock at a given index (63 trading days ≈ 3 months)
function threeMonthReturn(closes, idx, tradingDays = 63) {
  const startIdx = idx - tradingDays;
  if (startIdx < 0) return null;
  return (closes[idx] - closes[startIdx]) / closes[startIdx] * 100;
}

module.exports = { sma, adx, avgVolume, fetchNiftyMap, niftyPriceAt, threeMonthReturn };

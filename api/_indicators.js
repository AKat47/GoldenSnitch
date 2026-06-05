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

module.exports = { sma, adx, avgVolume };

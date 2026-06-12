// api/_candles.js — Angel One 5-minute candle provider
//
// Fixes: scanner received LTP but no OHLCV — Angel's historical API
// (getCandleData) allows ~3 requests/sec; firing 8 in parallel got
// throttled and errors were silently swallowed.
//
// Design:
//   • In-memory candle store (per warm serverless instance):
//       sym → { date, rows[], lastTs }
//   • Startup (cold / new symbol): full fetch — 4 calendar days of
//     FIVE_MINUTE candles (prior session warms up EMA50 / RSI14).
//   • During market: incremental fetch — only candles after lastTs are
//     requested and appended. Candles < 5 min old are served from cache.
//   • Throttled batch loader: 3 requests/sec (Angel's documented limit).
//   • Nothing fails silently: loadBatch reports loaded / failed symbols
//     so the scanner can show "Waiting for candle data" instead of
//     silently returning zero signals.
//
// Indicators are ALWAYS calculated from these candles — never from
// LTP ticks. (LTP/WebSocket is display-only.)

const angel = require('./_angel');

const _store = new Map(); // sym → { date, rows, lastTs }

// ── IST helpers ───────────────────────────────────────────
function toIST(d)      { return new Date(d.getTime() + 5.5 * 3600 * 1000); }
function istDateStr(d) { return toIST(d).toISOString().split('T')[0]; }
function istMinsOf(d)  { const i = toIST(d); return i.getUTCHours() * 60 + i.getUTCMinutes(); }

function istStampFromTs(ts) { // unix sec → 'YYYY-MM-DD HH:mm' IST
  const i = new Date((ts + 5.5 * 3600) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${i.getUTCFullYear()}-${p(i.getUTCMonth() + 1)}-${p(i.getUTCDate())} ${p(i.getUTCHours())}:${p(i.getUTCMinutes())}`;
}

// Angel candle row: [timestamp, open, high, low, close, volume]
function mapRow(r) {
  const d = new Date(r[0]); // "2026-06-12T09:15:00+05:30"
  return {
    ts:      Math.floor(d.getTime() / 1000),
    istDate: istDateStr(d),
    mins:    istMinsOf(d),
    open: r[1], high: r[2], low: r[3], close: r[4],
    volume: r[5] ?? 0,
  };
}

// ── Single-symbol fetch (full or incremental) ─────────────
// Returns { rows, hitApi } — rows is null on failure.
async function getCandles(sym, jwt, angelKey) {
  const today  = istDateStr(new Date());
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = _store.get(sym);

  // Cache hit, current candle still forming → no API call
  if (cached && cached.date === today && nowSec - cached.lastTs < 290) {
    return { rows: cached.rows, hitApi: false };
  }

  // Incremental: append candles after lastTs
  if (cached && cached.date === today && cached.rows.length) {
    const raw = await angel.fetchCandles(
      sym, 'FIVE_MINUTE', istStampFromTs(cached.lastTs), angel.istNowStr(), jwt, angelKey);
    const fresh = raw.map(mapRow).filter(r => r.ts > cached.lastTs && r.close != null);
    if (fresh.length) {
      cached.rows.push(...fresh);
      cached.lastTs = cached.rows[cached.rows.length - 1].ts;
    }
    return { rows: cached.rows, hitApi: true };
  }

  // Full fetch: 4 calendar days (≥ 2 sessions incl. weekend) for warmup
  const raw  = await angel.fetchCandles(
    sym, 'FIVE_MINUTE', angel.istStr(angel.daysAgoIST(4), '09:15'), angel.istNowStr(), jwt, angelKey);
  const rows = raw.map(mapRow).filter(r => r.close != null);
  if (!rows.length) return { rows: null, hitApi: true };

  _store.set(sym, { date: today, rows, lastTs: rows[rows.length - 1].ts });
  return { rows, hitApi: true };
}

// ── Throttled batch loader — 3 req/sec ────────────────────
// Returns { data: {sym: rows}, loaded, failed: [sym], requested }
async function loadBatch(symbols, jwt, angelKey) {
  const data = {}, failed = [], needApi = [];
  const today  = istDateStr(new Date());
  const nowSec = Math.floor(Date.now() / 1000);

  // Serve cache-fresh symbols instantly; queue the rest
  for (const sym of symbols) {
    const c = _store.get(sym);
    if (c && c.date === today && nowSec - c.lastTs < 290) data[sym] = c.rows;
    else needApi.push(sym);
  }

  for (let i = 0; i < needApi.length; i += 3) {
    const chunk   = needApi.slice(i, i + 3);
    const settled = await Promise.all(chunk.map(async sym => {
      try { const { rows } = await getCandles(sym, jwt, angelKey); return [sym, rows]; }
      catch (e) { return [sym, null]; }
    }));
    for (const [sym, rows] of settled) {
      if (rows && rows.length >= 15) data[sym] = rows;
      else failed.push(sym);
    }
    if (i + 3 < needApi.length) await new Promise(r => setTimeout(r, 1050)); // 3 req/sec
  }

  return { data, loaded: Object.keys(data).length, failed, requested: symbols.length };
}

module.exports = { getCandles, loadBatch, istDateStr };

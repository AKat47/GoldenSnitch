// api/data.js — Fetch 400 days of daily OHLC from Yahoo Finance
// GET /api/data?symbol=RELIANCE

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
    req.on('error', reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const sym = (req.query.symbol || '').toUpperCase().trim();
  if (!sym) return res.status(400).json({ ok: false, error: 'symbol required' });

  const ticker = sym.includes('.') ? sym : sym + '.NS';
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 400 * 86400; // 400 days back

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${from}&period2=${to}&interval=1d&events=history`;

  try {
    const json = await httpsGet(url);
    const result = json?.chart?.result?.[0];
    if (!result) return res.status(200).json({ ok: false, error: 'Symbol not found on Yahoo Finance' });

    const ts     = result.timestamp || [];
    const ohlcv  = result.indicators?.quote?.[0] || {};
    const closes = ohlcv.close  || [];
    const highs  = ohlcv.high   || [];
    const lows   = ohlcv.low    || [];
    const opens  = ohlcv.open   || [];
    const meta   = result.meta  || {};

    // Zip into candle array, filter nulls
    const candles = ts.map((t, i) => ({
      date:  new Date(t * 1000).toISOString().split('T')[0],
      open:  opens[i],
      high:  highs[i],
      low:   lows[i],
      close: closes[i]
    })).filter(c => c.close != null && c.open != null);

    return res.status(200).json({
      ok: true,
      symbol: sym,
      name: meta.longName || meta.shortName || sym,
      currency: meta.currency || 'INR',
      candles
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

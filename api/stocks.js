// api/stocks.js — Fetch complete NSE equity list from NSE archives
// Returns: [{ ticker, name }]  (all ~2000+ listed NSE equities)

const https = require('https');

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/csv,text/plain,*/*',
        'Referer': 'https://www.nseindia.com'
      }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

function parseCsv(csv) {
  const lines = csv.split('\n').slice(1); // skip header
  const stocks = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const ticker = (cols[0] || '').trim().replace(/"/g, '');
    const name   = (cols[1] || '').trim().replace(/"/g, '');
    const series = (cols[2] || '').trim().replace(/"/g, '');
    // Only EQ series (main equity, not futures/warrants/bonds)
    if (ticker && name && series === 'EQ') {
      stocks.push({ ticker, name });
    }
  }
  return stocks;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Return cache if fresh
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) {
    return res.status(200).json({ ok: true, stocks: _cache, cached: true });
  }

  try {
    const csv = await fetchCsv('https://archives.nseindia.com/content/equities/EQUITY_L.csv');
    const stocks = parseCsv(csv);
    if (stocks.length < 100) throw new Error('NSE list too short — likely blocked');
    _cache = stocks;
    _cacheTime = Date.now();
    return res.status(200).json({ ok: true, stocks, cached: false });
  } catch (e) {
    // Fallback: return cached data even if stale
    if (_cache) return res.status(200).json({ ok: true, stocks: _cache, cached: true, stale: true });
    return res.status(200).json({ ok: false, error: e.message });
  }
};

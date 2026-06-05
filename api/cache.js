// api/cache.js — Daily results cache in MongoDB
//
// Supports three cache types via ?type= query param:
//   (default)   → scan_cache        (golden cross scanner, keyed by IST date)
//   backtest    → backtest_cache     (hold-till-now backtest, keyed by IST date)
//   backtest2   → backtest2_cache    (10% TP/SL backtest, keyed by IST date)
//
// GET  /api/cache[?type=backtest]  → returns today's cached results
// POST /api/cache[?type=backtest]  → saves results for today
//
// Required env var: MONGODB_URI

const { MongoClient } = require('mongodb');

let _client = null;
async function getDb() {
  if (!_client) {
    _client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await _client.connect();
  }
  return _client.db('goldensnitch');
}

function istDateKey() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split('T')[0];
}

const ALLOWED_TYPES = { '': 'scan_cache', 'backtest': 'backtest_cache', 'backtest2': 'backtest2_cache' };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.MONGODB_URI) {
    return res.status(200).json({ ok: false, error: 'MONGODB_URI not set' });
  }

  const type = (req.query?.type || '').trim().toLowerCase();
  const colName = ALLOWED_TYPES[type];
  if (!colName) {
    return res.status(400).json({ ok: false, error: `Unknown cache type: ${type}` });
  }

  try {
    const db    = await getDb();
    const col   = db.collection(colName);
    const today = istDateKey();

    // ── GET: return today's cache ───────────────────
    if (req.method === 'GET') {
      const doc = await col.findOne({ _id: today });
      if (!doc) return res.status(200).json({ ok: true, cached: false });
      return res.status(200).json({
        ok: true,
        cached:  true,
        date:    today,
        results: doc.results,
        count:   doc.count,
        savedAt: doc.savedAt
      });
    }

    // ── POST: save today's results ──────────────────
    if (req.method === 'POST') {
      const body    = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const results = body?.results;
      if (!results) return res.status(400).json({ ok: false, error: 'Missing results' });

      const count = Array.isArray(results) ? results.length : Object.keys(results).length;

      await col.updateOne(
        { _id: today },
        { $set: { results, count, savedAt: new Date() } },
        { upsert: true }
      );

      // Auto-expire old docs after 3 days
      await col.createIndex({ savedAt: 1 }, { expireAfterSeconds: 3 * 86400, background: true })
        .catch(() => {});

      return res.status(200).json({ ok: true, saved: true, date: today, count });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

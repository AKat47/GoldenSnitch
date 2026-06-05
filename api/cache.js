// api/cache.js — Daily golden cross results cache in MongoDB
// GET  /api/cache          → returns today's cached results (IST date)
// POST /api/cache          → saves results for today
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
  // Returns YYYY-MM-DD in IST
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split('T')[0];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.MONGODB_URI) {
    return res.status(200).json({ ok: false, error: 'MONGODB_URI not set' });
  }

  try {
    const db  = await getDb();
    const col = db.collection('scan_cache');
    const today = istDateKey();

    // ── GET: return today's cache ───────────────────
    if (req.method === 'GET') {
      const doc = await col.findOne({ _id: today });
      if (!doc) return res.status(200).json({ ok: true, cached: false });
      return res.status(200).json({
        ok: true,
        cached: true,
        date: today,
        results: doc.results,
        count: doc.count,
        savedAt: doc.savedAt
      });
    }

    // ── POST: save today's results ──────────────────
    if (req.method === 'POST') {
      const body    = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const results = body?.results;
      if (!results) return res.status(400).json({ ok: false, error: 'Missing results' });

      await col.updateOne(
        { _id: today },
        { $set: {
            results,
            count:   Object.keys(results).length,
            savedAt: new Date()
        }},
        { upsert: true }
      );

      // Auto-expire old docs after 3 days
      await col.createIndex({ savedAt: 1 }, { expireAfterSeconds: 3 * 86400, background: true })
        .catch(() => {});

      return res.status(200).json({ ok: true, saved: true, date: today });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

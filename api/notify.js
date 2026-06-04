// api/notify.js — Twilio WhatsApp notification proxy
// POST /api/notify  body: { message: '...' }
// Env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_TO

const https = require('https');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM;
  const to         = process.env.TWILIO_TO;

  if (!accountSid || !authToken || !from || !to)
    return res.status(200).json({ ok: false, error: 'Twilio env vars not set' });

  const body    = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const message = body?.message;
  if (!message) return res.status(400).json({ ok: false, error: 'Missing message' });

  const payload = new URLSearchParams({ From: from, To: to, Body: message }).toString();
  const auth    = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  return new Promise(resolve => {
    const r = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Basic ${auth}`
      }
    }, resp => {
      let d = '';
      resp.on('data', c => (d += c));
      resp.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(res.status(200).json(resp.statusCode < 300
            ? { ok: true, sid: j.sid }
            : { ok: false, error: j.message }));
        } catch { resolve(res.status(200).json({ ok: false })); }
      });
    });
    r.on('error', e => resolve(res.status(200).json({ ok: false, error: e.message })));
    r.write(payload);
    r.end();
  });
};

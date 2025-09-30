// api/debug/tilda-echo.js
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');

    const ct = (req.headers['content-type'] || '').toLowerCase();
    let parsed = null;

    if (ct.includes('application/json')) {
      try { parsed = JSON.parse(raw); } catch {}
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      parsed = Object.fromEntries(new URLSearchParams(raw));
      if (parsed.payment && typeof parsed.payment === 'string') {
        try { parsed.payment = JSON.parse(parsed.payment); } catch {}
      }
    } else {
      try { parsed = JSON.parse(raw); } catch {
        try { parsed = Object.fromEntries(new URLSearchParams(raw)); } catch {}
      }
    }

    const topKeys = parsed ? Object.keys(parsed).sort() : [];
    const paymentKeys = parsed?.payment && typeof parsed.payment === 'object'
      ? Object.keys(parsed.payment).sort()
      : [];

    console.log('TILDA WEBHOOK DEBUG:', { ct, topKeys, paymentKeys, raw });

    res.status(200).json({
      ok: true,
      contentType: ct,
      keys: topKeys,
      paymentKeys,
      sample: parsed
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}

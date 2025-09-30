// api/debug/tilda-echo.js
export const config = { api: { bodyParser: false } }; // важно: берём сырой body

export default async function handler(req, res) {
  try {
    // читаем сырой body как строку
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');

    // Tilda обычно шлёт application/x-www-form-urlencoded или json
    const ct = (req.headers['content-type'] || '').toLowerCase();
    let parsed = null;
    if (ct.includes('application/json')) {
      try { parsed = JSON.parse(raw); } catch {}
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      parsed = Object.fromEntries(new URLSearchParams(raw));
    }

    // Лог в консоль (видно в Vercel → Functions → Logs)
    console.log('TILDA WEBHOOK DEBUG:', {
      method: req.method,
      contentType: ct,
      headers: pick(req.headers, ['user-agent','x-forwarded-for','content-type']),
      rawBody: raw,
      parsed
    });

    // Возвращаем всё назад, чтобы ты увидел в ответе
    res.status(200).json({
      ok: true,
      method: req.method,
      contentType: ct,
      headers: pick(req.headers, ['user-agent','x-forwarded-for','content-type']),
      rawBody: raw,
      parsed
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

function pick(obj, keys) { const out = {}; keys.forEach(k => { if (k in obj) out[k] = obj[k]; }); return out; }

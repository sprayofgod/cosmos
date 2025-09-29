// api/webhook/tilda-paid.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'METHOD_NOT_ALLOWED' });

    const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok:false, error:'BAD_JSON' });
    }

    const status = String(body.payment_status || body.status || '').toLowerCase();

    // быстрый выход: не paid -> не трогаем БД/SMTP
    if (status !== 'paid') {
      return res.status(200).json({ ok:true, skip:'not paid', status });
    }

    // флаги диагностики
    const NO_DB   = process.env.NO_DB === '1';
    const NO_MAIL = process.env.NO_MAIL === '1';

    const missing = [];
    if (!process.env.TICKET_SECRET) missing.push('TICKET_SECRET');
    if (!NO_DB && !process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!NO_MAIL) {
      ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM'].forEach(k => !process.env[k] && missing.push(k));
    }
    if (missing.length) return res.status(500).json({ ok:false, error:'ENV_MISSING', missing });

    const order_id   = String(body.orderid || body.order_id || '').trim();
    const email      = String(body.email || '').trim().toLowerCase();
    const name       = String(body.name || '').trim();
    const ticketType = String(body.ticket_type || 'Стандарт').trim();
    const qty        = Number(body.tickets_qty || body.quantity || 1);
    const event_id   = process.env.EVENT_ID || 'event';
    const eventName  = process.env.EVENT_NAME || 'Мероприятие';

    if (!order_id || !email || !Number.isFinite(qty) || qty < 1) {
      return res.status(400).json({ ok:false, error:'BAD_PAYLOAD', sample:{ orderid:'STR', email:'STR', tickets_qty:'INT>=1' }});
    }

    const { randomUUID }            = await import('node:crypto');
    const { makeToken, tokenToPng } = await import('../../_lib/qr.js');

    let db = null, sendTicketEmail = null;
    if (!NO_DB)   ({ db } = await import('../../_lib/db.js'));
    if (!NO_MAIL) ({ sendTicketEmail } = await import('../../_lib/mailer.js'));

    let issued = 0;
    for (let i = 0; i < qty; i++) {
      const tid   = randomUUID();
      const token = makeToken({ tid, order_id, event_id });
      const sign  = token.split('.').pop();

      if (!NO_DB) {
        try {
          await db.query(
            `insert into tickets (id, order_id, event_id, email, name, ticket_type, status, signature)
             values ($1,$2,$3,$4,$5,$6,'unused',$7)`,
            [tid, order_id, event_id, email, name, ticketType, sign]
          );
        } catch (e) { return res.status(500).json({ ok:false, error:'DB_INSERT_FAILED', message:e.message }); }
      }

      const png = await tokenToPng(token, 600);

      if (!NO_MAIL) {
        const html = `
          <p>Здравствуйте${name ? `, ${escapeHtml(name)}` : ''}!</p>
          <p>Ваш QR-билет на «${escapeHtml(eventName)}».</p>
          <p><strong>Номер заказа:</strong> ${escapeHtml(order_id)}<br>
             <strong>Тип билета:</strong> ${escapeHtml(ticketType)}</p>
          <p>Резервный код: <code style="word-break:break-all">${escapeHtml(token)}</code></p>
          <img src="cid:qr@${tid}" alt="QR" width="300" height="300"/>`;
        try {
          await sendTicketEmail({
            to: email, subject: `Ваш билет – ${eventName}`, html,
            attachments: [{ filename:`ticket-${tid}.png`, content: png, cid:`qr@${tid}` }]
          });
        } catch (e) { return res.status(500).json({ ok:false, error:'SMTP_SEND_FAILED', message:e.message }); }
      }

      issued++;
    }
    return res.status(200).json({ ok:true, issued });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'SERVER_ERROR', message: e?.message || String(e) });
  }
}
function safeJson(s){ try { return JSON.parse(s); } catch { return null; } }
function escapeHtml(str=''){ return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

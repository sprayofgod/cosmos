export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).end();

    // На некоторых конфигах body бывает строкой
    const raw = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
    const status = String(raw.payment_status || raw.status || '').toLowerCase();

    // Быстрая ветка: НЕ paid -> даже не трогаем БД/SMTP
    if (status !== 'paid') {
      return res.status(200).json({ ok: true, skip: 'not paid', status });
    }

    // ===== Ниже грузим тяжёлые зависимости только при paid =====
    const crypto = await import('crypto').then(m => m.default || m);
    const { db } = await import('../../_lib/db.js');
    const { makeToken, tokenToPng } = await import('../../_lib/qr.js');
    const { sendTicketEmail } = await import('../../_lib/mailer.js');

    const order_id   = String(raw.orderid || raw.order_id || '').trim();
    const email      = String(raw.email || '').trim().toLowerCase();
    const name       = String(raw.name || '').trim();
    const ticketType = String(raw.ticket_type || 'Стандарт').trim();
    const qty        = Number(raw.tickets_qty || raw.quantity || 1);
    const event_id   = process.env.EVENT_ID || 'event';

    if (!order_id || !email || qty < 1) {
      return res.status(400).json({ ok: false, error: 'BAD_PAYLOAD' });
    }

    const issued = [];
    for (let i = 0; i < qty; i++) {
      const tid    = crypto.randomUUID();
      const token  = makeToken({ tid, order_id, event_id });
      const sign   = token.split('.').pop();

      await db.query(
        `insert into tickets (id, order_id, event_id, email, name, ticket_type, status, signature)
         values ($1,$2,$3,$4,$5,$6,'unused',$7)`,
        [tid, order_id, event_id, email, name, ticketType, sign]
      );

      const png       = await tokenToPng(token, 600);
      const eventName = process.env.EVENT_NAME || 'Мероприятие';

      const html = `
        <p>Здравствуйте${name ? `, ${escapeHtml(name)}` : ''}!</p>
        <p>Ваш QR-билет на «${escapeHtml(eventName)}».</p>
        <p><strong>Номер заказа:</strong> ${escapeHtml(order_id)}<br>
           <strong>Тип билета:</strong> ${escapeHtml(ticketType)}</p>
        <p>Покажите QR на входе. Резервный код:<br>
           <code style="word-break:break-all">${escapeHtml(token)}</code></p>
        <img src="cid:qr@${tid}" alt="QR" width="300" height="300"/>
      `;

      await sendTicketEmail({
        to: email,
        subject: `Ваш билет – ${eventName}`,
        html,
        attachments: [{ filename: `ticket-${tid}.png`, content: png, cid: `qr@${tid}` }]
      });

      issued.push(tid);
    }

    return res.status(200).json({ ok: true, issued: issued.length });

  } catch (e) {
    console.error('tilda-paid error:', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function escapeHtml(str=''){ return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
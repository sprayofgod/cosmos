export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'METHOD_NOT_ALLOWED' });

    // На Vercel body может быть объектом или строкой
    const rawBody = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    const status  = String(rawBody.payment_status || rawBody.status || '').toLowerCase();

    // Если это не paid — выходим РАНО, не трогая БД/SMTP (чтобы не падать)
    if (status !== 'paid') {
      return res.status(200).json({ ok:true, skip:'not paid', status });
    }

    // Проверка env (чаще всего 500 из-за пустых переменных)
    const missing = [
      'DATABASE_URL','TICKET_SECRET',
      'SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM'
    ].filter(k => !process.env[k]);
    if (missing.length) {
      return res.status(500).json({
        ok:false,
        error:'ENV_MISSING',
        details: missing
      });
    }

    // Ленивая загрузка тяжёлых зависимостей (после всех валидаций)
    const { createHmac, randomUUID } = await import('node:crypto');
    const { db } = await import('../../_lib/db.js');                 // pg или mysql2 внутри
    const { makeToken, tokenToPng } = await import('../../_lib/qr.js');
    const { sendTicketEmail } = await import('../../_lib/mailer.js');

    // Поля из тела
    const order_id   = String(rawBody.orderid || rawBody.order_id || '').trim();
    const email      = String(rawBody.email || '').trim().toLowerCase();
    const name       = String(rawBody.name || '').trim();
    const ticketType = String(rawBody.ticket_type || 'Стандарт').trim();
    const qty        = Number(rawBody.tickets_qty || rawBody.quantity || 1);
    const event_id   = process.env.EVENT_ID || 'event';
    const eventName  = process.env.EVENT_NAME || 'Мероприятие';

    if (!order_id || !email || !Number.isFinite(qty) || qty < 1) {
      return res.status(400).json({ ok:false, error:'BAD_PAYLOAD', sample:{ orderid:'STR', email:'STR', tickets_qty:'INT>=1' }});
    }

    const issued = [];
    for (let i = 0; i < qty; i++) {
      const tid   = randomUUID();
      const token = makeToken({ tid, order_id, event_id });
      const sign  = token.split('.').pop();

      try {
        // Вставка в БД
        await db.query(
          // ВНИМАНИЕ: для MySQL версия запроса другая (values (?,?,?,?,?,?,'unused',?))
          `insert into tickets (id, order_id, event_id, email, name, ticket_type, status, signature)
           values ($1,$2,$3,$4,$5,$6,'unused',$7)`,
          [tid, order_id, event_id, email, name, ticketType, sign]
        );
      } catch (e) {
        // Возвращаем подробности — поможет быстро понять, что с БД
        return res.status(500).json({ ok:false, error:'DB_INSERT_FAILED', message:e.message });
      }

      let png;
      try {
        png = await tokenToPng(token, 600);
      } catch (e) {
        return res.status(500).json({ ok:false, error:'QR_GEN_FAILED', message:e.message });
      }

      // Формируем письмо
      const html = `
        <p>Здравствуйте${name ? `, ${escapeHtml(name)}` : ''}!</p>
        <p>Ваш QR-билет на «${escapeHtml(eventName)}».</p>
        <p><strong>Номер заказа:</strong> ${escapeHtml(order_id)}<br>
           <strong>Тип билета:</strong> ${escapeHtml(ticketType)}</p>
        <p>Покажите QR на входе. Резервный код:<br>
           <code style="word-break:break-all">${escapeHtml(token)}</code></p>
        <img src="cid:qr@${tid}" alt="QR" width="300" height="300"/>
      `;

      try {
        await sendTicketEmail({
          to: email,
          subject: `Ваш билет – ${eventName}`,
          html,
          attachments: [{ filename: `ticket-${tid}.png`, content: png, cid: `qr@${tid}` }]
        });
      } catch (e) {
        return res.status(500).json({ ok:false, error:'SMTP_SEND_FAILED', message:e.message });
      }

      issued.push(tid);
    }

    return res.status(200).json({ ok:true, issued: issued.length });

  } catch (e) {
    // Финальный трап — вернём текст ошибки, чтобы не искать её вслепую
    return res.status(500).json({ ok:false, error:'SERVER_ERROR', message: e?.message || String(e) });
  }
}

function safeJson(s){ try { return JSON.parse(s); } catch { return {}; } }
function escapeHtml(str=''){ return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
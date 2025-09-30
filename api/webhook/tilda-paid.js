// api/webhook/tilda-paid.js
// Боевик для Tilda: выпускает билеты ТОЛЬКО после оплаты.
// Особенности:
//  - GET/HEAD -> 200 (проверка доступности)
//  - Режим привязки: ?bind=1  -> всегда 200 OK, НИЧЕГО не делает (нужно для "Добавить вебхук" в Tilda)
//  - Требует payment.orderid (или совместимый ключ) и email в обычном режиме
//  - Ленивые импорты, идемпотентность по (order_id, event_id), понятные ошибки

export default async function handler(req, res) {
  try {
    // Пинг/health-check
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.status(200).json({ ok: true, ping: true });
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    // Парсим тело безопасно
    const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'BAD_JSON' });
    }

    // Параметры URL
    const qs = req.url?.split('?')[1] || '';
    const urlParams = new URLSearchParams(qs);
    const BIND_MODE = urlParams.get('bind') === '1'; // <<< режим привязки

    // В режиме привязки просто отвечаем 200 и выходим
    if (BIND_MODE) {
      return res.status(200).json({ ok: true, bind: true });
    }

    // Нормализация базовых полей
    const email = String(body.Email || body.email || '').trim().toLowerCase();
    const name  = String(body.Name  || body.name  || '').trim();
    const ticketType = String(body.ticket_type || 'Стандарт');

    // payment может быть объектом или строкой JSON
    const payment = (typeof body.payment === 'string') ? safeJson(body.payment) : (body.payment || {});
    const rawOrderId = firstNonEmpty(
      payment?.orderid,
      payment?.order_id,
      body['payment.orderid'],
      body['payment.order_id'],
      body.orderid,
      body.order_id,
      body.OrderId,
      body.paymentid,
      payment?.systranid
    );

    // products и qty
    let products = payment?.products || body.products || [];
    if (typeof products === 'string') {
      try { products = JSON.parse(products); } catch { products = []; }
    }
    let qty = 1;
    try {
      if (Array.isArray(products) && products.length) {
        qty = products.reduce((s,p)=>s + (Number(p?.quantity)||0), 0) || 1;
      } else {
        qty = Number(body.tickets_qty || body.quantity) || 1;
      }
    } catch { qty = 1; }

    // В боевом режиме обязателен orderId и email
    if (!rawOrderId) {
      return res.status(400).json({ ok: false, error: 'NO_ORDER_ID', hint: 'payment.orderid is required for production webhooks' });
    }
    if (!email) {
      return res.status(400).json({ ok: false, error: 'NO_EMAIL', hint: 'Email is required to send ticket' });
    }

    // Минимальные env
    const missing = [];
    if (!process.env.TICKET_SECRET) missing.push('TICKET_SECRET');
    if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (missing.length) {
      return res.status(500).json({ ok: false, error: 'ENV_MISSING', missing });
    }

    // Импорты после валидаций
    const { randomUUID } = await import('node:crypto');
    const { makeToken, tokenToPng } = await import('../../_lib/qr.js');
    const { db } = await import('../../_lib/db.js');
    const { sendTicketEmail } = await import('../../_lib/mailer.js');

    const event_id = process.env.EVENT_ID || 'default-event';
    const event_name = process.env.EVENT_NAME || 'Мероприятие';

    // Идемпотентность
    try {
      const chk = await db.query(
        `select count(*)::int as cnt from tickets where order_id=$1 and event_id=$2`,
        [rawOrderId, event_id]
      );
      if (Number(chk.rows?.[0]?.cnt || 0) > 0) {
        return res.status(200).json({ ok: true, issued: 0, existing: chk.rows[0].cnt, order_id: rawOrderId });
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'DB_CHECK_FAILED', message: e?.message || String(e) });
    }

    // Выпуск
    const issued = [];
    for (let i = 0; i < (qty || 1); i++) {
      const tid = randomUUID();
      const token = makeToken({ tid, order_id: rawOrderId, event_id });
      const signature = token.split('.').pop();

      // БД
      try {
        await db.query(
          `insert into tickets (id, order_id, event_id, email, name, ticket_type, status, signature, issued_at)
           values ($1,$2,$3,$4,$5,$6,'unused',$7, now())`,
          [tid, rawOrderId, event_id, email, name || null, ticketType, signature]
        );
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'DB_INSERT_FAILED', message: e?.message || String(e) });
      }

      // QR
      let png;
      try { png = await tokenToPng(token, 600); }
      catch (e) { return res.status(500).json({ ok:false, error:'QR_GEN_FAILED', message: e?.message || String(e) }); }

      // Письмо
      const html = `
        <p>Здравствуйте${name ? `, ${escapeHtml(name)}` : ''}!</p>
        <p>Спасибо за покупку билета на <strong>${escapeHtml(event_name)}</strong>.</p>
        <p><strong>Номер заказа:</strong> ${escapeHtml(rawOrderId)}<br>
           <strong>Тип билета:</strong> ${escapeHtml(ticketType)}</p>
        <p>Покажите QR на входе или назовите резервный код:</p>
        <p><code style="word-break:break-all">${escapeHtml(token)}</code></p>
        <p><img src="cid:qr@${tid}" alt="QR" width="300" height="300"/></p>
      `;
      try {
        await sendTicketEmail({
          to: email,
          subject: `Ваш билет — ${event_name}`,
          html,
          attachments: [{ filename: `ticket-${tid}.png`, content: png, cid: `qr@${tid}` }]
        });
      } catch (e) {
        return res.status(500).json({ ok:false, error:'SMTP_SEND_FAILED', message: e?.message || String(e) });
      }

      issued.push(tid);
    }

    return res.status(200).json({ ok: true, issued: issued.length, order_id: rawOrderId });

  } catch (e) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e?.message || String(e) });
  }
}

/* ---------- helpers ---------- */

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

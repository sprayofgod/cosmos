// api/webhook/tilda-paid.js
// ЕДИНЫЙ URL для привязки И боевой работы:
// - GET/HEAD -> 200 ping
// - Если запрос "проверочный" от Tilda (нет orderid/email) -> 200 bind:true (ничего не делаем)
// - Если есть orderid + email -> выпускаем билеты, пишем в БД, отправляем письмо

export default async function handler(req, res) {
  try {
    // Health check
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.status(200).json({ ok: true, ping: true });
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    // Safe body parse
    const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'BAD_JSON' });
    }

    // Heuristics: запрос пришёл от Tilda?
    const ua = String(req.headers['user-agent'] || '');
    const IS_TILDA = /Tilda\.cc/i.test(ua);

    // Normalize fields
    const email = String(body.Email || body.email || '').trim().toLowerCase();
    const name  = String(body.Name  || body.name  || '').trim();
    const ticketType = String(body.ticket_type || 'Стандарт');

    // payment object or string
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

    // products -> qty
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

    // --- АВТО-БИНД: если Tilda пингует без orderid/email — не ругаемся, просто 200 ---
    // Это позволяет один и тот же URL использовать для "Привязать вебхук" и боевой работы.
    if (IS_TILDA && (!rawOrderId || !email)) {
      return res.status(200).json({ ok: true, bind: true, note: 'noop: no orderid/email (tilda verification)' });
    }

    // Боевой режим: требуем orderid + email
    if (!rawOrderId) {
      return res.status(400).json({ ok: false, error: 'NO_ORDER_ID', hint: 'payment.orderid is required' });
    }
    if (!email) {
      return res.status(400).json({ ok: false, error: 'NO_EMAIL', hint: 'Email is required' });
    }

    // Env checks
    const missing = [];
    if (!process.env.TICKET_SECRET) missing.push('TICKET_SECRET');
    if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (missing.length) {
      return res.status(500).json({ ok: false, error: 'ENV_MISSING', missing });
    }

    // Lazy imports
    const { randomUUID } = await import('node:crypto');
    const { makeToken, tokenToPng } = await import('../../_lib/qr.js');
    const { db } = await import('../../_lib/db.js');
    const { sendTicketEmail } = await import('../../_lib/mailer.js');

    const event_id   = process.env.EVENT_ID   || 'default-event';
    const event_name = process.env.EVENT_NAME || 'Мероприятие';

    // Idempotency
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

    // Issue tickets
    const issued = [];
    for (let i = 0; i < (qty || 1); i++) {
      const tid = randomUUID();
      const token = makeToken({ tid, order_id: rawOrderId, event_id });
      const signature = token.split('.').pop();

      // DB
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

      // Email
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

/* helpers */
function safeJson(s){ try { return JSON.parse(s); } catch { return null; } }
function firstNonEmpty(...vals){
  for (const v of vals){ if (v===undefined || v===null) continue; const s=String(v).trim(); if (s) return s; }
  return '';
}
function escapeHtml(s=''){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

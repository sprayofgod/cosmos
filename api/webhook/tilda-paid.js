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
   <!-- Прехедер (скрыт) -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">
//   Ваш электронный билет на ${escapeHtml(event_name)}. Покажите QR на входе. Резервный код внутри письма.
<h1> QR код билета работает в тестовом режиме! По всем вопросам обращайтесь к организаторам</h1>
  Ваш электронный билет на КОСМОС НАШ. Покажите QR на входе. Резервный код внутри письма.
</div>

<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f7f9;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;background:#ffffff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.06);">
        <!-- Шапка -->
        <tr>
          <td align="center" style="padding:20px 24px;border-bottom:1px solid #eef0f3;">

             <img src="https://static.tildacdn.com/tild3364-3435-4539-b337-623031396262/-.jpg" width="120" height="36" alt="wwww" style="display:block;border:0;"> 
            <div style="font:700 20px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial; color:#1a1d22;">Ваш билет</div>
            <div style="font:400 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Arial; color:#6b7280; margin-top:6px;">КОСМОС НАШ</div>
          </td>
        </tr>

        <!-- Контент -->
        <tr>
          <td style="padding:24px;">
            <div style="font:400 16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#1f2937;">
              Здравствуйте ${name ? `, ${escapeHtml(name)}` : ''}! Спасибо за покупку билета на <strong>КОСМОС НАШ</strong>.
            </div>

            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;background:#f7faf9;border:1px solid #e2e8f0;border-radius:10px;">
              <tr>
                <td style="padding:14px 16px;font:400 14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#374151;">
                  <div><strong>Номер заказа:</strong> ${escapeHtml(rawOrderId)}</div>
                  <div><strong>Тип билета:</strong> ${escapeHtml(ticketType)}</div>
                  <div><strong>Имя:</strong> ${name ? `, ${escapeHtml(name)}` : ''}</div>
                </td>
              </tr>
            </table>

            <!-- QR -->
            <div style="text-align:center;margin:22px 0 10px;">
             <p><img src="cid:qr@${tid}" alt="QR" width="300" height="300"/></p>
            </div>

            <!-- Резервный код -->
            <div style="font:400 13px/1.6 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#111827;background:#f9fafb;border:1px dashed #e5e7eb;border-radius:8px;padding:12px;word-break:break-all;">
              Резервный код (на случай, если QR не сканируется):<br>
              <span style="font-weight:600">${escapeHtml(token)}</span>
            </div>

            <div style="font:400 12px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#6b7280;margin-top:14px;">
              Покажите этот QR код на входе. Не делитесь билетом с третьими лицами. 
            </div>
          </td>
        </tr>

       
      </table>
    </td>
  </tr>
</table>
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

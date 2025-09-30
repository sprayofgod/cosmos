// api/webhook/tilda-paid.js
// Боевик под Tilda payload (пример пришёл: Email, Name, Phone, formid, formname, payment:{orderid,products,amount})
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });

    // Тильда может шлать JSON — но безопасно парсим сырой body
    const rawBody = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    if (!rawBody || typeof rawBody !== 'object') return res.status(400).json({ ok: false, error: 'BAD_JSON' });

    // Normalize keys: Tilda присылает "Email","Name" с большой буквы
    const email = String(rawBody.Email || rawBody.email || '').trim().toLowerCase();
    const name  = String(rawBody.Name  || rawBody.name  || '').trim();
    const phone = String(rawBody.Phone || rawBody.phone || '').trim();
    const formid = String(rawBody.formid || '').trim();
    const formname = String(rawBody.formname || '').trim();

    // payment может быть объектом (у тебя так и есть)
    const payment = (typeof rawBody.payment === 'string') ? safeJson(rawBody.payment) : (rawBody.payment || {});
    const orderId = String(payment?.orderid || rawBody.orderid || rawBody.order_id || '').trim();
    // products может быть массивом [{name, quantity, amount, price}]
    let products = payment?.products || rawBody.products || [];
    if (typeof products === 'string') {
      try { products = JSON.parse(products); } catch { products = []; }
    }
    // qty = сумма quantity в products или 1
    let qty = 1;
    try {
      if (Array.isArray(products) && products.length) {
        qty = products.reduce((s, p) => s + (Number(p?.quantity) || 0), 0) || 1;
      } else {
        qty = Number(rawBody.tickets_qty || rawBody.quantity) || 1;
      }
    } catch { qty = 1; }

    // статус (если нужен) — Tilda в данном webhook не дал явный payment_status в примере,
    // считаем, что этот webhook вызывается ПОСЛЕ успешной оплаты (режим Tilda store).
    // Всё равно добавим защиту: если пришёл статус явно — проверим
    const rawStatus = String(rawBody.payment_status || payment?.status || rawBody.status || '').toLowerCase();
    const paidValues = new Set(['paid', 'success', 'ok', '1', 'true']);
    const isPaidExplicit = rawStatus ? paidValues.has(rawStatus) : true; // если нет статуса — доверяем webhook store

    if (!isPaidExplicit) {
      return res.status(200).json({ ok: true, skip: 'not_paid', status: rawStatus });
    }

    // Диагностические флаги — можно тестировать без БД/MAIL
    const NO_DB = process.env.NO_DB === '1';
    const NO_MAIL = process.env.NO_MAIL === '1';

    // Минимальные env проверки
    const missing = [];
    if (!process.env.TICKET_SECRET) missing.push('TICKET_SECRET');
    if (!NO_DB && !process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!NO_MAIL) {
      ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM'].forEach(k => { if (!process.env[k]) missing.push(k); });
    }
    if (missing.length) return res.status(500).json({ ok: false, error: 'ENV_MISSING', missing });

    if (!orderId) return res.status(400).json({ ok: false, error: 'NO_ORDER_ID' });
    if (!email) return res.status(400).json({ ok: false, error: 'NO_EMAIL' });
    if (!Number.isFinite(qty) || qty < 1) qty = 1;

    // lazy imports AFTER basic validation
    const { randomUUID } = await import('node:crypto');
    const { makeToken, tokenToPng } = await import('../../_lib/qr.js');

    let db = null;
    if (!NO_DB) {
      ({ db } = await import('../../_lib/db.js')); // expects db.query(sql, params)
    }
    let sendTicketEmail = null;
    if (!NO_MAIL) {
      ({ sendTicketEmail } = await import('../../_lib/mailer.js')); // expects sendTicketEmail({to,subject,html,attachments})
    }

    const event_id = process.env.EVENT_ID || 'default-event';
    const event_name = process.env.EVENT_NAME || 'Мероприятие';

    // Idempotency: если по этому orderId и event_id уже есть записи — не выпускам дубли
    if (!NO_DB) {
      try {
        const chk = await db.query(
          `select count(*)::int as cnt from tickets where order_id=$1 and event_id=$2`,
          [orderId, event_id]
        );
        const existing = Number(chk.rows?.[0]?.cnt || 0);
        if (existing > 0) {
          return res.status(200).json({ ok: true, issued: 0, existing });
        }
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'DB_CHECK_FAILED', message: e?.message || String(e) });
      }
    }

    const issuedTickets = [];

    for (let i = 0; i < qty; i++) {
      const tid = randomUUID();
      const token = makeToken({ tid, order_id: orderId, event_id });
      const signature = token.split('.').pop();

      // Save to DB
      if (!NO_DB) {
        try {
          await db.query(
            `insert into tickets (id, order_id, event_id, email, name, ticket_type, status, signature, issued_at)
             values ($1,$2,$3,$4,$5,$6,'unused',$7, now())`,
            [tid, orderId, event_id, email, name || null, String(rawBody.ticket_type || rawBody.ticket_type || 'Стандарт'), signature]
          );
        } catch (e) {
          return res.status(500).json({ ok: false, error: 'DB_INSERT_FAILED', message: e?.message || String(e) });
        }
      }

      // generate QR PNG
      let png;
      try {
        png = await tokenToPng(token, 600);
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'QR_GEN_FAILED', message: e?.message || String(e) });
      }

      // Send mail (if allowed)
      if (!NO_MAIL) {
        const html = `
          <p>Здравствуйте${name ? `, ${escapeHtml(name)}` : ''}!</p>
          <p>Спасибо за покупку билета на <strong>${escapeHtml(event_name)}</strong>.</p>
          <p><strong>Номер заказа:</strong> ${escapeHtml(orderId)}<br>
             <strong>Тип билета:</strong> ${escapeHtml(rawBody.ticket_type || 'Стандарт')}</p>
          <p>Покажите QR на входе или назовите резервный код:</p>
          <p><code style="word-break:break-all">${escapeHtml(token)}</code></p>
          <p><img src="cid:qr@${tid}" alt="QR" width="300" height="300" /></p>
        `;

        try {
          await sendTicketEmail({
            to: email,
            subject: `Ваш билет — ${event_name}`,
            html,
            attachments: [{ filename: `ticket-${tid}.png`, content: png, cid: `qr@${tid}` }]
          });
        } catch (e) {
          return res.status(500).json({ ok: false, error: 'SMTP_SEND_FAILED', message: e?.message || String(e) });
        }
      }

      issuedTickets.push(tid);
    }

    return res.status(200).json({ ok: true, issued: issuedTickets.length, order_id: orderId });

  } catch (e) {
    // Catch all
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e?.message || String(e) });
  }
}

// Helpers
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function escapeHtml(str = '') { return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

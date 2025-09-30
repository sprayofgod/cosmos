// api/webhook/tilda-paid.js
// Поддерживает тестовый режим ?test=1 или body.force_paid = true
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'METHOD_NOT_ALLOWED' });

    // Сырой парсинг тела (более устойчиво)
    const rawBody = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    if (!rawBody || typeof rawBody !== 'object') return res.status(400).json({ ok:false, error:'BAD_JSON' });

    // ---- Test mode detection ----
    const qs = req.url?.split('?')[1] || '';
    const urlParams = new URLSearchParams(qs);
    const TEST_MODE = urlParams.get('test') === '1' || rawBody.force_paid === true || process.env.FORCE_TEST_MODE === '1';

    // Normalize incoming fields (Tilda sends Email/Name with capital letter)
    const email = String(rawBody.Email || rawBody.email || '').trim().toLowerCase();
    const name  = String(rawBody.Name  || rawBody.name  || '').trim();
    const phone = String(rawBody.Phone || rawBody.phone || '').trim();
    const formid = String(rawBody.formid || '').trim();

    // payment object handling
    const payment = (typeof rawBody.payment === 'string') ? safeJson(rawBody.payment) : (rawBody.payment || {});
    // try many variants for order id
    function firstNonEmpty(...vals) {
      for (const v of vals) {
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s) return s;
      }
      return '';
    }
    const rawOrderId = firstNonEmpty(
      payment?.orderid,
      payment?.order_id,
      rawBody['payment.orderid'],
      rawBody['payment.order_id'],
      rawBody.orderid,
      rawBody.order_id,
      rawBody.OrderId,
      rawBody.paymentid,
      payment?.systranid
    );

    // products & qty
    let products = payment?.products || rawBody.products || [];
    if (typeof products === 'string') {
      try { products = JSON.parse(products); } catch { products = []; }
    }
    let qty = 1;
    try {
      if (Array.isArray(products) && products.length) {
        qty = products.reduce((s,p)=>s + (Number(p?.quantity)||0), 0) || 1;
      } else {
        qty = Number(rawBody.tickets_qty || rawBody.quantity) || 1;
      }
    } catch { qty = 1; }

    // status detection
    const rawStatus = String(rawBody.payment_status || payment?.status || rawBody.status || '').toLowerCase();
    const paidValues = new Set(['paid','success','ok','1','true']);
    const isPaidExplicit = rawStatus ? paidValues.has(rawStatus) : false;

    // If not explicitly paid, allow test mode to force processing.
    const shouldProcess = isPaidExplicit || TEST_MODE;

    if (!shouldProcess) {
      return res.status(200).json({ ok:true, skip:'not_paid', status: rawStatus || 'unknown', test_mode: !!TEST_MODE });
    }

    // env flags to control DB / MAIL for tests
    const NO_DB = process.env.NO_DB === '1';
    const NO_MAIL = process.env.NO_MAIL === '1';

    // env checks (minimal)
    const missing = [];
    if (!process.env.TICKET_SECRET) missing.push('TICKET_SECRET');
    if (!NO_DB && !process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!NO_MAIL) {
      ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM'].forEach(k => { if (!process.env[k]) missing.push(k); });
    }
    if (missing.length) return res.status(500).json({ ok:false, error:'ENV_MISSING', missing });

    // decide order id: prefer real, else fallback if allowed
    const allowFallback = process.env.ALLOW_NO_ORDER_ID === '1' || TEST_MODE;
    const fallbackOrderId = `${formid || 'form'}-${Date.now()}`;
    const effectiveOrderId = rawOrderId || (allowFallback ? fallbackOrderId : '');

    if (!effectiveOrderId) {
      return res.status(400).json({ ok:false, error:'NO_ORDER_ID', hint:'Нет orderid и фолбэк запрещён' });
    }

    // lazy imports
    const { randomUUID } = await import('node:crypto');
    const { makeToken, tokenToPng } = await import('../../_lib/qr.js');

    let db = null;
    if (!NO_DB) ({ db } = await import('../../_lib/db.js'));

    let sendTicketEmail = null;
    if (!NO_MAIL) ({ sendTicketEmail } = await import('../../_lib/mailer.js'));

    const event_id = process.env.EVENT_ID || 'default-event';
    const event_name = process.env.EVENT_NAME || 'Мероприятие';

    // idempotency: don't issue if order already exists (only if DB present)
    if (!NO_DB) {
      try {
        const chk = await db.query(`select count(*)::int as cnt from tickets where order_id=$1 and event_id=$2`, [effectiveOrderId, event_id]);
        if ((chk.rows?.[0]?.cnt || 0) > 0) {
          return res.status(200).json({ ok:true, issued:0, existing: chk.rows[0].cnt, order_id: effectiveOrderId });
        }
      } catch (e) {
        return res.status(500).json({ ok:false, error:'DB_CHECK_FAILED', message:e?.message || String(e) });
      }
    }

    const issued = [];
    for (let i=0;i<qty;i++){
      const tid = randomUUID();
      const token = makeToken({ tid, order_id: effectiveOrderId, event_id });
      const signature = token.split('.').pop();

      if (!NO_DB) {
        try {
          await db.query(
            `insert into tickets (id, order_id, event_id, email, name, ticket_type, status, signature, issued_at)
             values ($1,$2,$3,$4,$5,$6,'unused',$7, now())`,
            [tid, effectiveOrderId, event_id, email, name || null, String(rawBody.ticket_type || 'Стандарт'), signature]
          );
        } catch (e) {
          return res.status(500).json({ ok:false, error:'DB_INSERT_FAILED', message:e?.message || String(e) });
        }
      }

      let png;
      try { png = await tokenToPng(token, 600); } catch (e) {
        return res.status(500).json({ ok:false, error:'QR_GEN_FAILED', message: e?.message || String(e) });
      }

      if (!NO_MAIL) {
        const html = `
          <p>Здравствуйте${name ? `, ${escapeHtml(name)}` : ''}!</p>
          <p>Спасибо за покупку билета на <strong>${escapeHtml(event_name)}</strong>.</p>
          <p><strong>Номер заказа:</strong> ${escapeHtml(effectiveOrderId)}</p>
          <p>Покажите QR на входе или назовите резервный код:</p>
          <p><code style="word-break:break-all">${escapeHtml(token)}</code></p>
          <p><img src="cid:qr@${tid}" alt="QR" width="300" height="300"/></p>
        `;
        try {
          await sendTicketEmail({
            to: email,
            subject: `Ваш билет — ${event_name}`,
            html,
            attachments: [{ filename:`ticket-${tid}.png`, content: png, cid:`qr@${tid}` }]
          });
        } catch (e) {
          return res.status(500).json({ ok:false, error:'SMTP_SEND_FAILED', message: e?.message || String(e) });
        }
      }

      issued.push(tid);
    }

    return res.status(200).json({ ok:true, issued: issued.length, order_id: effectiveOrderId, test_mode: !!TEST_MODE });

  } catch (e) {
    return res.status(500).json({ ok:false, error:'SERVER_ERROR', message: e?.message || String(e) });
  }
}

function safeJson(s){ try { return JSON.parse(s); } catch { return null; } }
function escapeHtml(s=''){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

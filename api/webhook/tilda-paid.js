// api/webhook/tilda-paid.js
// Полноценный хэндлер под вебхук Tilda (магазин/оплата).
// Функции:
//  - GET/HEAD -> 200 OK (проверка доступности)
//  - Тест-режим: ?test=1 или body.force_paid=true или FORCE_TEST_MODE=1
//  - Отключение почты на привязке: ?nomail=1 (или TEST_MODE && нет email)
//  - Устойчивый парсинг payment/orderid/products
//  - Ленивые импорты DB/QR/Mailer
//  - Идемпотентность по (order_id, event_id)
//  - Понятные JSON-ошибки вместо безликого 500

export default async function handler(req, res) {
  try {
    // --- Пинг для проверки URL (Tilda при привязке может дергать GET/HEAD) ---
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.status(200).json({ ok: true, ping: true });
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    // --- Безопасный парсинг тела (может быть строка) ---
    const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'BAD_JSON' });
    }

    // --- Параметры URL (для test/nomail/bypass и пр.) ---
    const qs = req.url?.split('?')[1] || '';
    const urlParams = new URLSearchParams(qs);

    // --- Тест-режим (разрешаем обработать без реальной оплаты) ---
    const TEST_MODE =
      urlParams.get('test') === '1' ||
      body.force_paid === true ||
      process.env.FORCE_TEST_MODE === '1';

    // --- Нормализация базовых полей (Tilda шлёт с заглавной) ---
    const email = String(body.Email || body.email || '').trim().toLowerCase();
    const name  = String(body.Name  || body.name  || '').trim();
    const phone = String(body.Phone || body.phone || '').trim();
    const formid = String(body.formid || '').trim();
    const ticketType = String(body.ticket_type || 'Стандарт');

    // --- payment: объект или строка JSON ---
    const payment = (typeof body.payment === 'string') ? safeJson(body.payment) : (body.payment || {});

    // --- Вычисляем order_id, пробуя разные варианты ключей ---
    const rawOrderId = firstNonEmpty(
      payment?.orderid,
      payment?.order_id,
      body['payment.orderid'],
      body['payment.order_id'],
      body.orderid,
      body.order_id,
      body.OrderId,
      body.paymentid,       // встречается у некоторых провайдеров
      payment?.systranid    // системный id транзакции
    );

    // --- Товары и qty ---
    let products = payment?.products || body.products || [];
    if (typeof products === 'string') {
      try { products = JSON.parse(products); } catch { products = []; }
    }
    let qty = 1;
    try {
      if (Array.isArray(products) && products.length) {
        qty = products.reduce((s, p) => s + (Number(p?.quantity) || 0), 0) || 1;
      } else {
        qty = Number(body.tickets_qty || body.quantity) || 1;
      }
    } catch { qty = 1; }

    // --- Статус оплаты (если присутствует) ---
    const rawStatus = String(body.payment_status || payment?.status || body.status || '').toLowerCase();
    const paidValues = new Set(['paid','success','ok','1','true']);
    const isPaidExplicit = rawStatus ? paidValues.has(rawStatus) : false;

    // Если не paid, но тест-режим включён — обрабатываем.
    const shouldProcess = isPaidExplicit || TEST_MODE;
    if (!shouldProcess) {
      return res.status(200).json({ ok: true, skip: 'not_paid', status: rawStatus || 'unknown', test_mode: !!TEST_MODE });
    }

    // --- Флаги окружения (для безопасных тестов) ---
    const NO_DB   = process.env.NO_DB === '1';
    const NO_MAIL = process.env.NO_MAIL === '1';

    // Возможность отключить почту через query (?nomail=1),
    // а также автоматом отключаем отправку в тест-режиме при пустом email.
    const NOMAIL_QS = urlParams.get('nomail') === '1';
    const NO_MAIL_EFFECTIVE = NO_MAIL || NOMAIL_QS || (TEST_MODE && !email);

    // --- Проверка env (минимально необходимого) ---
    const missing = [];
    if (!process.env.TICKET_SECRET) missing.push('TICKET_SECRET');
    if (!NO_DB && !process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!NO_MAIL_EFFECTIVE) {
      ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM'].forEach(k => { if (!process.env[k]) missing.push(k); });
    }
    if (missing.length) {
      return res.status(500).json({ ok: false, error: 'ENV_MISSING', missing });
    }

    // --- Решаем окончательный order_id (фолбэк в тесте или если разрешено ALLOW_NO_ORDER_ID) ---
    const allowFallback = TEST_MODE || process.env.ALLOW_NO_ORDER_ID === '1';
    const fallbackOrderId = `${formid || 'form'}-${Date.now()}`;
    const effectiveOrderId = rawOrderId || (allowFallback ? fallbackOrderId : '');
    if (!effectiveOrderId) {
      return res.status(400).json({ ok: false, error: 'NO_ORDER_ID', hint: 'Нет orderid/order_id/paymentid/systranid. Проверь, что это webhook ПОСЛЕ ОПЛАТЫ или включи ALLOW_NO_ORDER_ID=1/TEST_MODE.' });
    }

    // --- Ленивые импорты после всех валидаций ---
    const { randomUUID } = await import('node:crypto');
    const { makeToken, tokenToPng } = await import('../../_lib/qr.js');

    let db = null;
    if (!NO_DB) {
      ({ db } = await import('../../_lib/db.js')); // db.query(text, params)
    }

    let sendTicketEmail = null;
    if (!NO_MAIL_EFFECTIVE) {
      ({ sendTicketEmail } = await import('../../_lib/mailer.js')); // sendTicketEmail({to,subject,html,attachments})
    }

    const event_id   = process.env.EVENT_ID   || 'default-event';
    const event_name = process.env.EVENT_NAME || 'Мероприятие';

    // --- Идемпотентность по (order_id, event_id) ---
    if (!NO_DB) {
      try {
        const chk = await db.query(
          `select count(*)::int as cnt from tickets where order_id=$1 and event_id=$2`,
          [effectiveOrderId, event_id]
        );
        const existing = Number(chk.rows?.[0]?.cnt || 0);
        if (existing > 0) {
          return res.status(200).json({ ok: true, issued: 0, existing, order_id: effectiveOrderId, test_mode: !!TEST_MODE });
        }
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'DB_CHECK_FAILED', message: e?.message || String(e) });
      }
    }

    // --- Выпуск билетов ---
    const issued = [];
    for (let i = 0; i < (qty || 1); i++) {
      const tid   = randomUUID();
      const token = makeToken({ tid, order_id: effectiveOrderId, event_id });
      const signature = token.split('.').pop();

      // Сохраняем в БД
      if (!NO_DB) {
        try {
          await db.query(
            `insert into tickets (id, order_id, event_id, email, name, ticket_type, status, signature, issued_at)
             values ($1,$2,$3,$4,$5,$6,'unused',$7, now())`,
            [tid, effectiveOrderId, event_id, email || null, name || null, ticketType, signature]
          );
        } catch (e) {
          return res.status(500).json({ ok: false, error: 'DB_INSERT_FAILED', message: e?.message || String(e) });
        }
      }

      // Генерируем QR
      let png;
      try {
        png = await tokenToPng(token, 600);
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'QR_GEN_FAILED', message: e?.message || String(e) });
      }

      // Отправляем письмо (если включено и email есть)
      if (!NO_MAIL_EFFECTIVE) {
        if (!email) {
          return res.status(400).json({ ok: false, error: 'NO_EMAIL', hint: 'Для отправки письма нужен email. Для привязки используйте ?nomail=1.' });
        }
        const html = `
          <p>Здравствуйте${name ? `, ${escapeHtml(name)}` : ''}!</p>
          <p>Спасибо за покупку билета на <strong>${escapeHtml(event_name)}</strong>.</p>
          <p><strong>Номер заказа:</strong> ${escapeHtml(effectiveOrderId)}<br>
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
          return res.status(500).json({ ok: false, error: 'SMTP_SEND_FAILED', message: e?.message || String(e) });
        }
      }

      issued.push(tid);
    }

    return res.status(200).json({
      ok: true,
      issued: issued.length,
      order_id: effectiveOrderId,
      test_mode: !!TEST_MODE,
      nomail: !!NO_MAIL_EFFECTIVE
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e?.message || String(e) });
  }
}

/* ----------------- helpers ----------------- */

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

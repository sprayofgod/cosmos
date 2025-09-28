// api/webhook/tilda-paid.js
import crypto from 'crypto';
import QRCode from 'qrcode';
import { sendEmail } from '../_lib/mailer.js';
import { db } from '../_lib/db.js';

const SECRET = process.env.TICKET_SECRET; // длинный случайный

export default async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { order_id, email, name, ticket_type, event_id, status, quantity = 1 } = req.body || {};
  if (status !== 'paid') return res.json({ ok: true, skip: 'not paid' });

  const results = [];

  for (let i = 0; i < Number(quantity); i++) {
    const tid = crypto.randomUUID();
    const payload = `${tid}.${order_id}.${event_id}`;
    const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    const token = `${payload}.${signature}`;

    await db.query(
      `INSERT INTO tickets (id, order_id, event_id, email, name, ticket_type, status, signature)
       VALUES ($1,$2,$3,$4,$5,$6,'unused',$7)`,
      [tid, order_id, event_id, email, name, ticket_type, signature]
    );

    const qrPng = await QRCode.toBuffer(token, { errorCorrectionLevel: 'M', width: 512 });

    await sendEmail({
      to: email,
      subject: `Ваш билет на мероприятие`,
      html: `
        <p>Здравствуйте, ${name || 'гость'}!</p>
        <p>Ниже – ваш QR-билет. Покажите его на входе.</p>
        <p><strong>Номер заказа:</strong> ${order_id}<br>
           <strong>Тип билета:</strong> ${ticket_type || 'Стандарт'}</p>
        <p>Если QR не сканируется, назовите код: <code>${token}</code></p>
      `,
      attachments: [{ filename: `ticket-${tid}.png`, content: qrPng, cid: `qr@${tid}` }],
      inlineCidHtmlReplace: true // если в отправщике используешь <img src="cid:...">
    });

    results.push({ tid });
  }

  res.json({ ok: true, issued: results.length });
};
import nodemailer from 'nodemailer';

const host   = process.env.SMTP_HOST;
const port   = Number(process.env.SMTP_PORT || 587);
const user   = process.env.SMTP_USER;
const pass   = process.env.SMTP_PASS;
const from   = process.env.SMTP_FROM;     
const helo   = process.env.SMTP_HELO ||    // FQDN для EHLO
               (new URL(`https://${process.env.MAIL_HELO_DOMAIN || 'modul.promo'}`)).host;

const secure = port === 465; // 465 — SMTPS, 587 — STARTTLS

export const transporter = nodemailer.createTransport({
  host,
  port,
  secure,                 // 465=true, 587=false + STARTTLS
  auth: { user, pass },
  name: helo,             // HELO/EHLO hostname
  requireTLS: !secure,    // на 587 заставляем STARTTLS
  tls: { servername: host, minVersion: 'TLSv1.2' },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000
});

function isTempSmtpError(err) {
  // 4xx — временные, имеет смысл ретраить
  const code = (err && err.responseCode) || 0;
  return code >= 400 && code < 500;
}

export async function sendTicketEmail({ to, subject, html, attachments }) {
  // Envelope-From должен быть в домене учётки
  // Получим чистый адрес из FROM:
  const envelopeFrom = (from.match(/<([^>]+)>/) || [null, from])[1];

  // до 3 попыток при 4xx, с паузами 1s, 2s, 4s
  const attempts = [0, 1000, 2000, 4000];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i]) await new Promise(r => setTimeout(r, attempts[i]));
    try {
      await transporter.verify(); // быстрый баннер/аутентификация
      return await transporter.sendMail({
        from,                
        to,
        subject,
        html,
        attachments,
        envelope: {           // реальный SMTP MAIL FROM / RCPT TO
          from: envelopeFrom, // совпадает с доменом учётки
          to
        }
      });
    } catch (e) {
      lastErr = e;
      if (!isTempSmtpError(e) || i === attempts.length - 1) {
        // не временная ошибка или исчерпали попытки
        throw e;
      }
      // иначе — ретрай
    }
  }
  throw lastErr;
}

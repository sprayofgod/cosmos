import nodemailer from 'nodemailer';

const host   = process.env.SMTP_HOST;
const port   = Number(process.env.SMTP_PORT || 587);
const user   = process.env.SMTP_USER;
const pass   = process.env.SMTP_PASS;
const from   = process.env.SMTP_FROM;
const secure = port === 465; // 465 – TLS, 587 – STARTTLS

// некоторые провайдеры требуют servername в SNI
const tls = { servername: host };

// для диагностики можно временно включить
const debug = process.env.SMTP_DEBUG === '1';

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,              // true для 465, false для 587 (STARTTLS)
  auth: { user, pass },
  tls,
  connectionTimeout: 10000, // 10s на установку TCP
  greetingTimeout: 10000,   // 10s ожидания SMTP баннера
  socketTimeout: 20000,     // 20s общий
  pool: false,              // в serverless пул не нужен
  logger: debug,
  debug
});

export async function sendTicketEmail({ to, subject, html, attachments }) {
  // быстрый pre-flight: даст явную ошибку, если баннер не пришёл
  await transporter.verify();
  return transporter.sendMail({
    from,
    to,
    subject,
    html,
    attachments
  });
}

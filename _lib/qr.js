import crypto from 'crypto';
import QRCode from 'qrcode';

const SECRET = process.env.TICKET_SECRET;

export function makeToken({ tid, order_id, event_id }) {
  const payload = `${tid}.${order_id}.${event_id}`;
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export async function tokenToPng(token, size = 512) {
  return QRCode.toBuffer(token, { errorCorrectionLevel: 'M', width: size });
}

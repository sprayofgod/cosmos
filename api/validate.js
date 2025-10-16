// api/validate.js
import crypto from 'crypto';
import { db } from '../_lib/db.js';

const SECRET = process.env.TICKET_SECRET;

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });

    const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    const token = String(body.token || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'NO_TOKEN' });

    const parts = token.split('.');
    if (parts.length !== 4) return res.status(400).json({ ok: false, error: 'BAD_TOKEN' });
    const [tid, oid, eid, sig] = parts;

    const expect = crypto.createHmac('sha256', SECRET)
      .update(`${tid}.${oid}.${eid}`)
      .digest('base64url');

    if (sig !== expect) return res.status(400).json({ ok: false, error: 'SIGN_INVALID' });

    // Атомарно помечаем использованным и сразу возвращаем данные билета
    const { rows } = await db.query(
      `UPDATE tickets
          SET status='used', used_at=NOW()
        WHERE id=$1 AND status='unused'
      RETURNING id, order_id, email, name, ticket_type, used_at`,
      [tid]
    );

    if (rows.length > 0) {
      const t = rows[0];
      return res.status(200).json({
        ok: true,
        tid: t.id,
        order_id: t.order_id,
        name: t.name,
        type: t.ticket_type,
        used: false,
        used_at: t.used_at
      });
    }

    // Если не обновили строку — смотрим, что с билетом
    const chk = await db.query(
      `SELECT id, order_id, email, name, ticket_type, status, used_at
         FROM tickets
        WHERE id=$1`,
      [tid]
    );

    if (chk.rows.length === 0) {
      return res.status(400).json({ ok: false, error: 'NOT_FOUND' });
    }

    const t = chk.rows[0];

    if (t.status === 'used') {
      // Уже использован — показываем имя, тип, время
      return res.status(200).json({
        ok: false,
        error: 'ALREADY_USED',
        tid: t.id,
        order_id: t.order_id,
        name: t.name,
        type: t.ticket_type,
        used: true,
        used_at: t.used_at
      });
    }

    // Любой другой статус (например, 'cancelled')
    return res.status(400).json({ ok: false, error: t.status || 'NOT_ALLOWED' });

  } catch (e) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e?.message || String(e) });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

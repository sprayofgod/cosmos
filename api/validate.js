// api/validate.js
import crypto from 'crypto';
import { db } from '../_lib/db.js';
const SECRET = process.env.TICKET_SECRET;

export default async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: 'NO_TOKEN' });

  const parts = token.split('.');
  if (parts.length !== 4) return res.status(400).json({ ok: false, error: 'BAD_TOKEN' });
  const [tid, oid, eid, sig] = parts;

  const expect = crypto.createHmac('sha256', SECRET).update(`${tid}.${oid}.${eid}`).digest('base64url');
  if (sig !== expect) return res.status(400).json({ ok: false, error: 'SIGN_INVALID' });

  // Атомарно помечаем использованным
  const { rows } = await db.query(
    `UPDATE tickets
       SET status='used', used_at=NOW()
     WHERE id=$1 AND status='unused'
     RETURNING id, email, name, ticket_type, used_at`,
    [tid]
  );

  if (rows.length === 0) {
    // Уже использован/не существует/отменён
    const chk = await db.query(`SELECT status FROM tickets WHERE id=$1`, [tid]);
    return res.status(400).json({ ok: false, error: chk.rows[0]?.status || 'NOT_FOUND' });
  }

  const t = rows[0];
  res.json({ ok: true, name: t.name, type: t.ticket_type, used_at: t.used_at });
};
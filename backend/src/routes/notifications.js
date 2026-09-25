import express from 'express';
import db, { nowIso } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { parseIntSafe } from '../utils/validation.js';
import { notificationEvents } from '../utils/notifications.js';
import { onTicketEvent } from '../utils/ticketBus.js';
import { getTicket, canViewTicket } from './tickets.js';

const router = express.Router();
router.use(requireAuth);

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  const onNewNotification = (data) => {
    if (data.userId === req.user.id) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Eventos de tickets de baja fidelidad (solo el id y el tipo, nunca contenido
  // sensible) para que las pantallas de listas refresquen sus cachés sin polling.
  const onTicketChange = (evt) => {
    if (evt.type === 'typing') return;
    const ticket = getTicket(evt.ticketId);
    if (!ticket || !canViewTicket(req.user, ticket)) return;
    res.write(`data: ${JSON.stringify({ channel: 'tickets', type: evt.type, ticketId: evt.ticketId, at: evt.at })}\n\n`);
  };

  notificationEvents.on('new_notification', onNewNotification);
  const offTicketEvents = onTicketEvent(onTicketChange);

  req.on('close', () => {
    notificationEvents.off('new_notification', onNewNotification);
    offTicketEvents();
  });
});

// Últimas notificaciones del usuario autenticado.
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT n.*, t.ticket_number
       FROM notifications n
       LEFT JOIN tickets t ON t.id = n.ticket_id
       WHERE n.user_id = ?
       ORDER BY n.id DESC LIMIT 50`
    )
    .all(req.user.id);
  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id).n;
  res.json({ data: rows, unread });
});

// Solo el conteo de no leídas (para la campana, barato de consultar).
router.get('/unread-count', (req, res) => {
  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id).n;
  res.json({ unread });
});

// Marca como leídas un conjunto de notificaciones (por id o "all").
router.post('/read', (req, res) => {
  const body = req.body || {};
  if (body.all) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), req.user.id);
  } else {
    const ids = Array.isArray(body.ids) ? body.ids.map((v) => parseIntSafe(v)).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Lista de notificaciones vacía' });
    const marks = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${marks})`
    ).run(nowIso(), req.user.id, ...ids);
  }
  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id).n;
  res.json({ ok: true, unread });
});

// Elimina las notificaciones ya leídas (limpieza manual).
router.delete('/read', (req, res) => {
  db.prepare('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL').run(req.user.id);
  res.json({ ok: true });
});

export default router;
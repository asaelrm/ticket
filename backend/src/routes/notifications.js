import express from 'express';
import runtime from '../db/runtime.js';
import { nowIso } from '../utils/time.js';
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
  const onTicketChange = async (evt) => {
    if (evt.type === 'typing') return;
    const ticket = await getTicket(evt.ticketId);
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
router.get('/', async (req, res) => {
  try {
    const rows = await runtime.queryMany(
      `SELECT n.*, t.ticket_number
       FROM notifications n
       LEFT JOIN tickets t ON t.id = n.ticket_id
       WHERE n.user_id = ?
       ORDER BY n.id DESC LIMIT 50`,
      req.user.id
    );
    const unreadRow = await runtime.queryOne(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
      req.user.id
    );
    const unread = unreadRow?.n ?? 0;
    res.json({ data: rows, unread });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Solo el conteo de no leídas (para la campana, barato de consultar).
router.get('/unread-count', async (req, res) => {
  try {
    const unreadRow = await runtime.queryOne(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
      req.user.id
    );
    const unread = unreadRow?.n ?? 0;
    res.json({ unread });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Marca como leídas un conjunto de notificaciones (por id o "all").
router.post('/read', async (req, res) => {
  try {
    const body = req.body || {};
    const now = nowIso();
    if (body.all) {
      await runtime.execute(
        'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
        now,
        req.user.id
      );
    } else {
      const ids = Array.isArray(body.ids) ? body.ids.map((v) => parseIntSafe(v)).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ error: 'Lista de notificaciones vacía' });
      const marks = ids.map(() => '?').join(',');
      await runtime.execute(
        `UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${marks})`,
        now,
        req.user.id,
        ...ids
      );
    }
    const unreadRow = await runtime.queryOne(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
      req.user.id
    );
    const unread = unreadRow?.n ?? 0;
    res.json({ ok: true, unread });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Elimina las notificaciones ya leídas (limpieza manual).
router.delete('/read', async (req, res) => {
  try {
    await runtime.execute(
      'DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL',
      req.user.id
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
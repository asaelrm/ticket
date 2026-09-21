import fs from 'node:fs';
import express from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { canViewTicket, hasPerm } from './tickets.js';
import { attachmentPath } from '../utils/fileType.js';

const router = express.Router();
router.use(requireAuth);

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare(`
    SELECT ta.*, t.reporter_id, tc.is_internal
    FROM ticket_attachments ta
    JOIN tickets t ON t.id = ta.ticket_id
    LEFT JOIN ticket_comments tc ON tc.id = ta.comment_id
    WHERE ta.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ error: 'Archivo no encontrado' });

  if (!canViewTicket(req.user, row) || (row.is_internal && !hasPerm(req.user, 'ticket.note'))) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }

  const absPath = attachmentPath(row.stored_name);
  if (!absPath) return res.status(404).json({ error: 'Archivo no encontrado en el almacenamiento' });

  const headers = {
    'Content-Type': row.mime_type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Length': String(row.size_bytes),
  };
  if (IMAGE_MIME.has(row.mime_type)) {
    headers['Content-Disposition'] = `inline; filename="${row.original_name.replace(/"/g, "'")}"`;
  } else {
    headers['Content-Disposition'] = `attachment; filename="${row.original_name.replace(/"/g, "'")}"`;
  }
  res.set(headers);
  return fs.createReadStream(absPath).pipe(res);
});

export default router;

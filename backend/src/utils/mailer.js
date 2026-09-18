import nodemailer from 'nodemailer';
import db, { nowIso } from '../db.js';
import config from '../config.js';

// Correos "enviados" por el transporte de desarrollo (sin SMTP). La misma
// instancia del módulo es compartida por rutas y tests, lo que permite
// verificar el envío sin configurar un servidor de correo real.
export const sentEmails = [];

// Toggles por tipo de notificación (editable en Configuración).
const NOTIFY_KEYS = {
  assign: 'notify_on_assign',
  comment: 'notify_on_comment',
  resolve: 'notify_on_resolve',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function isNotifyEnabled(kind) {
  const key = NOTIFY_KEYS[kind];
  if (!key) return true;
  const raw = getSetting(key);
  if (raw === null || raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

export function getMailConfig() {
  const m = config.mail;
  const useSmtp = m.enabled && Boolean(m.host) && m.transport !== 'dev';
  return { ...m, useSmtp };
}

let transport = null;

async function smtpTransport() {
  if (transport) return transport;
  const m = config.mail;
  transport = nodemailer.createTransport({
    host: m.host,
    port: m.port,
    secure: m.secure,
    auth: m.user ? { user: m.user, pass: m.pass } : undefined,
  });
  return transport;
}

/**
 * Envía (o registra en modo dev) un correo y lo audita en email_logs.
 * La función nunca lanza: los errores de SMTP quedan en el registro.
 */
export async function sendMail({ to, subject, text = '', html = '', kind = 'generic', ticketId = null }) {
  const recipients = [to].flat().filter(Boolean);
  const cfg = getMailConfig();
  const results = [];

  for (const recipient of recipients) {
    const subjectSafe = String(subject).slice(0, 200);
    const row = {
      kind,
      to: recipient,
      subject: subjectSafe,
      ticket_id: ticketId,
      status: 'error',
      error: null,
    };

    if (cfg.useSmtp) {
      try {
        const t = await smtpTransport();
        await t.sendMail({
          from: `"${cfg.fromName}" <${cfg.from}>`,
          to: recipient,
          subject: subjectSafe,
          text,
          html: html || textHtml(text),
        });
        row.status = 'smtp';
      } catch (err) {
        row.status = 'error';
        row.error = String(err?.message || err).slice(0, 500);
      }
    } else {
      row.status = 'dev';
      console.log(`[mail:dev] ${row.kind} → ${recipient} :: ${subjectSafe}`);
    }

    const info = db
      .prepare(
        'INSERT INTO email_logs (kind, to_email, subject, ticket_id, status, error) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(row.kind, row.to, row.subject, row.ticket_id, row.status, row.error);

    if (row.status !== 'error') {
      sentEmails.push({ id: info.lastInsertRowid, ...row, created_at: nowIso() });
    }
    results.push(row);
  }

  return results[0] || { status: 'skipped' };
}

// ---------------------------------------------------------------------------
// Plantillas de correo
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textHtml(text) {
  return esc(text).replace(/\n/g, '<br>');
}

function wrapHtml(title, bodyHtml) {
  return `<!doctype html><html lang="es"><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:600px;margin:24px auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
<div style="background:#2563eb;padding:16px 24px;color:#ffffff;font-size:18px;font-weight:600;">${esc(title)}</div>
<div style="padding:24px;">${bodyHtml}</div>
<div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:12px 24px;font-size:12px;color:#64748b;">Mensaje generado por Ticket.</div>
</div></body></html>`;
}

function ucFirst(v) {
  const s = String(v || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

export function notifyAssigned(ticket, actorName) {
  if (!isNotifyEnabled('assign')) return;
  if (!ticket.assigned_to_id) return;
  if (ticket.assigned_to_id === ticket.reporter_id) return;
  const assignee = db
    .prepare('SELECT id, name, last_name, email FROM users WHERE id = ? AND active = 1')
    .get(ticket.assigned_to_id);
  if (!assignee || !assignee.email) return;

  const subject = `[${ticket.ticket_number}] Ticket asignado a usted: ${ticket.title}`;
  const text = [
    `Hola ${assignee.name}:`,
    ``,
    `Se le asignó el ticket ${ticket.ticket_number} “${ticket.title}”.`,
    ``,
    `Prioridad: ${ucFirst(ticket.priority)}`,
    `Reportado por: ${ticket.reporter_name}`,
    `Estado: ${ucFirst(ticket.status)}`,
    ``,
    `Descripción:`,
    ticket.description,
    ``,
    `Atienda el ticket desde la aplicación.`,
  ].join('\n');
  return sendMail({
    to: assignee.email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'assign',
    ticketId: ticket.id,
  });
}

export function notifyComment(ticket, comment, actorName) {
  if (!isNotifyEnabled('comment')) return;
  const recipients = [];
  if (ticket.reporter_id !== comment.user_id) recipients.push(ticket.reporter_email);
  if (ticket.assigned_to_id && ticket.assigned_to_id !== comment.user_id) {
    const assignee = db
      .prepare('SELECT email FROM users WHERE id = ? AND active = 1')
      .get(ticket.assigned_to_id);
    if (assignee?.email) recipients.push(assignee.email);
  }
  const unique = [...new Set(recipients.map((e) => String(e).toLowerCase()))];
  if (!unique.length) return;

  const subject = `[${ticket.ticket_number}] Nuevo comentario: ${ticket.title}`;
  const text = [
    `${actorName} comentó en el ticket ${ticket.ticket_number} “${ticket.title}”.`,
    ``,
    comment.message,
    ``,
    `Puede responder desde la aplicación.`,
  ].join('\n');
  return sendMail({
    to: unique,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'comment',
    ticketId: ticket.id,
  });
}

export function notifyResolved(ticket, resolverName, resolution) {
  if (!isNotifyEnabled('resolve')) return;
  if (!ticket.reporter_email) return;
  if (ticket.reporter_id === null) return;

  const subject = `[${ticket.ticket_number}] Su ticket fue resuelto: ${ticket.title}`;
  const text = [
    `Hola:`,
    ``,
    `El ticket ${ticket.ticket_number} “${ticket.title}” que usted reportó fue resuelto por ${resolverName}.`,
    ``,
    resolution,
    ``,
    `Si el problema persiste, puede reabrir el ticket desde la aplicación.`,
  ].join('\n');
  return sendMail({
    to: ticket.reporter_email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'resolve',
    ticketId: ticket.id,
  });
}

export function notifyCancelled(ticket, actorName, reason) {
  if (!isNotifyEnabled('resolve')) return;
  if (!ticket.reporter_email) return;
  if (ticket.reporter_id === null) return;

  const subject = `[${ticket.ticket_number}] Su ticket fue cancelado: ${ticket.title}`;
  const text = [
    `Hola:`,
    ``,
    `El ticket ${ticket.ticket_number} “${ticket.title}” que usted reportó fue cancelado por ${actorName}.`,
    ``,
    reason ? `Motivo: ${reason}` : '',
    ``,
    `Puede consultar el detalle desde la aplicación o reportar una nueva incidencia.`,
  ].join('\n');
  return sendMail({
    to: ticket.reporter_email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'cancel',
    ticketId: ticket.id,
  });
}

export function notifyPasswordReset(user, token, resetUrlBase) {
  if (!user?.email) return;
  const resetUrl = `${resetUrlBase || ''}/reset-password?token=${token}`;
  const subject = 'Recuperación de contraseña';
  const text = [
    `Hola ${user.name}:`,
    ``,
    `Recibimos una solicitud para restablecer su contraseña.`,
    `Para continuar, abra el siguiente enlace (válido por 24 horas):`,
    ``,
    resetUrl,
    ``,
    `Si usted no solicitó este cambio, ignore este mensaje.`,
  ].join('\n');
  return sendMail({
    to: user.email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'password_reset',
  });
}
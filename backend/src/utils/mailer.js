import nodemailer from 'nodemailer';
import db from '../db/runtime.js';
import { nowIso } from '../db.js';
import config from '../config.js';
import { getSetting } from './settingsStore.js';

// Correos "enviados" por el transporte de desarrollo (sin SMTP). La misma
// instancia del módulo es compartida por rutas y tests, lo que permite
// verificar el envío sin configurar un servidor de correo real.
export const sentEmails = [];

// Toggles por tipo de notificación (editable en Configuración).
const NOTIFY_KEYS = {
  assign: 'notify_on_assign',
  comment: 'notify_on_comment',
  resolve: 'notify_on_resolve',
  create: 'notify_on_create',
  status: 'notify_on_status',
  close: 'notify_on_close',
};

// Etiquetas legibles para los estados del ticket. Se mantienen aquí (y no se
// importan de routes/tickets.js) para no crear una dependencia circular.
const STATUS_TEXT = {
  OPEN: 'Abierto',
  ASSIGNED: 'Asignado',
  IN_PROGRESS: 'En proceso',
  PENDING: 'Pendiente',
  RESOLVED: 'Resuelto',
  CLOSED: 'Cerrado',
  CANCELLED: 'Cancelado',
};

function statusText(status) {
  const key = String(status || '').toUpperCase();
  return STATUS_TEXT[key] || ucFirst(status);
}
// ETAPA 3 (defensa central de correo): el destinatario de un correo de ticket
// debe pertenecer a la MISMA organización del ticket. Un ticket legacy
// corrupto (org A con reportante/asignado de org B) no puede filtrar correo
// hacia otra organización. Los correos no ligados a tickets (password reset)
// no pasan por aquí: cada función de este módulo solo lo usa con contexto de
// ticket.
async function recipientInTicketOrg(userId, ticket) {
  if (!ticket || ticket.organization_id == null) return false;
  if (!userId) return false;
  const row = await db.queryOne('SELECT organization_id FROM users WHERE id = ?', userId);
  return !!row && row.organization_id != null && Number(row.organization_id) === Number(ticket.organization_id);
}

export async function isNotifyEnabled(kind, organizationId = null) {
  const key = NOTIFY_KEYS[kind];
  if (!key) return true;
  // V1: los interruptores notify_on_* son configuración POR ORGANIZACIÓN. Cada
  // disparador pasa la organización del ticket que origina el correo, de modo
  // que desactivar el correo al asignar en A no apaga el de B.
  const raw = await getSetting(key, organizationId);
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

// Mensaje de error apto para registro: nunca incluye la contraseña del
// transporte (solo el texto que devuelve nodemailer o la propia base de datos).
function safeError(err) {
  const message = err && err.message ? String(err.message) : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/**
 * Envía (o registra en modo dev) un correo y lo audita en email_logs.
 *
 * Es funcionalidad secundaria: NUNCA lanza. Cualquier fallo (SMTP, transporte,
 * configuración, plantilla o el propio registro en email_logs) se captura y se
 * registra de forma segura para diagnóstico, sin afectar a la operación que lo
 * disparó (crear, comentar, cambiar estado, resolver, cerrar...).
 */
export async function sendMail({ to, subject, text = '', html = '', kind = 'generic', ticketId = null }) {
  try {
    const recipients = [to].flat().filter(Boolean);
    const cfg = getMailConfig();
    const results = [];

    for (const recipient of recipients) {
      const subjectSafe = String(subject ?? '').slice(0, 200);
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
          row.error = safeError(err);
          console.error(`[mail] Fallo SMTP (${kind} → ${recipient}): ${row.error}`);
        }
      } else {
        row.status = 'dev';
        console.log(`[mail:dev] ${row.kind} → ${recipient} :: ${subjectSafe}`);
      }

      // El registro en la bitácora es secundario: si falla, el correo ya se
      // envió (o se registró en dev) y la operación principal no debe caerse.
      let logId = null;
      try {
        const info = await db.insertAndGetId(
          'INSERT INTO email_logs (kind, to_email, subject, ticket_id, status, error) VALUES (?, ?, ?, ?, ?, ?)',
          row.kind,
          row.to,
          row.subject,
          row.ticket_id,
          row.status,
          row.error,
        );
        logId = info.id;
      } catch (err) {
        console.error(`[mail] No se pudo registrar el correo en email_logs: ${safeError(err)}`);
      }

      if (row.status !== 'error') {
        sentEmails.push({ id: logId, ...row, created_at: nowIso() });
      }
      results.push(row);
    }

    return results[0] || { status: 'skipped' };
  } catch (err) {
    console.error(`[mail] Fallo inesperado al preparar el correo (${kind}): ${safeError(err)}`);
    return { status: 'error', error: safeError(err) };
  }
}

/**
 * Envuelve sendMail para que un disparador de correo jamás genere un
 * unhandledRejection, ni siquiera si en el futuro sendMail empezara a rechazar.
 * El resultado siempre es una promesa resuelta.
 */
function send(payload) {
  let promise;
  try {
    promise = sendMail(payload);
  } catch (err) {
    console.error(`[mail] Error no controlado al preparar sendMail (${payload?.kind}): ${safeError(err)}`);
    return Promise.resolve({ status: 'error', error: safeError(err) });
  }
  return Promise.resolve(promise).catch((err) => {
    console.error(`[mail] Error no controlado en sendMail (${payload?.kind}): ${safeError(err)}`);
    return { status: 'error', error: safeError(err) };
  });
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

export async function notifyAssigned(ticket, actorName) {
  if (!(await isNotifyEnabled('assign', ticket?.organization_id))) return;
  if (!ticket.assigned_to_id) return;
  if (ticket.assigned_to_id === ticket.reporter_id) return;
  if (!(await recipientInTicketOrg(ticket.assigned_to_id, ticket))) return;
  const assignee = await db.queryOne(
    'SELECT id, name, last_name, email FROM users WHERE id = ? AND active = 1',
    ticket.assigned_to_id,
  );
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
  return send({
    to: assignee.email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'assign',
    ticketId: ticket.id,
  });
}

export async function notifyComment(ticket, comment, actorName) {
  if (!(await isNotifyEnabled('comment', ticket?.organization_id))) return;
  const recipients = [];
  if (ticket.reporter_id !== comment.user_id && (await recipientInTicketOrg(ticket.reporter_id, ticket))) {
    recipients.push(ticket.reporter_email);
  }
  if (ticket.assigned_to_id && ticket.assigned_to_id !== comment.user_id && (await recipientInTicketOrg(ticket.assigned_to_id, ticket))) {
    const assignee = await db.queryOne('SELECT email FROM users WHERE id = ? AND active = 1', ticket.assigned_to_id);
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
  return send({
    to: unique,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'comment',
    ticketId: ticket.id,
  });
}

export async function notifyResolved(ticket, resolverName, resolution) {
  if (!(await isNotifyEnabled('resolve', ticket?.organization_id))) return;
  if (!ticket.reporter_email) return;
  if (ticket.reporter_id === null) return;
  if (!(await recipientInTicketOrg(ticket.reporter_id, ticket))) return;

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
  return send({
    to: ticket.reporter_email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'resolve',
    ticketId: ticket.id,
  });
}

export async function notifyCancelled(ticket, actorName, reason) {
  if (!(await isNotifyEnabled('resolve', ticket?.organization_id))) return;
  if (!ticket.reporter_email) return;
  if (ticket.reporter_id === null) return;
  if (!(await recipientInTicketOrg(ticket.reporter_id, ticket))) return;

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
  return send({
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
  return send({
    to: user.email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'password_reset',
  });
}

// Confirmación al reportante de que su requerimiento fue creado.
export async function notifyCreated(ticket) {
  if (!(await isNotifyEnabled('create', ticket?.organization_id))) return;
  if (!ticket?.reporter_email) return;
  if (ticket.reporter_id === null || ticket.reporter_id === undefined) return;
  if (!(await recipientInTicketOrg(ticket.reporter_id, ticket))) return;

  const greeting = ticket.reporter_name ? `Hola ${ticket.reporter_name}:` : 'Hola:';
  const subject = `[${ticket.ticket_number}] Hemos recibido su ticket: ${ticket.title}`;
  const text = [
    greeting,
    '',
    `Su requerimiento fue recibido correctamente y quedó registrado con el número ${ticket.ticket_number}.`,
    '',
    `Número de ticket: ${ticket.ticket_number}`,
    `Asunto: ${ticket.title}`,
    `Estado: ${statusText(ticket.status)}`,
    `Prioridad: ${ucFirst(ticket.priority)}`,
    '',
    'Nuestro equipo revisará su solicitud y le informaremos por este medio cuando haya novedades.',
  ].join('\n');
  return send({
    to: ticket.reporter_email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'create',
    ticketId: ticket.id,
  });
}

// Cambio de estado NO terminal. No debe usarse para RESOLVED/CLOSED/CANCELLED:
// esas transiciones ya tienen su propia notificación y generarían duplicados.
export async function notifyStatusChanged(ticket, oldStatus, actor) {
  if (!(await isNotifyEnabled('status', ticket?.organization_id))) return;
  if (!ticket?.reporter_email) return;
  if (ticket.reporter_id === null || ticket.reporter_id === undefined) return;
  if (!(await recipientInTicketOrg(ticket.reporter_id, ticket))) return;

  const oldLabel = statusText(oldStatus);
  const newLabel = statusText(ticket.status);
  const who = actor ? ` por ${actor}` : '';
  const subject = `[${ticket.ticket_number}] Estado actualizado: ${newLabel}`;
  const text = [
    'Hola:',
    '',
    `El ticket ${ticket.ticket_number} “${ticket.title}” cambió de estado${who}.`,
    '',
    `Estado anterior: ${oldLabel}`,
    `Nuevo estado: ${newLabel}`,
    '',
    'Puede consultar el detalle desde la aplicación.',
  ].join('\n');
  return send({
    to: ticket.reporter_email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'status',
    ticketId: ticket.id,
  });
}

// Cierre del ticket: se avisa explícitamente al reportante.
export async function notifyClosed(ticket) {
  if (!(await isNotifyEnabled('close', ticket?.organization_id))) return;
  if (!ticket?.reporter_email) return;
  if (ticket.reporter_id === null || ticket.reporter_id === undefined) return;
  if (!(await recipientInTicketOrg(ticket.reporter_id, ticket))) return;

  const subject = `[${ticket.ticket_number}] Su ticket fue cerrado: ${ticket.title}`;
  const text = [
    'Hola:',
    '',
    `El ticket ${ticket.ticket_number} “${ticket.title}” fue cerrado.`,
    '',
    `Número de ticket: ${ticket.ticket_number}`,
    `Estado: ${statusText(ticket.status)}`,
    '',
    'Si el problema persiste, puede reabrir el ticket desde la aplicación o reportar una nueva incidencia.',
  ].join('\n');
  return send({
    to: ticket.reporter_email,
    subject,
    text,
    html: wrapHtml(subject, textHtml(text)),
    kind: 'close',
    ticketId: ticket.id,
  });
}
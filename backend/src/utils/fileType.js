import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

//
// Validación de archivos por CONTENIDO (magic bytes), no solo por extensión.
//

const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt'];

function hasPrefix(buf, hex) {
  const magic = Buffer.from(hex, 'hex');
  if (buf.length < magic.length) return false;
  return buf.subarray(0, magic.length).equals(magic);
}

function asciiAt(buf, offset, len) {
  if (buf.length < offset + len) return null;
  return buf.toString('latin1', offset, offset + len);
}

function detectType(buf, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const type = {};
  let detected = 'unknown';

  // Imágenes
  if (hasPrefix(buf, 'ffd8ff')) detected = 'image/jpeg';
  else if (hasPrefix(buf, '89504e470d0a1a0a')) detected = 'image/png';
  else if (
    buf.length >= 12 &&
    asciiAt(buf, 0, 4) === 'RIFF' &&
    asciiAt(buf, 8, 4) === 'WEBP'
  ) {
    detected = 'image/webp';
  }

  // PDF
  if (detected === 'unknown' && asciiAt(buf, 0, 4) === '%PDF') detected = 'application/pdf';

  // Documentos OOXML (docx/xlsx) son contenedores ZIP
  if (detected === 'unknown' && (hasPrefix(buf, '504b0304') || hasPrefix(buf, '504b0506'))) {
    const fakeFile = Buffer.from('PK\x03\x04', 'binary');
    detected =
      ext === '.docx' || ext === '.xlsx'
        ? { '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[ext]
        : 'application/zip';
  }

  // OLE2 (doc/xls antiguos)
  if (detected === 'unknown' && hasPrefix(buf, 'd0cf11e0a1b11ae1')) {
    detected =
      ext === '.doc' || ext === '.xls'
        ? { '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel' }[ext]
        : 'application/x-ole-storage';
  }

  // Texto plano: sin bytes nulos y texto legible
  if (detected === 'unknown' && ext === '.txt') {
    const hasBinary = buf.subarray(0, Math.min(buf.length, 8192)).includes(0);
    if (!hasBinary && /^[\x09\x0A\x0D\x20-\x7E\xC0-\xFF]*$/.test(buf.toString('latin1', 0, Math.min(buf.length, 8192)))) {
      detected = 'text/plain';
    }
  }

  // Coherencia extensión-contenido
  const extAllowed = EXTENSIONS.includes(ext);
  if (!extAllowed) return { ok: false, reason: `Extensión no permitida. Formatos aceptados: ${EXTENSIONS.join(', ')}` };
  if (detected === 'unknown') return { ok: false, reason: 'El contenido del archivo no coincide con un formato permitido' };

  const extToExpectedMime = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
  };

  if (extToExpectedMime[ext] !== detected) {
    return { ok: false, reason: `El contenido no coincide con la extensión "${ext}"` };
  }

  return { ok: true, mime: detected, ext };
}

export function validateFile(buffer, originalName) {
  return detectType(buffer, originalName);
}

export function generateStoredName(ext) {
  return `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
}

export function persistUpload(buffer, info) {
  const storedName = generateStoredName(info.ext);
  const absPath = path.join(config.uploadDir, storedName);
  fs.writeFileSync(absPath, buffer, { flag: 'wx', mode: 0o600 });

  return {
    ok: true,
    originalName: (info.originalName || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 200),
    storedName,
    mime: info.mime,
    size: buffer.length,
  };
}

export function saveUpload(buffer, originalName) {
  const info = detectType(buffer, originalName);
  if (!info.ok) return { ok: false, reason: info.reason };
  return persistUpload(buffer, { ...info, originalName });
}

export function attachmentPath(storedName) {
  const absPath = path.resolve(config.uploadDir, storedName);
  if (!absPath.startsWith(path.resolve(config.uploadDir)) || path.dirname(absPath) !== path.resolve(config.uploadDir)) {
    return null;
  }
  if (!fs.existsSync(absPath)) return null;
  return absPath;
}
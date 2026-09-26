import multer from 'multer';
import config from '../config.js';

// Subida en memoria; la validación por contenido ocurre después en la ruta.
export function uploadMiddleware({ maxFiles = 12 } = {}) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.uploads.maxSizeMb * 1024 * 1024,
      files: maxFiles,
      // Sin estos tres, busboy admite un número ilimitado de campos de texto y
      // de "partes" (su límite por defecto es Infinity) y, con memoryStorage,
      // cada uno se queda en el heap antes de mirar ningún permiso: una sola
      // petición podíatragarse varios GB. Los formularios reales usan 2 campos.
      fields: 20,
      parts: maxFiles + 20,
      fieldSize: 64 * 1024,
    },
    fileFilter: (req, file, cb) => cb(null, true),
  });
}

export function uploadSizeError(err, req, res, next) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `Archivo demasiado grande. Límite: ${config.uploads.maxSizeMb} MB por archivo.` });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Demasiados archivos en la solicitud' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Campo de archivo inesperado. Use el campo "files".' });
    }
    if (err.code === 'LIMIT_FIELD_COUNT') {
      return res.status(400).json({ error: 'Demasiados campos en la solicitud' });
    }
    if (err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_PART_COUNT') {
      return res.status(400).json({ error: 'El contenido de la solicitud es demasiado grande' });
    }
    return res.status(400).json({ error: `Error al procesar archivos: ${err.message}` });
  }
  return next();
}
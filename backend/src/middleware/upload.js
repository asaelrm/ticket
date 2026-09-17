import multer from 'multer';
import config from '../config.js';

// Subida en memoria; la validación por contenido ocurre después en la ruta.
export function uploadMiddleware({ maxFiles = 12 } = {}) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.uploads.maxSizeMb * 1024 * 1024,
      files: maxFiles,
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
    return res.status(400).json({ error: `Error al procesar archivos: ${err.message}` });
  }
  return next();
}
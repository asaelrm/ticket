export function errorHandler(err, req, res, next) {
  if (err && err.name === 'ValidationError') {
    return res.status(err.status || 400).json({ error: 'Datos inválidos', fields: err.fields });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido en la solicitud' });
  }
  // Los errores detallados solo se loguean, no se expone información sensible al cliente.
  if (err) {
    const safeMessage = err.status && err.status < 500 ? err.message : 'Error interno del servidor';
    console.error(new Date().toISOString(), req.method, req.originalUrl, err.message, err.stack);
    return res.status(err.status || 500).json({ error: safeMessage });
  }
  next();
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'No encontrado' });
}
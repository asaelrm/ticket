const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,30}$/;

export class ValidationError extends Error {
  constructor(fields) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.status = 400;
    this.fields = fields || {};
  }
}

export function validate(validators) {
  const errors = {};
  for (const [field, result] of Object.entries(validators)) {
    if (result && result.trim()) errors[field] = result.trim();
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

export const rules = {
  required: (v, label = 'Campo') =>
    v === undefined || v === null || String(v).trim() === '' ? `${label} es obligatorio` : '',
  max: (v, n, label = 'Campo') =>
    typeof v === 'string' && v.length > n ? `${label} no debe exceder ${n} caracteres` : '',
  min: (v, n, label = 'Campo') =>
    typeof v === 'string' && v.length < n ? `${label} debe tener al menos ${n} caracteres` : '',
  email: (v, label = 'Correo') =>
    typeof v === 'string' && v.trim() && !EMAIL_RE.test(v.trim()) ? `${label} no es válido` : '',
  username: (v, label = 'Usuario') =>
    typeof v === 'string' && v.trim() && !USERNAME_RE.test(v.trim())
      ? `${label} solo permite letras, números, puntos, guiones y debe tener 3-30 caracteres`
      : '',
  oneOf: (v, allowed, label = 'Valor') =>
    allowed.includes(v) ? '' : `${label} no es válido`,
  password: (v) => {
    const p = String(v || '');
    if (!p) return 'La contraseña es obligatoria';
    if (p.length < 6) return 'La contraseña debe tener al menos 6 caracteres';
    return '';
  },
};

export function safeStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export function parseIntSafe(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}
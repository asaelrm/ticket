function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export class ApiError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

async function apiFetch(path, { method = 'GET', body, headers = {}, formData } = {}) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { ...headers },
  };

  if (formData) {
    opts.body = formData;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  // Double-submit CSRF para cualquier mutación (excepto login/recuperación públicos).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = getCookie('tf_csrf');
    if (token) opts.headers['x-csrf-token'] = token;
  }

  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, 'No se pudo conectar con el servidor. Verifique su conexión.');
  }

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  }

  if (!res.ok) {
    const message = data?.error || `Error ${res.status}`;
    throw new ApiError(res.status, message, data?.fields);
  }

  return data === null ? {} : data;
}

export const api = {
  get: (path) => apiFetch(path),
  post: (path, body, formData) => apiFetch(path, { method: 'POST', body, formData }),
  patch: (path, body) => apiFetch(path, { method: 'PATCH', body }),
  del: (path) => apiFetch(path, { method: 'DELETE' }),
};

export function fileUrl(id) {
  return `/api/files/${id}`;
}

export const STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED'];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const STATUS_LABEL = {
  OPEN: 'Abierto',
  ASSIGNED: 'Asignado',
  IN_PROGRESS: 'En proceso',
  PENDING: 'Pendiente',
  RESOLVED: 'Resuelto',
  CLOSED: 'Cerrado',
  CANCELLED: 'Cancelado',
};

export const PRIORITY_LABEL = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' };

export const STATUS_COLOR = {
  OPEN: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  ASSIGNED: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  IN_PROGRESS: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  PENDING: 'bg-purple-50 text-purple-700 ring-purple-600/20',
  RESOLVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  CLOSED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  CANCELLED: 'bg-red-50 text-red-700 ring-red-600/20',
};

export const PRIORITY_COLOR = {
  LOW: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  MEDIUM: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  HIGH: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  CRITICAL: 'bg-red-50 text-red-700 ring-red-600/20',
};

export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

export function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImage(mime) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(mime);
}
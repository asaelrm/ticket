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
  put: (path, body) => apiFetch(path, { method: 'PUT', body }),
  patch: (path, body) => apiFetch(path, { method: 'PATCH', body }),
  del: (path) => apiFetch(path, { method: 'DELETE' }),
};

export function fileUrl(id) {
  return `/api/files/${id}`;
}

// Flujo de conversación en vivo (Server-Sent Events) de un ticket.
export function ticketStreamUrl(id) {
  return `/api/tickets/${id}/stream`;
}

// Descarga un recurso del backend respetando cookies (dispara "Guardar como").
export function download(path) {
  const a = document.createElement('a');
  a.href = path;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
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
  OPEN: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  ASSIGNED: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  IN_PROGRESS: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  PENDING: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  RESOLVED: 'bg-teal-50 text-teal-700 ring-teal-600/20',
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

export const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];

export const STATUS_DOT = {
  OPEN: 'bg-amber-500',
  ASSIGNED: 'bg-blue-500',
  IN_PROGRESS: 'bg-emerald-500',
  PENDING: 'bg-sky-400',
  RESOLVED: 'bg-teal-400',
  CLOSED: 'bg-slate-400',
  CANCELLED: 'bg-red-500',
};

// Etiquetas de las vistas rápidas; el orden define los chips del panel.
export const VIEWS = [
  { key: 'all', label: 'Todos', counter: 'all' },
  { key: 'open', label: 'Abiertos', counter: 'open' },
  { key: 'pending', label: 'Pendientes', counter: 'pending' },
  { key: 'attended', label: 'Atendidos', counter: 'attended' },
  { key: 'in_progress', label: 'En proceso', counter: 'in_progress', view: false },
  { key: 'overdue', label: 'Retrasados', counter: 'overdue' },
  { key: 'mine', label: 'Asignados a mí', counter: 'assigned_to_me' },
  { key: 'my-teams', label: 'Mi equipo', counter: 'assigned_to_my_teams' },
  { key: 'closed', label: 'Cerrados', counter: null },
];

export const CLOSED_PERIODS = [
  ['today', 'Hoy'],
  ['yesterday', 'Ayer'],
  ['week', 'Esta semana'],
  ['month', 'Este mes'],
  ['quarter', 'Este trimestre'],
  ['year', 'Este año'],
];

export const SORT_OPTIONS = [
  ['created_at', 'Fecha de creación'],
  ['updated_at', 'Última actualización'],
  ['ticket_number', 'Número de ticket'],
  ['closed_at', 'Fecha de cierre'],
  ['priority', 'Prioridad'],
  ['status', 'Estado'],
  ['title', 'Título'],
];

export function formatRelative(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  let text;
  if (abs < MIN) return 'hace unos segundos';
  else if (abs < HOUR) text = `${Math.round(abs / MIN)} min`;
  else if (abs < DAY) text = `${Math.round(abs / HOUR)} h`;
  else if (abs < 30 * DAY) text = `${Math.round(abs / DAY)} d`;
  else return formatDate(value);
  return diff >= 0 ? `hace ${text}` : `en ${text}`;
}

// Devuelve el estado de SLA de un ticket abierto: { overdue, hours, due } o null.
export function slaInfo(ticket) {
  if (!ticket?.sla_due_at || !OPEN_STATUSES.includes(ticket.status)) return null;
  const due = new Date(ticket.sla_due_at);
  if (Number.isNaN(due.getTime())) return null;
  const diffMs = due.getTime() - Date.now();
  return { overdue: diffMs < 0, hours: Math.abs(diffMs) / 3_600_000, due };
}

export function formatSla(ticket) {
  const info = slaInfo(ticket);
  if (!info) return '—';
  const h = info.hours;
  const amount = h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
  return info.overdue ? `Vencido hace ${amount}` : `Vence en ${amount}`;
}
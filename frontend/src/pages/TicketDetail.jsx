import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  api,
  fileUrl,
  STATUSES,
  PRIORITIES,
  STATUS_LABEL,
  PRIORITY_LABEL,
  formatDate,
  formatDateTime,
  formatSize,
  isImage,
} from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { StatusBadge, PriorityBadge, ErrorBox, Spinner, LoadingScreen, EmptyState } from '../components/ui';

const HISTORY_ACTION_LABEL = {
  CREATED: 'creó el ticket',
  ASSIGNED: 'actualizó la asignación',
  STATUS_CHANGED: 'cambió el estado',
  REOPENED: 'reabrió el ticket',
  PRIORITY_CHANGED: 'cambió la prioridad',
  CATEGORY_CHANGED: 'cambió la categoría',
  UPDATED: 'actualizó el ticket',
  COMMENT_ADDED: 'agregó un comentario',
  ATTACHMENT_ADDED: 'adjuntó un archivo',
};

const HISTORY_ICON = {
  CREATED: '✦',
  ASSIGNED: '👤',
  STATUS_CHANGED: '🔄',
  REOPENED: '↩️',
  PRIORITY_CHANGED: '⚡',
  CATEGORY_CHANGED: '🗂',
  UPDATED: '✏️',
  COMMENT_ADDED: '💬',
  ATTACHMENT_ADDED: '📎',
};

export default function TicketDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState([]);

  const [message, setMessage] = useState('');
  const [files, setFiles] = useState([]);
  const [statusDraft, setStatusDraft] = useState('');
  const [priorityDraft, setPriorityDraft] = useState('');
  const [assignDraft, setAssignDraft] = useState('');

  const canManage = user.permissions.includes('ticket.update.any');
  const canAssign = user.permissions.includes('ticket.assign');
  const canComment = user.permissions.includes('ticket.comment');

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await api.get(`/api/tickets/${id}`);
      setData(d);
      setStatusDraft(d.ticket.status);
      setPriorityDraft(d.ticket.priority);
      setAssignDraft(d.ticket.assigned_to_id ? String(d.ticket.assigned_to_id) : '');
    } catch (err) {
      setError(err.message || 'No se pudo cargar el ticket');
    }
  }, [id]);

  useEffect(() => {
    load();
    if (canAssign) {
      api
        .get('/api/users/assignable')
        .then((d) => setUsers(d.data || []))
        .catch(() => {});
    }
  }, [id, load, canAssign]);

  if (error && !data) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorBox message={error} />
        <button className="btn-secondary mt-4" onClick={load}>
          Reintentar
        </button>
      </div>
    );
  }
  if (!data) return <LoadingScreen text="Cargando ticket…" />;

  const t = data.ticket;
  const isReporterOrAll = user.permissions.includes('ticket.view.all') || t.reporter_id === user.id;
  void isReporterOrAll;

  async function patchTicket(payload) {
    setSaving(true);
    setError('');
    try {
      await api.patch(`/api/tickets/${t.id}`, payload);
      await load();
    } catch (err) {
      setError(err.message || 'No se pudo actualizar el ticket');
    } finally {
      setSaving(false);
    }
  }

  function onStatus(e) {
    setStatusDraft(e.target.value);
    if (e.target.value !== t.status) patchTicket({ status: e.target.value });
  }
  function onPriority(e) {
    setPriorityDraft(e.target.value);
    if (e.target.value !== t.priority) patchTicket({ priority: e.target.value });
  }
  function onAssign(e) {
    setAssignDraft(e.target.value);
    const value = e.target.value ? Number(e.target.value) : null;
    if (value !== t.assigned_to_id) patchTicket({ assigned_to_id: value });
  }

  async function onSubmitComment(e) {
    e.preventDefault();
    if (!message.trim() && files.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const fd = new FormData();
      if (message.trim()) fd.append('message', message.trim());
      for (const f of files) fd.append('files', f);
      await api.post(`/api/tickets/${t.id}/comments`, null, fd);
      setMessage('');
      setFiles([]);
      await load();
    } catch (err) {
      setError(err.message || 'No se pudo enviar el comentario');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      {/* Header */}
      <div>
        <button className="btn-ghost mb-3 !px-2 text-sm" onClick={() => navigate(-1)}>
          ← Volver
        </button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-bold text-brand-700">{t.ticket_number}</h2>
              <StatusBadge status={t.status} />
              <PriorityBadge priority={t.priority} />
            </div>
            <h1 className="mt-1 text-lg font-semibold text-slate-800">{t.title}</h1>
            <p className="mt-1 text-sm text-slate-500">
              Reportado por <b className="text-slate-700">{t.reporter_name}</b>
              {t.department_name ? ` · ${t.department_name}` : ''} · {formatDateTime(t.created_at)}
            </p>
          </div>
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      {/* Acciones admin */}
      {canManage && (
        <div className="card grid gap-4 p-4 sm:grid-cols-3">
          <div>
            <label className="label">Estado</label>
            <select className="input" value={statusDraft} onChange={onStatus} disabled={saving}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Prioridad</label>
            <select className="input" value={priorityDraft} onChange={onPriority} disabled={saving}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          {canAssign ? (
            <div>
              <label className="label">Asignado a</label>
              <select className="input" value={assignDraft} onChange={onAssign} disabled={saving}>
                <option value="">Sin asignar</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} {u.last_name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="label">Asignado a</label>
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                {t.assigned_name || 'Sin asignar'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Info del ticket */}
      <div className="card p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Detalle</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Info label="Empleado" value={t.reporter_name} />
          <Info label="Departamento" value={t.department_name || '—'} />
          <Info label="Categoría" value={t.category_name || '—'} />
          <Info label="Prioridad" value={PRIORITY_LABEL[t.priority]} />
          <Info label="Estado" value={STATUS_LABEL[t.status]} />
          <Info label="Asignado a" value={t.assigned_name || 'Sin asignar'} />
          <Info label="Creado" value={formatDateTime(t.created_at)} />
          <Info label="Actualizado" value={formatDateTime(t.updated_at)} />
          <Info label="Adjuntos" value={`${t.attachment_count ?? data.attachments.length} archivos`} />
        </div>
        <div className="mt-4">
          <h4 className="label">Descripción</h4>
          <p className="whitespace-pre-wrap rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">{t.description}</p>
        </div>
      </div>

      {/* Adjuntos */}
      {data.attachments.length > 0 && (
        <div className="card p-5">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Adjuntos ({data.attachments.length})
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.attachments.map((a) => (
              <a
                key={a.id}
                href={fileUrl(a.id)}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-3 rounded-xl border border-slate-200 p-3 transition hover:border-brand-300 hover:bg-brand-50/50"
              >
                {isImage(a.mime_type) ? (
                  <img
                    src={fileUrl(a.id)}
                    alt={a.original_name}
                    className="h-12 w-12 shrink-0 rounded-lg object-cover ring-1 ring-slate-200"
                  />
                ) : (
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13H7zM14 3v5h5" />
                    </svg>
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-700 group-hover:text-brand-700">
                    {a.original_name}
                  </p>
                  <p className="text-xs text-slate-400">{formatSize(a.size_bytes)}</p>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Comentarios */}
      {canComment && (
        <div className="card p-5">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Agregar comentario</h3>
          <form onSubmit={onSubmitComment} className="space-y-3" noValidate>
            <textarea
              className="input min-h-[90px] resize-y"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Escriba su comentario o actualización…"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-brand-600">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1.5M8 7.5L12 3l4 4.5M12 3v11" />
                </svg>
                Adjuntar archivos
                <input type="file" multiple className="hidden" onChange={(e) => setFiles(Array.from(e.target.files || []))} />
                {files.length > 0 && (
                  <span className="badge bg-brand-100 text-brand-700">{files.length} archivo(s)</span>
                )}
              </label>
              <button type="submit" className="btn-primary" disabled={saving || (!message.trim() && !files.length)}>
                {saving && <Spinner className="h-4 w-4 text-white" />}
                Enviar
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Timeline: historial + comentarios intercalados no — historial y comentarios por separado por claridad */}
      <div className="card p-5">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">Historial y actividad</h3>
        {data.history.length === 0 && data.comments.length === 0 ? (
          <EmptyState icon="🕓" title="Sin actividad" />
        ) : (
          <ol className="space-y-0">
            {[...data.history]
              .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
              .map((h) => (
                <li key={`h-${h.id}`} className="relative flex gap-3 pb-5 last:pb-0">
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-100 text-xs">
                    {HISTORY_ICON[h.action] || '•'}
                  </span>
                  <div>
                    <p className="text-sm text-slate-700">
                      <span className="font-medium text-slate-800">{h.user_name || 'Sistema'}</span>{' '}
                      <span className="text-slate-500">{HISTORY_ACTION_LABEL[h.action] || h.action}</span>
                      {h.description ? <span className="text-slate-500"> — {h.description}</span> : null}
                    </p>
                    <p className="text-xs text-slate-400">{formatDateTime(h.created_at)}</p>
                  </div>
                </li>
              ))}

            {data.comments.map((c) => (
              <li key={`c-${c.id}`} className="relative flex gap-3 border-t border-slate-100 pt-5">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-100 text-xs">
                  {c.user_name?.slice(0, 1).toUpperCase() || 'U'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-semibold text-slate-800">{c.user_name || 'Usuario'}</span>
                    <span className="text-xs text-slate-400">{formatDateTime(c.created_at)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{c.message}</p>
                  {data.attachments.filter((a) => a.comment_id === c.id).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {data.attachments
                        .filter((a) => a.comment_id === c.id)
                        .map((a) =>
                          isImage(a.mime_type) ? (
                            <a href={fileUrl(a.id)} target="_blank" rel="noreferrer" key={a.id}>
                              <img
                                src={fileUrl(a.id)}
                                alt={a.original_name}
                                className="h-16 w-16 rounded-lg object-cover ring-1 ring-slate-200 hover:opacity-80"
                              />
                            </a>
                          ) : (
                            <a
                              key={a.id}
                              href={fileUrl(a.id)}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200"
                            >
                              📎 {a.original_name}
                            </a>
                          )
                        )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-700">{value || '—'}</dd>
    </div>
  );
}
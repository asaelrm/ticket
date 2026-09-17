import { useEffect, useState } from 'react';
import { Drawer, ErrorBox, Spinner } from './ui';
import { api } from '../lib/api';

export default function ResolveDrawer({ open, onClose, ticket, options, onDone }) {
  const [resolution, setResolution] = useState('');
  const [category, setCategory] = useState('');
  const [cause, setCause] = useState('');
  const [time, setTime] = useState('');
  const [unit, setUnit] = useState('minutes');
  const [files, setFiles] = useState([]);
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setResolution('');
    setCategory('');
    setCause('');
    setTime('');
    setUnit('minutes');
    setFiles([]);
    setNotify(true);
    setError('');
  }, [open, ticket?.id]);

  async function onSubmit(e) {
    e.preventDefault();
    if (!resolution.trim()) {
      setError('La solución es obligatoria.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('resolution', resolution.trim());
      if (category) fd.append('resolution_category', category);
      if (cause) fd.append('root_cause', cause);
      if (time !== '' && Number(time) > 0) {
        const minutes = unit === 'hours' ? Math.round(Number(time) * 60) : Math.round(Number(time));
        fd.append('time_spent_minutes', String(minutes));
      }
      if (notify) fd.append('notify', '1');
      for (const f of files) fd.append('files', f);
      await api.post(`/api/tickets/${ticket.id}/resolve`, null, fd);
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message || 'No se pudo resolver el ticket');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Resolver ticket"
      subtitle={ticket ? `${ticket.ticket_number} · ${ticket.title}` : ''}
      wide
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="resolve-form" className="btn-primary" disabled={saving}>
            {saving && <Spinner className="h-4 w-4 text-white" />}
            Resolver ticket
          </button>
        </div>
      }
    >
      <form id="resolve-form" onSubmit={onSubmit} className="space-y-5" noValidate>
        <div>
          <label className="label" htmlFor="resolution">
            Solución / trabajo realizado *
          </label>
          <textarea
            id="resolution"
            className="input min-h-[120px] resize-y"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="Ej.: Se reemplazó el mouse defectuoso y se realizaron pruebas de funcionamiento."
            required
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="root_cause">
              Causa
            </label>
            <select id="root_cause" className="input" value={cause} onChange={(e) => setCause(e.target.value)}>
              <option value="">Sin especificar</option>
              {(options?.root_causes || []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="resolution_category">
              Categoría de solución
            </label>
            <select
              id="resolution_category"
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Sin especificar</option>
              {(options?.resolution_categories || []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="time">
            Tiempo empleado
          </label>
          <div className="flex gap-2">
            <input
              id="time"
              type="number"
              min="0"
              step="1"
              className="input"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              placeholder="0"
            />
            <select className="input !w-36" value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="minutes">Minutos</option>
              <option value="hours">Horas</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">Archivos de evidencia</label>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500 transition hover:border-brand-400 hover:text-brand-600">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1.5M8 7.5L12 3l4 4.5M12 3v11" />
            </svg>
            Adjuntar fotos, capturas o documentos
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files || [])])}
            />
          </label>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-sm text-slate-600"
                >
                  <span className="truncate">📎 {f.name}</span>
                  <button
                    type="button"
                    className="ml-2 text-slate-400 hover:text-red-500"
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    aria-label={`Quitar ${f.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="flex items-center gap-2.5 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
          />
          Notificar al usuario que el ticket fue resuelto.
        </label>

        {error && <ErrorBox message={error} />}
      </form>
    </Drawer>
  );
}

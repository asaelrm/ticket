import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorBox, Spinner, LoadingScreen } from '../components/ui';

export default function Settings() {
  const { setAppName } = useAuth();
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [mail, setMail] = useState(null);
  const [emails, setEmails] = useState([]);

  useEffect(() => {
    api
      .get('/api/settings')
      .then((d) => setForm(normalize(d.data)))
      .catch((err) => setError(err.message || 'No se pudieron cargar los ajustes'));
    api
      .get('/api/settings/mail')
      .then((d) => setMail(d.data || {}))
      .catch(() => {});
    api
      .get('/api/settings/emails')
      .then((d) => setEmails(d.data || []))
      .catch(() => {});
  }, []);

  if (!form) return <LoadingScreen text="Cargando configuración…" />;

  function set(key, value) {
    setForm({ ...form, [key]: value });
    setSuccess('');
  }

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = {
        ...form,
        resolution_categories: toList(form.resolution_categories),
        root_causes: toList(form.root_causes),
        pending_reasons: toList(form.pending_reasons),
        require_resolution_to_close: form.require_resolution_to_close ? '1' : '0',
        notify_on_assign: form.notify_on_assign ? '1' : '0',
        notify_on_comment: form.notify_on_comment ? '1' : '0',
        notify_on_resolve: form.notify_on_resolve ? '1' : '0',
      };
      const data = await api.patch('/api/settings', payload);
      setForm(normalize(data.data));
      if (data.data.app_name) setAppName(data.data.app_name);
      setSuccess('Configuración guardada correctamente.');
    } catch (err) {
      setError(err.message || 'No se pudieron guardar los ajustes');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="card">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-800">Configuración del sistema</h2>
          <p className="text-sm text-slate-500">Ajustes generales que se muestran en la aplicación.</p>
        </div>
        <form onSubmit={onSave} className="space-y-5 px-6 py-5" noValidate>
          <div>
            <label className="label">Nombre del sistema</label>
            <input className="input" value={form.app_name || ''} onChange={(e) => set('app_name', e.target.value)} maxLength={120} />
          </div>
          <div>
            <label className="label">Nombre de la empresa</label>
            <input className="input" value={form.company_name || ''} onChange={(e) => set('company_name', e.target.value)} maxLength={120} />
          </div>
          <div>
            <label className="label">Prefijo de tickets</label>
            <input className="input" value={form.ticket_prefix || ''} onChange={(e) => set('ticket_prefix', e.target.value)} maxLength={10} />
            <p className="mt-1 text-xs text-slate-400">Se usa al generar números nuevos (ej. TCK-000001).</p>
          </div>
          <div>
            <label className="label">Texto del pie de página</label>
            <input className="input" value={form.footer_text || ''} onChange={(e) => set('footer_text', e.target.value)} maxLength={120} />
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-800">Tiempos de atención (SLA)</h3>
            <p className="mb-4 text-sm text-slate-500">
              Horas objetivo para resolver un ticket según su prioridad. Se usan para calcular la fecha límite y los
              tickets retrasados.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <SlaField label="Prioridad crítica" value={form.sla_critical_hours} onChange={(v) => set('sla_critical_hours', v)} />
              <SlaField label="Prioridad alta" value={form.sla_high_hours} onChange={(v) => set('sla_high_hours', v)} />
              <SlaField label="Prioridad media" value={form.sla_medium_hours} onChange={(v) => set('sla_medium_hours', v)} />
              <SlaField label="Prioridad baja" value={form.sla_low_hours} onChange={(v) => set('sla_low_hours', v)} />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Dejar vacío para usar el valor por defecto (Crítica 4 h · Alta 24 h · Media 48 h · Baja 72 h).
            </p>
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-800">Flujo de resolución</h3>
            <p className="mb-4 text-sm text-slate-500">
              Opciones que se ofrecerán al resolver, cerrar o pausar un ticket. Escriba un valor por línea.
            </p>
            <div className="space-y-4">
              <ListField
                label="Categorías de solución"
                hint="Tipo de trabajo realizado (ej. Configuración, Reparación, Reemplazo)."
                value={form.resolution_categories}
                onChange={(v) => set('resolution_categories', v)}
              />
              <ListField
                label="Causas raíz"
                hint="Origen del problema (ej. Falla de hardware, Error de usuario)."
                value={form.root_causes}
                onChange={(v) => set('root_causes', v)}
              />
              <ListField
                label="Motivos de ticket pendiente"
                hint="Razones por las que un ticket queda en espera."
                value={form.pending_reasons}
                onChange={(v) => set('pending_reasons', v)}
              />
            </div>
            <label className="mt-4 flex items-start gap-2.5 text-sm text-slate-700">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                checked={!!form.require_resolution_to_close}
                onChange={(e) => set('require_resolution_to_close', e.target.checked)}
              />
              <span>
                Exigir una resolución antes de cerrar un ticket.
                <span className="block text-xs text-slate-400">
                  Si está activo, no se podrá cerrar un ticket que no tenga solución registrada.
                </span>
              </span>
            </label>
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-800">Notificaciones por correo</h3>
            <p className="mb-4 text-sm text-slate-500">
              Qué eventos envían un correo. El servidor SMTP se configura con las variables{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">SMTP_HOST</code>,{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">SMTP_USER</code> y{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">SMTP_PASS</code> del backend.
            </p>
            <div className="space-y-3">
              <CheckToggle
                label="Al asignar un ticket"
                hint="Notifica al usuario que recibe la asignación."
                value={form.notify_on_assign}
                onChange={(v) => set('notify_on_assign', v)}
              />
              <CheckToggle
                label="Cuando hay un comentario nuevo"
                hint="Notifica al reportante y al asignado (excepto al autor del comentario)."
                value={form.notify_on_comment}
                onChange={(v) => set('notify_on_comment', v)}
              />
              <CheckToggle
                label="Al resolver un ticket"
                hint="Notifica al reportante cuando se marca la resolución."
                value={form.notify_on_resolve}
                onChange={(v) => set('notify_on_resolve', v)}
              />
            </div>
            <MailStatus mail={mail} />
            <EmailLog emails={emails} />
          </div>

          {error && <ErrorBox message={error} />}
          {success && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              {success}
            </div>
          )}

          <div className="flex justify-end border-t border-slate-200 pt-4">
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving && <Spinner className="h-4 w-4 text-white" />}
              {saving ? 'Guardando…' : 'Guardar configuración'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ListField({ label, hint, value, onChange }) {
  return (
    <div>
      <label className="label">{label}</label>
      <textarea
        className="input min-h-[80px] resize-y font-mono text-xs"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'Opción 1\nOpción 2'}
      />
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function toLines(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
}

function toList(value) {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalize(data) {
  return {
    ...data,
    resolution_categories: toLines(data.resolution_categories),
    root_causes: toLines(data.root_causes),
    pending_reasons: toLines(data.pending_reasons),
    require_resolution_to_close: data.require_resolution_to_close === '1',
  };
}

function SlaField({ label, value, onChange }) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="relative">
        <input
          type="number"
          min="1"
          max="720"
          className="input !pr-12"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="—"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">horas</span>
      </div>
    </div>
  );
}
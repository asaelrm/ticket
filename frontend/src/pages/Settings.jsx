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
        enable_csat: form.enable_csat ? '1' : '0',
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

          <div className="border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-800">Encuesta de satisfacción (CSAT)</h3>
            <p className="mb-4 text-sm text-slate-500">
              Permite que el reportante califique la atención (1–5 estrellas) cuando su ticket queda resuelto o cerrado.
            </p>
            <CheckToggle
              label="Activar encuesta de satisfacción"
              hint="Al cerrar un ticket, se notifica al reportante para calificar la atención."
              value={form.enable_csat}
              onChange={(v) => set('enable_csat', v)}
            />
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-800">Escalación automática</h3>
            <p className="mb-4 text-sm text-slate-500">
              Reglas que ejecuta el sistema periódicamente para alertar o subir prioridad de tickets que nadie atendió.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="label">
                Escalar sin asignar después de
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    max="720"
                    className="input !pr-12"
                    value={form.rule_unassigned_hours ?? ''}
                    onChange={(e) => set('rule_unassigned_hours', e.target.value)}
                    placeholder="8"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">horas</span>
                </div>
                <span className="mt-1 block text-xs font-normal text-slate-400">
                  Sube la prioridad de tickets abiertos sin asignar. 0 desactiva la regla.
                </span>
              </label>
              <label className="label">
                Prioridad al escalar
                <select
                  className="input"
                  value={form.rule_unassigned_priority || 'HIGH'}
                  onChange={(e) => set('rule_unassigned_priority', e.target.value)}
                >
                  <option value="LOW">Baja</option>
                  <option value="MEDIUM">Media</option>
                  <option value="HIGH">Alta</option>
                  <option value="CRITICAL">Crítica</option>
                </select>
                <span className="mt-1 block text-xs font-normal text-slate-400">
                  Solo se escala si el ticket tiene menor prioridad que la elegida.
                </span>
              </label>
              <label className="label">
                Alertar crítico abierto después de
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    max="720"
                    className="input !pr-12"
                    value={form.rule_critical_hours ?? ''}
                    onChange={(e) => set('rule_critical_hours', e.target.value)}
                    placeholder="12"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">horas</span>
                </div>
                <span className="mt-1 block text-xs font-normal text-slate-400">
                  Notifica a los administradores si un CRITICAL lleva mucho tiempo abierto. 0 desactiva la regla.
                </span>
              </label>
            </div>
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
    require_resolution_to_close: flag(data.require_resolution_to_close),
    notify_on_assign: flag(data.notify_on_assign),
    notify_on_comment: flag(data.notify_on_comment),
    notify_on_resolve: flag(data.notify_on_resolve),
    enable_csat: flag(data.enable_csat),
  };
}

function flag(value) {
  return value === '1' || value === true;
}

function CheckToggle({ label, hint, value, onChange }) {
  return (
    <label className="flex items-start gap-2.5 text-sm text-slate-700">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        <span className="block text-xs text-slate-400">{hint}</span>
      </span>
    </label>
  );
}

const EMAIL_STATUS_COLOR = {
  smtp: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  dev: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  error: 'bg-red-50 text-red-700 ring-red-600/20',
};

const EMAIL_STATUS_LABEL = { smtp: 'Enviado', dev: 'Dev', error: 'Error' };

function MailStatus({ mail }) {
  if (!mail) return (
    <p className="mt-4 text-xs text-slate-400">Consultando estado del correo…</p>
  );
  const classes = mail.useSmtp
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : 'border-amber-200 bg-amber-50 text-amber-800';
  return (
    <div className={`mt-4 rounded-lg border px-4 py-3 text-sm ${classes}`}>
      {mail.useSmtp ? (
        <>
          <span className="font-semibold">Correo SMTP activo</span>{' '}
          <span className="text-xs">
            ({mail.host}:{mail.port} — de {mail.fromName} &lt;{mail.from}&gt;)
          </span>
        </>
      ) : (
        <>
          <span className="font-semibold">Modo desarrollo</span>{' '}
          <span className="text-xs">
            El SMTP no está configurado (o MAIL_ENABLED está apagado); los correos se registran en la
            bitácora y en consola, sin enviarse.
          </span>
        </>
      )}
    </div>
  );
}

function EmailLog({ emails }) {
  const rows = emails.slice(0, 15);
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Correos recientes</h4>
        <span className="text-xs text-slate-400">últimos {rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 px-4 py-3 text-sm text-slate-400">
          Todavía no se han enviado correos.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Estado</th>
                <th className="px-3 py-2 font-medium">Para</th>
                <th className="px-3 py-2 font-medium">Asunto</th>
                <th className="px-3 py-2 font-medium">Fecha</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                        EMAIL_STATUS_COLOR[e.status] || 'bg-slate-100 text-slate-600 ring-slate-500/20'
                      }`}
                      title={e.error || ''}
                    >
                      {EMAIL_STATUS_LABEL[e.status] || e.status}
                    </span>
                  </td>
                  <td className="max-w-[160px] truncate px-3 py-2">{e.to_email}</td>
                  <td className="max-w-[260px] truncate px-3 py-2">
                    {e.ticket_number && <span className="mr-1 font-mono text-slate-400">{e.ticket_number}</span>}
                    {e.subject}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-400">
                    {new Date(e.created_at).toLocaleString('es-ES', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
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
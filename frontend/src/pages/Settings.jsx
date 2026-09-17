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

  useEffect(() => {
    api
      .get('/api/settings')
      .then((d) => setForm({ ...d.data }))
      .catch((err) => setError(err.message || 'No se pudieron cargar los ajustes'));
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
      const data = await api.patch('/api/settings', form);
      setForm({ ...data.data });
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
import { useState } from 'react';
import { api, formatDateTime } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorBox, Spinner } from '../components/ui';

export default function Profile() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (next !== confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/auth/change-password', { current_password: current, new_password: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setSuccess('Contraseña actualizada correctamente.');
    } catch (err) {
      setError(err.message || 'No se pudo cambiar la contraseña');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="card p-6">
        <div className="flex items-center gap-4">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-brand-100 text-xl font-bold text-brand-700">
            {(user?.name?.[0] || '') + (user?.last_name?.[0] || '')}
          </span>
          <div>
            <h2 className="text-lg font-bold text-slate-800">
              {user?.name} {user?.last_name}
            </h2>
            <p className="text-sm text-slate-500">{user?.username} · {user?.email}</p>
            <p className="mt-0.5 text-sm text-slate-500">
              {user?.role_name}
              {user?.department_name ? ` · ${user.department_name}` : ''}
              {user?.position ? ` · ${user.position}` : ''}
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="border-b border-slate-200 px-6 py-4">
          <h3 className="text-base font-semibold text-slate-800">Cambiar contraseña</h3>
        </div>
        <form onSubmit={onSubmit} className="space-y-4 px-6 py-5" noValidate>
          <div>
            <label className="label" htmlFor="current">Contraseña actual</label>
            <input id="current" type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="next">Nueva contraseña</label>
              <input id="next" type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="confirm">Confirmar nueva</label>
              <input id="confirm" type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
          </div>
          <p className="text-xs text-slate-400">Mínimo 8 caracteres, debe incluir mayúscula, minúscula y número.</p>
          {error && <ErrorBox message={error} />}
          {success && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{success}</div>}
          <div className="flex justify-end">
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving && <Spinner className="h-4 w-4 text-white" />}
              {saving ? 'Guardando…' : 'Actualizar contraseña'}
            </button>
          </div>
        </form>
      </div>

      <p className="text-center text-xs text-slate-400">
        Último acceso: {user?.last_login_at ? formatDateTime(user.last_login_at) : '—'}
      </p>
    </div>
  );
}
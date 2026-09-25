import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, formatDateTime } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorBox, Spinner } from '../components/ui';
import UserTicketHistory from '../components/UserTicketHistory';

export default function Profile() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  const passwordMutation = useMutation({
    mutationFn: ({ currentPassword, newPassword }) =>
      api.post('/api/auth/change-password', { current_password: currentPassword, new_password: newPassword }),
    onMutate: () => {
      setError('');
      setSuccess('');
      setSaving(true);
    },
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setSuccess('Contraseña actualizada correctamente.');
    },
    onError: (err) => setError(err.message || 'No se pudo cambiar la contraseña'),
    onSettled: () => setSaving(false),
  });

  function onSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (next !== confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }
    passwordMutation.mutate({ currentPassword: current, newPassword: next });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
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
          <h3 className="text-base font-semibold text-slate-800">Historial de tickets</h3>
          <p className="text-sm text-slate-500">Sus tickets reportados y los asignados a usted.</p>
        </div>
        <div className="px-6 py-5">
          <UserTicketHistory userId={user?.id} self />
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
          <p className="text-xs text-slate-400">Mínimo 6 caracteres.</p>
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
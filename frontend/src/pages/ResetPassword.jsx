import { useState, useEffect } from 'react';
import { Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { ErrorBox, Spinner } from '../components/ui';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const token = location.state?.token || params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // Si el token llegó por query string, se limpia de la URL para no dejarlo
  // en el historial ni en los logs del servidor.
  useEffect(() => {
    if (!location.state?.token && params.get('token')) {
      navigate('/reset-password', { replace: true, state: { token: params.get('token') } });
    }
  }, [location.state, params, navigate]);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }
    if (!token) {
      setError('Falta el token de recuperación');
      return;
    }
    setLoading(true);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(err.message || 'No se pudo restablecer la contraseña');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="card nex-pop p-8">
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-14 w-28 shrink-0 items-center rounded-2xl bg-[#0a253a] p-2 shadow-md shadow-slate-950/15">
              <img
                alt="Centro Médico UCE"
                className="h-full w-full object-contain"
                src="/logo-centro-medico-uce-white.png"
              />
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-extrabold text-slate-800">Restablecer contraseña</h1>
            </div>
          </div>

          {done ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Su contraseña fue restablecida correctamente. Puede iniciar sesión.
              </div>
              <Link to="/login" className="btn-primary w-full">
                Ir al inicio de sesión
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
              <p className="text-sm text-slate-500">
                Ingrese su nueva contraseña. Debe tener al menos 6 caracteres.
              </p>
              <div>
                <label className="label" htmlFor="password">
                  Nueva contraseña
                </label>
                <input
                  id="password"
                  type="password"
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="confirm">
                  Confirmar contraseña
                </label>
                <input
                  id="confirm"
                  type="password"
                  className="input"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              {error && <ErrorBox message={error} />}
              <button type="submit" className="btn-primary w-full" disabled={loading}>
                {loading && <Spinner className="h-4 w-4 text-white" />}
                {loading ? 'Restableciendo…' : 'Restablecer contraseña'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

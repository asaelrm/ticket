import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth, can } from '../context/AuthContext';
import { ErrorBox, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await login(account, password, remember);
      const from = location.state?.from?.pathname;
      if (from && from.startsWith('/app')) return navigate(from, { replace: true });
      return navigate(can(user, 'dashboard.view') ? '/app/dashboard' : '/app/my-tickets', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(700px 420px at 15% 10%, rgba(34,199,122,0.14), transparent 60%), radial-gradient(700px 420px at 85% 85%, rgba(32,199,183,0.12), transparent 60%)',
        }}
      />
      <div className="relative w-full max-w-md">
        <div className="card nex-pop p-8">
          <div className="mb-6 flex flex-col items-center gap-2 text-center">
            <object
              aria-label="Logo del Centro Médico UCE"
              className="h-14 w-14 rounded-2xl"
              data="/logo-uce.pdf"
              type="application/pdf"
            />
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-300">Centro Médico UCE</p>
            <h1 className="text-2xl font-extrabold text-slate-800">Tickets</h1>
            <p className="max-w-xs text-sm text-slate-400">Gestión de incidencias</p>
            <p className="mt-1 text-xs font-medium italic text-emerald-200/70">Comprometidos con tu salud</p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div>
              <label className="label" htmlFor="account">
                Usuario o correo
              </label>
              <input
                id="account"
                className="input"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="usuario@centromedico.uce"
                autoComplete="username"
                required
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="label" htmlFor="password">
                  Contraseña
                </label>
                <Link to="/forgot-password" className="text-xs font-medium text-emerald-300 hover:text-emerald-200">
                  ¿Olvidó su contraseña?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 rounded text-emerald-500 focus:ring-emerald-400/40"
              />
              Recordarme
            </label>

            {error && <ErrorBox message={error} />}

            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading && <Spinner className="h-4 w-4 text-white" />}
              {loading ? 'Iniciando sesión…' : 'Iniciar sesión'}
            </button>
          </form>
        </div>
        <p className="mt-5 text-center text-xs text-slate-500">Centro Médico UCE · Tickets</p>
      </div>
    </div>
  );
}

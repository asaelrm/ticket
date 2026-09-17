import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth, can } from '../context/AuthContext';
import { ErrorBox, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';

export default function Login() {
  const { login, appName } = useAuth();
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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-black via-[#0a0f1a] to-[#141f57] px-4 py-10">
      <div className="w-full max-w-md">
        <div className="card p-8">
          <div className="mb-6 flex flex-col items-center gap-2 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-600 text-white">
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" d="M6 6h12v2H6zM6 11h12v2H6zM6 16h7v2H6z" />
              </svg>
            </span>
            <h1 className="text-xl font-bold text-slate-800">{appName}</h1>
            <p className="text-sm text-slate-500">Sistema de gestión de tickets e incidencias</p>
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
                placeholder="usuario@empresa.com"
                autoComplete="username"
                required
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="label" htmlFor="password">
                  Contraseña
                </label>
                <Link to="/forgot-password" className="text-xs font-medium text-brand-600 hover:text-brand-700">
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

            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
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

        <p className="mt-4 text-center text-xs text-slate-400">
          Cuenta demo · Admin: <code className="font-semibold">admin</code> / <code className="font-semibold">Admin1234!</code> · Empleado:{' '}
          <code className="font-semibold">empleado</code> / <code className="font-semibold">Empleado1234!</code>
        </p>
      </div>
    </div>
  );
}
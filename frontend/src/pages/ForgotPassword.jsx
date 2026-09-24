import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ErrorBox, Spinner } from '../components/ui';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [account, setAccount] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.post('/api/auth/forgot-password', { account });
      setResult(data);
    } catch (err) {
      setError(err.message || 'No se pudo generar la recuperación');
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
                className="logo-mark-green h-full w-full object-contain"
                src="/logo-centro-medico-uce.png"
              />
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-extrabold text-slate-800">Recuperar contraseña</h1>
            </div>
          </div>
          <p className="text-sm text-slate-400">
            Ingrese su usuario o correo para generar un enlace de recuperación (válido por 24 horas).
          </p>

          {!result ? (
            <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
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
              {error && <ErrorBox message={error} />}
              <button type="submit" className="btn-primary w-full" disabled={loading}>
                {loading && <Spinner className="h-4 w-4 text-white" />}
                {loading ? 'Enviando…' : 'Generar enlace'}
              </button>
            </form>
          ) : (
            <div className="mt-6 space-y-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                {result.message}
              </div>
              {result.token && (
                <div>
                  <p className="mb-1 text-sm font-medium text-slate-700">Token de recuperación (modo desarrollo):</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
                      {result.token}
                    </code>
                    <button
                      type="button"
                      className="btn-secondary !px-3 !py-2"
                      onClick={() => navigator.clipboard.writeText(result.token)}
                    >
                      Copiar
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn-primary mt-3 w-full"
                    onClick={() => navigate('/reset-password', { state: { token: result.token } })}
                  >
                    Continuar al restablecimiento
                  </button>
                </div>
              )}
              <Link to="/login" className="btn-secondary w-full">
                Volver al inicio de sesión
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { ErrorBox, Spinner } from '../components/ui';

// Clave del token dentro de sessionStorage. Se eligió sessionStorage y no
// localStorage porque es POR PESTAÑA: al cerrarla el token desaparece solo, y no
// queda en un almacenamiento que otra pestaña del mismo navegador pudiera leer.
const TOKEN_KEY = 'tf.resetToken';

function leerToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    // Modo privado o almacenamiento bloqueado: el campo manual de abajo
    // permite introducir el token a mano en ese caso.
    return '';
  }
}

function guardarToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Sin almacenamiento disponible el flujo sigue siendo utilizable gracias al
    // campo manual, solo se pierde la persistencia al recargar.
  }
}

function borrarToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nada que limpiar.
  }
}

// Si en el campo manual se pega el enlace entero en lugar del token suelto, se
// extrae el valor del parámetro: si no, el backend recibiría la URL completa y
// la rechazaría como token inválido sin explicar por qué. Solo se intenta
// cuando aparece "token=", de modo que un token pegado tal cual (que puede
// llevar +, / o =) se envía sin tocar.
function normalizarToken(valor) {
  const limpio = (valor || '').trim();
  if (!limpio.includes('token=')) return limpio;
  const encontrado = limpio.match(/[?&]token=([^&#\s]+)/);
  if (!encontrado) return limpio;
  try {
    return decodeURIComponent(encontrado[1]);
  } catch {
    return encontrado[1];
  }
}

export default function ResetPassword() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  // Orden de resolución: la query string de la URL, el estado de navegación
  // (cuando el enlace se abre dentro de la aplicación) y, por último, lo que
  // quedó guardado de una visita anterior.
  const inicial = location.state?.token || params.get('token') || leerToken();
  const [token, setToken] = useState(inicial);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // El token se traslada a sessionStorage y se borra de la URL. Antes se
  // quedaba solo en memoria y la URL conservaba el token, con dos problemas:
  // quedaba en el historial del navegador y en la cabecera Referer al navegar,
  // y al recargar la página se perdía y el formulario quedaba inservible.
  useEffect(() => {
    const deUrl = params.get('token') || location.state?.token || '';
    if (!deUrl) return;
    guardarToken(deUrl);
    setToken(deUrl);
    navigate('/reset-password', { replace: true });
  }, [params, location.state, navigate]);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    const limpio = normalizarToken(token);
    if (!limpio) {
      setError('Falta el token de recuperación');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }
    if (password.length < 12) {
      setError('La contraseña debe tener al menos 12 caracteres');
      return;
    }
    // El token tecleado a mano también se guarda: si algo falla (red, contraseña
    // incorrecta) un F5 no obliga a volver a pegarlo.
    guardarToken(limpio);
    setLoading(true);
    try {
      await api.post('/api/auth/reset-password', { token: limpio, password });
      // El token ya está canjeado: no se conserva ni en memoria ni en
      // sessionStorage, ni siquiera si el usuario recarga ahora.
      borrarToken();
      setToken('');
      setPassword('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      const mensaje = err instanceof ApiError && err.message ? err.message : 'No se pudo restablecer la contraseña';
      setError(mensaje);
      // 400 sin errores de campo significa que la petición era correcta pero el
      // token fue rechazado: está caducado, ya se usó o no es válido. Guardarlo
      // solo serviría para volver a fallar, así que se descarta y el campo
      // manual queda listo para pegar el enlace nuevo.
      if (err instanceof ApiError && err.status === 400 && !err.fields) {
        borrarToken();
        setToken('');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="card nex-pop p-8">
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-14 w-36 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-inverse)] p-2 shadow-md shadow-slate-950/15">
              <img
                alt="SIFHA"
                className="h-full w-full object-contain"
                src="/logo/TSIFHA-PNG.png"
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
                Ingrese su nueva contraseña. Debe tener al menos 12 caracteres.
              </p>
              <div>
                <label className="label" htmlFor="token">
                  Token de recuperación
                </label>
                <input
                  id="token"
                  name="reset-token"
                  type="text"
                  className="input font-mono text-xs"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <p className="mt-1 text-xs text-slate-400">
                  Viene rellenado si abrió el enlace recibido. Si lo abrió en otro
                  navegador o en una ventana privada, pegue aquí el enlace o el
                  token que le hayan enviado.
                </p>
              </div>
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
                  minLength={12}
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

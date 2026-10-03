import { Link, useLocation, useNavigate } from 'react-router-dom';
import ErrorPage from '../components/ErrorPage';

/**
 * Página de error 404 de SIFHA.
 *
 * Antes, cualquier ruta desconocida terminaba en `<Navigate to="/app" />`: el
 * usuario escribía mal una dirección o seguía un enlace caducado y la
 * aplicación lo devolvía a su inicio sin explicar nada, de modo que el fallo
 * pasaba por un glitch. Ahora la ruta inexistente se muestra tal cual.
 *
 * `embedded` la usa dentro de `Layout` (una dirección mal escrita *dentro* de
 * la aplicación: se conserva la cabecera y el menú, y el usuario no pierde el
 * contexto de dónde estaba). Sin `embedded` es una pantalla completa, el mismo
 * caso que las rutas públicas.
 *
 * No consulta permisos ni `user` a propósito: el 404 no depende de la sesión, y
 * "Volver al inicio" apunta siempre a `/app`, que ya decide entre el panel y el
 * login según haya sesión o no. Así una dirección equivocada nunca filtra si
 * alguien está autenticado, y la vista no parpadea esperando a `AuthProvider`.
 */
export default function NotFound({ embedded = false }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  return (
    <ErrorPage
      embedded={embedded}
      showLogo={!embedded}
      code="404"
      title="Página no encontrada"
      description="La dirección solicitada no existe en SIFHA. Puede que el enlace esté mal escrito, que la página haya cambiado de sitio o que el contenido ya no esté disponible."
      detail={<>Ruta solicitada: {pathname}{search}</>}
      actions={
        <>
          <Link to="/app" className="btn-primary">
            Volver al inicio
          </Link>
          {canGoBack && (
            <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>
              Volver atrás
            </button>
          )}
        </>
      }
    />
  );
}

/**
 * ¿Hay una entrada anterior a la que volver?
 *
 * `history` de React Router guarda el índice de la entrada actual en
 * `history.state.idx` cada vez que apila una nueva. Con índice 0 el usuario
 * llegó aquí directamente (enlace pegado en el correo, pestaña nueva) y un
 * "Volver atrás" sería un botón que no hace nada, así que en ese caso no se
 * ofrece.
 */
function useCanGoBack() {
  return (window.history.state?.idx ?? 0) > 0;
}
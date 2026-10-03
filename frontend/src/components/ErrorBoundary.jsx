import React from 'react';
import { Link } from 'react-router-dom';
import ErrorPage from './ErrorPage';

/**
 * Fronte de seguridad para fallos de render.
 *
 * Sin él, una excepción al pintar cualquier pantalla deja el `<div id="root">`
 * en blanco: el usuario ve una página vacía y solo le queda recargar a ciegas.
 * Con él, el fallo se convierte en una pantalla de SIFHA con salida.
 *
 * Va dentro de `App`, es decir dentro del `Router` y del `AuthProvider`, así que
 * sólo sustituye lo que ya se estaba pintando y no toca el enrutado ni la
 * sesión: si una pantalla lanza, deja de pintarse; si no, el árbol es idéntico
 * al de siempre. `Suspense` sigue por fuera del error porque un `lazy` que
 * tarda no es un error, y un chunk que no se puede cargar sí lo es.
 *
 * `getDerivedStateFromError` y `componentDidCatch` son la pareja obligatoria: el
 * primero decide qué pintar y el segundo deja el fallo registrado en consola, que
 * es lo único que queda para diagnosticarlo en producción.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[SIFHA] Error inesperado al pintar la pantalla:', error, info?.componentStack);
  }

  retry() {
    this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <ErrorPage
        showLogo
        icon={
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        }
        title="Algo ha ido mal"
        description="Se ha producido un error inesperado al mostrar esta pantalla. Se puede volver al inicio o reintentar la carga; si el problema continúa, contacta con el equipo de soporte."
        actions={
          <>
            <Link to="/app" className="btn-primary">
              Volver al inicio
            </Link>
            <button type="button" className="btn-secondary" onClick={this.retry}>
              Reintentar
            </button>
          </>
        }
      />
    );
  }
}
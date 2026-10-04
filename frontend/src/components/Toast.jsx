import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Avisos flotantes de corta vida.
//
// Contrato:
// - ToastProvider envuelve la aplicación una sola vez (main.jsx) y en las
//   pruebas (test/utils.jsx), y monta la región en document.body.
// - useToast() devuelve { show, success, info, warning, error, dismiss }.
// - Sin robar foco y sin role="alert": la región es role="status" con
//   aria-live="polite", así un aviso se anuncia sin interrumpir.
//
// La región existe aunque no haya avisos. Ese estado vacío se marca
// aria-hidden="true" a propósito: un contenedor vacío no tiene nada que
// anunciar y ocultarlo evita que compita con la región role="status" propia de
// cada página (el "ticket tomado", los indicadores de carga) al consultar el
// árbol accesible. En cuanto entra un aviso se quita el aria-hidden.

const MAX_VISIBLE = 3;

// error va en 0: persistente por defecto y sólo se cierra a mano. Cualquier
// tipo puede sobrescribirlo con { duration: ms } (y { duration: 0 } lo fija).
const DURACIONES = { success: 4000, info: 4000, warning: 6000, error: 0 };

const CIERRE = 'Cerrar notificación';

// Los iconos son adornos (aria-hidden) y el tipo se nombra además con texto
// para lector de pantalla: el aviso no depende sólo del color. Las clases van
// literales para que Tailwind las detecte al escanear el fuente.
const TIPOS = {
  success: { icono: '✓', etiqueta: 'Éxito', acento: 'bg-[var(--success)]', tinta: 'text-[var(--success)]' },
  info: { icono: 'i', etiqueta: 'Información', acento: 'bg-[var(--info)]', tinta: 'text-[var(--info)]' },
  warning: { icono: '!', etiqueta: 'Aviso', acento: 'bg-[var(--warning)]', tinta: 'text-[var(--warning)]' },
  error: { icono: '✕', etiqueta: 'Error', acento: 'bg-[var(--danger)]', tinta: 'text-[var(--danger)]' },
};

const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error(
      'useToast se usó fuera de <ToastProvider>. Envuelve el árbol con <ToastProvider> (lo hace main.jsx y renderWithProviders).'
    );
  }
  return ctx;
}

function Aviso({ aviso, onCerrar }) {
  const meta = TIPOS[aviso.type];
  return (
    <div
      data-testid="toast"
      data-type={aviso.type}
      className="pointer-events-auto flex w-full max-w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text)] shadow-[var(--shadow-overlay)] nex-pop"
    >
      <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${meta.acento}`} />
      <div className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5">
        <span aria-hidden="true" className={`shrink-0 text-base font-bold leading-none ${meta.tinta}`}>
          {meta.icono}
        </span>
        <p className="min-w-0 flex-1 break-words text-sm leading-snug">
          <span className="sr-only">{meta.etiqueta}: </span>
          {aviso.message}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onCerrar(aviso.id)}
        aria-label={CIERRE}
        className="mr-1.5 mt-1.5 h-7 w-7 shrink-0 rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-secondary)] hover:text-[var(--text)]"
      >
        <svg className="mx-auto h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [avisos, setAvisos] = useState([]);
  // Temporizadores por id: { handle, tick }. tick identifica el ciclo de vida
  // del aviso, no el nodo, así un duplicado se reprograma sin crear otro
  // elemento ni remover el que ya está en pantalla.
  const timers = useRef(new Map());
  const seq = useRef(0);

  const limpiar = useCallback((id) => {
    const entry = timers.current.get(id);
    if (!entry) return;
    clearTimeout(entry.handle);
    timers.current.delete(id);
  }, []);

  const cerrar = useCallback(
    (id) => {
      limpiar(id);
      setAvisos((prev) => prev.filter((t) => t.id !== id));
    },
    [limpiar]
  );

  const show = useCallback((type, message, options = {}) => {
    const texto = String(message ?? '');
    if (!texto) return;
    const tipo = TIPOS[type] ? type : 'info';
    const duration = options.duration === undefined ? DURACIONES[tipo] : options.duration;
    setAvisos((prev) => {
      const key = tipo + ' ' + texto;
      const idx = prev.findIndex((t) => t.key === key);
      if (idx >= 0) {
        // Mismo tipo y mensaje que uno ya visible: no se duplica el nodo, solo
        // se refresca su temporizador para que vuelva a durar lo que le toca.
        const copia = [...prev];
        copia[idx] = { ...copia[idx], duration, tick: copia[idx].tick + 1 };
        return copia;
      }
      seq.current += 1;
      const nuevo = { id: seq.current, key, type: tipo, message: texto, duration, tick: 0 };
      const siguiente = [...prev, nuevo];
      // Cuarto aviso: se descarta el mas antiguo y se conserva el nuevo.
      return siguiente.length > MAX_VISIBLE ? siguiente.slice(siguiente.length - MAX_VISIBLE) : siguiente;
    });
  }, []);

  const value = useMemo(
    () => ({
      show,
      dismiss: cerrar,
      success: (message, options) => show('success', message, options),
      info: (message, options) => show('info', message, options),
      warning: (message, options) => show('warning', message, options),
      error: (message, options) => show('error', message, options),
    }),
    [show, cerrar]
  );

  // Los temporizadores se reconcilian con la lista, nunca dentro del updater
  // de setState: React puede invocarlo dos veces en StrictMode.
  useEffect(() => {
    const vivos = new Set(avisos.map((t) => t.id));
    timers.current.forEach((entry, id) => {
      if (vivos.has(id)) return;
      clearTimeout(entry.handle);
      timers.current.delete(id);
    });
    avisos.forEach((t) => {
      if (!t.duration) return;
      const entry = timers.current.get(t.id);
      if (entry && entry.tick === t.tick) return;
      if (entry) {
        clearTimeout(entry.handle);
        timers.current.delete(t.id);
      }
      const handle = setTimeout(() => cerrar(t.id), t.duration);
      timers.current.set(t.id, { handle, tick: t.tick });
    });
  }, [avisos, cerrar]);

  // Al desmontar no queda ningun temporizador vivo.
  useEffect(() => {
    const mapa = timers.current;
    return () => {
      mapa.forEach((entry) => clearTimeout(entry.handle));
      mapa.clear();
    };
  }, []);

  // Escape cierra el aviso mas reciente. Si otro componente ya trato la tecla
  // (Select, inputs) o hay un dialogo modal abierto, el Escape es suyo.
  useEffect(() => {
    if (!avisos.length) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      cerrar(avisos[avisos.length - 1].id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [avisos, cerrar]);

  const vacia = avisos.length === 0;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          data-testid="toast-region"
          role="status"
          aria-live="polite"
          aria-atomic="false"
          {...(vacia ? { 'aria-hidden': 'true' } : {})}
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-end gap-2 p-4"
        >
          {avisos.map((t) => (
            <Aviso key={t.id} aviso={t} onCerrar={cerrar} />
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

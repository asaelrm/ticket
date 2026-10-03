import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Tooltip de SIFHA.
 *
 * Sustituye a los `title=` nativos dispersos por la aplicación. El `title` del
 * navegador tenía tres problemas que este componente resuelve: no aparece al
 * navegar con teclado, no se adapta al tema oscuro y llega tarde (~1 s), así que
 * un técnico que recorre una tabla con el ratón ve menos de lo que antes.
 *
 * Aparece con `hover` y con `focus`, se cierra con Escape, al salir y al
 * desplazarse o redimensionar. Se muestra en un portal a `document.body` con
 * `position: fixed`, igual que `Menu` y `Select`: dentro de una tabla o de una
 * tarjeta con `overflow`, una burbuja absoluta quedaría recortada, y el
 * contenedor del `header` la descentraría.
 *
 * Accessibility: la burbuja es `role="tooltip"` y se asocia al disparador con
 * `aria-describedby`, de forma que el texto es la *descripción* del control y no
 * sustituye a su nombre accesible. Por eso hay que mantener el `aria-label`: un
 * icono no se anuncia solo y un tooltip no es un nombre accesible.
 *
 * `describe={false}` es para cuando el texto ya es el nombre accesible del
 * elemento (una barra de color que sólo se entiende mirando su `aria-label`):
 * ahí la burbuja es sólo visual y se marca `aria-hidden` para no repetir la
 * misma frase dos veces en el lector de pantalla.
 *
 * @param {string} text          texto del tooltip
 * @param {'top'|'bottom'} placement  lado preferido; se invierte si no cabe
 * @param {boolean} describe     asocia el texto con `aria-describedby`
 */
export default function Tooltip({
  text,
  placement = 'top',
  describe = true,
  children,
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const bubbleRef = useRef(null);
  const timer = useRef(null);
  const id = useId();

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clear();
    // Un retardo corto quita el parpadeo al recorrer una fila de la tabla con
    // el ratón, que es justo cuando se pasa por encima de celdas que no
    // tienen tooltip.
    timer.current = setTimeout(() => setOpen(true), 250);
  }, [clear]);

  const hide = useCallback(() => {
    clear();
    setOpen(false);
  }, [clear]);

  // Al ocultar (o desmontar) se cancela el retardo pendiente: si no, el tooltip
  // aparecería después de haber salido el puntero o el foco.
  useEffect(() => clear, [clear]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') hide();
    };
    // La burbuja es `position: fixed`: si la tabla se desplaza o la ventana
    // cambia, quedaría apuntando al vacío. Se cierra, como hace `Menu`.
    const onMove = () => hide();
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, hide]);

  // Se mide en un efecto de layout, antes de pintar: así la burbuja no aparece
  // primero en (0,0) y luego salta a su sitio. Se elige el lado según el
  // espacio libre de verdad y se recorta horizontalmente para no salirse del
  // viewport en pantallas estrechas.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = wrapRef.current?.getBoundingClientRect();
    const bubble = bubbleRef.current?.getBoundingClientRect();
    if (!trigger || !bubble) return;

    const gap = 8;
    const margin = 8;
    const below = window.innerHeight - trigger.bottom;
    const above = trigger.top;
    let side = placement;
    if (placement === 'top' && above < bubble.height + gap && below > above) side = 'bottom';
    if (placement === 'bottom' && below < bubble.height + gap && above > below) side = 'top';

    const top = side === 'top' ? trigger.top - bubble.height - gap : trigger.bottom + gap;
    const center = trigger.left + trigger.width / 2;
    const left = Math.min(
      Math.max(center - bubble.width / 2, margin),
      Math.max(margin, window.innerWidth - bubble.width - margin)
    );
    setPos({ top, left });
  }, [open, placement]);

  if (!text || !isValidElement(children)) return children ?? null;

  const child = Children.only(children);
  const describedBy = describe
    ? [child.props['aria-describedby'], id].filter(Boolean).join(' ')
    : child.props['aria-describedby'];

  return (
    <span
      ref={wrapRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onPointerDown={hide}
    >
      {cloneElement(child, { 'aria-describedby': describedBy || undefined })}
      {open &&
        createPortal(
          <span
            id={id}
            ref={bubbleRef}
            role={describe ? 'tooltip' : undefined}
            aria-hidden={describe ? undefined : 'true'}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
            className="nex-fade pointer-events-none fixed z-[60] box-border w-max max-w-[min(18rem,calc(100vw-1.5rem))] rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] px-2.5 py-1.5 text-xs leading-snug font-medium text-[var(--text)] shadow-[var(--shadow-overlay)]"
          >
            {text}
          </span>,
          document.body
        )}
    </span>
  );
}
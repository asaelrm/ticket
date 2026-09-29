import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Select propio para teñir también el menú desplegado, que es la única parte
 * que el `<select>` nativo deja en manos del sistema.
 *
 * Sustituye a `<select>` de forma gradual: mismo contrato de valores (siempre
 * cadenas, como `event.target.value`) y mismos `options` en forma
 * `[{ value, label, disabled }]`.
 *
 * - `onChange(value)` recibe el valor, no el evento.
 * - `name` renderiza un input oculto para que el campo siga apareciendo en
 *   formularios; sin `name` no se añade nada al DOM.
 * - El menú se monta en `document.body`: las tarjetas del tema usan
 *   `backdrop-filter`, que crea un stacking context, así que un menú dentro del
 *   DOM del control quedaría atrapado detrás de la tabla aunque lleve `z-index`.
 */
const TYPE_RESET_MS = 700;

const MENU_GAP = 4; // separación entre el control y el menú
const EDGE = 8; // margen mínimo con el borde de la ventana
const MAX_MENU_HEIGHT = 288; // 18rem
const MIN_MENU_HEIGHT = 120; // con menos sitio, el menú se abre hacia arriba

// Los valores viajan como cadenas para igualar al `<select>` nativo: las
// opciones con `id` numérico siguen llegando a `onChange` como texto.
const asKey = (v) => (v === null || v === undefined ? '' : String(v));

// Sin tildes ni mayúsculas, para que escribir "crit" encuentre "Crítica".
const plain = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

// Primera opción habilitada a partir de `from` en la dirección `dir`, con
// vuelta al final. Si todas están deshabilitadas devuelve `from`.
function step(options, from, dir) {
  for (let i = 1; i <= options.length; i += 1) {
    const next = (((from + dir * i) % options.length) + options.length) % options.length;
    if (!options[next]?.disabled) return next;
  }
  return from;
}

function Chevron() {
  return (
    <svg className="select-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m5 13 4 4 10-10"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Select({
  id,
  name,
  value,
  onChange,
  options = [],
  placeholder = 'Selecciona una opción',
  disabled = false,
  className = '',
  ...rest
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState({ flip: false, top: 0, bottom: null, left: 0, width: 0, maxHeight: MAX_MENU_HEIGHT });
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const optionRefs = useRef([]);
  const typeRef = useRef({ text: '', at: 0 });
  const base = useId();
  const listId = `${base}-listbox`;
  const optionId = (i) => `${base}-option-${i}`;

  const items = useMemo(() => options.filter(Boolean), [options]);
  const currentKey = asKey(value);
  const selectedIndex = items.findIndex((o) => asKey(o.value) === currentKey);
  const isPlaceholder = selectedIndex < 0;
  const current = isPlaceholder ? placeholder : items[selectedIndex].label;

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  // El menú va en coordenadas de ventana (`position: fixed`), así que se
  // placementa midiendo el control. Si no cabe debajo, se abre hacia arriba; en
  // horizontal se mantiene dentro del viewport.
  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - MENU_GAP - EDGE;
    const above = r.top - MENU_GAP - EDGE;
    const flip = below < MIN_MENU_HEIGHT && above > below;
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - EDGE - r.width));
    setPlace({
      flip,
      top: r.bottom + MENU_GAP,
      bottom: flip ? window.innerHeight - r.top + MENU_GAP : null,
      left,
      width: r.width,
      maxHeight: Math.max(MIN_MENU_HEIGHT, Math.min(MAX_MENU_HEIGHT, flip ? above : below)),
    });
  };

  // Se mide antes de abrir para que el menú ya nazca colocado y no dé un salto
  // desde la esquina.
  const openAt = (index) => {
    measure();
    setActive(index);
    setOpen(true);
  };

  const choose = (i) => {
    const option = items[i];
    if (!option || option.disabled) return;
    onChange?.(asKey(option.value));
    close();
  };

  // Clic en cualquier parte que no sea el control ni el menú (que vive en otro
  // punto del DOM por el portal).
  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (e) => {
      const insideMenu = menuRef.current?.contains(e.target);
      const insideTrigger = triggerRef.current?.contains(e.target);
      if (!insideMenu && !insideTrigger) close();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // El menú sigue al control si la página se desplaza o cambia de tamaño. El
  // scroll se escucha en fase de captura para pescar también el de cualquier
  // ancestro con scroll propio.
  useEffect(() => {
    if (!open) return undefined;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Mantiene visible la opción activa cuando la lista es más larga que el menú.
  useEffect(() => {
    if (!open || active < 0) return;
    optionRefs.current[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (e) => {
    if (disabled || e.altKey || e.ctrlKey || e.metaKey) return;
    const { key } = e;

    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        e.preventDefault();
        // Abrir deja el cursor donde ya estabas; con ArrowUp se va al final,
        // que es la lectura natural de "sube al último".
        const from = selectedIndex >= 0 ? selectedIndex : step(items, -1, 1);
        openAt(key === 'ArrowUp' ? step(items, items.length, -1) : from);
      }
      return;
    }

    if (key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => step(items, i, 1));
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => step(items, i, -1));
    } else if (key === 'Home') {
      e.preventDefault();
      setActive(step(items, -1, 1));
    } else if (key === 'End') {
      e.preventDefault();
      setActive(step(items, items.length, -1));
    } else if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      choose(active);
    } else if (key === 'Escape') {
      e.preventDefault();
      close();
    } else if (key === 'Tab') {
      close();
    } else if (key.length === 1) {
      // Búsqueda por letras, como en el desplegable nativo: se acumulan en una
      // ventana corta y se busca desde la opción activa.
      const now = Date.now();
      const buffer = now - typeRef.current.at > TYPE_RESET_MS ? key : typeRef.current.text + key;
      typeRef.current = { text: buffer, at: now };
      const needle = plain(buffer);
      for (let n = 0; n < items.length; n += 1) {
        const i = (active + 1 + n) % items.length;
        if (items[i].disabled) continue;
        if (plain(items[i].label).startsWith(needle)) {
          setActive(i);
          return;
        }
      }
    }
  };

  return (
    <div>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        disabled={disabled}
        data-placeholder={isPlaceholder ? 'true' : undefined}
        className={`select-trigger ${className}`.trim()}
        onClick={() => (open ? close() : openAt(selectedIndex >= 0 ? selectedIndex : step(items, -1, 1)))}
        onKeyDown={onKeyDown}
        {...rest}
      >
        <span className="truncate">{current}</span>
        <Chevron />
      </button>

      {open &&
        createPortal(
          <ul
            id={listId}
            role="listbox"
            ref={menuRef}
            className="panel-glass nex-pop select-menu"
            style={{
              top: place.flip ? undefined : place.top,
              bottom: place.flip ? place.bottom : undefined,
              left: place.left,
              minWidth: place.width,
              maxWidth: `calc(100vw - ${place.left + EDGE}px)`,
              maxHeight: place.maxHeight,
            }}
          >
            {items.map((option, i) => {
              const isSelected = asKey(option.value) === currentKey;
              return (
                <li
                  key={asKey(option.value)}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  data-active={i === active ? 'true' : undefined}
                  data-disabled={option.disabled ? 'true' : undefined}
                  ref={(el) => {
                    optionRefs.current[i] = el;
                  }}
                  className="select-option"
                  onMouseMove={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                >
                  {/* Hueco fijo para que el check no desplace los rótulos. */}
                  <span className="flex w-4 shrink-0 justify-end text-white/85">{isSelected && <Check />}</span>
                  <span className="flex-1 truncate">{option.label}</span>
                </li>
              );
            })}
          </ul>,
          document.body
        )}

      {name ? <input type="hidden" name={name} value={currentKey} readOnly /> : null}
    </div>
  );
}

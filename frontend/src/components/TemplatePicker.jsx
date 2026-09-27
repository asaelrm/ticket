import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { renderMessage } from '../lib/markdown';
import { extractVariables, expandTemplate, MAX_COMMENT_LENGTH } from '../lib/templateVars';
import { Spinner, EmptyState, ErrorBox } from './ui';

const SCOPE_LABEL = { GLOBAL: 'Global', PERSONAL: 'Personal', TEAM: 'Equipo' };

function scopeBadge(t) {
  if (t.scope === 'TEAM') return `Equipo: ${t.team_name || '—'}`;
  return SCOPE_LABEL[t.scope] || t.scope;
}

/**
 * Selector de respuestas rápidas del editor de ticket.
 *
 * Nunca envía el comentario: solo devuelve el texto ya expandido al padre, que
 * lo inserta en el textarea. El contador de caracteres avisa cuando el texto
 * expandido superaría el máximo del comentario para que no se intente enviar.
 */
export default function TemplatePicker({ context, onInsert, onManagePersonal, onManageGlobal, canManageGlobal = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 150);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isFetching, error } = useQuery({
    queryKey: ['canned-responses', debounced],
    queryFn: () => api.get(`/api/canned-responses?q=${encodeURIComponent(debounced)}`).then((d) => d.data?.data || []),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const templates = data || [];

  useEffect(() => {
    setHighlight(0);
  }, [debounced]);

  const place = () => {
    const btn = buttonRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    // El alto del panel no se conoce hasta que se ha renderizado (cambia según
    // si hay resultados, vista previa, etc.), así que se mide. Antes se
    // asumía un alto fijo de 320 px: en una pantalla baja el panel se salía por
    // abajo, y con window.innerHeight < 320 la posición calculada era negativa
    // y el menú aparecía fuera de la ventana.
    const height = panelRef.current?.getBoundingClientRect().height ?? 320;
    const margin = 8;
    const roomBelow = window.innerHeight - r.bottom - margin;
    const roomAbove = r.top - margin;
    let top;
    if (height <= roomBelow) top = r.bottom + 6;
    else if (height <= roomAbove) top = Math.max(margin, r.top - height - 6);
    else top = Math.max(margin, Math.min(r.bottom + 6, window.innerHeight - height - margin));
    setPos({ top: Math.round(top), left: Math.round(left) });
  };

  useEffect(() => {
    if (!open) {
      setSearch('');
      return undefined;
    }
    place();
    const onClick = (e) => {
      const inPanel = panelRef.current && panelRef.current.contains(e.target);
      const inButton = buttonRef.current && buttonRef.current.contains(e.target);
      if (!inPanel && !inButton) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    const onMove = () => place();
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const current = templates[highlight] || null;
  const expansion = current ? expandTemplate(current.body, context) : null;
  const tooLong = Boolean(expansion && expansion.text.length > MAX_COMMENT_LENGTH);
  const templateVars = current ? extractVariables(current.body) : { used: [], unknown: [] };

  const close = () => setOpen(false);

  // Reubicar cuando cambia el alto del panel: al abrirlo la lista suele estar
  // vacía y al cargar los resultados (o al elegir una plantilla y aparecer la
  // vista previa) crece. Se declara aquí porque depende de `tooLong`.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, templates.length, highlight, tooLong]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  function insert(mode) {
    if (!current || !expansion || tooLong) return;
    onInsert({ text: expansion.text, template: current, mode });
    close();
  }

  async function copy() {
    if (!current || !expansion || tooLong) return;
    try {
      await navigator.clipboard?.writeText(expansion.text);
    } catch {
      /* el portapapeles puede estar bloqueado: no es crítico */
    }
    close();
  }

  function onPanelKeyDown(e) {
    if (!templates.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((i) => (i + 1) % templates.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((i) => (i - 1 + templates.length) % templates.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      insert('cursor');
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        // text-slate-600 y no text-slate-100: con la paleta invertida de
        // index.css, slate-100 es un azul marino (#0C3347) que sobre la barra
        // del editor (#08283d) quedaba en 1.05:1, es decir invisible.
        className="rounded-md border border-white/25 bg-white/10 px-2 py-1 text-xs font-semibold text-slate-700 transition hover:border-white/40 hover:bg-white/20"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Respuestas rápidas"
      >
        ⚡ Respuestas rápidas
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Respuestas rápidas"
            onKeyDown={onPanelKeyDown}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: 420, maxWidth: 'calc(100vw - 16px)' }}
            // El panel se portaliza a document.body, así que NO hereda la
            // superficie de la tarjeta: debe declarar la suya. Era bg-white
            // (blanco puro) con texto slate-800, que en esta paleta también es
            // blanco: títulos y vista previa invisibles. Ahora usa las mismas
            // superficies oscuras que el resto de la aplicación.
            className="z-50 overflow-hidden rounded-xl border border-cyan-300/40 bg-[#0e3a50] shadow-xl"
          >
            <div className="border-b border-cyan-300/20 p-3">
              <label className="sr-only" htmlFor="canned-search">
                Buscar respuestas rápidas
              </label>
              <input
                id="canned-search"
                className="input"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por título o contenido…"
              />
            </div>

            <div className="max-h-64 overflow-y-auto">
              {error && (
                <div className="p-3">
                  <ErrorBox message={error.message || 'No se pudieron cargar las plantillas'} />
                </div>
              )}
              {!error && isFetching && !templates.length && (
                <div className="flex items-center justify-center gap-2 p-6 text-sm text-slate-500">
                  <Spinner className="h-4 w-4" /> Cargando…
                </div>
              )}
              {!error && !templates.length && !isFetching && (
                <EmptyState
                  icon="⚡"
                  title={debounced ? 'Sin resultados' : 'Sin respuestas rápidas'}
                  subtitle={debounced ? undefined : 'Cree las suyas desde Mi cuenta.'}
                />
              )}

              {templates.map((t, index) => (
                <div key={t.id}>
                  {index === 0 || templates[index - 1].scope !== t.scope ? (
                    // bg-slate-50 (#0E3A50) era idéntico al fondo del panel, así
                    // que la cabecera de grupo no se veía; slate-400 sobre
                    // #0E3A50 tampoco llegaba a 4.5:1.
                    <p className="bg-[#08283d] px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {scopeBadge(t)}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => setHighlight(index)}
                    aria-pressed={index === highlight}
                    // hover:bg-slate-50 era el mismo color que el panel (invisible)
                    // y la selección usaba bg-brand-50 (#E7FAF1, casi blanco) con
                    // texto slate-800 (#F8FAFC, blanco): blanco sobre blanco.
                    className={`block w-full px-3 py-2 text-left text-sm transition hover:bg-white/10 ${
                      index === highlight ? 'bg-brand-500/20 ring-1 ring-inset ring-brand-400/40' : ''
                    }`}
                  >
                    <span className="block font-medium text-slate-700">{t.title}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {t.scope === 'TEAM' ? `${t.team_name} · ` : ''}
                      {t.body.slice(0, 80)}
                    </span>
                  </button>
                </div>
              ))}
            </div>

            {current && (
              <div className="border-t border-cyan-300/20 bg-[#08283d] p-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Vista previa</p>
                {/* El cuerpo se escapa antes de aplicar markdown: nunca HTML crudo. */}
                <div
                  className="max-h-28 overflow-y-auto rounded-lg border border-cyan-300/20 bg-[#0b3046] p-2 text-sm text-slate-600"
                  dangerouslySetInnerHTML={{ __html: renderMessage(expansion.text) }}
                />
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {templateVars.used.map((k) => (
                    <span key={k} className="rounded bg-brand-100 px-1.5 py-0.5 text-[11px] text-brand-700">
                      {`{{${k}}}`}
                    </span>
                  ))}
                  {expansion.unknown.map((k) => (
                    <span key={k} className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                      Desconocida: {`{{${k}}}`}
                    </span>
                  ))}
                </div>
                {tooLong && (
                  <p className="mt-2 text-xs font-medium text-red-300">
                    El texto expandido tiene {expansion.text.length} caracteres y supera el máximo de {MAX_COMMENT_LENGTH} del
                    comentario. Acorte la plantilla antes de usarla.
                  </p>
                )}
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={copy} disabled={tooLong}>
                    Copiar
                  </button>
                  <button type="button" className="btn-secondary !px-2 !py-1 text-xs" onClick={() => insert('replace')} disabled={tooLong}>
                    Reemplazar todo
                  </button>
                  <button type="button" className="btn-primary !px-2 !py-1 text-xs" onClick={() => insert('cursor')} disabled={tooLong}>
                    Insertar
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap justify-between gap-2 border-t border-cyan-300/20 bg-[#08283d] px-3 py-2 text-xs">
              {onManagePersonal && (
                <button type="button" className="text-brand-300 hover:underline" onClick={() => { close(); onManagePersonal(); }}>
                  Administrar mis plantillas
                </button>
              )}
              {canManageGlobal && onManageGlobal && (
                <button type="button" className="text-brand-300 hover:underline" onClick={() => { close(); onManageGlobal(); }}>
                  Plantillas globales y de equipo
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

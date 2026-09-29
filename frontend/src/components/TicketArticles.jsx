import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth, can } from '../context/AuthContext';
import { ErrorBox, Modal, Spinner } from '../components/ui';
import Select from './Select';
import { ARTICLE_LIMITS, fieldErrors, toQuery } from '../lib/kb';

// Artículos de la base de conocimiento asociados a un ticket.
//
// Reglas que respeta esta pantalla, todas respaldadas por el servidor:
//  * GET /api/tickets/:id/articles exige kb.view y la visibilidad del ticket, y
//    solo devuelve artículos PUBLICADOS. Por eso aquí no hay que filtrar
//    borradores: un borrador enlazado es invisible en este listado por diseño.
//  * Enlazar y desenlazar es una escritura y va por
//    POST/DELETE /api/kb-articles/:articleId/tickets/:ticketId, que exige
//    kb.create. El botón se oculta sin ese permiso, pero la comprobación real
//    es del servidor.
//  * El borrador sale de la previsualización de solo lectura
//    GET /api/kb-articles/from-ticket/:ticketId, que nunca incluye notas
//    internas, adjuntos ni datos del reportante. El cuerpo enviado se limita a
//    los seis campos editoriales y sin status: el artículo nace SIEMPRE en
//    borrador y esta pantalla no publica nada.

const EMPTY_DRAFT = {
  title: '',
  summary: '',
  description: '',
  solution: '',
  keywords: '',
  category_id: '',
};

// Lista blanca estricta del cuerpo de POST /api/kb-articles. Fuera de aquí no
// pasa nada del ticket: ni status, ni ticket_id, ni autor, ni notas internas,
// ni adjuntos, ni datos personales del reportante.
function toPayload(form) {
  return {
    title: form.title,
    summary: form.summary,
    description: form.description,
    solution: form.solution,
    keywords: form.keywords,
    category_id: form.category_id === '' ? null : Number(form.category_id),
  };
}

// El resumen NO viene en la previsualización, así que se pide explícitamente en
// lugar de inventarlo: quien documente decide cómo se resume su propio caso.
function draftFromPreview(p) {
  return {
    title: p.title || '',
    summary: '',
    description: p.description || '',
    solution: p.solution || '',
    keywords: p.keywords || '',
    category_id: p.category_id == null ? '' : String(p.category_id),
  };
}

function validateDraft(form) {
  const errors = {};
  for (const name of ['title', 'summary', 'description', 'solution']) {
    if (!form[name].trim()) errors[name] = 'Campo obligatorio';
    else if (form[name].length > ARTICLE_LIMITS[name]) {
      errors[name] = `No debe exceder ${ARTICLE_LIMITS[name]} caracteres`;
    }
  }
  if (form.keywords.length > ARTICLE_LIMITS.keywords) {
    errors.keywords = `No debe exceder ${ARTICLE_LIMITS.keywords} caracteres`;
  }
  return errors;
}

export default function TicketArticles({ ticket }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Sin kb.view no hay nada que mostrar ni que consultar: la sección no existe.
  const canView = can(user, 'kb.view');
  // kb.create es lo que autoriza a modificar el enlace y a redactar artículos.
  const canCreate = can(user, 'kb.create');

  const [term, setTerm] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [fields, setFields] = useState({});
  const [draftError, setDraftError] = useState('');
  const [filled, setFilled] = useState(false);
  const [created, setCreated] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['ticket-articles', ticket.id],
    queryFn: () => api.get(`/api/tickets/${ticket.id}/articles`),
    enabled: canView,
  });

  const q = term.trim();
  const search = useQuery({
    queryKey: ['kb-search', q],
    // El backend filtra con LIKE %término%: una letra suelta no devuelve nada
    // útil, así que se espera a dos caracteres.
    queryFn: () => api.get(`/api/kb-articles?${toQuery({ q, perPage: 5 })}`),
    enabled: canCreate && searchOpen && q.length >= 2,
  });

  const { data: previewData, isLoading: previewLoading, error: previewError } = useQuery({
    queryKey: ['kb-from-ticket', ticket.id],
    queryFn: () => api.get(`/api/kb-articles/from-ticket/${ticket.id}`),
    enabled: draftOpen,
  });
  const preview = previewData?.preview;

  const { data: categories } = useQuery({
    queryKey: ['kb-categories'],
    queryFn: () => api.get('/api/kb-categories').then((r) => r.data),
    enabled: draftOpen,
  });

  // Rellena el formulario con lo que propone la API, una sola vez por sesión del
  // diálogo: así una refactorización en segundo plano no borra lo ya escrito.
  useEffect(() => {
    if (preview && !filled) {
      setDraft(draftFromPreview(preview));
      setFilled(true);
    }
  }, [preview, filled]);

  const linked = data?.data || [];
  const linkedIds = useMemo(() => new Set(linked.map((a) => a.id)), [linked]);
  const results = search.data?.data || [];

  const links = useMutation({
    mutationFn: ({ method, articleId }) => api[method](`/api/kb-articles/${articleId}/tickets/${ticket.id}`),
    onSuccess: (_result, { articleId }) => {
      setLinkError('');
      queryClient.invalidateQueries({ queryKey: ['ticket-articles', ticket.id] });
      // La ficha del artículo muestra sus tickets enlazados y la indexa por el
      // id de la ruta, que llega como texto.
      queryClient.invalidateQueries({ queryKey: ['kb-article', String(articleId)] });
    },
    onError: (err) => setLinkError(err.message || 'No se pudo actualizar el vínculo'),
  });

  const createDraft = useMutation({
    mutationFn: (form) => api.post('/api/kb-articles', toPayload(form)),
    onSuccess: (result) => {
      setDraftError('');
      setFields({});
      closeDraft();
      setCreated(result.article);
      queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
    },
    onError: (err) => {
      setDraftError(err.message || 'No se pudo crear el borrador');
      // El servidor responde { fields } con las etiquetas ya en español.
      setFields(fieldErrors(err));
    },
  });

  if (!canView) return null;

  function openDraft() {
    setDraftError('');
    setFields({});
    setFilled(false);
    setDraftOpen(true);
  }

  function closeDraft() {
    setDraftOpen(false);
    setDraft(EMPTY_DRAFT);
    setFilled(false);
  }

  function submitDraft(e) {
    e.preventDefault();
    setDraftError('');
    const invalid = validateDraft(draft);
    setFields(invalid);
    if (Object.keys(invalid).length) {
      setDraftError('Revise los campos marcados antes de crear el borrador.');
      return;
    }
    createDraft.mutate(draft);
  }

  return (
    <div className="card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Base de conocimiento</h3>
        {linked.length > 0 && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {linked.length} vinculados
          </span>
        )}
      </div>

      {created && (
        <div
          className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          role="status"
        >
          Borrador creado:{' '}
          <Link className="font-medium underline" to={`/app/knowledge/${created.id}`}>
            {created.title}
          </Link>
          . Solo usted lo ve hasta que lo publique.
        </div>
      )}

      {linkError && <ErrorBox message={linkError} />}

      {isLoading ? (
        <p className="text-sm text-slate-500">Cargando artículos…</p>
      ) : error ? (
        <ErrorBox message={error.message || 'No se pudieron cargar los artículos del ticket'} />
      ) : linked.length === 0 ? (
        <p className="text-sm text-slate-500">
          Este ticket no tiene artículos vinculados.
          {canCreate && ' Vincule uno publicado o documente la solución como borrador.'}
        </p>
      ) : (
        <ul className="space-y-2.5">
          {linked.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link
                  to={`/app/knowledge/${a.id}`}
                  className="block truncate text-sm font-medium text-brand-700 hover:underline"
                >
                  {a.title}
                </Link>
                <p className="truncate text-xs text-slate-400">
                  {a.category_name || 'Sin categoría'} · {a.view_count} consulta{a.view_count === 1 ? '' : 's'}
                </p>
              </div>
              {canCreate && (
                <button
                  type="button"
                  className="btn-secondary !px-2 !py-1 text-xs"
                  disabled={links.isPending}
                  onClick={() => links.mutate({ method: 'del', articleId: a.id })}
                >
                  Desvincular
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canCreate && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary !px-2.5 !py-1.5 text-xs"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((v) => !v);
              setLinkError('');
            }}
          >
            {searchOpen ? 'Cerrar búsqueda' : 'Vincular artículo'}
          </button>
          {['RESOLVED', 'CLOSED'].includes(ticket.status) && (
            <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={openDraft}>
              Crear borrador desde el ticket
            </button>
          )}
        </div>
      )}

      {canCreate && searchOpen && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <label className="label" htmlFor="kb-search-ticket">
            Buscar artículos publicados
          </label>
          <input
            id="kb-search-ticket"
            className="input"
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setLinkError('');
            }}
            placeholder="Palabras clave del problema…"
            autoComplete="off"
          />

          {q.length > 0 && q.length < 2 && (
            <p className="mt-1.5 text-xs text-slate-400">Escriba al menos dos caracteres.</p>
          )}

          {q.length >= 2 && search.isFetching && <p className="mt-2 text-xs text-slate-400">Buscando…</p>}

          {q.length >= 2 && search.error && <ErrorBox message={search.error.message || 'No se pudo buscar'} />}

          {q.length >= 2 && !search.isFetching && !search.error && (
            <ul className="mt-2 space-y-2">
              {results.length === 0 ? (
                <li className="text-xs text-slate-500">Ningún artículo publicado coincide con «{q}».</li>
              ) : (
                results.map((a) => {
                  const isLinked = linkedIds.has(a.id);
                  return (
                    <li key={a.id} className="rounded-lg border border-slate-100 p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Link
                            to={`/app/knowledge/${a.id}`}
                            className="block truncate text-sm font-medium text-slate-700 hover:underline"
                          >
                            {a.title}
                          </Link>
                          <p className="truncate text-xs text-slate-400">
                            {a.category_name || 'Sin categoría'} · {a.author_name}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="btn-secondary !px-2 !py-1 text-xs"
                          disabled={isLinked || links.isPending}
                          onClick={() => links.mutate({ method: 'post', articleId: a.id })}
                        >
                          {isLinked ? 'Vinculado' : 'Vincular'}
                        </button>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          )}

          <p className="mt-2 text-xs text-slate-400">
            Solo se ofrecen artículos publicados. Los borradores no se enlazan desde aquí.
          </p>
        </div>
      )}

      <DraftModal
        open={draftOpen}
        onClose={closeDraft}
        loading={previewLoading}
        error={previewError}
        preview={preview}
        form={draft}
        setForm={setDraft}
        categories={categories || []}
        fields={fields}
        errorMessage={draftError}
        saving={createDraft.isPending}
        onSubmit={submitDraft}
        ticketCategory={ticket.category_name}
      />
    </div>
  );
}

function DraftModal({ open, onClose, loading, error, preview, form, setForm, categories, fields, errorMessage, saving, onSubmit, ticketCategory }) {
  // Antes del early-return: los hooks no pueden quedar detrás de una salida
  // condicional.
  // "Sin categoría" era una `<option>` vacía seleccionable: se conserva como
  // opción real para poder volver a ella.
  const categoryOptions = useMemo(
    () => [{ value: '', label: 'Sin categoría' }, ...(categories || []).map((c) => ({ value: c.id, label: c.name }))],
    [categories]
  );

  if (!open) return null;

  const set = (name, value) => setForm({ ...form, [name]: value });

  return (
    <Modal open onClose={onClose} title="Crear borrador desde el ticket" wide>
      {loading ? (
        <p className="text-sm text-slate-500">Preparando la previsualización…</p>
      ) : error ? (
        <div className="space-y-4">
          <ErrorBox message={error.message || 'No se pudo preparar el borrador'} />
          <p className="text-sm text-slate-500">
            Solo los tickets resueltos o cerrados con solución registrada pueden convertirse en artículo.
          </p>
          <div className="flex justify-end">
            <button className="btn-secondary" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Se creará un <b>borrador</b> visible solo para usted. No se publica nada automáticamente.
          </div>

          <dl className="grid gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 sm:grid-cols-3">
            <div>
              <dt className="font-semibold">Ticket</dt>
              <dd>{preview.ticket_number}</dd>
            </div>
            {preview.resolution_category && (
              <div>
                <dt className="font-semibold">Categoría de solución</dt>
                <dd>{preview.resolution_category}</dd>
              </div>
            )}
            {preview.root_cause && (
              <div>
                <dt className="font-semibold">Causa</dt>
                <dd>{preview.root_cause}</dd>
              </div>
            )}
          </dl>

          <p className="text-xs text-slate-400">
            La previsualización no incluye notas internas, adjuntos ni datos personales del reportante. Revise el
            texto y complete el resumen antes de guardarlo.
          </p>

          {errorMessage && <ErrorBox message={errorMessage} />}

          {[
            ['title', 'Título', 1, false],
            ['summary', 'Resumen', 1, true],
            ['description', 'Descripción', 4, true],
            ['solution', 'Solución', 6, true],
          ].map(([name, label, rows, required]) => (
            <div key={name}>
              <label className="label" htmlFor={`kb-draft-${name}`}>
                {label}
                {required && ' *'}
              </label>
              {rows === 1 ? (
                <input
                  id={`kb-draft-${name}`}
                  className={`input ${fields[name] ? '!border-red-400' : ''}`}
                  value={form[name]}
                  maxLength={ARTICLE_LIMITS[name]}
                  aria-invalid={fields[name] ? 'true' : undefined}
                  onChange={(e) => set(name, e.target.value)}
                />
              ) : (
                <textarea
                  id={`kb-draft-${name}`}
                  rows={rows}
                  className={`input min-h-[5rem] ${fields[name] ? '!border-red-400' : ''}`}
                  value={form[name]}
                  maxLength={ARTICLE_LIMITS[name]}
                  aria-invalid={fields[name] ? 'true' : undefined}
                  onChange={(e) => set(name, e.target.value)}
                />
              )}
              <div className="mt-1 flex items-start justify-between gap-2 text-xs">
                <span className={fields[name] ? 'text-red-600' : 'text-slate-400'}>
                  {fields[name] || (name === 'summary' ? 'La previsualización no lo propone: es obligatorio.' : '')}
                </span>
                <span className="shrink-0 text-slate-400">
                  {form[name].length}/{ARTICLE_LIMITS[name]}
                </span>
              </div>
            </div>
          ))}

          <div>
            <label className="label" htmlFor="kb-draft-keywords">
              Palabras clave
            </label>
            <input
              id="kb-draft-keywords"
              className={`input ${fields.keywords ? '!border-red-400' : ''}`}
              value={form.keywords}
              maxLength={ARTICLE_LIMITS.keywords}
              onChange={(e) => set('keywords', e.target.value)}
              placeholder="correo, contraseña"
            />
          </div>

          <div>
            <label className="label" htmlFor="kb-draft-category">
              Categoría de conocimiento
            </label>
            <Select
              id="kb-draft-category"
              options={categoryOptions}
              value={form.category_id}
              onChange={(v) => set('category_id', v)}
            />
            <p className="mt-1 text-xs text-slate-400">
              Es el tema de documentación, no la categoría de la incidencia ({ticketCategory || 'sin categoría'}).
            </p>
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving && <Spinner className="h-4 w-4 text-white" />}
              Crear borrador
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth, can } from '../context/AuthContext';
import { ErrorBox, EmptyState, Modal, Spinner } from '../components/ui';
import { ARTICLE_LIMITS, fieldErrors, toQuery } from '../lib/kb';

// Artículos de la base de conocimiento asociados a un ticket.
//
// Reglas que respeta esta pantalla, todas respaldadas por el servidor:
//  * GET /api/tickets/:id/articles exige kb.view y la visibilidad del ticket, y
//    solo devuelve artículos PUBLICADOS. Por eso aquí no se filtran borradores:
//    un borrador enlazado es invisible en este listado por diseño.
//  * Enlazar y desenlazar es una escritura y por eso va por
//    POST/DELETE /api/kb-articles/:articleId/tickets/:ticketId, que exige
//    kb.create. El botón se oculta sin él, pero la comprobación real es del
//    servidor.
//  * El borrador se crea con POST /api/kb-articles a partir de la previsualización
//    de GET /api/kb-articles/from-ticket/:ticketId, que es de solo lectura y
//    nunca incluye notas internas, adjuntos ni datos del reportante. El cuerpo
//    que se envía se limita a los seis campos editoriales, sin status: el
//    artículo nace SIEMPRE en borrador y aquí no se publica nada.

const EMPTY_DRAFT = { title: '', summary: '', description: '', solution: '', keywords: '', category_id: '' };

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
  const [draftError, setDraftError] = useState('');
  const [created, setCreated] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['ticket-articles', ticket.id],
    queryFn: () => api.get(`/api/tickets/${ticket.id}/articles`),
    enabled: canView,
  });

  const q = term.trim();
  const search = useQuery({
    queryKey: ['kb-search', q],
    // Solo se busca a partir de dos caracteres: el backend hace LIKE %término%
    // y una letra suelta no devuelve nada útil.
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

  const linked = data?.data || [];
  const linkedIds = useMemo(() => new Set(linked.map((a) => a.id)), [linked]);
  const results = search.data?.data || [];

  const links = useMutation({
    mutationFn: ({ method, articleId }) => api[method](`/api/kb-articles/${articleId}/tickets/${ticket.id}`),
    onSuccess: (_result, variables) => {
      setLinkError('');
      queryClient.invalidateQueries({ queryKey: ['ticket-articles', ticket.id] });
      // La ficha del artículo también muestra sus tickets enlazados.
      queryClient.invalidateQueries({ queryKey: ['kb-article', variables.articleId] });
      queryClient.invalidateQueries({ queryKey: ['kb-article', String(variables.articleId)] });
    },
    onError: (err) => setLinkError(err.message || 'No se pudo actualizar el vínculo'),
  });

  const createDraft = useMutation({
    mutationFn: (form) => api.post('/api/kb-articles', toPayload(form)),
    onSuccess: (result) => {
      setDraftError('');
      setDraftOpen(false);
      setDraft(EMPTY_DRAFT);
      setCreated(result.article);
      queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
    },
    onError: (err) => {
      setDraftError(err.message || 'No se pudo crear el borrador');
      setFields(fieldErrors(err));
    },
  });

  const [fields, setFields] = useState({});

  if (!canView) return null;

  function openDraft() {
    setDraftError('');
    setFields({});
    setDraftOpen(true);
  }

  // El formulario se rellena con lo que propone la API, nunca con notas internas
  // ni con datos del reportante: el endpoint de previsualización no los trae.
  function applyPreview(p) {
    setDraft({
      title: p.title || '',
      summary: '',
      description: p.description || '',
      solution: p.solution || '',
      keywords: p.keywords || '',
      category_id: p.category_id == null ? '' : String(p.category_id),
    });
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
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Base de conocimiento
        </h3>
        {linked.length > 0 && (
          <span className="badge bg-slate-100 text-slate-600">{linked.length} vinculados</span>
        )}
      </div>

      {created && (
        <div
          className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          role="status"
        >
          Borrador creado: <Link className="font-medium underline" to={`/app/knowledge/${created.id}`}>{created.title}</Link>.
          Solo usted lo ve hasta que lo publique.
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
          {canCreate && ' Busque uno publicado o documente la solución como borrador.'}
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
                  className="btn-ghost !px-2 !py-1 text-xs !text-slate-500"
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

          {q.length >= 2 && search.error && (
            <ErrorBox message={search.error.message || 'No se pudo buscar'} />
          )}

          {q.length >= 2 && !search.isFetching && !search.error && (
            <ul className="mt-2 space-y-2">
              {results.length === 0 ? (
                <li className="text-xs text-slate-500">
                  Ningún artículo publicado coincide con «{q}».
                </li>
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
        onClose={() => setDraftOpen(false)}
        loading={previewLoading}
        error={previewError}
        preview={preview}
        form={draft}
        onApply={applyPreview}
        setForm={(next) => setDraft(next)}
        categories={categories || []}
        fields={fields}
        errorMessage={draftError}
        saving={createDraft.isPending}
        onSubmit={submitDraft}
        ticket={ticket}
      />
    </div>
  );
}

// El cuerpo que se envía a POST /api/kb-articles. Lista blanca estricta: ni
// status (el artículo nace en borrador), ni ticket_id, ni autor, ni nada que
// venga del ticket que no sea texto editorial.
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

function DraftModal({ open, onClose, loading, error, preview, form, onApply, setForm, categories, fields, errorMessage, saving, onSubmit, ticket }) {
  // Mientras la previsualización no llega se espera: rellenar el formulario a
  // mano partiría de datos inventados.
  const [applied, setApplied] = useState(null);
  if (open && preview && applied !== preview.ticket_id) {
    onApply(preview);
    setApplied(preview.ticket_id);
  }
  if (!open) {
    setApplied(null);
    return null;
  }

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
            La previsualización no incluye notas internas, adjuntos ni datos personales del reportante. Revise y
            complete el texto antes de guardarlo.
          </p>

          {errorMessage && <ErrorBox message={errorMessage} />}

          {[
            ['title', 'Título', 'input', 1],
            ['summary', 'Resumen *', 'input', 1],
            ['description', 'Descripción', 'textarea', 4],
            ['solution', 'Solución', 'textarea', 6],
          ].map(([name, label, tag, rows]) => (
            <div key={name}>
              <label className="label" htmlFor={`kb-draft-${name}`}>
                {label}
              </label>
              {tag === 'input' ? (
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
                  className={`input min-h-[6rem] ${fields[name] ? '!border-red-400' : ''}`}
                  value={form[name]}
                  maxLength={ARTICLE_LIMITS[name]}
                  aria-invalid={fields[name] ? 'true' : undefined}
                  onChange={(e) => set(name, e.target.value)}
                />
              )}
              <div className="mt-1 flex justify-between text-xs">
                {fields[name] ? (
                  <span className="text-red-600">{fields[name]}</span>
                ) : (
                  <span className="text-slate-400">
                    {name === 'summary' ? 'Obligatorio: la API no lo propone.' : ''}
                  </span>
                )}
                <span className="text-slate-400">
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
            <select
              id="kb-draft-category"
              className="input"
              value={form.category_id}
              onChange={(e) => set('category_id', e.target.value)}
            >
              <option value="">Sin categoría</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">
              Elige el tema de documentación: no es la categoría de la incidencia ({ticket.category_name || 'sin categoría'}).
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

export { EMPTY_DRAFT, validateDraft, toPayload, EmptyState };

import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '../lib/api';
import { Pagination, ErrorBox, EmptyState, LoadingScreen, Modal, Spinner, ConfirmToggle, ConfirmDialog } from '../components/ui';
import {
  parseFilters,
  toQuery,
  statusLabel,
  ARTICLE_STATUS_COLOR,
  ARTICLE_STATUS_LABEL,
  ARTICLE_SORTS,
} from '../lib/kb';

const EMPTY_CATEGORY = { name: '', description: '', color: '#64748b' };

// Diálogo de confirmación de una transición. El botón y el título usan la misma
// etiqueta que la acción de la fila, para que no haya dos nombres distintos
// para lo mismo.
const TRANSITIONS = {
  publish: {
    label: 'Publicar',
    danger: false,
    message: 'quedará visible para todos los usuarios con permiso de consulta.',
  },
  unpublish: {
    label: 'Despublicar',
    danger: false,
    message: 'dejará de aparecer en los listados públicos; seguirá siendo visible para su autor y los administradores.',
  },
  archive: {
    label: 'Archivar',
    danger: true,
    message: 'dejará de aparecer en los listados públicos. Se conserva su historial y sus consultas.',
  },
};

function ask(article, action) {
  return {
    id: article.id,
    title: article.title,
    action,
    path: `/api/kb-articles/${article.id}/${action}`,
    ...TRANSITIONS[action],
  };
}

// Administración de la base de conocimiento. La ruta exige kb.manage, así que
// quien llega aquí ya puede moderators artículos de cualquier autor y administrar
// el catálogo de categorías. Aun así cada acción se muestra solo si el permiso
// concreto lo permite, porque puede haber roles con parte de esos permisos.
export default function KnowledgeAdmin() {
  const [tab, setTab] = useState('articles');
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">Administración de conocimientos</h2>
        <p className="text-sm text-slate-500">
          Modere los artículos de cualquier autor y mantenga el catálogo de categorías.
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="Secciones de administración">
        {[
          ['articles', 'Artículos'],
          ['categories', 'Categorías'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'articles' ? <ArticlesTab /> : <CategoriesTab />}
    </div>
  );
}

function ArticlesTab() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const [extra, setExtra] = useState({ status: '', author: '' });
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null);

  // Los filtros de administración añaden status y author a los del listado
  // público, así que la consulta se construye aparte de toQuery().
  const query = useMemo(() => {
    const base = toQuery(filters);
    const sp = new URLSearchParams(base);
    if (extra.status) sp.set('status', extra.status);
    return sp.toString();
  }, [filters, extra]);

  const { data: list, isLoading, error: queryError } = useQuery({
    queryKey: ['kb-manage', query, extra.status],
    queryFn: () => api.get(`/api/kb-articles/manage?${query}`),
  });

  const { data: categories } = useQuery({
    queryKey: ['kb-categories-manage'],
    queryFn: () => api.get('/api/kb-categories?active=0').then((r) => r.data),
  });

  const update = useCallback(
    (partial) => {
      const next = { ...filters, ...partial };
      if (!('page' in partial)) next.page = 1;
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) {
        if (v === '' || v == null) continue;
        if (k === 'sort' && v === 'recent') continue;
        if (k === 'page' && Number(v) === 1) continue;
        if (k === 'perPage' && Number(v) === 10) continue;
        sp.set(k, String(v));
      }
      setSearchParams(sp);
    },
    [filters, setSearchParams]
  );

  const transition = useMutation({
    mutationFn: (path) => api.post(path),
    onSuccess: () => {
      setError('');
      setConfirm(null);
      queryClient.invalidateQueries({ queryKey: ['kb-manage'] });
      queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
      queryClient.invalidateQueries({ queryKey: ['kb-article'] });
    },
    onError: (err) => {
      setError(err.message || 'No se pudo cambiar el estado');
      setConfirm(null);
    },
  });

  const articles = list?.data || [];

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
            </svg>
            <input
              className="input !pl-9"
              value={filters.q}
              onChange={(e) => update({ q: e.target.value })}
              placeholder="Buscar por título, contenido o palabras clave…"
              aria-label="Buscar artículos"
            />
          </div>
          <select
            className="input sm:w-48"
            value={extra.status}
            onChange={(e) => {
              setExtra((s) => ({ ...s, status: e.target.value }));
              update({ page: 1 });
            }}
            aria-label="Filtrar por estado"
          >
            <option value="">Todos los estados</option>
            {Object.entries(ARTICLE_STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="input sm:w-48"
            value={filters.category}
            onChange={(e) => update({ category: e.target.value })}
            aria-label="Filtrar por categoría"
          >
            <option value="">Todas las categorías</option>
            {(categories || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.active ? '' : ' (inactiva)'}
              </option>
            ))}
          </select>
          <select
            className="input sm:w-44"
            value={filters.sort}
            onChange={(e) => update({ sort: e.target.value })}
            aria-label="Ordenar artículos"
          >
            {ARTICLE_SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <ErrorBox message={error} />}
      {queryError && <ErrorBox message={queryError.message || 'No se pudo cargar el listado'} />}

      {isLoading ? (
        <LoadingScreen text="Cargando artículos…" />
      ) : articles.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="🗂️"
            title="No hay artículos que coincidan"
            subtitle="Pruebe con otros filtros. Los borradores y archivados de todos los autores aparecen aquí."
          />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Título</th>
                <th className="px-4 py-2.5">Autor</th>
                <th className="px-4 py-2.5">Estado</th>
                <th className="px-4 py-2.5">Vistas</th>
                <th className="px-4 py-2.5">Actualizado</th>
                <th className="px-4 py-2.5 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {articles.map((a) => (
                <tr key={a.id} className="align-middle">
                  <td className="px-4 py-2.5">
                    <Link to={`/app/knowledge/${a.id}`} className="font-medium text-slate-800 hover:underline">
                      {a.title}
                    </Link>
                    {a.category_name && (
                      <p className="text-xs text-slate-400">{a.category_name}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{a.author_name || 'Sin autor'}</td>
                  <td className="px-4 py-2.5">
                    <span className={`badge ring-1 ${ARTICLE_STATUS_COLOR[a.status]}`}>{statusLabel(a.status)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{a.view_count}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{formatDate(a.updated_at)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Link to={`/app/knowledge/${a.id}/edit`} className="btn-ghost !px-2 !py-1 text-xs">
                        Editar
                      </Link>
                      {a.status !== 'PUBLISHED' && (
                        <button
                          type="button"
                          className="btn-secondary !px-2 !py-1 text-xs"
                          disabled={transition.isPending}
                          onClick={() => setConfirm(ask(a, 'publish'))}
                        >
                          Publicar
                        </button>
                      )}
                      {a.status === 'PUBLISHED' && (
                        <button
                          type="button"
                          className="btn-secondary !px-2 !py-1 text-xs"
                          disabled={transition.isPending}
                          onClick={() => setConfirm(ask(a, 'unpublish'))}
                        >
                          Despublicar
                        </button>
                      )}
                      {a.status !== 'ARCHIVED' && (
                        <button
                          type="button"
                          className="btn-danger !px-2 !py-1 text-xs"
                          disabled={transition.isPending}
                          onClick={() => setConfirm(ask(a, 'archive'))}
                        >
                          Archivar
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-ghost !px-2 !py-1 text-xs"
                        disabled={transition.isPending}
                        onClick={() => transition.mutate(`/api/kb-articles/${a.id}/feature`)}
                      >
                        {a.is_featured ? 'Quitar destacado' : 'Destacar'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={list.page}
            pages={list.pages}
            total={list.total}
            perPage={list.perPage}
            onPerPage={(n) => update({ perPage: n })}
            onChange={(p) => update({ page: p })}
          />
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => transition.mutate(confirm.path)}
        title={confirm?.label || ''}
        message={confirm ? `«${confirm.title}» — ${confirm.message}` : ''}
        confirmLabel={confirm?.label}
        danger={confirm?.danger}
      />
    </div>
  );
}

function CategoriesTab() {
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);

  const { data: list, isLoading, error: queryError } = useQuery({
    queryKey: ['kb-categories-manage'],
    // active=0 solo lo respeta quien tiene kb.manage, que es el caso de esta
    // pantalla; así también se ven las categorías desactivadas.
    queryFn: () => api.get('/api/kb-categories?active=0').then((r) => r.data),
  });

  const save = useMutation({
    mutationFn: (form) =>
      modal.id
        ? api.patch(`/api/kb-categories/${modal.id}`, { ...form, active: modal.active })
        : api.post('/api/kb-categories', form),
    onSuccess: () => {
      setModal(null);
      setError('');
      queryClient.invalidateQueries({ queryKey: ['kb-categories-manage'] });
      queryClient.invalidateQueries({ queryKey: ['kb-categories'] });
    },
    onError: (err) => setError(err.message || 'No se pudo guardar la categoría'),
  });

  const toggle = useMutation({
    mutationFn: (c) => api.patch(`/api/kb-categories/${c.id}`, { active: !c.active }),
    onSuccess: () => {
      setError('');
      queryClient.invalidateQueries({ queryKey: ['kb-categories-manage'] });
      queryClient.invalidateQueries({ queryKey: ['kb-categories'] });
    },
    onError: (err) => setError(err.message || 'No se pudo cambiar el estado'),
  });

  const visible = list ? (onlyActive ? list.filter((c) => c.active) : list) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600"
          />
          Solo activas
        </label>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            setError('');
            setModal({ id: null, active: 1, form: { ...EMPTY_CATEGORY } });
          }}
        >
          + Nueva categoría
        </button>
      </div>

      {(error || save.error || toggle.error) && (
        <ErrorBox message={error || save.error?.message || toggle.error?.message || 'Error al guardar'} />
      )}
      {queryError && <ErrorBox message={queryError.message || 'No se pudieron cargar las categorías'} />}

      {isLoading ? (
        <LoadingScreen text="Cargando categorías…" />
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState icon="🏷️" title="Sin categorías" subtitle="Cree la primera para clasificar los artículos." />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((c) => (
            <div key={c.id} className={`card p-4 ${c.active ? '' : 'opacity-70'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="h-4 w-4 rounded-md" style={{ backgroundColor: c.color }} aria-hidden="true" />
                  <div>
                    <p className="font-semibold text-slate-800">{c.name}</p>
                    <p className="text-xs text-slate-400">
                      {`${c.articles_count} artículo${c.articles_count === 1 ? '' : 's'} publicados`}
                      {c.active ? '' : ' · inactiva'}
                    </p>
                  </div>
                </div>
                <ConfirmToggle
                  active={!!c.active}
                  name={c.name}
                  labelActivate="Desactivar"
                  labelDeactivate="Activar"
                  onToggle={() => toggle.mutate(c)}
                />
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-500">{c.description || 'Sin descripción'}</p>
              <button
                type="button"
                className="btn-ghost mt-3 !px-2 !py-1 text-xs"
                onClick={() => {
                  setError('');
                  setModal({
                    id: c.id,
                    active: c.active,
                    form: { name: c.name, description: c.description || '', color: c.color },
                  });
                }}
              >
                Editar
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-slate-400">
        No hay borrado de categorías: se desactivan para retirarlas de los filtros sin romper los artículos que ya las
        usan.
      </p>

      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal?.id ? 'Editar categoría' : 'Nueva categoría'}
      >
        {modal && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!modal.form.name.trim()) {
                setError('Nombre es obligatorio');
                return;
              }
              save.mutate(modal.form);
            }}
            className="space-y-4"
          >
            <div>
              <label className="label" htmlFor="kb-cat-name">
                Nombre *
              </label>
              <input
                id="kb-cat-name"
                className="input"
                value={modal.form.name}
                onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })}
                maxLength={100}
              />
            </div>
            <div>
              <label className="label" htmlFor="kb-cat-desc">
                Descripción
              </label>
              <textarea
                id="kb-cat-desc"
                className="input min-h-[5rem]"
                value={modal.form.description}
                onChange={(e) => setModal({ ...modal, form: { ...modal.form, description: e.target.value } })}
              />
            </div>
            <div>
              <label className="label" htmlFor="kb-cat-color">
                Color
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  aria-label="Selector de color"
                  className="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 p-1"
                  value={modal.form.color}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, color: e.target.value } })}
                />
                <input
                  id="kb-cat-color"
                  className="input flex-1"
                  value={modal.form.color}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, color: e.target.value } })}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setModal(null)}>
                Cancelar
              </button>
              <button type="submit" className="btn-primary" disabled={save.isPending}>
                {save.isPending && <Spinner className="h-4 w-4 text-white" />}
                Guardar
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

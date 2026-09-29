import { useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, formatDate } from '../lib/api';
import { useAuth, can } from '../context/AuthContext';
import { Pagination, ErrorBox, EmptyState, LoadingScreen } from '../components/ui';
import Select from '../components/Select';
import { parseFilters, toQuery, ARTICLE_SORTS } from '../lib/kb';

// Listado público de la base de conocimiento. Solo trae artículos publicados:
// el servidor nunca devuelve borradores ni archivados en este endpoint, así que
// la UI no tiene que filtrar por estado ni interpretar un 403.
export default function Knowledge() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const query = useMemo(() => toQuery(filters), [filters]);

  const { data: list, isLoading, error } = useQuery({
    queryKey: ['kb-articles', query],
    queryFn: () => api.get(`/api/kb-articles?${query}`),
  });

  const { data: categories } = useQuery({
    queryKey: ['kb-categories'],
    queryFn: () => api.get('/api/kb-categories').then((r) => r.data),
  });

  // "Todas las categorías" era una `<option>` vacía seleccionable, así que se
  // conserva como opción real. `ARTICLE_SORTS` no tenía opción vacía: se
  // mantiene tal cual, con `recent` como valor inicial.
  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'Todas las categorías' },
      ...(categories || []).map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories]
  );
  const sortOptions = useMemo(() => ARTICLE_SORTS.map(([value, label]) => ({ value, label })), []);

  const update = useCallback(
    (partial, { replace = false } = {}) => {
      const next = { ...filters, ...partial };
      // Cualquier cambio de filtro vuelve a la primera página: si no, se puede
      // quedar en una página 4 que ya no existe.
      if (!('page' in partial)) next.page = 1;
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) {
        if (v === '' || v == null) continue;
        if (k === 'sort' && v === 'recent') continue;
        if (k === 'page' && Number(v) === 1) continue;
        if (k === 'perPage' && Number(v) === 10) continue;
        sp.set(k, String(v));
      }
      setSearchParams(sp, { replace });
    },
    [filters, setSearchParams]
  );

  const articles = list?.data || [];
  const total = list?.total || 0;
  const hasFilters = Boolean(filters.q || filters.category);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Base de conocimiento</h2>
          <p className="text-sm text-slate-500">
            Procedimientos y soluciones documentadas por el equipo de soporte.
          </p>
        </div>
        {can(user, 'kb.create') && (
          <Link to="/app/knowledge/new" className="btn-primary">
            + Nuevo artículo
          </Link>
        )}
      </div>

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
              onChange={(e) => update({ q: e.target.value }, { replace: true })}
              placeholder="Buscar en título, resumen, contenido y palabras clave…"
              aria-label="Buscar artículos"
            />
          </div>
          <Select
            className="sm:w-56"
            aria-label="Filtrar por categoría"
            options={categoryOptions}
            value={filters.category}
            onChange={(v) => update({ category: v })}
          />
          <Select
            className="sm:w-48"
            aria-label="Ordenar artículos"
            options={sortOptions}
            value={filters.sort}
            onChange={(v) => update({ sort: v })}
          />
        </div>
        {hasFilters && (
          <div className="mt-3 flex items-center gap-2 text-sm text-slate-500">
            <span>{total} artículo{total === 1 ? '' : 's'} encontrado{total === 1 ? '' : 's'}</span>
            <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setSearchParams({})}>
              Limpiar filtros
            </button>
          </div>
        )}
      </div>

      {error && <ErrorBox message={error.message || 'No se pudo cargar la base de conocimiento'} />}

      {isLoading ? (
        <LoadingScreen text="Cargando artículos…" />
      ) : articles.length === 0 ? (
        <div className="card">
          {hasFilters ? (
            <EmptyState
              icon="🔍"
              title="Ningún artículo coincide con la búsqueda"
              subtitle="Pruebe con otras palabras o quite los filtros aplicados."
            />
          ) : (
            <EmptyState
              icon="📚"
              title="Todavía no hay artículos publicados"
              subtitle={
                can(user, 'kb.create')
                  ? 'Documente la primera solución para que el equipo pueda consultarla.'
                  : 'Vuelva más tarde: aún no se ha documentado ninguna solución.'
              }
            />
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {articles.map((a) => (
            <Link
              key={a.id}
              to={`/app/knowledge/${a.id}`}
              className="card block p-4 transition hover:border-brand-300 hover:shadow-md"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 text-base font-semibold text-slate-800">{a.title}</h3>
                {a.is_featured ? (
                  <span className="badge bg-amber-50 text-amber-700 ring-1 ring-amber-600/20">Destacado</span>
                ) : null}
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-slate-600">{a.summary}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                {a.category_name && (
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: a.category_color || '#64748b' }}
                      aria-hidden="true"
                    />
                    {a.category_name}
                  </span>
                )}
                <span>{a.author_name || 'Sin autor'}</span>
                <span>Publicado el {formatDate(a.published_at)}</span>
                <span>{a.view_count} consulta{a.view_count === 1 ? '' : 's'}</span>
              </div>
            </Link>
          ))}

          <div className="card overflow-hidden">
            <Pagination
              page={list.page}
              pages={list.pages}
              total={total}
              perPage={list.perPage}
              onPerPage={(n) => update({ perPage: n })}
              onChange={(p) => update({ page: p })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

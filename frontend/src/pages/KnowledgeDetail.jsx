import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDateTime } from '../lib/api';
import { renderMessage } from '../lib/markdown';
import { useAuth } from '../context/AuthContext';
import { ErrorBox, LoadingScreen, Spinner, ConfirmDialog } from '../components/ui';
import {
  canEditArticle,
  availableTransitions,
  statusLabel,
  ARTICLE_STATUS_COLOR,
} from '../lib/kb';

// Ficha de un artículo.
//
// El cuerpo llega en Markdown y se pinta con dangerouslySetInnerHTML, así que
// la seguridad depende por completo de renderMessage(): escapa el HTML antes de
// aplicar ningún formato. Aquí no se interpreta nada más.
export default function KnowledgeDetail() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['kb-article', id],
    queryFn: () => api.get(`/api/kb-articles/${id}`),
  });

  const article = data?.article;

  const transition = useMutation({
    mutationFn: (path) => api.post(path),
    onSuccess: () => {
      setError('');
      setConfirm(null);
      // El contador de visitas también cambia en cada lectura, así que se
      // invalidan las dos listas además de la ficha.
      queryClient.invalidateQueries({ queryKey: ['kb-article', id] });
      queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
    },
    onError: (err) => {
      setError(err.message || 'No se pudo cambiar el estado del artículo');
      setConfirm(null);
    },
  });

  if (isLoading) return <LoadingScreen text="Cargando artículo…" />;

  // 404 no es solo "no existe": también es la respuesta para un borrador o un
  // archivado de otro autor. El mensaje no debe confirmar cuál de los dos es.
  if (queryError || !article) {
    return (
      <div className="space-y-4">
        <ErrorBox message={queryError?.message || 'Artículo no encontrado'} />
        <Link to="/app/knowledge" className="btn-secondary">
          ← Volver a la base de conocimiento
        </Link>
      </div>
    );
  }

  const transitions = availableTransitions(user, article);
  const editable = canEditArticle(user, article);
  // Publicar, despublicar y archivar cambian lo que ve el resto del equipo, así
  // que los tres piden confirmación. Destacar es reversible y no molesta.
  const needsConfirm = (t) => t.key === 'publish' || t.key === 'unpublish' || t.kind === 'danger';

  function runTransition(t) {
    if (needsConfirm(t)) {
      setConfirm(t);
      return;
    }
    transition.mutate(t.path);
  }

  const confirmText = {
    publish:
      'El artículo pasará a estar visible para todos los usuarios con permiso de consulta. Podrá seguir editándolo: los cambios se aplican sin despublicarlo.',
    unpublish:
      'El artículo dejará de aparecer en los listados públicos. Seguirá siendo visible para usted y para los administradores, y podrá volver a publicarlo cuando quiera.',
    archive:
      'El artículo dejará de aparecer en los listados públicos. Se conserva su historial y sus consultas, y podrás volver a publicarlo desde aquí mismo.',
  }[confirm?.key];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/app/knowledge" className="btn-ghost !px-2 !py-1 text-sm">
          ← Base de conocimiento
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <Link to={`/app/knowledge/${article.id}/edit`} className="btn-secondary !px-3 !py-1.5 text-sm">
              Editar
            </Link>
          )}
          {transitions.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`${t.kind === 'primary' ? 'btn-primary' : t.kind === 'danger' ? 'btn-danger' : 'btn-secondary'} !px-3 !py-1.5 text-sm`}
              disabled={transition.isPending}
              onClick={() => runTransition(t)}
            >
              {transition.isPending && transition.variables === t.path ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : null}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      {article.status !== 'PUBLISHED' && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          role="status"
        >
          <span className="font-medium">Este artículo es un {statusLabel(article.status).toLowerCase()}</span> y solo
          lo ven usted {article.status === 'ARCHIVED' ? 'y los administradores' : ''}.{' '}
          {article.status === 'DRAFT'
            ? 'Publíquelo cuando esté listo para que el resto del equipo pueda consultarlo.'
            : 'Vuelva a publicarlo si la solución sigue siendo válida.'}
        </div>
      )}

      <article className="card p-5 sm:p-6">
        <header className="border-b border-slate-100 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`badge ring-1 ${ARTICLE_STATUS_COLOR[article.status]}`}>
              {statusLabel(article.status)}
            </span>
            {article.is_featured ? (
              <span className="badge bg-amber-50 text-amber-700 ring-1 ring-amber-600/20">Destacado</span>
            ) : null}
            {article.category_name && (
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: article.category_color || '#64748b' }}
                  aria-hidden="true"
                />
                {article.category_name}
              </span>
            )}
          </div>
          <h1 className="mt-2 text-xl font-bold text-slate-800 sm:text-2xl">{article.title}</h1>
          <p className="mt-1.5 text-sm text-slate-600">{article.summary}</p>
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
            <div className="flex gap-1">
              <dt>Autor:</dt>
              <dd className="font-medium text-slate-600">{article.author_name || 'Sin autor'}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Creado:</dt>
              <dd>{formatDateTime(article.created_at)}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Actualizado:</dt>
              <dd>{formatDateTime(article.updated_at)}</dd>
            </div>
            {article.published_at && (
              <div className="flex gap-1">
                <dt>Publicado:</dt>
                <dd>{formatDateTime(article.published_at)}</dd>
              </div>
            )}
            <div className="flex gap-1">
              <dt>Consultas:</dt>
              <dd>{article.view_count}</dd>
            </div>
          </dl>
        </header>

        {article.keywords && (
          <p className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <span className="font-medium">Palabras clave:</span>
            {article.keywords.split(',').map((k) => (
              <span key={k} className="badge bg-slate-100 text-slate-600">
                {k}
              </span>
            ))}
          </p>
        )}

        <section className="mt-5">
          <h2 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">Descripción</h2>
          <div
            className="text-sm leading-relaxed text-slate-700"
            data-testid="article-description"
            dangerouslySetInnerHTML={{ __html: renderMessage(article.description) }}
          />
        </section>

        <section className="mt-5">
          <h2 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">Solución</h2>
          <div
            className="text-sm leading-relaxed text-slate-700"
            data-testid="article-solution"
            dangerouslySetInnerHTML={{ __html: renderMessage(article.solution) }}
          />
        </section>
      </article>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => transition.mutate(confirm.path)}
        title={confirm?.label || ''}
        message={confirmText}
        confirmLabel={confirm?.label}
        danger={confirm?.kind === 'danger'}
      />
    </div>
  );
}

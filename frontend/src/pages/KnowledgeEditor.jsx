import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { renderMessage } from '../lib/markdown';
import { useAuth } from '../context/AuthContext';
import { ErrorBox, Spinner, LoadingScreen } from '../components/ui';
import { fieldErrors, statusLabel, ARTICLE_STATUS_COLOR, canEditArticle } from '../lib/kb';

// Límites que replica backend/src/utils/articleLimits.js. Deben coincidir con
// los CHECK de schema.sql: es la misma constante en tres sitios.
const LIMITS = {
  title: 200,
  summary: 500,
  description: 20000,
  solution: 20000,
  keywords: 200,
};

const EMPTY = {
  title: '',
  summary: '',
  description: '',
  solution: '',
  keywords: '',
  category_id: '',
};

function validate(form) {
  const errors = {};
  if (!form.title.trim()) errors.title = 'El título es obligatorio';
  else if (form.title.length > LIMITS.title) errors.title = `El título no debe exceder ${LIMITS.title} caracteres`;

  if (!form.summary.trim()) errors.summary = 'El resumen es obligatorio';
  else if (form.summary.length > LIMITS.summary) {
    errors.summary = `El resumen no debe exceder ${LIMITS.summary} caracteres`;
  }

  if (!form.description.trim()) errors.description = 'La descripción es obligatoria';
  else if (form.description.length > LIMITS.description) {
    errors.description = `La descripción no debe exceder ${LIMITS.description} caracteres`;
  }

  if (!form.solution.trim()) errors.solution = 'La solución es obligatoria';
  else if (form.solution.length > LIMITS.solution) {
    errors.solution = `La solución no debe exceder ${LIMITS.solution} caracteres`;
  }

  if (form.keywords.length > LIMITS.keywords) {
    errors.keywords = `Las palabras clave no deben exceder ${LIMITS.keywords} caracteres`;
  }
  return errors;
}

// El servidor nunca acepta status, author_id, view_count ni published_at en el
// cuerpo: el estado solo cambia por /publish, /unpublish y /archive. Aquí solo
// se envían los seis campos editables.
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

export default function KnowledgeEditor() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState('');
  const [preview, setPreview] = useState(false);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['kb-article', id],
    queryFn: () => api.get(`/api/kb-articles/${id}`),
    enabled: !isNew,
  });

  const article = data?.article;

  const { data: categories } = useQuery({
    queryKey: ['kb-categories'],
    queryFn: () => api.get('/api/kb-categories').then((r) => r.data),
  });

  // Si la categoría del artículo fue desactivada, ya no viene en el catálogo
  // activo. Sin añadirla a mano el <select> quedaría sin opción seleccionada y al
  // guardar se enviaría su id, que el servidor rechaza con 400.
  const categoryOptions = useMemo(() => {
    const list = categories || [];
    if (!article?.category_id || list.some((c) => c.id === article.category_id)) return list;
    return [
      ...list,
      {
        id: article.category_id,
        name: article.category_name || `Categoría ${article.category_id}`,
        color: article.category_color,
        active: 0,
      },
    ];
  }, [categories, article]);

  useEffect(() => {
    if (!article) return;
    setForm({
      title: article.title || '',
      summary: article.summary || '',
      description: article.description || '',
      solution: article.solution || '',
      keywords: article.keywords || '',
      category_id: article.category_id == null ? '' : String(article.category_id),
    });
  }, [article]);

  const save = useMutation({
    mutationFn: (payload) =>
      isNew ? api.post('/api/kb-articles', payload) : api.patch(`/api/kb-articles/${id}`, payload),
    onSuccess: (result) => {
      const saved = result.article;
      setErrors({});
      setBanner('');
      queryClient.invalidateQueries({ queryKey: ['kb-article', saved.id] });
      queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
      // Un artículo nuevo SIEMPRE nace como borrador: se navega a la ficha para
      // que el autor vea el estado real y decida si lo publica.
      navigate(`/app/knowledge/${saved.id}`);
    },
    onError: (err) => {
      setBanner(err.message || 'No se pudo guardar el artículo');
      // El servidor responde { fields } con las etiquetas en español; se
      // traducen a las claves del formulario para pintar el error junto al campo.
      const fromServer = fieldErrors(err);
      const mapped = {};
      for (const [label, message] of Object.entries(fromServer)) {
        if (label === 'El título') mapped.title = message;
        else if (label === 'El resumen') mapped.summary = message;
        else if (label === 'La descripción') mapped.description = message;
        else if (label === 'La solución') mapped.solution = message;
        else if (label === 'Las palabras clave') mapped.keywords = message;
      }
      setErrors(mapped);
    },
  });

  if (!isNew && isLoading) return <LoadingScreen text="Cargando artículo…" />;

  if (!isNew && (loadError || !article)) {
    return (
      <div className="space-y-4">
        <ErrorBox message={loadError?.message || 'No se encontró el artículo'} />
        <Link to="/app/knowledge" className="btn-secondary">
          ← Volver a la base de conocimiento
        </Link>
      </div>
    );
  }

  // El backend responde 404 a un artículo de otro autor sin kb.manage, así que
  // esta comprobación solo evita pintar un formulario que el servidor va a
  // rechazar. La barrera real está en PATCH /:id.
  if (!isNew && article && !canEditArticle(user, article)) {
    return (
      <div className="space-y-4">
        <ErrorBox message="No tiene permiso para editar este artículo" />
        <Link to="/app/knowledge" className="btn-secondary">
          ← Volver a la base de conocimiento
        </Link>
      </div>
    );
  }

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => {
      if (!e[field]) return e;
      const next = { ...e };
      delete next[field];
      return next;
    });
  }

  function onSubmit(e) {
    e.preventDefault();
    setBanner('');
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length) {
      setBanner('Revise los campos marcados antes de guardar.');
      return;
    }
    save.mutate(toPayload(form));
  }

  const field = (name, label, hint) => (
    <div>
      <label className="label" htmlFor={`kb-${name}`}>
        {label} *
      </label>
      <input
        id={`kb-${name}`}
        className={`input ${errors[name] ? '!border-red-400' : ''}`}
        value={form[name]}
        onChange={(e) => set(name, e.target.value)}
        maxLength={LIMITS[name]}
        aria-invalid={errors[name] ? 'true' : undefined}
        aria-describedby={errors[name] ? `kb-${name}-error` : undefined}
      />
      <div className="mt-1 flex justify-between gap-2">
        {errors[name] ? (
          <p id={`kb-${name}-error`} className="text-xs text-red-600">
            {errors[name]}
          </p>
        ) : (
          <span />
        )}
        <span className="text-xs text-slate-400">{hint || `${form[name].length}/${LIMITS[name]}`}</span>
      </div>
    </div>
  );

  const area = (name, label, rows, heightClass) => (
    <div>
      <label className="label" htmlFor={`kb-${name}`}>
        {label} *
      </label>
      <textarea
        id={`kb-${name}`}
        rows={rows}
        className={`input font-mono text-sm ${heightClass} ${errors[name] ? '!border-red-400' : ''}`}
        value={form[name]}
        onChange={(e) => set(name, e.target.value)}
        maxLength={LIMITS[name]}
        aria-invalid={errors[name] ? 'true' : undefined}
        aria-describedby={errors[name] ? `kb-${name}-error` : undefined}
      />
      <div className="mt-1 flex justify-between gap-2">
        {errors[name] ? (
          <p id={`kb-${name}-error`} className="text-xs text-red-600">
            {errors[name]}
          </p>
        ) : (
          <span className="text-xs text-slate-400">Markdown: # título, **negrita**, - viñeta, 1. paso</span>
        )}
        <span className="shrink-0 text-xs text-slate-400">
          {form[name].length}/{LIMITS[name]}
        </span>
      </div>
    </div>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-800">
          {isNew ? 'Nuevo artículo' : 'Editar artículo'}
        </h2>
        <div className="flex items-center gap-2">
          {article && (
            <span className={`badge ring-1 ${ARTICLE_STATUS_COLOR[article.status]}`}>
              {statusLabel(article.status)}
            </span>
          )}
          <Link
            to={article ? `/app/knowledge/${article.id}` : '/app/knowledge'}
            className="btn-ghost !px-2 !py-1 text-sm"
          >
            Cancelar
          </Link>
        </div>
      </div>

      {(banner || save.error) && (
        <ErrorBox
          message={banner || save.error?.message || 'No se pudo guardar el artículo'}
        />
      )}

      {!isNew && article && article.status === 'PUBLISHED' && (
        <p className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          Este artículo está publicado. Guardar los cambios no lo despublica: seguirá visible para todos hasta que
          vuelva a borrador de forma explícita.
        </p>
      )}

      <div className="card space-y-4 p-5">
        {field('title', 'Título')}
        {field('summary', 'Resumen')}
        {area('description', 'Descripción', 8, 'min-h-[9rem]')}
        {area('solution', 'Solución', 10, 'min-h-[12rem]')}

        <div>
          <label className="label" htmlFor="kb-keywords">
            Palabras clave
          </label>
          <input
            id="kb-keywords"
            className={`input ${errors.keywords ? '!border-red-400' : ''}`}
            value={form.keywords}
            onChange={(e) => set('keywords', e.target.value)}
            placeholder="correo, contraseña, outlook"
            maxLength={LIMITS.keywords}
          />
          <div className="mt-1 flex justify-between gap-2">
            {errors.keywords ? (
              <p className="text-xs text-red-600">{errors.keywords}</p>
            ) : (
              <span className="text-xs text-slate-400">Separadas por comas</span>
            )}
            <span className="text-xs text-slate-400">
              {form.keywords.length}/{LIMITS.keywords}
            </span>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="kb-category">
            Categoría
          </label>
          <select
            id="kb-category"
            className="input"
            value={form.category_id}
            onChange={(e) => set('category_id', e.target.value)}
          >
            <option value="">Sin categoría</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.active === 0 ? ' (desactivada)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Vista previa</h3>
          <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setPreview((v) => !v)}>
            {preview ? 'Ocultar' : 'Mostrar'}
          </button>
        </div>
        {preview ? (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Descripción</p>
              <div
                className="mt-1 text-sm text-slate-700"
                data-testid="preview-description"
                dangerouslySetInnerHTML={{ __html: renderMessage(form.description) }}
              />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Solución</p>
              <div
                className="mt-1 text-sm text-slate-700"
                data-testid="preview-solution"
                dangerouslySetInnerHTML={{ __html: renderMessage(form.solution) }}
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            La vista previa muestra el Markdown tal como se verá en la ficha. El texto se guarda tal cual y se escapa
            al representarse, de modo que nunca se ejecuta HTML.
          </p>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Link
          to={article ? `/app/knowledge/${article.id}` : '/app/knowledge'}
          className="btn-secondary"
        >
          Cancelar
        </Link>
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          {save.isPending && <Spinner className="h-4 w-4 text-white" />}
          {isNew ? 'Guardar borrador' : 'Guardar cambios'}
        </button>
      </div>
    </form>
  );
}

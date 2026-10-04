import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, PRIORITIES, PRIORITY_LABEL, isImage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorBox, Spinner, LoadingScreen } from '../components/ui';
import Select from '../components/Select';

const MAX_SIZE_MB = 5;
const MAX_FILES = 5;

// Campos que el servidor exige al crear un ticket: es su `validate()` en
// `POST /api/tickets` (reglas `required` sobre título, categoría y
// descripción). No se inventa ninguna regla nueva, sólo se comprueba antes de
// gastar un POST en un fallo que el navegador no puede evitar por sí solo: el
// `<form>` va con `noValidate`, así que sus `required` no hacen nada.
// Los textos son los del backend para que el mensaje sea el mismo lo detecte
// el formulario o el servidor.
const REQUIRED_MESSAGE = {
  title: 'Título es obligatorio',
  category: 'Categoría es obligatorio',
  description: 'Descripción es obligatorio',
};

// Orden en el que se revisan los campos: el foco salta al primero que falte.
const FIELD_ORDER = ['title', 'category', 'description'];

function validateRequired({ title: t, categoryId, description: d }) {
  const errors = {};
  if (!t.trim()) errors.title = REQUIRED_MESSAGE.title;
  // La categoría viaja como texto del <Select>; vacío significa "sin elegir",
  // que es justo lo que el backend rechaza.
  if (!categoryId) errors.category = REQUIRED_MESSAGE.category;
  if (!d.trim()) errors.description = REQUIRED_MESSAGE.description;
  return errors;
}

export default function NewTicket() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // `error` es el aviso general (API, adjuntos) y `fieldErrors` el detalle junto
  // a cada campo, como en el editor de la base de conocimiento: así un campo
  // vacío no compite con el `role="alert"` del error general.
  const [fieldErrors, setFieldErrors] = useState({});

  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [departmentId, setDepartmentId] = useState('');
  const [files, setFiles] = useState([]);

  const titleRef = useRef(null);
  const descriptionRef = useRef(null);
  const fieldRefs = { title: titleRef, description: descriptionRef };

  function focusField(key) {
    if (key === 'category') {
      // El <Select> propio no admite refs (su trigger es un <button> real al que
      // esta página ya le pasa `id`), así que se localiza por ese id en vez de
      // tocar el componente compartido.
      document.getElementById('category')?.focus();
      return;
    }
    fieldRefs[key]?.current?.focus();
  }

  function clearFieldError(key) {
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  const categoriesQuery = useQuery({
    queryKey: ['categories-active'],
    queryFn: () => api.get('/api/categories?active=1').then((d) => d.data || []),
    retry: false,
  });

  const departmentsQuery = useQuery({
    queryKey: ['active-departments'],
    queryFn: () => api.get('/api/departments?active=1').then((d) => d.data || []),
    retry: false,
  });

  // Al montar se preselecciona el departamento del usuario (equivalente al efecto original).
  useEffect(() => {
    setDepartmentId(user?.department_id ? String(user.department_id) : '');
  }, [user]);

  const loadingInit = categoriesQuery.isLoading || departmentsQuery.isLoading;
  const categories = categoriesQuery.data || [];
  const departments = departmentsQuery.data || [];

  // "Sin departamento" era una `<option>` vacía seleccionable, así que se
  // conserva como opción real. En cambio la de categoría venía `disabled`, de
  // modo que no se podía elegir: eso equivale a un `placeholder`.
  // Los `required` del markup son inertes (`noValidate`), pero ya no son la
  // única comprobación: `validateRequired` cubre los mismos campos antes de
  // enviar, y el backend sigue validando igual por si acaso.
  const categoryOptions = useMemo(() => categories.map((c) => ({ value: c.id, label: c.name })), [categories]);
  const departmentOptions = useMemo(
    () => [{ value: '', label: 'Sin departamento' }, ...departments.map((d) => ({ value: d.id, label: d.name }))],
    [departments]
  );
  const priorityOptions = useMemo(() => PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })), []);

  const createMutation = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append('title', title.trim());
      fd.append('description', description.trim());
      fd.append('category_id', categoryId);
      fd.append('priority', priority);
      if (departmentId) fd.append('department_id', departmentId);
      for (const f of files) fd.append('files', f);
      return api.post('/api/tickets', null, fd);
    },
    onMutate: () => {
      setError('');
      setSaving(true);
    },
    onSuccess: (data) => {
      navigate(`/app/my-tickets/${data.ticket.id}`);
    },
    onError: (err) => {
      // `err.fields` es el mecanismo de validación por campo que ya usan otros
      // formularios del proyecto. Si viene, cada mensaje se pinta junto a su
      // campo igual que los del cliente; si no, al ErrorBox de siempre. Así el
      // backend nunca muestra su `Validation failed` en crudo.
      const fields = err.fields;
      if (fields) {
        const mapped = {};
        const resto = [];
        for (const [key, message] of Object.entries(fields)) {
          if (REQUIRED_MESSAGE[key]) mapped[key] = message;
          else resto.push(message);
        }
        setFieldErrors(mapped);
        setError(resto.join('. '));
        const first = FIELD_ORDER.find((k) => mapped[k]);
        if (first) focusField(first);
        return;
      }
      setError(err.message || 'No se pudo crear el ticket');
    },
    onSettled: () => setSaving(false),
  });

  function onFiles(e) {
    const list = Array.from(e.target.files || []);
    const accepted = [];
    const oversized = [];
    for (const f of list) {
      if (f.size > MAX_SIZE_MB * 1024 * 1024) {
        oversized.push(f.name);
        continue;
      }
      accepted.push(f);
    }

    // El tamaño manda sobre el resto, igual que hasta ahora: si hay un archivo
    // grande no se agrega ninguno de los elegidos. Ahora el aviso lo dice, para
    // que la selección no desaparezca sin explicación.
    if (oversized.length) {
      setError(`Archivos demasiado grandes: ${oversized.join(', ')}. Máximo ${MAX_SIZE_MB} MB por archivo. No se agregó ningún archivo.`);
      return;
    }

    // El límite se respeta sin descartar nada en silencio: se agrega lo que cabe
    // y se nombra lo que no. Antes, un `.slice(0, MAX_FILES)` se comía el resto
    // sin decir nada y el usuario creía haber adjuntado todo.
    const room = MAX_FILES - files.length;
    const added = accepted.slice(0, Math.max(room, 0));
    const dropped = accepted.slice(added.length);

    if (dropped.length) {
      setError(
        dropped.length === 1
          ? `Máximo ${MAX_FILES} archivos por ticket. No se agregó ${dropped[0].name}.`
          : `Máximo ${MAX_FILES} archivos por ticket. No se agregaron ${dropped.length} archivos: ${dropped.map((f) => f.name).join(', ')}.`
      );
    } else {
      setError('');
    }
    setFiles((prev) => [...prev, ...added]);
  }

  function removeFile(index) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function onSubmit(e) {
    e.preventDefault();
    const found = validateRequired({ title, categoryId, description });
    setFieldErrors(found);
    const first = FIELD_ORDER.find((k) => found[k]);
    if (first) {
      // No se envía nada: ni el POST ni se toca lo escrito ni los adjuntos. Se
      // lleva el foco al primer campo que falta para corregirlo y reintentar.
      focusField(first);
      return;
    }
    createMutation.mutate();
  }

  if (loadingInit) return <LoadingScreen text="Cargando formulario…" />;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="card">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-800">Reportar incidencia</h2>
          <p className="text-sm text-slate-500">Complete los datos para generar su ticket de soporte.</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-5 px-6 py-5" noValidate>
          <div>
            <label className="label" htmlFor="title">
              Título *
            </label>
            <input
              id="title"
              ref={titleRef}
              className={`input ${fieldErrors.title ? '!border-red-400' : ''}`}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                clearFieldError('title');
              }}
              placeholder="Resumen breve del problema"
              maxLength={200}
              required
              aria-invalid={fieldErrors.title ? 'true' : undefined}
              aria-describedby={fieldErrors.title ? 'title-error' : undefined}
            />
            {fieldErrors.title && (
              <p id="title-error" className="mt-1 text-xs text-red-600">
                {fieldErrors.title}
              </p>
            )}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="category">
                Categoría *
              </label>
              <Select
                id="category"
                placeholder="Seleccione…"
                options={categoryOptions}
                value={categoryId}
                onChange={(v) => {
                  setCategoryId(v);
                  clearFieldError('category');
                }}
                aria-invalid={fieldErrors.category ? 'true' : undefined}
                aria-describedby={fieldErrors.category ? 'category-error' : undefined}
              />
              {fieldErrors.category && (
                <p id="category-error" className="mt-1 text-xs text-red-600">
                  {fieldErrors.category}
                </p>
              )}
            </div>
            <div>
              <label className="label" htmlFor="priority">
                Prioridad *
              </label>
              <Select id="priority" options={priorityOptions} value={priority} onChange={setPriority} />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="department">
              Departamento
            </label>
            <Select
              id="department"
              options={departmentOptions}
              value={departmentId}
              onChange={setDepartmentId}
            />
            <p className="mt-1 text-xs text-slate-400">
              Por defecto se usa su departamento ({user?.department_name || 'sin asignar'}).
            </p>
          </div>

          <div>
            <label className="label" htmlFor="description">
              Descripción detallada *
            </label>
            <textarea
              id="description"
              ref={descriptionRef}
              className={`input min-h-[130px] resize-y ${fieldErrors.description ? '!border-red-400' : ''}`}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                clearFieldError('description');
              }}
              placeholder="Describa el problema, pasos para reproducirlo y cualquier detalle relevante…"
              maxLength={10000}
              required
              aria-invalid={fieldErrors.description ? 'true' : undefined}
              aria-describedby={fieldErrors.description ? 'description-error' : undefined}
            />
            {fieldErrors.description && (
              <p id="description-error" className="mt-1 text-xs text-red-600">
                {fieldErrors.description}
              </p>
            )}
          </div>

          <div>
            <span className="label">Archivos adjuntos</span>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center transition hover:border-brand-400 hover:bg-brand-50">
              <svg className="h-8 w-8 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1.5M8 7.5L12 3l4 4.5M12 3v11" />
              </svg>
              <span className="text-sm font-medium text-slate-600">Haga clic para adjuntar fotos o archivos</span>
              <span className="text-xs text-slate-400">
                JPG, PNG, WEBP, PDF, DOC/DOCX, XLS/XLSX, TXT · Máx. {MAX_SIZE_MB} MB · {MAX_FILES} archivos
              </span>
              <input type="file" className="hidden" multiple onChange={onFiles} />
            </label>

            {files.length > 0 && (
              <ul className="mt-3 space-y-2">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    {isImage(f.type) ? (
                      <FileThumb file={f} />
                    ) : (
                      <span className="grid h-10 w-10 place-items-center rounded-md bg-slate-100 text-slate-500">
                        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13H7zM14 3v5h5" />
                        </svg>
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-700">{f.name}</p>
                      <p className="text-xs text-slate-400">{(f.size / 1024).toFixed(0)} KB</p>
                    </div>
                    <button type="button" onClick={() => removeFile(i)} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Quitar archivo">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && <ErrorBox message={error} />}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving && <Spinner className="h-4 w-4 text-white" />}
              {saving ? 'Creando ticket…' : 'Crear ticket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Miniatura de un archivo local. El object URL se crea en un efecto y se libera
// al desmontar o cambiar el archivo. Antes se creaba dentro del render con un
// revoke en onLoad: cada tecla del formulario generaba una URL nueva (y por
// tanto reiniciaba la carga de todas las miniaturas) y, si la carga se abortaba
// porque el src había cambiado, onLoad no llegaba a dispararse y esa URL, con el
// File entero detrás, se quedaba retenida durante toda la sesión.
function FileThumb({ file }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  if (!url) return <span className="h-10 w-10 rounded-md bg-slate-100" aria-hidden="true" />;
  return <img src={url} alt="" className="h-10 w-10 rounded-md object-cover" />;
}

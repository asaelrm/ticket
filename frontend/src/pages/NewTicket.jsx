import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, PRIORITIES, PRIORITY_LABEL, isImage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorBox, Spinner, LoadingScreen } from '../components/ui';

const MAX_SIZE_MB = 5;
const MAX_FILES = 5;

export default function NewTicket() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [departmentId, setDepartmentId] = useState('');
  const [files, setFiles] = useState([]);

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
    onError: (err) => setError(err.message || 'No se pudo crear el ticket'),
    onSettled: () => setSaving(false),
  });

  function onFiles(e) {
    const list = Array.from(e.target.files || []);
    const resized = [];
    const oversized = [];
    for (const f of list) {
      if (f.size > MAX_SIZE_MB * 1024 * 1024) {
        oversized.push(f.name);
        continue;
      }
      resized.push(f);
    }
    if (oversized.length) {
      setError(`Archivos demasiado grandes: ${oversized.join(', ')}. Máximo ${MAX_SIZE_MB} MB por archivo.`);
      return;
    }
    setError('');
    setFiles((prev) => [...prev, ...resized].slice(0, MAX_FILES));
  }

  function removeFile(index) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function onSubmit(e) {
    e.preventDefault();
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
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Resumen breve del problema"
              maxLength={200}
              required
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="category">
                Categoría *
              </label>
              <select id="category" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
                <option value="" disabled>
                  Seleccione…
                </option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="priority">
                Prioridad *
              </label>
              <select id="priority" className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="department">
              Departamento
            </label>
            <select id="department" className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Sin departamento</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
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
              className="input min-h-[130px] resize-y"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describa el problema, pasos para reproducirlo y cualquier detalle relevante…"
              maxLength={10000}
              required
            />
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
                      <img
                        src={URL.createObjectURL(f)}
                        alt=""
                        className="h-10 w-10 rounded-md object-cover"
                        onLoad={(e) => URL.revokeObjectURL(e.target.src)}
                      />
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
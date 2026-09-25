import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Modal, ErrorBox, Spinner, LoadingScreen, ConfirmToggle, EmptyState } from '../components/ui';

const EMPTY = { name: '', description: '', color: '#3366ff' };

export default function Categories() {
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(null);
  const [onlyActive, setOnlyActive] = useState(false);

  // Reemplazando useEffect con useQuery para fetching y caché
  const { data: list, isLoading, error: queryError } = useQuery({
    // Key propia: este listado incluye conteos (?withCounts=1) y es distinto de
    // la lista base compartida ['categories'] de los filtros/selects.
    queryKey: ['categories-manage'],
    queryFn: () => api.get('/api/categories?withCounts=1').then(res => res.data),
  });

  // Muta para crear/editar
  const saveMutation = useMutation({
    mutationFn: (form) =>
      modal.id
        ? api.patch(`/api/categories/${modal.id}`, { ...form, active: true })
        : api.post('/api/categories', form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories-manage'] });
      setModal(null);
    },
  });

  // Muta para alternar estado
  const toggleMutation = useMutation({
    mutationFn: (c) => api.patch(`/api/categories/${c.id}`, { active: !c.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['categories-manage'] }),
  });

  async function onSave(e) {
    e.preventDefault();
    saveMutation.mutate(modal.form);
  }

  const visible = list ? (onlyActive ? list.filter((c) => c.active) : list) : [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600"
          />
          Solo activas
        </label>
        <button className="btn-primary" onClick={() => { saveMutation.reset(); setModal({ id: null, form: { ...EMPTY } }); }}>
          + Nueva categoría
        </button>
      </div>

      <div className="mb-3">
        {queryError && <ErrorBox message={queryError.message || 'Error al cargar'} />}
        {toggleMutation.error && <ErrorBox message={toggleMutation.error.message || 'Error al cambiar estado'} />}
        {saveMutation.error && <ErrorBox message={saveMutation.error.fields ? Object.values(saveMutation.error.fields).join('. ') : saveMutation.error.message || 'Error al guardar'} />}
      </div>

      {isLoading ? (
        <LoadingScreen />
      ) : visible.length === 0 ? (
        <div className="card"><EmptyState icon="📂" title="Sin categorías" /></div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((c) => (
            <div key={c.id} className="card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="h-4 w-4 rounded-md" style={{ backgroundColor: c.color }} />
                  <div>
                    <p className="font-semibold text-slate-800">{c.name}</p>
                    <p className="text-xs text-slate-400">{c.tickets_count} tickets</p>
                  </div>
                </div>
                <ConfirmToggle
                  active={c.active}
                  name={c.name}
                  labelActivate="Desactivar"
                  labelDeactivate="Activar"
                  onToggle={() => toggleMutation.mutate(c)}
                />
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-500">{c.description || 'Sin descripción'}</p>
              <button className="btn-ghost mt-3 !px-2 !py-1 text-xs" onClick={() => { saveMutation.reset(); setModal({ id: c.id, form: { name: c.name, description: c.description || '', color: c.color } }); }}>
                Editar
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.id ? 'Editar categoría' : 'Nueva categoría'}>
        {modal && (
          <form onSubmit={onSave} className="space-y-4" noValidate>
            <div>
              <label className="label">Nombre *</label>
              <input className="input" value={modal.form.name} onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })} required />
            </div>
            <div>
              <label className="label">Descripción</label>
              <textarea className="input min-h-[80px]" value={modal.form.description} onChange={(e) => setModal({ ...modal, form: { ...modal.form, description: e.target.value } })} />
            </div>
            <div>
              <label className="label">Color</label>
              <div className="flex items-center gap-3">
                <input type="color" className="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 p-1" value={modal.form.color} onChange={(e) => setModal({ ...modal, form: { ...modal.form, color: e.target.value } })} />
                <input className="input flex-1" value={modal.form.color} onChange={(e) => setModal({ ...modal, form: { ...modal.form, color: e.target.value } })} />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setModal(null)}>Cancelar</button>
              <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
                {saveMutation.isPending && <Spinner className="h-4 w-4 text-white" />}
                Guardar
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
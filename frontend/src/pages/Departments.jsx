import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Modal, ErrorBox, Spinner, LoadingScreen, ConfirmToggle, EmptyState } from '../components/ui';

const EMPTY = { name: '', description: '' };

export default function Departments() {
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);

  const { data: list, error: queryError } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/departments').then((res) => res.data),
  });

  const saveMutation = useMutation({
    mutationFn: (form) =>
      modal.id
        ? api.patch(`/api/departments/${modal.id}`, { ...form, active: true })
        : api.post('/api/departments', form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['departments'] });
      setModal(null);
    },
    onError: (err) => {
      if (err.fields) setError(Object.values(err.fields).join('. '));
      else setError(err.message || 'No se pudo guardar');
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (d) => api.patch(`/api/departments/${d.id}`, { active: !d.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['departments'] }),
    onError: (err) => {
      setError(err.message || 'No se pudo cambiar el estado');
    },
  });

  function onSave(e) {
    e.preventDefault();
    setError('');
    saveMutation.mutate(modal.form);
  }

  function toggle(d) {
    toggleMutation.mutate(d);
  }

  const showError = error || queryError?.message || '';
  const visible = list ? (onlyActive ? list.filter((d) => d.active) : list) : [];

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
          Solo activos
        </label>
        <button className="btn-primary" onClick={() => { setError(''); setModal({ id: null, form: { ...EMPTY } }); }}>
          + Nuevo departamento
        </button>
      </div>

      <div className="mb-3">{showError && <ErrorBox message={showError} />}</div>

      {!list ? (
        <LoadingScreen />
      ) : visible.length === 0 ? (
        <div className="card"><EmptyState icon="🏢" title="Sin departamentos" /></div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((d) => (
            <div key={d.id} className="card p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-slate-800">{d.name}</p>
                <ConfirmToggle
                  active={d.active}
                  name={d.name}
                  labelActivate="Desactivar"
                  labelDeactivate="Activar"
                  onToggle={() => toggle(d)}
                />
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-500">{d.description || 'Sin descripción'}</p>
              <button className="btn-ghost mt-3 !px-2 !py-1 text-xs" onClick={() => { setError(''); setModal({ id: d.id, form: { name: d.name, description: d.description || '' } }); }}>
                Editar
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.id ? 'Editar departamento' : 'Nuevo departamento'}>
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
            {error && <ErrorBox message={error} />}
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
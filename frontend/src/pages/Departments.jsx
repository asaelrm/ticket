import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { Modal, ErrorBox, Spinner, LoadingScreen, ConfirmToggle, EmptyState } from '../components/ui';

const EMPTY = { name: '', description: '' };

export default function Departments() {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [loadingModal, setLoadingModal] = useState(false);
  const [onlyActive, setOnlyActive] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await api.get('/api/departments');
      setList(data.data);
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los departamentos');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onSave(e) {
    e.preventDefault();
    setLoadingModal(true);
    setError('');
    try {
      if (modal.id) await api.patch(`/api/departments/${modal.id}`, { ...modal.form, active: true });
      else await api.post('/api/departments', modal.form);
      setModal(null);
      await load();
    } catch (err) {
      if (err.fields) setError(Object.values(err.fields).join('. '));
      else setError(err.message || 'No se pudo guardar');
    } finally {
      setLoadingModal(false);
    }
  }

  async function toggle(d) {
    try {
      await api.patch(`/api/departments/${d.id}`, { active: !d.active });
      await load();
    } catch (err) {
      setError(err.message || 'No se pudo cambiar el estado');
    }
  }

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

      <div className="mb-3">{error && <ErrorBox message={error} />}</div>

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
              <button type="submit" className="btn-primary" disabled={loadingModal}>
                {loadingModal && <Spinner className="h-4 w-4 text-white" />}
                Guardar
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
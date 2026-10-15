import { useId, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Modal, Pagination, ErrorBox, Spinner, LoadingScreen, ConfirmToggle, EmptyState } from '../components/ui';
import Select from '../components/Select';
import Tooltip from '../components/Tooltip';

const EMPTY = {
  code: '',
  name: '',
  description: '',
};

export default function Organizations() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({ page: 1, perPage: 15 });
  const [error, setError] = useState('');
  const [loadingModal, setLoadingModal] = useState(false);
  const [modal, setModal] = useState(null); // null | { mode: 'create'|'edit', form, id }
  const { user } = useAuth();

  const { data: list, error: queryError } = useQuery({
    queryKey: ['organizations', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) {
        if (v !== '' && v != null) params.append(k, v);
      }
      params.append('perPage', filters.perPage || 15);
      return api.get(`/api/organizations?${params}`);
    },
  });

  const invalidateOrganizations = () => queryClient.invalidateQueries({ queryKey: ['organizations'] });

  const saveMutation = useMutation({
    mutationFn: (m) => {
      const body = { ...m.form };
      return m.mode === 'create'
        ? api.post('/api/organizations', body)
        : api.patch(`/api/organizations/${m.id}`, body);
    },
    onMutate: () => {
      setLoadingModal(true);
      setError('');
    },
    onSuccess: (_data, m) => {
      setModal(null);
      invalidateOrganizations();
    },
    onError: (err) => {
      if (err.fields) setError(Object.values(err.fields).join('. '));
      else setError(err.message || 'No se pudo guardar la empresa');
    },
    onSettled: () => {
      setLoadingModal(false);
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (org) => api.patch(`/api/organizations/${org.id}`, { active: !org.active }),
    onSuccess: (_data, org) => {
      invalidateOrganizations();
    },
    onError: (err) => setError(err.message || 'No se pudo cambiar el estado'),
  });

  function openCreate() {
    setError('');
    setModal({ mode: 'create', form: { ...EMPTY } });
  }

  function openEdit(org) {
    setError('');
    setModal({
      mode: 'edit',
      id: org.id,
      form: {
        code: org.code,
        name: org.name,
        description: org.description || '',
      },
    });
  }

  function onSave(e) {
    e.preventDefault();
    const m = modal;
    if (m.mode === 'create' && !m.form.code) {
      setError('El código es obligatorio');
      return;
    }
    if (m.mode === 'create' && !m.form.name) {
      setError('El nombre es obligatorio');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(m.form.code)) {
      setError('El código debe tener entre 2 y 20 caracteres (letras, números, guion bajo o guion) y empezar por alfanumérico');
      return;
    }
    saveMutation.mutate(m);
  }

  function toggleActive(org) {
    toggleActiveMutation.mutate(org);
  }

  const showError = error || queryError?.message || '';

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="m20 20-3.5-3.5" />
            </svg>
            <input
              className="input !pl-9"
              placeholder="Buscar por nombre o código…"
              value={filters.search || ''}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
            />
          </div>
          <Select
            className="!w-auto"
            aria-label="Filtrar por estado"
            options={[
              { value: '', label: 'Activas e inactivas' },
              { value: 'active', label: 'Solo activas' },
              { value: 'inactive', label: 'Solo inactivas' },
            ]}
            value={filters.status || ''}
            onChange={(v) => setFilters((f) => ({ ...f, status: v, page: 1 }))}
          />
        </div>
        <button className="btn-primary" onClick={openCreate}>
          + Nueva empresa
        </button>
      </div>

      {(showError || queryError) && (
        <div className="mb-3"><ErrorBox message={showError || queryError.message || 'No se pudieron cargar las empresas'} /></div>
      )}

      {!list ? (
        <LoadingScreen text="Cargando empresas…" />
      ) : (
        <div className="card">
          {list.data.length === 0 ? (
            <EmptyState icon="🏢" title="Sin empresas" subtitle="No se encontraron empresas con los criterios seleccionados." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="th">Código</th>
                    <th className="th">Nombre</th>
                    <th className="th">Descripción</th>
                    <th className="th">Usuarios</th>
                    <th className="th">Usuarios activos</th>
                    <th className="th">Tickets</th>
                    <th className="th">Estado</th>
                    <th className="th">Creada</th>
                    <th className="th text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.data.map((org) => (
                    <tr key={org.id} className="hover:bg-slate-50">
                      <td className="td font-mono text-sm text-slate-700">{org.code}</td>
                      <td className="td font-medium text-slate-800">{org.name}</td>
                      <td className="td max-w-xs truncate text-slate-600">{org.description || '—'}</td>
                      <td className="td whitespace-nowrap text-slate-600">{org.users_count ?? 0}</td>
                      <td className="td whitespace-nowrap text-slate-600">{org.active_users_count ?? 0}</td>
                      <td className="td whitespace-nowrap text-slate-600">{org.tickets_count ?? 0}</td>
                      <td className="td">
                        <ConfirmToggle
                          active={!!org.active}
                          name={`estado de ${org.name}`}
                          labelActivate="Desactivar"
                          labelDeactivate="Activar"
                          onToggle={() => toggleActive(org)}
                        />
                      </td>
                      <td className="td whitespace-nowrap text-slate-500">
                        {org.created_at ? formatDate(org.created_at) : '—'}
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          <Tooltip text="Editar empresa">
                            <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => openEdit(org)} aria-label={`Editar ${org.name}`}>
                              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={list.page} pages={list.pages} total={list.total} onChange={(page) => setFilters((f) => ({ ...f, page }))} />
        </div>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.mode === 'create' ? 'Nueva empresa' : 'Editar empresa'} wide>
        {modal && (
          <form onSubmit={onSave} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="org-code">Código *</label>
                <input
                  className="input"
                  id="org-code"
                  value={modal.form.code}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, code: e.target.value.toUpperCase() } })}
                  maxLength={20}
                  disabled={modal.mode === 'edit'}
                  aria-label="Código de empresa"
                  placeholder="EJ: EMPRESA1"
                />
                {modal.mode === 'edit' && (
                  <p className="mt-1 text-xs text-slate-400">El código es inmutable y no se puede modificar.</p>
                )}
              </div>
              <div>
                <label className="label" htmlFor="org-name">Nombre *</label>
                <input
                  className="input"
                  id="org-name"
                  value={modal.form.name}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })}
                  maxLength={120}
                  aria-label="Nombre de empresa"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="org-description">Descripción</label>
                <textarea
                  className="input min-h-[80px] resize-y"
                  id="org-description"
                  value={modal.form.description}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, description: e.target.value } })}
                  maxLength={500}
                  placeholder="Descripción opcional de la empresa"
                />
              </div>
            </div>
            {error && <ErrorBox message={error} />}
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setModal(null)}>Cancelar</button>
              <button type="submit" className="btn-primary" disabled={loadingModal}>
                {loadingModal && <Spinner className="h-4 w-4 text-white" />}
                {modal.mode === 'create' ? 'Crear empresa' : 'Guardar cambios'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
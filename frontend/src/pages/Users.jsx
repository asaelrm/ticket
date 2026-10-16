import { useId, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatDate, formatDateTime } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Modal, Pagination, ErrorBox, Spinner, LoadingScreen, ConfirmToggle, EmptyState } from '../components/ui';
import Select from '../components/Select';
import Tooltip from '../components/Tooltip';
import UserTicketHistory from '../components/UserTicketHistory';
import { useToast } from '../components/Toast';

const EMPTY = {
  name: '',
  last_name: '',
  username: '',
  email: '',
  password: '',
  department_id: '',
  position: '',
  role_id: '',
  organization_id: '',
};

// Enlace de restablecimiento. Se usa el origen real del navegador para que
// apunte al servidor que el administrador está usando, y se codifica el token
// porque es base64url y puede llevar caracteres con significado en la URL.
export function resetEnlace(token) {
  const origen = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origen}/reset-password?token=${encodeURIComponent(token)}`;
}

function TextField({ label, value, onChange, type = 'text', help }) {
  const inputId = useId();
  return (
    <div>
      <label className="label" htmlFor={inputId}>
        {label}
      </label>
      <input
        className="input"
        id={inputId}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={help ? `${inputId}-help` : undefined}
      />
      {help && (
        <p id={`${inputId}-help`} className="mt-1 text-xs text-slate-400">
          {help}
        </p>
      )}
    </div>
  );
}

export default function Users() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filters, setFilters] = useState({ page: 1, perPage: 15 });
  const [error, setError] = useState('');
  const [loadingModal, setLoadingModal] = useState(false);

  const [modal, setModal] = useState(null); // null | { mode: 'create'|'edit', form }
  const [tokenModal, setTokenModal] = useState(null);
  const [historyUser, setHistoryUser] = useState(null);
  const [assignmentModal, setAssignmentModal] = useState(null);
  const [assignmentSaving, setAssignmentSaving] = useState(false);

  const { data: list, error: queryError } = useQuery({
    queryKey: ['users', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) {
        if (v !== '' && v != null) params.append(k, v);
      }
      params.append('perPage', filters.perPage || 15);
      return api.get(`/api/users?${params}`);
    },
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['user-roles'],
    queryFn: () => api.get('/api/users/roles').then((d) => d.roles || []),
    retry: false,
  });

  const { data: departments = [] } = useQuery({
    queryKey: ['active-departments'],
    queryFn: () => api.get('/api/departments?active=1').then((d) => d.data || []),
    retry: false,
  });

  const { data: organizationsForUser = [] } = useQuery({
    queryKey: ['organizations-for-user'],
    queryFn: async () => {
      const res = await api.get('/api/organizations?perPage=100');
      return (res.data || []).filter((o) => o.active === 1);
    },
    enabled: user?.is_superadmin === true,
  });

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  async function openAssignments(target) {
    try {
      const [orgs, sifha, history] = await Promise.all([
        api.get(`/api/users/${target.id}/organizations`),
        api.get(`/api/users/${target.id}/sifha-support`),
        api.get(`/api/users/${target.id}/organization-history`),
      ]);
      const activeSifhaIds = (sifha.organizations || []).filter((a) => a.active).map((a) => Number(a.organization_id));
      setAssignmentModal({
        user: target,
        assignments: orgs.organizations || [],
        initialAssignmentIds: (orgs.organizations || []).filter((a) => a.active).map((a) => Number(a.organization_id)),
        sifha: organizationsForUser.map((o) => ({ organization_id: o.id, name: o.name, active: activeSifhaIds.includes(Number(o.id)) })),
        initialSifhaIds: activeSifhaIds,
        history: history.history || [],
        error: '',
      });
    } catch (err) {
      setError(err.message || 'No se pudieron cargar las asignaciones');
    }
  }

  async function saveAssignments() {
    const m = assignmentModal;
    setAssignmentSaving(true);
    try {
      await api.put(`/api/users/${m.user.id}/organizations`, {
        assignments: m.assignments.map((a) => ({ organization_id: a.organization_id, role_id: a.role_id })),
        revoked_organization_ids: m.initialAssignmentIds.filter((id) => !m.assignments.some((a) => Number(a.organization_id) === id)),
      });
      await api.put(`/api/users/${m.user.id}/sifha-support`, {
        organization_ids: m.sifha.filter((a) => a.active).map((a) => a.organization_id),
        revoked_organization_ids: m.initialSifhaIds.filter((id) => !m.sifha.some((a) => a.active && Number(a.organization_id) === id)),
      });
      const updated = await api.get(`/api/users/${m.user.id}/organization-history`);
      setAssignmentModal(null);
      toast.success('Asignaciones y permisos actualizados');
      queryClient.invalidateQueries({ queryKey: ['users'] });
      return updated;
    } catch (err) {
      setAssignmentModal((current) => current ? { ...current, error: err.message || 'No se pudieron guardar las asignaciones' } : current);
      return null;
    } finally {
      setAssignmentSaving(false);
    }
  }

  // Los tres filtros tenían opción vacía seleccionable, así que se conservan
  // como primeras opciones reales. Los ids siguen llegando como cadena.
  const departmentFilterOptions = useMemo(
    () => [{ value: '', label: 'Todos los deptos' }, ...departments.map((d) => ({ value: d.id, label: d.name }))],
    [departments]
  );
  const roleFilterOptions = useMemo(
    () => [{ value: '', label: 'Todos los roles' }, ...roles.map((r) => ({ value: r.id, label: r.name }))],
    [roles]
  );
  const statusFilterOptions = useMemo(
    () => [
      { value: '', label: 'Activos e inactivos' },
      { value: 'active', label: 'Solo activos' },
      { value: 'inactive', label: 'Solo inactivos' },
    ],
    []
  );
  // "Sin departamento" también era seleccionable: opción real. El rol NO, su
  // opción vacía era `disabled` (placeholder) y por eso no entra en la lista.
  const departmentFormOptions = useMemo(
    () => [{ value: '', label: 'Sin departamento' }, ...departments.map((d) => ({ value: d.id, label: d.name }))],
    [departments]
  );
  const roleFormOptions = useMemo(() => roles.map((r) => ({ value: r.id, label: r.name })), [roles]);

  const saveMutation = useMutation({
    mutationFn: (m) => {
      const body = { ...m.form };
      // SUPERADMIN puede especificar organization_id al crear usuarios
      if (m.mode === 'create' && user?.is_superadmin && body.organization_id) {
        // organization_id ya está en el body
      } else if (m.mode === 'create') {
        // Usuarios no SUPERADMIN no pueden especificar organization_id
        delete body.organization_id;
      } else {
        // En edición, nunca se envía organization_id desde el cliente
        delete body.organization_id;
      }
      return m.mode === 'create' ? api.post('/api/users', body) : api.patch(`/api/users/${m.id}`, body);
    },
    onMutate: () => {
      setLoadingModal(true);
      setError('');
    },
    onSuccess: (_data, m) => {
      setModal(null);
      invalidateUsers();
      toast.success(m.mode === 'create' ? 'Usuario creado' : 'Usuario actualizado');
    },
    onError: (err) => {
      if (err.fields) setError(Object.values(err.fields).join('. '));
      else setError(err.message || 'No se pudo guardar el usuario');
    },
    onSettled: () => {
      setLoadingModal(false);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (u) => api.patch(`/api/users/${u.id}/status`, { active: !u.active }),
    onSuccess: (_data, u) => {
      invalidateUsers();
      toast.success(u.active ? 'Usuario desactivado' : 'Usuario activado');
    },
    onError: (err) => setError(err.message || 'No se pudo cambiar el estado'),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (u) => api.post(`/api/users/${u.id}/reset-password`, {}),
    onMutate: () => {
      setLoadingModal(true);
      setError('');
    },
    onSuccess: (data, u) => {
      setTokenModal({ user: `${u.name} ${u.last_name}`, ...data });
    },
    onError: (err) => setError(err.message || 'No se pudo generar el token'),
    onSettled: () => {
      setLoadingModal(false);
    },
  });

  function openCreate() {
    setError('');
    setModal({
      mode: 'create',
      form: {
        ...EMPTY,
        role_id: roles.find((r) => r.code === 'EMPLOYEE')?.id || '',
        organization_id: user?.is_superadmin ? '' : '',
      },
    });
  }

  function openEdit(u) {
    setError('');
    setModal({
      mode: 'edit',
      id: u.id,
      form: {
        name: u.name,
        last_name: u.last_name,
        username: u.username,
        email: u.email,
        department_id: u.department_id ? String(u.department_id) : '',
        position: u.position || '',
        role_id: u.role_id ? String(u.role_id) : '',
      },
    });
  }

  function onSave(e) {
    e.preventDefault();
    const m = modal;
    if (m.mode === 'create' && !m.form.password) {
      setError('La contraseña es obligatoria');
      return;
    }
    if (m.mode === 'create') {
      const role = roles.find((r) => r.id === Number(m.form.role_id));
      const minLength = role?.code === 'SUPERADMIN' ? 12 : 6;
      if (m.form.password.length < minLength) {
        setError(`La contraseña debe tener al menos ${minLength} caracteres`);
        return;
      }
    }
    saveMutation.mutate(m);
  }

  function toggleActive(u) {
    if (u.id === user.id && u.active) {
      setError('No puede desactivar su propia cuenta');
      return;
    }
    toggleMutation.mutate(u);
  }

  function resetPassword(u) {
    resetPasswordMutation.mutate(u);
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
              placeholder="Buscar por nombre, usuario o correo…"
              value={filters.search || ''}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
            />
          </div>
            <Select
              className="!w-auto"
              aria-label="Filtrar por departamento"
              options={departmentFilterOptions}
              value={filters.department || ''}
              onChange={(v) => setFilters((f) => ({ ...f, department: v, page: 1 }))}
            />
            <Select
              className="!w-auto"
              aria-label="Filtrar por rol"
              options={roleFilterOptions}
              value={filters.role || ''}
              onChange={(v) => setFilters((f) => ({ ...f, role: v, page: 1 }))}
            />
            <Select
              className="!w-auto"
              aria-label="Filtrar por estado"
              options={statusFilterOptions}
              value={filters.status || ''}
              onChange={(v) => setFilters((f) => ({ ...f, status: v, page: 1 }))}
            />
        </div>
        {user?.permissions?.includes('user.manage') && (
          <button className="btn-primary" onClick={openCreate}>
            + Nuevo usuario
          </button>
        )}
      </div>

      {(showError || queryError) && (
        <div className="mb-3"><ErrorBox message={showError || queryError.message || 'No se pudieron cargar los usuarios'} /></div>
      )}

      {!list ? (
        <LoadingScreen />
      ) : (
        <div className="card">
          {list.data.length === 0 ? (
            <EmptyState icon="👥" title="Sin usuarios" subtitle="No se encontraron usuarios con los criterios seleccionados." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="th">Empleado</th>
                    <th className="th">Usuario</th>
                    <th className="th">Correo</th>
                    <th className="th">Departamento</th>
                    <th className="th">Rol</th>
                    <th className="th">Último acceso</th>
                    <th className="th">Estado</th>
                    <th className="th text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.data.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="td">
                        <p className="font-medium text-slate-800">{u.name} {u.last_name}</p>
                        {u.position && <p className="text-xs text-slate-400">{u.position}</p>}
                      </td>
                      <td className="td text-slate-600">{u.username}</td>
                      <td className="td text-slate-600">{u.email}</td>
                      <td className="td text-slate-600">{u.department_name || '—'}</td>
                      <td className="td">
                        <span className="badge bg-brand-50 text-brand-700 ring-1 ring-brand-600/20">{u.role_name}</span>
                      </td>
                      <td className="td whitespace-nowrap text-slate-500">
                        {u.last_login_at ? formatDateTime(u.last_login_at) : 'Nunca'}
                      </td>
                      <td className="td">
                        {user?.permissions?.includes('user.manage') ? (
                          <ConfirmToggle
                            active={u.active}
                            name={`estado de ${u.username}`}
                            labelActivate="Desactivar"
                            labelDeactivate="Activar"
                            onToggle={() => toggleActive(u)}
                          />
                        ) : (
                          <span
                            className={`badge ring-1 ${u.active ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-slate-100 text-slate-500 ring-slate-400/20'}`}
                          >
                            {u.active ? 'Activo' : 'Inactivo'}
                          </span>
                        )}
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setHistoryUser(u)}>
                            Historial
                          </button>
                          {user?.permissions?.includes('user.manage') && (
                            <>
                              {user?.is_superadmin && <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => openAssignments(u)}>Empresas</button>}
                              <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => openEdit(u)}>
                                Editar
                              </button>
                              <Tooltip text="Restablecer contraseña">
                                <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => resetPassword(u)} aria-label="Restablecer contraseña">
                                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                                    <rect x="4" y="10" width="16" height="10" rx="2" />
                                    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                                  </svg>
                                </button>
                              </Tooltip>
                            </>
                          )}
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

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.mode === 'create' ? 'Nuevo usuario' : 'Editar usuario'} wide>
        {modal && (
          <form onSubmit={onSave} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Nombre *" value={modal.form.name} onChange={(v) => setModal({ ...modal, form: { ...modal.form, name: v } })} />
              <TextField label="Apellidos *" value={modal.form.last_name} onChange={(v) => setModal({ ...modal, form: { ...modal.form, last_name: v } })} />
              <TextField label="Usuario *" value={modal.form.username} onChange={(v) => setModal({ ...modal, form: { ...modal.form, username: v } })} />
              <TextField label="Correo *" type="email" value={modal.form.email} onChange={(v) => setModal({ ...modal, form: { ...modal.form, email: v } })} />
                <div>
                  <label className="label" htmlFor="user-department">Departamento</label>
                  <Select
                    id="user-department"
                    options={departmentFormOptions}
                    value={modal.form.department_id}
                    onChange={(v) => setModal({ ...modal, form: { ...modal.form, department_id: v } })}
                  />
                </div>
              <TextField label="Cargo" value={modal.form.position} onChange={(v) => setModal({ ...modal, form: { ...modal.form, position: v } })} />
                <div>
                  <label className="label" htmlFor="user-role">Rol *</label>
                  {/* La opción vacía era `disabled`, así que se comporta como
                      placeholder. El formulario es `noValidate` y la validación
                      real la hace el backend (`err.fields`), por lo que se pierde
                      el aviso nativo del navegador igual que en el resto de
                      select migrados. */}
                  <Select
                    id="user-role"
                    placeholder="Seleccione."
                    options={roleFormOptions}
                    value={modal.form.role_id}
                    onChange={(v) => setModal({ ...modal, form: { ...modal.form, role_id: v } })}
                  />
                </div>
              {user?.is_superadmin && modal.mode === 'create' && (
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="user-organization">Empresa</label>
                  <Select
                    id="user-organization"
                    placeholder="Seleccione empresa (opcional)"
                    options={[{ value: '', label: 'Sin empresa (usuario global)' }, ...organizationsForUser.map((o) => ({ value: o.id, label: o.name }))]}
                    value={modal.form.organization_id}
                    onChange={(v) => setModal({ ...modal, form: { ...modal.form, organization_id: v } })}
                  />
                  <p className="mt-1 text-xs text-slate-400">
                    Solo SUPERADMIN puede asignar empresa. Usuarios normales pertenecen a su empresa de sesión.
                  </p>
                </div>
              )}
              {modal.mode === 'create' && (
                <div className="sm:col-span-2">
                  <TextField label="Contraseña inicial *" type="password" help={(() => {
                    const role = roles.find((r) => r.id === Number(modal.form.role_id));
                    return role?.code === 'SUPERADMIN' ? 'Mínimo 12 caracteres.' : 'Mínimo 6 caracteres.';
                  })()} value={modal.form.password} onChange={(v) => setModal({ ...modal, form: { ...modal.form, password: v } })} />
                </div>
              )}
            </div>
            {error && <ErrorBox message={error} />}
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setModal(null)}>Cancelar</button>
              <button type="submit" className="btn-primary" disabled={loadingModal}>
                {loadingModal && <Spinner className="h-4 w-4 text-white" />}
                {modal.mode === 'create' ? 'Crear usuario' : 'Guardar cambios'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!assignmentModal} onClose={() => setAssignmentModal(null)} title="Empresas y soporte SIFHA" wide>
        {assignmentModal && (
          <div className="space-y-5">
            <p className="text-sm text-slate-600">Configura las empresas y el rol independiente del usuario.</p>
            {assignmentModal.error && <ErrorBox message={assignmentModal.error} />}
            {organizationsForUser.map((organization) => {
              const current = assignmentModal.assignments.find((a) => Number(a.organization_id) === Number(organization.id));
              return <div key={organization.id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
                <input type="checkbox" checked={!!current} onChange={(e) => setAssignmentModal((m) => ({ ...m, assignments: e.target.checked ? [...m.assignments, { organization_id: organization.id, organization_name: organization.name, role_id: roles[0]?.id }] : m.assignments.filter((a) => Number(a.organization_id) !== Number(organization.id)) }))} />
                <span className="min-w-0 flex-1 text-sm font-medium">{organization.name}</span>
                <select className="input max-w-52" disabled={!current} value={current?.role_id || ''} onChange={(e) => setAssignmentModal((m) => ({ ...m, assignments: m.assignments.map((a) => Number(a.organization_id) === Number(organization.id) ? { ...a, role_id: Number(e.target.value) } : a) }))}>
                  {roles.filter((r) => r.code !== 'SUPERADMIN').map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                </select>
              </div>;
            })}
            <section className="space-y-2 border-t border-slate-200 pt-4">
              <h3 className="text-sm font-semibold text-slate-800">Soporte central SIFHA</h3>
              <p className="text-xs text-slate-500">Marque cada empresa cuyos tickets SIFHA podrá atender. No concede acceso a tickets internos.</p>
              {assignmentModal.sifha.map((item) => (
                <label key={item.organization_id} className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={!!item.active} onChange={(e) => setAssignmentModal((m) => ({ ...m, sifha: m.sifha.map((entry) => Number(entry.organization_id) === Number(item.organization_id) ? { ...entry, active: e.target.checked } : entry) }))} />
                  {item.name}
                </label>
              ))}
            </section>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4"><button className="btn-secondary" onClick={() => setAssignmentModal(null)} disabled={assignmentSaving}>Cancelar</button><button className="btn-primary" onClick={saveAssignments} disabled={assignmentSaving}>{assignmentSaving ? 'Guardando…' : 'Guardar asignaciones'}</button></div>
            <section className="border-t border-slate-200 pt-4">
              <h3 className="text-sm font-semibold text-slate-800">Historial de asignaciones</h3>
              {assignmentModal.history.length === 0 ? <p className="mt-2 text-xs text-slate-500">Sin cambios registrados.</p> : <div className="mt-2 max-h-48 overflow-auto"><table className="w-full text-xs"><thead><tr className="border-b border-slate-200 text-left"><th className="p-2">Empresa</th><th className="p-2">Rol</th><th className="p-2">Acción</th><th className="p-2">Administrador / fecha</th></tr></thead><tbody>{assignmentModal.history.map((item) => <tr key={item.id} className="border-b border-slate-100"><td className="p-2">{item.organization_name}</td><td className="p-2">{item.role_name || '—'}</td><td className="p-2">{item.action}</td><td className="p-2">{item.admin_name} {item.admin_last_name}<br />{formatDateTime(item.changed_at)}</td></tr>)}</tbody></table></div>}
            </section>
          </div>
        )}
      </Modal>

      <Modal open={!!tokenModal} onClose={() => setTokenModal(null)} title="Restablecer contraseña">
        {tokenModal && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Se generó un enlace de recuperación para <b>{tokenModal.user}</b>. Compártalo únicamente con el usuario.
            </p>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Enlace de recuperación</p>
              {/* El enlace se construye con el origen desde el que se está
                  usando la aplicación, no con PUBLIC_URL del backend: así
                  funciona igual en localhost, en el laboratorio con
                  tickets.lan y en el dominio público detrás de Cloudflare.
                  La ruta NO lleva el prefijo /app de las páginas privadas:
                  /reset-password es una ruta pública hermana de /login. */}
              <a
                href={`${resetEnlace(tokenModal.token)}`}
                target="_blank"
                rel="noreferrer"
                className="block break-all text-sm font-semibold text-blue-700 underline hover:text-blue-900"
              >
                {resetEnlace(tokenModal.token)}
              </a>
              <p className="mt-1 text-xs text-slate-400">Expira: {formatDateTime(tokenModal.expires)}</p>
            </div>
            <p className="text-xs text-slate-400">
              Envíale este enlace al usuario. Se abre sin iniciar sesión y vale una sola vez.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="btn-secondary"
                onClick={() => navigator.clipboard.writeText(resetEnlace(tokenModal.token))}
              >
                Copiar enlace
              </button>
              <a
                href={resetEnlace(tokenModal.token)}
                target="_blank"
                rel="noreferrer"
                className="btn-primary inline-flex items-center"
              >
                Abrir enlace
              </a>
              <button className="btn-secondary" onClick={() => setTokenModal(null)}>Cerrar</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!historyUser}
        onClose={() => setHistoryUser(null)}
        title={historyUser ? `Historial de ${historyUser.name} ${historyUser.last_name}` : 'Historial'}
        wide
      >
        {historyUser && <UserTicketHistory userId={historyUser.id} />}
      </Modal>
    </div>
  );
}

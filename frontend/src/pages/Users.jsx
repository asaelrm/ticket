import { useEffect, useState, useCallback } from 'react';
import { api, formatDate, formatDateTime } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Modal, Pagination, ErrorBox, Spinner, LoadingScreen, ConfirmToggle, EmptyState } from '../components/ui';
import UserTicketHistory from '../components/UserTicketHistory';

const EMPTY = {
  name: '',
  last_name: '',
  username: '',
  email: '',
  password: '',
  department_id: '',
  position: '',
  role_id: '',
};

export default function Users() {
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [roles, setRoles] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [filters, setFilters] = useState({ page: 1, perPage: 15 });
  const [error, setError] = useState('');
  const [loadingModal, setLoadingModal] = useState(false);

  const [modal, setModal] = useState(null); // null | { mode: 'create'|'edit', form }
  const [tokenModal, setTokenModal] = useState(null);
  const [historyUser, setHistoryUser] = useState(null);

  const load = useCallback(async (f) => {
    setError('');
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) {
        if (v !== '' && v != null) params.append(k, v);
      }
      params.append('perPage', f.perPage || 15);
      const data = await api.get(`/api/users?${params}`);
      setList(data);
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los usuarios');
    }
  }, []);

  useEffect(() => {
    load(filters);
  }, [load, filters]);

  useEffect(() => {
    Promise.all([api.get('/api/users/roles'), api.get('/api/departments?active=1')])
      .then(([r, d]) => {
        setRoles(r.roles || []);
        setDepartments(d.data || []);
      })
      .catch(() => {});
  }, []);

  function openCreate() {
    setError('');
    setModal({ mode: 'create', form: { ...EMPTY, role_id: roles.find((r) => r.code === 'EMPLOYEE')?.id || '' } });
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

  async function onSave(e) {
    e.preventDefault();
    setLoadingModal(true);
    setError('');
    const m = modal;
    const body = { ...m.form };
    if (m.mode === 'create' && !body.password) {
      setError('La contraseña es obligatoria');
      setLoadingModal(false);
      return;
    }
    try {
      if (m.mode === 'create') await api.post('/api/users', body);
      else await api.patch(`/api/users/${m.id}`, body);
      setModal(null);
      await load(filters);
    } catch (err) {
      if (err.fields) setError(Object.values(err.fields).join('. '));
      else setError(err.message || 'No se pudo guardar el usuario');
    } finally {
      setLoadingModal(false);
    }
  }

  async function toggleActive(u) {
    if (u.id === user.id && u.active) {
      setError('No puede desactivar su propia cuenta');
      return;
    }
    try {
      await api.patch(`/api/users/${u.id}/status`, { active: !u.active });
      await load(filters);
    } catch (err) {
      setError(err.message || 'No se pudo cambiar el estado');
    }
  }

  async function resetPassword(u) {
    setLoadingModal(true);
    setError('');
    try {
      const data = await api.post(`/api/users/${u.id}/reset-password`, {});
      setTokenModal({ user: `${u.name} ${u.last_name}`, ...data });
    } catch (err) {
      setError(err.message || 'No se pudo generar el token');
    } finally {
      setLoadingModal(false);
    }
  }

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
          <select className="input !w-auto" value={filters.department || ''} onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value, page: 1 }))}>
            <option value="">Todos los deptos</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <select className="input !w-auto" value={filters.role || ''} onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value, page: 1 }))}>
            <option value="">Todos los roles</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <select className="input !w-auto" value={filters.status || ''} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}>
            <option value="">Activos e inactivos</option>
            <option value="active">Solo activos</option>
            <option value="inactive">Solo inactivos</option>
          </select>
        </div>
        {user?.permissions?.includes('user.manage') && (
          <button className="btn-primary" onClick={openCreate}>
            + Nuevo usuario
          </button>
        )}
      </div>

      {error && <div className="mb-3"><ErrorBox message={error} /></div>}

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
                        <ConfirmToggle
                          active={u.active}
                          name={`estado de ${u.username}`}
                          labelActivate="Desactivar"
                          labelDeactivate="Activar"
                          onToggle={() => toggleActive(u)}
                        />
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setHistoryUser(u)}>
                            Historial
                          </button>
                          {user?.permissions?.includes('user.manage') && (
                            <>
                              <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => openEdit(u)}>
                                Editar
                              </button>
                              <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => resetPassword(u)} title="Restablecer contraseña">
                                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                                  <rect x="4" y="10" width="16" height="10" rx="2" />
                                  <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                                </svg>
                              </button>
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
                <label className="label">Departamento</label>
                <select className="input" value={modal.form.department_id} onChange={(e) => setModal({ ...modal, form: { ...modal.form, department_id: e.target.value } })}>
                  <option value="">Sin departamento</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <TextField label="Cargo" value={modal.form.position} onChange={(v) => setModal({ ...modal, form: { ...modal.form, position: v } })} />
              <div>
                <label className="label">Rol *</label>
                <select className="input" value={modal.form.role_id} onChange={(e) => setModal({ ...modal, form: { ...modal.form, role_id: e.target.value } })} required>
                  <option value="" disabled>Seleccione…</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              {modal.mode === 'create' && (
                <div className="sm:col-span-2">
                  <TextField label="Contraseña inicial *" type="password" help="Mínimo 6 caracteres." value={modal.form.password} onChange={(v) => setModal({ ...modal, form: { ...modal.form, password: v } })} />
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

      <Modal open={!!tokenModal} onClose={() => setTokenModal(null)} title="Restablecer contraseña">
        {tokenModal && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Se generó un enlace de recuperación para <b>{tokenModal.user}</b>. Compártalo únicamente con el usuario.
            </p>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Token (modo desarrollo)</p>
              <code className="block break-all text-sm font-semibold text-slate-800">{tokenModal.token}</code>
              <p className="mt-1 text-xs text-slate-400">Expira: {formatDateTime(tokenModal.expires)}</p>
            </div>
            <p className="text-xs text-slate-400">Puede usar este token en la URL /reset-password?token=…</p>
            <div className="flex justify-end gap-2">
              <button
                className="btn-secondary"
                onClick={() => navigator.clipboard.writeText(tokenModal.token)}
              >
                Copiar token
              </button>
              <button className="btn-primary" onClick={() => setTokenModal(null)}>Cerrar</button>
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

function TextField({ label, value, onChange, type = 'text', help }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" type={type} value={value} onChange={(e) => onChange(e.target.value)} />
      {help && <p className="mt-1 text-xs text-slate-400">{help}</p>}
    </div>
  );
}
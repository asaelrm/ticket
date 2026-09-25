import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth, can } from '../context/AuthContext';
import { LoadingScreen, ErrorBox, EmptyState, Modal, ConfirmDialog, Spinner, Avatar } from '../components/ui';

export default function Teams() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canManage = can(user, 'team.manage');

  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [editing, setEditing] = useState(null); // { id?, name, description }
  const [membersTeam, setMembersTeam] = useState(null);
  const [selected, setSelected] = useState([]);
  const [toDelete, setToDelete] = useState(null);

  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get('/api/teams').then((d) => d.data || []),
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users-assignable'],
    queryFn: () => api.get('/api/users/assignable').then((d) => d.data || []),
  });

  const membersQuery = useQuery({
    queryKey: ['team-members', membersTeam?.id ?? null],
    queryFn: () => api.get(`/api/teams/${membersTeam.id}`),
    enabled: !!membersTeam,
  });

  useEffect(() => {
    if (!membersTeam) return;
    setSelected((membersQuery.data?.members || []).map((m) => m.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersTeam?.id, membersQuery.data]);

  const saveTeam = useMutation({
    mutationFn: ({ id, name, description }) =>
      id
        ? api.patch(`/api/teams/${id}`, { name, description })
        : api.post('/api/teams', { name, description }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams'] });
      setEditing(null);
      setNotice('Equipo guardado');
    },
    onError: (err) => {
      setError(err.message || 'No se pudo guardar el equipo');
    },
  });

  const saveMembersMutation = useMutation({
    mutationFn: ({ id, user_ids }) => api.put(`/api/teams/${id}/members`, { user_ids }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['teams'] });
      setMembersTeam(data.team);
      setNotice('Miembros actualizados');
    },
    onError: (err) => {
      setError(err.message || 'No se pudieron guardar los miembros');
    },
  });

  const deleteTeam = useMutation({
    mutationFn: (id) => api.del(`/api/teams/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams'] });
      setToDelete(null);
      setNotice('Equipo eliminado');
    },
    onError: (err) => {
      setError(err.message || 'No se pudo eliminar el equipo');
    },
  });

  const saving = saveTeam.isPending || saveMembersMutation.isPending || deleteTeam.isPending;

  function onSave(e) {
    e.preventDefault();
    setError('');
    saveTeam.mutate({ id: editing.id, name: editing.name, description: editing.description });
  }

  function openMembers(team) {
    setMembersTeam(team);
    setError('');
  }

  function saveMembers() {
    setError('');
    saveMembersMutation.mutate({ id: membersTeam.id, user_ids: selected });
  }

  function confirmDelete() {
    setError('');
    deleteTeam.mutate(toDelete.id);
  }

  if (!teams) return <LoadingScreen text="Cargando equipos…" />;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {teams.length} equipo(s). Agrupe usuarios para asignar tickets a un equipo completo.
        </p>
        {canManage && (
          <button className="btn-primary" onClick={() => setEditing({ name: '', description: '' })}>
            + Nuevo equipo
          </button>
        )}
      </div>

      {error && <div className="mb-3"><ErrorBox message={error} /></div>}
      {notice && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>
      )}

      {teams.length === 0 ? (
        <div className="card">
          <EmptyState icon="👥" title="Sin equipos" subtitle="Cree el primer equipo de trabajo para organizar la atención." />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {teams.map((t) => (
            <div key={t.id} className="card flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-slate-800">{t.name}</h3>
                  <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{t.description || 'Sin descripción'}</p>
                </div>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">👥</span>
              </div>
              <div className="mt-4 flex gap-4 text-sm">
                <span className="text-slate-600">
                  <b className="text-slate-800">{t.member_count}</b> miembro(s)
                </span>
                <span className="text-slate-600">
                  <b className="text-slate-800">{t.open_tickets}</b> abiertos
                </span>
              </div>
              <div className="mt-4 flex gap-2 border-t border-slate-100 pt-4">
                <button className="btn-secondary !px-3 !py-1.5 text-sm" onClick={() => openMembers(t)}>
                  Miembros
                </button>
                {canManage && (
                  <>
                    <button className="btn-secondary !px-3 !py-1.5 text-sm" onClick={() => setEditing({ id: t.id, name: t.name, description: t.description || '' })}>
                      Editar
                    </button>
                    <button className="btn-ghost !px-2 text-sm text-red-600 hover:bg-red-50" onClick={() => setToDelete(t)}>
                      Eliminar
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Crear / editar equipo */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Editar equipo' : 'Nuevo equipo'}>
        {editing && (
          <form onSubmit={onSave} className="space-y-4" noValidate>
            <div>
              <label className="label">Nombre *</label>
              <input
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={100}
                required
              />
            </div>
            <div>
              <label className="label">Descripción</label>
              <textarea
                className="input min-h-[80px] resize-y"
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                maxLength={300}
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                Cancelar
              </button>
              <button type="submit" className="btn-primary" disabled={saving || !editing.name.trim()}>
                {saving && <Spinner className="h-4 w-4 text-white" />}
                Guardar
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Miembros */}
      <Modal open={!!membersTeam} onClose={() => setMembersTeam(null)} title={`Miembros de ${membersTeam?.name || ''}`}>
        <p className="mb-3 text-sm text-slate-500">Seleccione los usuarios que forman parte del equipo.</p>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {users.map((u) => (
            <label key={u.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                checked={selected.includes(u.id)}
                onChange={(e) =>
                  setSelected((prev) => (e.target.checked ? [...prev, u.id] : prev.filter((id) => id !== u.id)))
                }
              />
              <Avatar name={`${u.name} ${u.last_name}`} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-700">
                  {u.name} {u.last_name}
                </span>
                <span className="block truncate text-xs text-slate-400">{u.position || u.department_name || '—'}</span>
              </span>
            </label>
          ))}
          {users.length === 0 && <p className="px-2 py-3 text-sm text-slate-400">No hay usuarios disponibles.</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className="btn-secondary" onClick={() => setMembersTeam(null)}>
            Cerrar
          </button>
          {canManage && (
            <button type="button" className="btn-primary" disabled={saving} onClick={saveMembers}>
              {saving && <Spinner className="h-4 w-4 text-white" />}
              Guardar miembros
            </button>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        title="Eliminar equipo"
        message={`¿Confirma eliminar el equipo "${toDelete?.name}"? Los tickets asignados quedarán sin equipo.`}
        confirmLabel="Eliminar"
        danger
      />
    </div>
  );
}
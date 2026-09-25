import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ErrorBox, Spinner, LoadingScreen } from '../components/ui';

const PERM_GROUPS = [
  {
    label: 'Tickets',
    codes: ['ticket.create', 'ticket.view.own', 'ticket.view.all', 'ticket.comment', 'ticket.assign', 'ticket.update.any', 'ticket.reopen', 'ticket.export'],
  },
  {
    label: 'Resolución de tickets',
    codes: ['ticket.resolve', 'ticket.close', 'ticket.note'],
  },
  {
    label: 'Usuarios y roles',
    codes: ['user.view', 'user.manage', 'role.manage'],
  },
  {
    label: 'Catálogos',
    codes: ['category.manage', 'department.manage'],
  },
  {
    label: 'Operación',
    codes: ['dashboard.view', 'report.view', 'settings.manage'],
  },
];

export default function Roles() {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');

  const { data, error: queryError } = useQuery({
    queryKey: ['roles'],
    queryFn: () =>
      Promise.all([api.get('/api/roles'), api.get('/api/roles/permissions')]).then(([roles, perms]) => ({
        ...roles,
        permissions: perms.permissions || [],
      })),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ role, next }) => api.patch(`/api/roles/${role.id}/permissions`, { permissions: next }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['roles'] }),
    onError: (err) => {
      setError(err.message || 'No se pudo actualizar el permiso');
    },
  });

  if (!data) return <LoadingScreen text="Cargando roles…" />;

  function togglePerm(role, code) {
    setError('');
    const next = role.permissions.includes(code)
      ? role.permissions.filter((c) => c !== code)
      : [...role.permissions, code];
    toggleMutation.mutate({ role, next });
  }

  return (
    <div className="space-y-6">
      <div className="mb-3">{error && <ErrorBox message={error} />}</div>
      <div className="flex items-center gap-2 text-sm text-slate-500">
        {toggleMutation.isPending && <Spinner className="h-4 w-4 text-brand-600" />}
        <span>Seleccione los permisos de cada rol. El rol Administrador siempre conserva todos.</span>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {data.roles.map((role) => {
          const isAdmin = role.code === 'ADMIN';
          return (
            <div key={role.id} className="card overflow-hidden">
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                <p className="font-semibold text-slate-800">{role.name}</p>
                <p className="text-xs text-slate-500">{role.description}</p>
                <span className="badge mt-1 bg-slate-100 text-slate-600">{role.users} usuario(s)</span>
              </div>
              <div className="space-y-4 p-4">
                {PERM_GROUPS.map((group) => (
                  <div key={group.label}>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{group.label}</p>
                    <label className="flex items-start gap-2 mx-1">
                      <input
                        disabled={isAdmin}
                        type="checkbox"
                        checked={isAdmin || group.codes.every((c) => role.permissions.includes(c))}
                        onChange={(e) => {
                          setError('');
                          const target = e.target.checked;
                          const codes = new Set(role.permissions);
                          for (const c of group.codes) target ? codes.add(c) : codes.delete(c);
                          toggleMutation.mutate({ role, next: [...codes] });
                        }}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                      <span className="text-sm font-medium text-slate-600">{group.label} (todo)</span>
                    </label>
                    <ul className="mt-1 space-y-1">
                      {group.codes.map((code) => {
                        const perm = data.permissions.find((p) => p.code === code);
                        return (
                          <li key={code}>
                            <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-50">
                              <input
                                disabled={isAdmin || toggleMutation.isPending}
                                type="checkbox"
                                checked={isAdmin || role.permissions.includes(code)}
                                onChange={() => togglePerm(role, code)}
                                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                              />
                              <span className="text-sm text-slate-600">{perm?.description || code}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
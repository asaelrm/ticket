import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Roles from './Roles';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const PERMS = [
  { code: 'ticket.create', description: 'Crear tickets' },
  { code: 'ticket.view.own', description: 'Ver sus tickets' },
  { code: 'ticket.view.all', description: 'Ver todos los tickets' },
  { code: 'ticket.comment', description: 'Comentar tickets' },
  { code: 'ticket.assign', description: 'Asignar tickets' },
  { code: 'ticket.update.any', description: 'Actualizar cualquier ticket' },
  { code: 'ticket.reopen', description: 'Reabrir tickets' },
  { code: 'ticket.export', description: 'Exportar tickets' },
  { code: 'ticket.resolve', description: 'Resolver tickets' },
  { code: 'ticket.close', description: 'Cerrar tickets' },
  { code: 'ticket.note', description: 'Notas internas' },
  { code: 'user.view', description: 'Ver usuarios' },
  { code: 'user.manage', description: 'Gestionar usuarios' },
  { code: 'role.manage', description: 'Gestionar roles' },
  { code: 'category.manage', description: 'Gestionar categorías' },
  { code: 'department.manage', description: 'Gestionar departamentos' },
  { code: 'dashboard.view', description: 'Ver dashboard' },
  { code: 'report.view', description: 'Ver reportes' },
  { code: 'settings.manage', description: 'Gestionar ajustes' },
];

const ALL_CODES = PERMS.map((p) => p.code);

const ROLES = [
  { id: 1, code: 'ADMIN', name: 'Administrador', description: 'Acceso total', users: 2, permissions: ALL_CODES },
  { id: 2, code: 'EMPLOYEE', name: 'Empleado', description: 'Acceso básico', users: 5, permissions: ['ticket.create', 'ticket.view.own', 'ticket.comment'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url === '/api/roles') return Promise.resolve({ roles: ROLES });
    if (url === '/api/roles/permissions') return Promise.resolve({ permissions: PERMS });
    return Promise.reject(new Error(`404 ${url}`));
  });
});

function cardFor(name) {
  return screen.getByText(name).closest('.card');
}

describe('Roles', () => {
  it('muestra la pantalla de carga mientras la API responde', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/roles') return new Promise(() => {});
      if (url === '/api/roles/permissions') return Promise.resolve({ permissions: PERMS });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Roles />, { route: '/app/roles' });
    expect(screen.getByText('Cargando roles…')).toBeInTheDocument();
  });

  it('muestra los roles y la agrupación de permisos', async () => {
    renderWithProviders(<Roles />, { route: '/app/roles' });

    expect(await screen.findByText('Administrador')).toBeInTheDocument();
    expect(screen.getByText('Acceso total')).toBeInTheDocument();
    expect(screen.getByText('Empleado')).toBeInTheDocument();
    expect(screen.getByText('2 usuario(s)')).toBeInTheDocument();
    expect(screen.getByText('5 usuario(s)')).toBeInTheDocument();
    expect(screen.getAllByText('Tickets').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Crear tickets').length).toBe(2);
    expect(api.get).toHaveBeenCalledWith('/api/roles');
    expect(api.get).toHaveBeenCalledWith('/api/roles/permissions');
  });

  it('agrega un permiso individual a un rol', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Asignar tickets' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/roles/2/permissions',
        expect.objectContaining({ permissions: expect.arrayContaining(['ticket.assign']) })
      )
    );
  });

  it('quita un permiso individual de un rol', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Comentar tickets' }));

    await waitFor(() => {
      const args = api.patch.mock.calls.find(([u]) => u === '/api/roles/2/permissions');
      expect(args).toBeDefined();
      expect(args[1].permissions).not.toContain('ticket.comment');
    });
  });

  it('marca todos los permisos de un grupo', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Tickets (todo)' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/roles/2/permissions',
        expect.objectContaining({ permissions: expect.arrayContaining(['ticket.assign', 'ticket.export', 'ticket.update.any']) })
      )
    );
  });

  it('mantiene deshabilitados los permisos del rol Administrador', async () => {
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Administrador');

    const adminCard = cardFor('Administrador');
    const code = within(adminCard).getByRole('checkbox', { name: 'Crear tickets' });
    const group = within(adminCard).getByRole('checkbox', { name: 'Tickets (todo)' });
    expect(code).toBeDisabled();
    expect(code).toBeChecked();
    expect(group).toBeDisabled();
    expect(group).toBeChecked();
  });

  it('refresca los roles tras actualizar un permiso', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const rolesCalls = () => api.get.mock.calls.filter(([u]) => u === '/api/roles').length;
    const before = rolesCalls();

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Asignar tickets' }));

    await waitFor(() => expect(rolesCalls()).toBeGreaterThan(before));
  });

  it('muestra el error al fallar la actualización de un permiso', async () => {
    api.patch.mockRejectedValueOnce(new Error('No se pudo actualizar el permiso'));

    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Asignar tickets' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo actualizar el permiso');
  });
});
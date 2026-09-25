import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { createQueryClient } from './test/utils';

const { authState } = vi.hoisted(() => ({
  authState: { user: null },
}));

vi.mock('./context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, loading: false, appName: 'Ticket', setAppName: vi.fn() }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

vi.mock('./components/Layout', () => ({
  default: function LayoutStub() {
    return <Outlet />;
  },
}));

vi.mock('./pages/Login', () => ({ default: () => 'PAGE login' }));
vi.mock('./pages/ForgotPassword', () => ({ default: () => 'PAGE forgot-password' }));
vi.mock('./pages/ResetPassword', () => ({ default: () => 'PAGE reset-password' }));
vi.mock('./pages/MyTickets', () => ({ default: () => 'PAGE my-tickets' }));
vi.mock('./pages/NewTicket', () => ({ default: () => 'PAGE new-ticket' }));
vi.mock('./pages/Inbox', () => ({ default: () => 'PAGE inbox' }));
vi.mock('./pages/Tickets', () => ({ default: () => 'PAGE tickets' }));
vi.mock('./pages/TicketDetail', () => ({ default: () => 'PAGE ticket-detail' }));
vi.mock('./pages/Dashboard', () => ({ default: () => 'PAGE dashboard' }));
vi.mock('./pages/Users', () => ({ default: () => 'PAGE users' }));
vi.mock('./pages/Categories', () => ({ default: () => 'PAGE categories' }));
vi.mock('./pages/Departments', () => ({ default: () => 'PAGE departments' }));
vi.mock('./pages/Teams', () => ({ default: () => 'PAGE teams' }));
vi.mock('./pages/Roles', () => ({ default: () => 'PAGE roles' }));
vi.mock('./pages/Reports', () => ({ default: () => 'PAGE reports' }));
vi.mock('./pages/Settings', () => ({ default: () => 'PAGE settings' }));
vi.mock('./pages/Audit', () => ({ default: () => 'PAGE audit' }));
vi.mock('./pages/Profile', () => ({ default: () => 'PAGE profile' }));

const MANAGER = {
  id: 7,
  name: 'Admin',
  permissions: ['category.manage', 'department.manage', 'team.manage', 'role.manage', 'settings.manage'],
};

const EMPLOYEE = { id: 9, name: 'Empleado', permissions: ['ticket.create', 'ticket.view.own'] };

function renderApp(route) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = MANAGER;
});

describe('Permisos de las rutas de gestión', () => {
  it.each([
    ['/app/categories', 'category.manage', 'PAGE categories'],
    ['/app/departments', 'department.manage', 'PAGE departments'],
    ['/app/teams', 'team.manage', 'PAGE teams'],
    ['/app/roles', 'role.manage', 'PAGE roles'],
    ['/app/settings', 'settings.manage', 'PAGE settings'],
    ['/app/audit', 'settings.manage', 'PAGE audit'],
  ])('%s se abre con su permiso y se redirige sin él', async (route, permission, page) => {
    renderApp(route);
    expect(await screen.findByText(page)).toBeInTheDocument();

    authState.user = { ...EMPLOYEE, permissions: EMPLOYEE.permissions.filter((p) => p !== permission) };
    renderApp(route);
    expect(await screen.findByText('PAGE my-tickets')).toBeInTheDocument();
    expect(screen.queryByText(page)).not.toBeInTheDocument();
  });

  it('el perfil no exige ningún permiso adicional', async () => {
    authState.user = EMPLOYEE;

    renderApp('/app/profile');
    expect(await screen.findByText('PAGE profile')).toBeInTheDocument();
  });

  it('mis tickets y reportar incidencia solo exigen sesión iniciada', async () => {
    authState.user = EMPLOYEE;

    renderApp('/app/my-tickets');
    expect(await screen.findByText('PAGE my-tickets')).toBeInTheDocument();
  });

  it('redirige a /login cuando no hay sesión', async () => {
    authState.user = null;

    renderApp('/app/categories');
    expect(await screen.findByText('PAGE login')).toBeInTheDocument();
  });

  it('redirige al dashboard si el usuario tiene dashboard.view', async () => {
    authState.user = { ...EMPLOYEE, permissions: ['dashboard.view'] };

    renderApp('/app');
    expect(await screen.findByText('PAGE dashboard')).toBeInTheDocument();
  });
});

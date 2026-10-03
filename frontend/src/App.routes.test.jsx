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
vi.mock('./pages/Knowledge', () => ({ default: () => 'PAGE knowledge' }));
vi.mock('./pages/KnowledgeDetail', () => ({ default: () => 'PAGE knowledge-detail' }));
vi.mock('./pages/KnowledgeEditor', () => ({ default: () => 'PAGE knowledge-editor' }));
vi.mock('./pages/KnowledgeAdmin', () => ({ default: () => 'PAGE knowledge-admin' }));

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
    const granted = renderApp(route);
    expect(await screen.findByText(page)).toBeInTheDocument();
    granted.unmount();

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

describe('Rutas desconocidas', () => {
  // Antes, `<Route path="*" element={<Navigate to="/app" replace />} />` mandaba
  // cualquier dirección inventada al inicio: el usuario veía su panel sin saber
  // que la ruta estaba mal, y una errata se confundía con un fallo de la
  // aplicación.

  it('una dirección inexistente muestra el 404 en vez de saltar a /app', async () => {
    renderApp('/no-existe');

    expect(await screen.findByRole('heading', { name: 'Página no encontrada' })).toBeInTheDocument();
    expect(screen.queryByText('PAGE my-tickets')).not.toBeInTheDocument();
    expect(screen.queryByText('PAGE dashboard')).not.toBeInTheDocument();
  });

  it('una dirección inexistente dentro de la aplicación también muestra el 404', async () => {
    renderApp('/app/pagina-que-no-existe');

    expect(await screen.findByRole('heading', { name: 'Página no encontrada' })).toBeInTheDocument();
    expect(screen.queryByText('PAGE my-tickets')).not.toBeInTheDocument();
  });

  it('el 404 ofrece volver al inicio, tanto con sesión como sin ella', async () => {
    const conSesion = renderApp('/no-existe');
    expect(await screen.findByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/app');
    conSesion.unmount();

    authState.user = null;
    renderApp('/no-existe');
    expect(await screen.findByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/app');
  });

  it('sin sesión, una ruta inexistente dentro de la aplicación va al login como el resto de /app', async () => {
    authState.user = null;

    renderApp('/app/pagina-que-no-existe');
    expect(await screen.findByText('PAGE login')).toBeInTheDocument();
  });

  it('el 404 no filtra si hay sesión: es la misma pantalla en ambos casos', async () => {
    const conSesion = renderApp('/no-existe');
    await screen.findByRole('heading', { name: 'Página no encontrada' });
    const textoSesion = screen.getByRole('main').textContent;
    conSesion.unmount();

    authState.user = null;
    renderApp('/no-existe');
    await screen.findByRole('heading', { name: 'Página no encontrada' });
    expect(screen.getByRole('main').textContent).toBe(textoSesion);
  });
});

describe('Permisos de las rutas de la base de conocimiento', () => {
  // kb.view consulta, kb.create redacta, kb.manage modera. Son los mismos
  // permisos que exigen GET /, POST y PATCH /:id en el backend.
  it.each([
    ['/app/knowledge', 'kb.view', 'PAGE knowledge'],
    ['/app/knowledge/5', 'kb.view', 'PAGE knowledge-detail'],
    ['/app/knowledge/new', 'kb.create', 'PAGE knowledge-editor'],
    ['/app/knowledge/5/edit', 'kb.create', 'PAGE knowledge-editor'],
    ['/app/knowledge/admin', 'kb.manage', 'PAGE knowledge-admin'],
  ])('%s se abre con %s y se redirige sin él', async (route, permission, page) => {
    authState.user = { id: 7, name: 'Lector', permissions: [permission] };

    const granted = renderApp(route);
    expect(await screen.findByText(page)).toBeInTheDocument();
    granted.unmount();

    authState.user = { id: 7, name: 'Lector', permissions: [] };
    renderApp(route);
    expect(await screen.findByText('PAGE my-tickets')).toBeInTheDocument();
    expect(screen.queryByText(page)).not.toBeInTheDocument();
  });

  it('la ruta literal "new" no se confunde con un identificador de artículo', async () => {
    authState.user = { id: 7, name: 'Autor', permissions: ['kb.view', 'kb.create'] };

    renderApp('/app/knowledge/new');
    expect(await screen.findByText('PAGE knowledge-editor')).toBeInTheDocument();
  });

  it('la administración exige kb.manage aunque se tenga kb.create', async () => {
    authState.user = { id: 7, name: 'Autor', permissions: ['kb.view', 'kb.create', 'kb.publish'] };

    renderApp('/app/knowledge/admin');
    expect(await screen.findByText('PAGE my-tickets')).toBeInTheDocument();
  });
});

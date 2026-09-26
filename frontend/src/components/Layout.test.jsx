import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import Layout from './Layout';
import { createQueryClient } from '../test/utils';

const { authState } = vi.hoisted(() => ({ authState: { user: null } }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, logout: vi.fn() }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

// El panel de notificaciones abre una conexión SSE: aquí solo interesa el menú.
vi.mock('./Notifications', () => ({ default: () => <div>NOTIFICACIONES</div> }));

const VIEWER = { id: 1, name: 'Lucía', last_name: 'Pérez', role_name: 'Técnico', permissions: ['kb.view'] };
const MANAGER = { id: 2, name: 'Ana', last_name: 'Díaz', role_name: 'Admin', permissions: ['kb.view', 'kb.manage'] };
const NONE = { id: 3, name: 'Luis', last_name: 'Gómez', role_name: 'Empleado', permissions: ['ticket.create'] };

function renderLayout(route = '/app') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/app/*" element={<Layout />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const link = (name) => screen.getAllByRole('link', { name })[0];

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = VIEWER;
});

describe('Layout · navegación de la base de conocimiento', () => {
  it('muestra "Conocimientos" a quien puede consultar la base', () => {
    renderLayout();

    expect(link('Conocimientos')).toHaveAttribute('href', '/app/knowledge');
    expect(screen.getByText('Principal')).toBeInTheDocument();
  });

  it('oculta la administración a quien solo tiene kb.view', () => {
    renderLayout();

    expect(screen.queryByRole('link', { name: 'Artículos y categorías' })).not.toBeInTheDocument();
  });

  it('muestra la administración solo con kb.manage', () => {
    authState.user = MANAGER;
    renderLayout();

    expect(link('Artículos y categorías')).toHaveAttribute('href', '/app/knowledge/admin');
    expect(link('Conocimientos')).toBeInTheDocument();
  });

  it('no muestra ninguna entrada sin permisos de conocimiento', () => {
    authState.user = NONE;
    renderLayout();

    expect(screen.queryByRole('link', { name: 'Conocimientos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Artículos y categorías' })).not.toBeInTheDocument();
  });

  it('marca la sección activa en el listado, la ficha y el editor', () => {
    authState.user = MANAGER;
    const { unmount } = renderLayout('/app/knowledge');
    expect(link('Conocimientos').className).toContain('app-nav-active');
    unmount();

    const detail = renderLayout('/app/knowledge/5');
    // La ficha pertenece a la sección Conocimientos, no a la de administración.
    expect(link('Conocimientos').className).toContain('app-nav-active');
    expect(link('Artículos y categorías').className).not.toContain('app-nav-active');
    detail.unmount();

    renderLayout('/app/knowledge/5/edit');
    expect(link('Conocimientos').className).toContain('app-nav-active');
  });

  it('marca solo la administración cuando se está administrando', () => {
    authState.user = MANAGER;
    renderLayout('/app/knowledge/admin');

    expect(link('Artículos y categorías').className).toContain('app-nav-active');
    expect(link('Conocimientos').className).not.toContain('app-nav-active');
  });

  it('titula la cabecera según la página de conocimientos', () => {
    const { unmount } = renderLayout('/app/knowledge');
    expect(screen.getByRole('heading', { level: 1, name: 'Base de conocimiento' })).toBeInTheDocument();
    unmount();

    const detail = renderLayout('/app/knowledge/5');
    expect(screen.getByRole('heading', { level: 1, name: 'Artículo' })).toBeInTheDocument();
    detail.unmount();

    renderLayout('/app/knowledge/5/edit');
    expect(screen.getByRole('heading', { level: 1, name: 'Editar artículo' })).toBeInTheDocument();
  });
});

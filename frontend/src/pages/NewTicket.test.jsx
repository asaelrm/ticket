import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import NewTicket from './NewTicket';
import { api } from '../lib/api';
import { createQueryClient, renderWithProviders } from '../test/utils';

const { authState } = vi.hoisted(() => ({
  authState: { user: null },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const USER = { id: 5, name: 'Javier', department_id: 3, department_name: 'TI', permissions: [] };

function renderWithNavigation(ui, { route }) {
  const client = createQueryClient();
  return {
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/new-ticket" element={ui} />
            <Route path="/app/my-tickets/:id" element={<p>Creación OK</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    ),
    queryClient: client,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = USER;
  api.get.mockImplementation((url) => {
    if (url === '/api/categories?active=1') return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }, { id: 2, name: 'Software' }] });
    if (url === '/api/departments?active=1') return Promise.resolve({ data: [{ id: 3, name: 'TI' }, { id: 4, name: 'Contabilidad' }] });
    return Promise.reject(new Error(`404 ${url}`));
  });
  api.post.mockResolvedValue({ ticket: { id: 42 } });
});

describe('NewTicket', () => {
  it('renderiza el formulario y preselecciona el departamento del usuario', async () => {
    renderWithProviders(<NewTicket />, { route: '/new-ticket' });

    expect(await screen.findByLabelText(/Título/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Categoría/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Prioridad/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Descripción detallada/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crear ticket' })).toBeInTheDocument();

    expect(screen.getByLabelText(/^Departamento$/)).toHaveValue('3');
    expect(screen.getByText(/Por defecto se usa su departamento \(TI\)/)).toBeInTheDocument();
  });

  it('rechaza archivos demasiado grandes sin crear el ticket', async () => {
    const { container } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
    await screen.findByLabelText(/Título/);

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [{ name: 'big.pdf', size: 6 * 1024 * 1024, type: 'application/pdf' }] } });

    expect(screen.getByRole('alert')).toHaveTextContent('Archivos demasiado grandes: big.pdf. Máximo 5 MB por archivo.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('crea el ticket con los datos del formulario y navega al detalle', async () => {
    const user = userEvent.setup();
    renderWithNavigation(<NewTicket />, { route: '/new-ticket' });

    await user.type(await screen.findByLabelText(/Título/), 'No puedo imprimir');
    await user.selectOptions(screen.getByLabelText(/Categoría/), '1');
    await user.type(screen.getByLabelText(/Descripción detallada/), 'La impresora no responde');
    await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

    expect(await screen.findByText('Creación OK')).toBeInTheDocument();

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets', null, expect.any(FormData)));
    const [, , fd] = api.post.mock.calls.find(([url]) => url === '/api/tickets');
    expect(fd.get('title')).toBe('No puedo imprimir');
    expect(fd.get('description')).toBe('La impresora no responde');
    expect(fd.get('category_id')).toBe('1');
    expect(fd.get('department_id')).toBe('3');
    expect(fd.get('priority')).toBe('MEDIUM');
  });

  it('muestra el error de la API y deja reintentar', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new Error('No se pudo crear el ticket'));

    renderWithProviders(<NewTicket />, { route: '/new-ticket' });
    await user.type(await screen.findByLabelText(/Título/), 'Sin conexión a red');
    await user.selectOptions(screen.getByLabelText(/Categoría/), '1');
    await user.type(screen.getByLabelText(/Descripción detallada/), 'No tengo internet');
    await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo crear el ticket');
    expect(screen.getByRole('button', { name: 'Crear ticket' })).toBeEnabled();
  });

  it('no restringe el acceso por permisos en el cliente', async () => {
    authState.user = { id: 5, department_id: 3, permissions: [] };

    renderWithProviders(<NewTicket />, { route: '/new-ticket' });
    expect(await screen.findByLabelText(/Título/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crear ticket' })).toBeInTheDocument();
  });
});
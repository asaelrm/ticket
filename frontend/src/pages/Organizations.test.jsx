import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import Organizations from './Organizations';
import { AuthProvider, useAuth } from '../context/AuthContext';
import * as apiModule from '../lib/api';

// Mock de api - preservar exports originales y mockear solo api
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
    },
  };
});

// Mock de AuthContext
vi.mock('../context/AuthContext', () => ({
  AuthProvider: ({ children }) => <>{children}</>,
  useAuth: vi.fn(),
}));

// Wrapper para pruebas
const createWrapper = (user = { permissions: ['organization.manage'], is_superadmin: true }) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useAuth.mockReturnValue({ user, loading: false });
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>{children}</AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
};

describe('Organizations Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renderiza LoadingScreen mientras carga', () => {
    apiModule.api.get.mockReturnValue(new Promise(() => {})); // Nunca resuelve
    render(<Organizations />, { wrapper: createWrapper() });
    expect(screen.getByText('Cargando empresas…')).toBeInTheDocument();
  });

  it('muestra la tabla de empresas cuando hay datos', async () => {
    const mockData = {
      data: [
        { id: 1, code: 'UCE', name: 'Centro Médico UCE', description: 'Org inicial', active: 1, users_count: 5, active_users_count: 3, tickets_count: 10, created_at: '2024-01-15T10:00:00.000Z' },
        { id: 2, code: 'EMPRESA2', name: 'Empresa 2', description: null, active: 1, users_count: 2, active_users_count: 2, tickets_count: 5, created_at: '2024-02-20T10:00:00.000Z' },
      ],
      page: 1,
      pages: 1,
      total: 2,
    };
    apiModule.api.get.mockResolvedValue(mockData);

    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('UCE')).toBeInTheDocument();
      expect(screen.getByText('Centro Médico UCE')).toBeInTheDocument();
      expect(screen.getByText('EMPRESA2')).toBeInTheDocument();
      expect(screen.getByText('Empresa 2')).toBeInTheDocument();
    });
  });

  it('muestra EmptyState cuando no hay empresas', async () => {
    apiModule.api.get.mockResolvedValue({ data: [], page: 1, pages: 0, total: 0 });
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Sin empresas')).toBeInTheDocument();
    });
  });

  it('muestra botón de crear empresa', async () => {
    apiModule.api.get.mockResolvedValue({ data: [], page: 1, pages: 0, total: 0 });
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Nueva empresa/i })).toBeInTheDocument();
    });
  });

  it('abre modal de creación al hacer clic en Nueva empresa', async () => {
    apiModule.api.get.mockResolvedValue({ data: [], page: 1, pages: 0, total: 0 });
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /Nueva empresa/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Nueva empresa/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/Código de empresa/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Nombre de empresa/i)).toBeInTheDocument();
    });
  });

  it('valida campos obligatorios en creación', async () => {
    apiModule.api.get.mockResolvedValue({ data: [], page: 1, pages: 0, total: 0 });
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /Nueva empresa/i }));
    });

    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /Crear empresa/i }));
    });

    // El error aparece en el modal, buscamos dentro del dialog
    await waitFor(() => {
      const dialog = screen.getByRole('dialog', { name: /Nueva empresa/i });
      expect(dialog).toHaveTextContent('El código es obligatorio');
    });
  });

  it('valida formato de código', async () => {
    apiModule.api.get.mockResolvedValue({ data: [], page: 1, pages: 0, total: 0 });
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /Nueva empresa/i }));
    });

    await waitFor(() => {
      const codeInput = screen.getByLabelText(/Código de empresa/i);
      fireEvent.change(codeInput, { target: { value: 'codigo invalido' } });
      // Llenar nombre para que no falle la validación de nombre primero
      const nameInput = screen.getByLabelText(/Nombre de empresa/i);
      fireEvent.change(nameInput, { target: { value: 'Empresa Test' } });
      fireEvent.click(screen.getByRole('button', { name: /Crear empresa/i }));
    });

    // El error de formato aparece en el modal
    await waitFor(() => {
      const dialog = screen.getByRole('dialog', { name: /Nueva empresa/i });
      expect(dialog).toHaveTextContent(/El código debe tener entre 2 y 20 caracteres/i);
    });
  });

  it('crea empresa con código válido y cierra el modal', async () => {
    apiModule.api.get.mockResolvedValue({ data: [], page: 1, pages: 0, total: 0 });
    apiModule.api.post.mockResolvedValue({ organization: { id: 3, code: 'VALID', name: 'Valida', description: '', active: 1, users_count: 0, active_users_count: 0, tickets_count: 0, created_at: '2024-03-01T10:00:00.000Z' } });
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /Nueva empresa/i }));
    });

    await waitFor(() => {
      const codeInput = screen.getByLabelText(/Código de empresa/i);
      fireEvent.change(codeInput, { target: { value: 'VALID1' } });
      const nameInput = screen.getByLabelText(/Nombre de empresa/i);
      fireEvent.change(nameInput, { target: { value: 'Empresa Válida' } });
      fireEvent.click(screen.getByRole('button', { name: /Crear empresa/i }));
    });

    // El modal debe cerrarse tras éxito
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Nueva empresa/i })).not.toBeInTheDocument();
    });
  });
});
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

// Datos de prueba para organizaciones activas
const mockOrganizations = {
  data: [
    { id: 1, code: 'UCE', name: 'Centro Médico UCE', description: 'Org inicial', active: 1, users_count: 5, active_users_count: 3, tickets_count: 10, created_at: '2024-01-15T10:00:00.000Z' },
    { id: 2, code: 'EMPRESA2', name: 'Empresa Demo', description: null, active: 1, users_count: 0, active_users_count: 0, tickets_count: 0, created_at: '2024-02-20T10:00:00.000Z' },
  ],
  page: 1,
  pages: 1,
  total: 2,
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

describe('Organizations Page · Crear administrador (SUPERADMIN)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock para organizaciones activas (para el selector en el modal de admin)
    apiModule.api.get.mockImplementation((url) => {
      if (url.startsWith('/api/organizations?perPage=100')) {
        return Promise.resolve({
          data: [
            { id: 1, code: 'UCE', name: 'Centro Médico UCE', active: 1 },
            { id: 2, code: 'EMPRESA2', name: 'Empresa Demo', active: 1 },
          ],
        });
      }
      if (url.startsWith('/api/organizations?page=')) {
        return Promise.resolve(mockOrganizations);
      }
      return Promise.reject(new Error(`404 ${url}`));
    });
    apiModule.api.post.mockResolvedValue({ user: { id: 99, username: 'admin_nuevo' } });
  });

  it('muestra botón "Crear administrador" en las acciones de cada empresa para SUPERADMIN', async () => {
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('UCE')).toBeInTheDocument();
      expect(screen.getByText('Empresa Demo')).toBeInTheDocument();
    });

    // Buscar los botones de crear administrador (icono + tooltip)
    const buttons = screen.getAllByRole('button', { name: /Crear administrador para/i });
    expect(buttons.length).toBe(2);
  });

  it('NO muestra botón "Crear administrador" para usuario no SUPERADMIN', async () => {
    const wrapperNoSuperadmin = createWrapper({ permissions: ['organization.manage'], is_superadmin: false });
    render(<Organizations />, { wrapper: wrapperNoSuperadmin });

    await waitFor(() => {
      expect(screen.getByText('UCE')).toBeInTheDocument();
    });

    const buttons = screen.queryAllByRole('button', { name: /Crear administrador para/i });
    expect(buttons.length).toBe(0);
  });

  it('abre modal "Crear administrador" al hacer clic en el botón', async () => {
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('UCE')).toBeInTheDocument();
    });

    // Hacer clic en el primer botón "Crear administrador" (para UCE)
    const buttons = screen.getAllByRole('button', { name: /Crear administrador para Centro Médico UCE/i });
    fireEvent.click(buttons[0]);

await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Crear administrador/i })).toBeInTheDocument();
      // El texto está dividido en elementos por la etiqueta <b>, usar getByText con función flexible
      const dialog = screen.getByRole('dialog', { name: /Crear administrador/i });
      expect(dialog).toHaveTextContent('Creando administrador para');
      expect(dialog).toHaveTextContent('Centro Médico UCE');
    });
  });

  it('valida campos obligatorios en creación de administrador', async () => {
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('UCE')).toBeInTheDocument();
    });

    // Hacer clic en el primer botón "Crear administrador"
    const buttons = screen.getAllByRole('button', { name: /Crear administrador para Centro Médico UCE/i });
    fireEvent.click(buttons[0]);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Crear administrador/i })).toBeInTheDocument();
    });

    // Intentar guardar sin llenar campos - usar el botón submit del formulario
    const submitButton = screen.getByRole('button', { name: /Crear administrador$/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      const dialog = screen.getByRole('dialog', { name: /Crear administrador/i });
      expect(dialog).toHaveTextContent('El nombre es obligatorio');
    });
  });

  it('valida longitud mínima de contraseña', async () => {
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('UCE')).toBeInTheDocument();
    });

    const buttons = screen.getAllByRole('button', { name: /Crear administrador para Centro Médico UCE/i });
    fireEvent.click(buttons[0]);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Crear administrador/i })).toBeInTheDocument();
    });

    // Llenar campos obligatorios pero contraseña corta
    fireEvent.change(screen.getByLabelText(/Nombre del administrador/i), { target: { value: 'Admin' } });
    fireEvent.change(screen.getByLabelText(/Apellidos del administrador/i), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText(/Usuario del administrador/i), { target: { value: 'admin_test' } });
    fireEvent.change(screen.getByLabelText(/Correo del administrador/i), { target: { value: 'admin@test.com' } });
    fireEvent.change(screen.getByLabelText(/Contraseña inicial del administrador/i), { target: { value: 'corta' } });

    const submitButton = screen.getByRole('button', { name: /Crear administrador$/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      const dialog = screen.getByRole('dialog', { name: /Crear administrador/i });
      expect(dialog).toHaveTextContent('La contraseña debe tener al menos 6 caracteres');
    });
  });

  it('crea administrador y cierra el modal', async () => {
    render(<Organizations />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('UCE')).toBeInTheDocument();
    });

    const buttons = screen.getAllByRole('button', { name: /Crear administrador para Centro Médico UCE/i });
    fireEvent.click(buttons[0]);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Crear administrador/i })).toBeInTheDocument();
    });

    // Llenar formulario completo
    fireEvent.change(screen.getByLabelText(/Nombre del administrador/i), { target: { value: 'Admin' } });
    fireEvent.change(screen.getByLabelText(/Apellidos del administrador/i), { target: { value: 'Nuevo' } });
    fireEvent.change(screen.getByLabelText(/Usuario del administrador/i), { target: { value: 'admin_nuevo' } });
    fireEvent.change(screen.getByLabelText(/Correo del administrador/i), { target: { value: 'admin_nuevo@test.com' } });
    fireEvent.change(screen.getByLabelText(/Contraseña inicial del administrador/i), { target: { value: 'Password1234!' } });

    // Seleccionar rol (solo hay uno: Administrador)
    fireEvent.click(screen.getByLabelText(/Rol \*/i));
    await waitFor(() => {
      fireEvent.click(screen.getByRole('option', { name: /Administrador/i }));
    });

    const submitButton = screen.getByRole('button', { name: /Crear administrador$/i });
    fireEvent.click(submitButton);

    // El modal debe cerrarse tras éxito
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Crear administrador/i })).not.toBeInTheDocument();
    });

    // Verificar que se llamó a la API con los datos correctos
    expect(apiModule.api.post).toHaveBeenCalledWith('/api/users', expect.objectContaining({
      name: 'Admin',
      last_name: 'Nuevo',
      username: 'admin_nuevo',
      email: 'admin_nuevo@test.com',
      password: 'Password1234!',
      role_id: 'ADMIN',
      organization_id: 1,
    }));
  });
});
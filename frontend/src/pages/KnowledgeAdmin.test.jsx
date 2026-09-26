import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KnowledgeAdmin from './KnowledgeAdmin';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

const { authState } = vi.hoisted(() => ({ authState: { user: null } }));

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

const MANAGER = { id: 4, permissions: ['kb.view', 'kb.create', 'kb.manage'] };

const MANAGE_URL = '/api/kb-articles/manage?perPage=10';
const CATEGORIES_URL = '/api/kb-categories?active=0';

const CATEGORIES = [
  { id: 1, name: 'Correo', description: 'Buzón corporativo', color: '#2563eb', active: 1, articles_count: 3 },
  { id: 2, name: 'Histórico', description: 'Legacy', color: '#64748b', active: 0, articles_count: 0 },
];

function article(overrides = {}) {
  return {
    id: 5,
    title: 'Restablecer la contraseña de Outlook',
    summary: 'Pasos para recuperar el acceso.',
    keywords: 'correo',
    status: 'PUBLISHED',
    category_id: 1,
    author_id: 2,
    author_name: 'Ana Díaz',
    is_featured: false,
    view_count: 12,
    published_at: '2026-09-20T10:00:00Z',
    created_at: '2026-09-19T10:00:00Z',
    updated_at: '2026-09-20T10:00:00Z',
    category_name: 'Correo',
    category_color: '#2563eb',
    ...overrides,
  };
}

function setup(articles, categories = CATEGORIES) {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/kb-articles/manage')) {
      return Promise.resolve({ data: articles, total: articles.length, page: 1, perPage: 10, pages: 1 });
    }
    if (url === CATEGORIES_URL) return Promise.resolve({ data: categories });
    return Promise.reject(new Error(`404 ${url}`));
  });
}

function rowFor(title) {
  return screen.getByText(title).closest('tr');
}

function cardFor(name) {
  return screen.getByText(name).closest('.card');
}

// El orden de los parámetros no es parte del contrato: se comparan como mapa.
function lastManageQuery() {
  const calls = api.get.mock.calls.filter(([url]) => url.startsWith('/api/kb-articles/manage'));
  const url = calls[calls.length - 1][0];
  return Object.fromEntries(new URLSearchParams(url.split('?')[1]));
}

function manageCalls() {
  return api.get.mock.calls.filter(([url]) => url.startsWith('/api/kb-articles/manage'));
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = MANAGER;
  setup([article(), article({ id: 6, title: 'Borrador sin publicar', status: 'DRAFT', author_name: 'Luis Pérez', view_count: 0 })]);
  api.post.mockResolvedValue({ article: article() });
  api.patch.mockResolvedValue({ category: CATEGORIES[0] });
});

describe('KnowledgeAdmin · moderación de artículos', () => {
  it('lista los artículos de cualquier autor con su estado', async () => {
    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });

    const row = await screen.findByRole('row', { name: /Restablecer la contraseña/ });
    expect(within(row).getByText('Ana Díaz')).toBeInTheDocument();
    expect(within(row).getByText('Publicado')).toBeInTheDocument();
    expect(within(row).getByText('12')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Borrador sin publicar/ })).toBeInTheDocument();
    expect(within(rowFor('Borrador sin publicar')).getByText('Borrador')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(MANAGE_URL);
  });

  it('filtra por estado y vuelve a consultar el listado de gestión', async () => {
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    await screen.findByRole('row', { name: /Restablecer la contraseña/ });

    const before = manageCalls().length;
    await user.selectOptions(screen.getByLabelText('Filtrar por estado'), 'DRAFT');

    await waitFor(() => expect(lastManageQuery()).toEqual({ perPage: '10', status: 'DRAFT' }));
    expect(manageCalls().length).toBeGreaterThan(before);
  });

  it('filtra por categoría mostrando también las desactivadas', async () => {
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    await screen.findByRole('row', { name: /Restablecer la contraseña/ });

    const select = screen.getByLabelText('Filtrar por categoría');
    await waitFor(() => expect(select.options).toHaveLength(3));
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Todas las categorías',
      'Correo',
      'Histórico (inactiva)',
    ]);

    await user.selectOptions(select, '2');
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/kb-articles/manage?category=2&perPage=10')
    );
  });

  it('confirma y despublica un artículo publicado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    await screen.findByRole('row', { name: /Restablecer la contraseña/ });

    await user.click(within(rowFor('Restablecer la contraseña de Outlook')).getByRole('button', { name: 'Despublicar' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.post).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Despublicar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/kb-articles/5/unpublish'));
  });

  it('publica y archiva borradores con confirmación', async () => {
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    const row = await screen.findByRole('row', { name: /Borrador sin publicar/ });

    await user.click(within(row).getByRole('button', { name: 'Publicar' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publicar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/kb-articles/6/publish'));

    await user.click(within(row).getByRole('button', { name: 'Archivar' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archivar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/kb-articles/6/archive'));
  });

  it('cambia el destacado sin confirmación y refresca el listado', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    await screen.findByRole('row', { name: /Restablecer la contraseña/ });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(within(rowFor('Restablecer la contraseña de Outlook')).getByRole('button', { name: 'Destacar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/kb-articles/5/feature'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['kb-manage'] });
  });

  it('etiqueta la acción de destacado según el estado del artículo', async () => {
    setup([article({ is_featured: true })]);

    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    expect(await screen.findByRole('button', { name: 'Quitar destacado' })).toBeInTheDocument();
  });

  it('un artículo archivado no ofrece archivar de nuevo', async () => {
    setup([article({ status: 'ARCHIVED' })]);

    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    const row = await screen.findByRole('row', { name: /Restablecer la contraseña/ });
    expect(within(row).getByRole('button', { name: 'Publicar' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Archivar' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Despublicar' })).not.toBeInTheDocument();
  });

  it('muestra el error si el servidor rechaza la transición', async () => {
    api.post.mockRejectedValue(new Error('Ya tienes un artículo con ese título'));
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    const row = await screen.findByRole('row', { name: /Borrador sin publicar/ });

    await user.click(within(row).getByRole('button', { name: 'Publicar' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publicar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ya tienes un artículo con ese título');
  });

  it('muestra el error y el estado vacío del listado de gestión', async () => {
    api.get.mockImplementation((url) =>
      url.startsWith('/api/kb-articles/manage')
        ? Promise.reject(new Error('No se pudo cargar el listado'))
        : Promise.resolve({ data: CATEGORIES })
    );
    const { unmount } = renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar el listado');
    unmount();

    setup([]);
    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    expect(await screen.findByText('No hay artículos que coincidan')).toBeInTheDocument();
  });
});

describe('KnowledgeAdmin · categorías', () => {
  async function openTab() {
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    await screen.findByRole('row', { name: /Restablecer la contraseña/ });
    await user.click(screen.getByRole('tab', { name: 'Categorías' }));
    return user;
  }

  it('lista las categorías activas e inactivas con su conteo de artículos', async () => {
    await openTab();

    expect(await screen.findByText('Correo')).toBeInTheDocument();
    expect(screen.getByText('3 artículos publicados')).toBeInTheDocument();
    expect(screen.getByText('0 artículos publicados')).toBeInTheDocument();
    expect(screen.getByText('Legacy')).toBeInTheDocument();
    expect(screen.getByText(/inactiva/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(CATEGORIES_URL);
  });

  it('filtra con la casilla "Solo activas"', async () => {
    const user = await openTab();
    await screen.findByText('Histórico');

    await user.click(screen.getByRole('checkbox', { name: 'Solo activas' }));

    expect(screen.queryByText('Histórico')).not.toBeInTheDocument();
    expect(screen.getByText('Correo')).toBeInTheDocument();
  });

  it('crea una categoría con POST', async () => {
    const user = await openTab();
    await screen.findByText('Correo');

    await user.click(screen.getByRole('button', { name: '+ Nueva categoría' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva categoría' });
    await user.type(within(dialog).getByLabelText('Nombre *'), 'Impresoras');
    await user.type(within(dialog).getByLabelText('Descripción'), 'Colas y drivers');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/kb-categories', {
        name: 'Impresoras',
        description: 'Colas y drivers',
        color: '#64748b',
      })
    );
  });

  it('exige el nombre antes de llamar a la API', async () => {
    const user = await openTab();
    await screen.findByText('Correo');

    await user.click(screen.getByRole('button', { name: '+ Nueva categoría' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva categoría' });
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nombre es obligatorio');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('edita una categoría conservando su estado activo', async () => {
    const user = await openTab();
    await screen.findByText('Correo');

    await user.click(screen.getByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar categoría' });
    expect(within(dialog).getByLabelText('Nombre *')).toHaveValue('Correo');

    await user.clear(within(dialog).getByLabelText('Nombre *'));
    await user.type(within(dialog).getByLabelText('Nombre *'), 'Correo y Outlook');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/kb-categories/1', {
        name: 'Correo y Outlook',
        description: 'Buzón corporativo',
        color: '#2563eb',
        active: 1,
      })
    );
  });

  it('cancela el formulario sin enviar nada', async () => {
    const user = await openTab();
    await screen.findByText('Correo');

    await user.click(screen.getByRole('button', { name: '+ Nueva categoría' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva categoría' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nueva categoría' })).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('desactiva y reactiva con el interruptor usando PATCH parcial', async () => {
    const user = await openTab();
    const toggle = await screen.findByRole('switch', { name: 'Correo' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/kb-categories/1', { active: false }));

    await user.click(await screen.findByRole('switch', { name: 'Histórico' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/kb-categories/2', { active: true }));
  });

  it('muestra el error del servidor al guardar o activar', async () => {
    api.patch.mockRejectedValue(new Error('Ya existe una categoría con ese nombre'));
    const user = await openTab();

    await user.click(await screen.findByRole('switch', { name: 'Correo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya existe una categoría con ese nombre');
  });

  it('explica que no hay borrado de categorías', async () => {
    await openTab();

    expect(await screen.findByText(/No hay borrado de categorías/)).toBeInTheDocument();
  });

  it('muestra el estado vacío y el error de carga de categorías', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) =>
      url.startsWith('/api/kb-articles/manage')
        ? Promise.resolve({ data: [article()], total: 1, page: 1, perPage: 10, pages: 1 })
        : Promise.reject(new Error('No se pudieron cargar las categorías'))
    );
    const { unmount } = renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    await screen.findByRole('row', { name: /Restablecer la contraseña/ });
    await user.click(screen.getByRole('tab', { name: 'Categorías' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar las categorías');
    unmount();

    setup([article()], []);
    renderWithProviders(<KnowledgeAdmin />, { route: '/app/knowledge/admin' });
    await user.click(await screen.findByRole('tab', { name: 'Categorías' }));
    expect(await screen.findByText('Sin categorías')).toBeInTheDocument();
  });
});

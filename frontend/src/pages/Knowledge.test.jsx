import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Knowledge from './Knowledge';
import { api } from '../lib/api';
import { renderWithProviders, pickOption } from '../test/utils';

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

const READER = { id: 1, permissions: ['kb.view'] };
const AUTHOR = { id: 2, permissions: ['kb.view', 'kb.create', 'kb.publish'] };

const CATEGORIES = [
  { id: 1, name: 'Correo', color: '#2563eb', active: 1, articles_count: 3 },
  { id: 2, name: 'Redes', color: '#059669', active: 1, articles_count: 1 },
];

function summary(overrides = {}) {
  return {
    id: 5,
    title: 'Restablecer la contraseña de Outlook',
    summary: 'Pasos para recuperar el acceso al correo corporativo.',
    keywords: 'correo, contraseña',
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

function list(overrides = {}) {
  return { data: [summary()], total: 1, page: 1, perPage: 10, pages: 1, ...overrides };
}

const LIST_URL = '/api/kb-articles?perPage=10';

function listCalls() {
  return api.get.mock.calls.filter(([url]) => url.startsWith('/api/kb-articles?'));
}

function setup(articles = list()) {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/kb-articles')) return Promise.resolve(articles);
    if (url === '/api/kb-categories') return Promise.resolve({ data: CATEGORIES });
    return Promise.reject(new Error(`404 ${url}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = READER;
  setup();
});

describe('Knowledge · listado', () => {
  it('muestra la pantalla de carga mientras responde la API', () => {
    api.get.mockImplementation((url) =>
      url.startsWith('/api/kb-articles') ? new Promise(() => {}) : Promise.resolve({ data: CATEGORIES })
    );

    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    expect(screen.getByText('Cargando artículos…')).toBeInTheDocument();
  });

  it('lista los artículos publicados con su categoría, autor y consultas', async () => {
    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });

    const card = await screen.findByRole('link', { name: /Restablecer la contraseña de Outlook/ });
    expect(within(card).getByText('Pasos para recuperar el acceso al correo corporativo.')).toBeInTheDocument();
    // 'Correo' también es una opción del filtro, así que se busca dentro de la tarjeta.
    expect(within(card).getByText('Correo')).toBeInTheDocument();
    expect(within(card).getByText('Ana Díaz')).toBeInTheDocument();
    expect(within(card).getByText('12 consultas')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(LIST_URL);
  });

  it('marca los artículos destacados', async () => {
    setup(list({ data: [summary({ is_featured: true })] }));

    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    expect(await screen.findByText('Destacado')).toBeInTheDocument();
  });

  it('singulariza el contador de una sola consulta', async () => {
    setup(list({ data: [summary({ view_count: 1 })] }));

    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    expect(await screen.findByText('1 consulta')).toBeInTheDocument();
  });

  it('muestra el error devuelto por la API', async () => {
    api.get.mockImplementation((url) =>
      url.startsWith('/api/kb-articles')
        ? Promise.reject(new Error('No se pudo cargar la base de conocimiento'))
        : Promise.resolve({ data: CATEGORIES })
    );

    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar la base de conocimiento');
  });

  it('distingue el estado vacío con y sin filtros', async () => {
    setup(list({ data: [], total: 0, pages: 0 }));

    const user = userEvent.setup();
    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });

    expect(await screen.findByText('Todavía no hay artículos publicados')).toBeInTheDocument();
    expect(screen.queryByText('Ningún artículo coincide con la búsqueda')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Buscar artículos'), 'vpn');

    expect(await screen.findByText('Ningún artículo coincide con la búsqueda')).toBeInTheDocument();
    expect(screen.queryByText('Todavía no hay artículos publicados')).not.toBeInTheDocument();
  });

  it('invita a documentar el primer artículo solo a quien puede crearlos', async () => {
    setup(list({ data: [], total: 0, pages: 0 }));

    const { unmount } = renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    expect(await screen.findByText('Todavía no hay artículos publicados')).toBeInTheDocument();
    expect(screen.getByText(/Vuelva más tarde/)).toBeInTheDocument();
    unmount();

    authState.user = AUTHOR;
    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    expect(await screen.findByText(/Documente la primera solución/)).toBeInTheDocument();
  });
});

describe('Knowledge · filtros y paginación', () => {
  it('escribe la búsqueda en la URL y vuelve a pedir los artículos', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    await screen.findByText('Restablecer la contraseña de Outlook');

    await user.type(screen.getByLabelText('Buscar artículos'), 'outlook');

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/kb-articles?q=outlook&perPage=10')
    );
  });

  it('filtra por categoría y limpia los filtros aplicados', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Knowledge />, { route: '/app/knowledge?q=outlook&category=1' });

    await screen.findByText('Restablecer la contraseña de Outlook');
    expect(screen.getByLabelText('Filtrar por categoría')).toHaveTextContent('Correo');
    expect(screen.getByText('1 artículo encontrado')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(LIST_URL));
  });

  it('ofrece los tres órdenes del servidor', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    await screen.findByText('Restablecer la contraseña de Outlook');

    const select = screen.getByLabelText('Ordenar artículos');
    expect(select).toHaveTextContent('Más recientes');
    await user.click(select);
    const listbox = within(screen.getByRole('listbox'));
    expect(listbox.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Más recientes',
      'Más consultados',
      'Título (A-Z)',
    ]);

    await user.click(listbox.getByRole('option', { name: 'Título (A-Z)' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/kb-articles?sort=title&perPage=10'));
  });

  it('muestra los controles de página solo si hay más de una', async () => {
    setup(list({ data: [summary()], total: 34, pages: 4, page: 2 }));
    const user = userEvent.setup();
    renderWithProviders(<Knowledge />, { route: '/app/knowledge?page=2' });

    await screen.findByText('Restablecer la contraseña de Outlook');
    expect(screen.getByText('11–20 de 34 · Página 2 de 4')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Siguiente/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/kb-articles?page=3&perPage=10'));
  });

  it('vuelve a la primera página al cambiar un filtro', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Knowledge />, { route: '/app/knowledge?page=3' });
    await screen.findByText('Restablecer la contraseña de Outlook');

    const before = listCalls().length;
    await pickOption(user, screen.getByLabelText('Ordenar artículos'), 'Más consultados');

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/kb-articles?sort=popular&perPage=10')
    );
    expect(listCalls().length).toBeGreaterThan(before);
  });

  it('cambia el número de registros por página', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    await screen.findByText('Restablecer la contraseña de Outlook');

    await pickOption(user, screen.getByLabelText(/Mostrar/), '25');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/kb-articles?perPage=25'));
  });

  it('el número de registros llega como número a la URL, no como texto', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Knowledge />, { route: '/app/knowledge?page=3' });
    await screen.findByText('Restablecer la contraseña de Outlook');

    // `Pagination` es el único punto que reconvierte a número: el resto de
    // selectores debe seguir enviando cadenas, como el `value` del nativo.
    // Aquí importa porque `parseFilters` valida el perPage contra los tamaños
    // permitidos comparando con `Number(v)`.
    const show = screen.getByLabelText(/Mostrar/);
    expect(show).toHaveTextContent('10');
    await pickOption(user, show, '100');

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/kb-articles?perPage=100'));
  });
});

describe('Knowledge · acceso', () => {
  it('enlaza al botón de crear artículo solo con kb.create', async () => {
    const { unmount } = renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    await screen.findByText('Restablecer la contraseña de Outlook');
    expect(screen.queryByRole('link', { name: /Nuevo artículo/ })).not.toBeInTheDocument();
    unmount();

    authState.user = AUTHOR;
    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });
    expect(await screen.findByRole('link', { name: /Nuevo artículo/ })).toHaveAttribute(
      'href',
      '/app/knowledge/new'
    );
  });

  it('enlaza cada tarjeta a su ficha', async () => {
    renderWithProviders(<Knowledge />, { route: '/app/knowledge' });

    const link = await screen.findByRole('link', { name: /Restablecer la contraseña de Outlook/ });
    expect(link).toHaveAttribute('href', '/app/knowledge/5');
  });
});

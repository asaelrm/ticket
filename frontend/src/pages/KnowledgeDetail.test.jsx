import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KnowledgeDetail from './KnowledgeDetail';
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

const READER = { id: 1, permissions: ['kb.view'] };
const AUTHOR = { id: 2, permissions: ['kb.view', 'kb.create', 'kb.publish'] };
const COLLEAGUE = { id: 3, permissions: ['kb.view', 'kb.create'] };
const MANAGER = { id: 4, permissions: ['kb.view', 'kb.create', 'kb.manage'] };

const DETAIL_URL = '/api/kb-articles/5';

function article(overrides = {}) {
  return {
    id: 5,
    title: 'Restablecer la contraseña de Outlook',
    summary: 'Pasos para recuperar el acceso al correo corporativo.',
    description: 'El usuario no consigue entrar a su buzón.',
    solution: '1. Abrir la intranet\n2. Pulsar «Olvidé mi contraseña»\n3. Revisar el correo de reserva',
    keywords: 'correo, contraseña, outlook',
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

function setup(data = { article: article() }) {
  api.get.mockImplementation((url) =>
    url === DETAIL_URL ? Promise.resolve(data) : Promise.reject(new Error(`404 ${url}`))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = READER;
  setup();
  api.post.mockResolvedValue({ article: article() });
});

describe('KnowledgeDetail · lectura', () => {
  it('muestra la pantalla de carga mientras responde la API', () => {
    api.get.mockImplementation(() => new Promise(() => {}));

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });
    expect(screen.getByText('Cargando artículo…')).toBeInTheDocument();
  });

  it('pinta el título, el resumen y los metadatos del artículo', async () => {
    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    expect(
      await screen.findByRole('heading', { name: 'Restablecer la contraseña de Outlook', level: 1 })
    ).toBeInTheDocument();
    expect(screen.getByText('Pasos para recuperar el acceso al correo corporativo.')).toBeInTheDocument();
    expect(screen.getByText('Ana Díaz')).toBeInTheDocument();
    expect(screen.getByText('Publicado')).toBeInTheDocument();
    expect(screen.getByText('Correo')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('convierte el Markdown de descripción y solución sin ejecutar el HTML', async () => {
    setup({
      article: article({
        description: '## Síntomas\nEl usuario ve **un aviso**.',
        solution: '<img src=x onerror="alert(1)">\n<script>alert(2)</script>',
      }),
    });

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    const description = await screen.findByTestId('article-description');
    expect(description.querySelector('h2')).toHaveTextContent('Síntomas');
    expect(description.querySelector('strong')).toHaveTextContent('un aviso');

    // El contenido llega escapado dentro de un <p>: no se crea ningún nodo.
    const solution = screen.getByTestId('article-solution');
    expect(solution.querySelector('img')).toBeNull();
    expect(solution.querySelector('script')).toBeNull();
    expect(solution.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('lista las palabras clave como etiquetas', async () => {
    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });
    expect(screen.getByText('Palabras clave:')).toBeInTheDocument();
    expect(screen.getByText('correo')).toBeInTheDocument();
    expect(screen.getByText('outlook')).toBeInTheDocument();
  });

  it('trata el 404 de un borrador ajeno como un artículo inexistente', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('Artículo no encontrado'), { status: 404 }));

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    expect(await screen.findByRole('alert')).toHaveTextContent('Artículo no encontrado');
    // El mensaje no debe revelar que existe un borrador.
    expect(screen.getByRole('link', { name: /Volver a la base de conocimiento/ })).toBeInTheDocument();
  });

  it('avisa de que un borrador no es visible para el resto del equipo', async () => {
    authState.user = AUTHOR;
    setup({ article: article({ status: 'DRAFT', published_at: null, is_featured: false }) });

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    expect(await screen.findByText(/Este artículo es un borrador/)).toBeInTheDocument();
    expect(screen.getByText('Borrador')).toBeInTheDocument();
  });
});

describe('KnowledgeDetail · permisos', () => {
  it('un lector sin kb.create no ve ni editar ni transiciones', async () => {
    setup({ article: article({ author_id: 1 }) });

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });
    expect(screen.queryByRole('link', { name: 'Editar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Volver a borrador' })).not.toBeInTheDocument();
  });

  it('un compañero que no es el autor no puede ni editar ni publicar', async () => {
    authState.user = COLLEAGUE;
    setup({ article: article({ author_id: 2 }) });

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });
    expect(screen.queryByRole('link', { name: 'Editar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Volver a borrador' })).not.toBeInTheDocument();
  });

  it('el autor ve editar y puede despublicar o archivar su artículo', async () => {
    authState.user = AUTHOR;
    setup({ article: article({ author_id: 2 }) });

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });
    expect(screen.getByRole('link', { name: 'Editar' })).toHaveAttribute('href', '/app/knowledge/5/edit');
    expect(screen.getByRole('button', { name: 'Volver a borrador' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeInTheDocument();
  });

  it('un gestor modera el artículo de otro autor', async () => {
    authState.user = MANAGER;
    setup({ article: article({ author_id: 99 }) });

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });
    expect(screen.getByRole('link', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver a borrador' })).toBeInTheDocument();
  });

  it('el autor sin kb.publish no ve los botones de estado', async () => {
    authState.user = { id: 2, permissions: ['kb.view', 'kb.create'] };
    setup({ article: article({ author_id: 2, status: 'DRAFT' }) });

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });

    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });
    expect(screen.getByRole('link', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publicar' })).not.toBeInTheDocument();
  });
});

describe('KnowledgeDetail · transiciones', () => {
  it('exige confirmación antes de despublicar y avisa de la visibilidad', async () => {
    authState.user = AUTHOR;
    setup({ article: article({ author_id: 2 }) });
    const user = userEvent.setup();

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });
    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });

    await user.click(screen.getByRole('button', { name: 'Volver a borrador' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/seguirá visible|volverá a ser visible/i)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Volver a borrador' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/kb-articles/5/unpublish'));
  });

  it('confirma el archivado y lo ejecuta', async () => {
    authState.user = AUTHOR;
    setup({ article: article({ author_id: 2 }) });
    const user = userEvent.setup();

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });
    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });

    await user.click(screen.getByRole('button', { name: 'Archivar' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archivar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/kb-articles/5/archive'));
  });

  it('cambia el destacado sin pedir confirmación', async () => {
    authState.user = AUTHOR;
    setup({ article: article({ author_id: 2 }) });
    const user = userEvent.setup();

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });
    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });

    await user.click(screen.getByRole('button', { name: 'Destacar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/kb-articles/5/feature'));
  });

  it('publica un borrador con la confirmación que explica quién lo verá', async () => {
    authState.user = AUTHOR;
    setup({ article: article({ author_id: 2, status: 'DRAFT', published_at: null }) });
    const user = userEvent.setup();

    renderWithProviders(<KnowledgeDetail />, { path: '/app/knowledge/:id', route: '/app/knowledge/5' });
    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });

    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/visible para todos/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Publicar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/kb-articles/5/publish'));
  });

  it('muestra el error si la transición es rechazada y refresca la ficha al aceptarla', async () => {
    authState.user = AUTHOR;
    setup({ article: article({ author_id: 2 }) });
    const { queryClient } = renderWithProviders(<KnowledgeDetail />, {
      path: '/app/knowledge/:id',
      route: '/app/knowledge/5',
    });
    await screen.findByRole('heading', { name: /Restablecer la contraseña/ });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    api.post.mockRejectedValueOnce(new Error('El artículo está en estado DRAFT y no admite esta acción'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Destacar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no admite esta acción');

    api.post.mockResolvedValueOnce({ article: article() });
    await user.click(screen.getByRole('button', { name: 'Destacar' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['kb-article', '5'] }));
  });
});

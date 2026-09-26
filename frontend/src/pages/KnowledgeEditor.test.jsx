import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import KnowledgeEditor from './KnowledgeEditor';
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

const AUTHOR = { id: 2, name: 'Ana', permissions: ['kb.view', 'kb.create', 'kb.publish'] };
const MANAGER = { id: 4, permissions: ['kb.view', 'kb.create', 'kb.manage'] };

const CATEGORIES_URL = '/api/kb-categories';
const DETAIL_URL = '/api/kb-articles/5';

const CATEGORIES = [
  { id: 1, name: 'Correo', color: '#2563eb', active: 1, articles_count: 3 },
  { id: 2, name: 'Redes', color: '#059669', active: 1, articles_count: 1 },
];

function article(overrides = {}) {
  return {
    id: 5,
    title: 'Restablecer la contraseña de Outlook',
    summary: 'Pasos para recuperar el acceso al correo corporativo.',
    description: 'El usuario no consigue entrar a su buzón.',
    solution: '1. Abrir la intranet\n2. Pulsar «Olvidé mi contraseña»',
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

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="location">{`${pathname}${search}`}</p>;
}

function renderEditor(route, existing) {
  return renderWithProviders(
    <>
      <KnowledgeEditor />
      <LocationProbe />
    </>,
    { path: '/app/knowledge/:id/edit', route }
  );
}

function setupCategories(extra = {}) {
  api.get.mockImplementation((url) => {
    if (url === CATEGORIES_URL) return Promise.resolve({ data: CATEGORIES, ...extra });
    if (url === DETAIL_URL) return Promise.resolve({ article: article(extra) });
    return Promise.reject(new Error(`404 ${url}`));
  });
}

const field = (label) => screen.getByLabelText(label);

async function fillValid(user) {
  await user.type(field('Título *'), 'Error de impresión en la reception');
  await user.type(field('Resumen *'), 'La impresora no responde desde la estación 3.');
  await user.type(field('Descripción *'), 'Ocurre tras el cambio de red.');
  await user.type(field('Solución *'), '1. Reiniciar el spooler');
  await user.type(field('Palabras clave'), 'impresora, red');
  await user.selectOptions(field('Categoría'), '2');
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = AUTHOR;
  setupCategories();
  api.post.mockResolvedValue({ article: article({ id: 9, status: 'DRAFT' }) });
  api.patch.mockResolvedValue({ article: article() });
});

describe('KnowledgeEditor · creación', () => {
  it('renderiza el formulario vacío con los contadores de longitud', async () => {
    renderEditor('/app/knowledge/new');

    expect(screen.getByRole('heading', { name: 'Nuevo artículo' })).toBeInTheDocument();
    await waitFor(() => expect(field('Título *')).toHaveValue(''));
    expect(field('Título *')).toHaveAttribute('maxlength', '200');
    expect(field('Resumen *')).toHaveAttribute('maxlength', '500');
    expect(field('Descripción *')).toHaveAttribute('maxlength', '20000');
    expect(field('Solución *')).toHaveAttribute('maxlength', '20000');
    expect(field('Palabras clave')).toHaveAttribute('maxlength', '200');
  });

  it('ofrece las categorías activas del servidor', async () => {
    renderEditor('/app/knowledge/new');

    const select = await screen.findByLabelText('Categoría');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Sin categoría',
      'Correo',
      'Redes',
    ]);
  });

  it('exige título, resumen, descripción y solución antes de llamar a la API', async () => {
    const user = userEvent.setup();
    renderEditor('/app/knowledge/new');

    await user.click(await screen.findByRole('button', { name: /Guardar borrador/ }));

    expect(await screen.findByText('El título es obligatorio')).toBeInTheDocument();
    expect(screen.getByText('El resumen es obligatorio')).toBeInTheDocument();
    expect(screen.getByText('La descripción es obligatoria')).toBeInTheDocument();
    expect(screen.getByText('La solución es obligatoria')).toBeInTheDocument();
    expect(screen.getByText('Revise los campos marcados antes de guardar.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    // Los campos con error quedan descritos por su mensaje para lectores de pantalla.
    expect(field('Título *')).toHaveAttribute('aria-invalid', 'true');
  });

  it('no cuenta como vacío un texto solo con espacios', async () => {
    const user = userEvent.setup();
    renderEditor('/app/knowledge/new');

    await user.type(await screen.findByLabelText('Título *'), '   ');
    await user.click(screen.getByRole('button', { name: /Guardar borrador/ }));

    expect(await screen.findByText('El título es obligatorio')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('envía solo los seis campos editoriales y navega a la ficha del borrador', async () => {
    const user = userEvent.setup();
    renderEditor('/app/knowledge/new');

    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /Guardar borrador/ }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/kb-articles', {
        title: 'Error de impresión en la reception',
        summary: 'La impresora no responde desde la estación 3.',
        description: 'Ocurre tras el cambio de red.',
        solution: '1. Reiniciar el spooler',
        keywords: 'impresora, red',
        category_id: 2,
      })
    );
    // Nunca se envían status, author_id ni view_count: el estado sale del servidor.
    const body = api.post.mock.calls[0][1];
    expect(Object.keys(body).sort()).toEqual([
      'category_id',
      'description',
      'keywords',
      'solution',
      'summary',
      'title',
    ]);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/app/knowledge/9'));
  });

  it('envía category_id null cuando no se elige categoría', async () => {
    const user = userEvent.setup();
    renderEditor('/app/knowledge/new');

    await fillValid(user);
    await user.selectOptions(screen.getByLabelText('Categoría'), '');
    await user.click(screen.getByRole('button', { name: /Guardar borrador/ }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/api/kb-articles',
        expect.objectContaining({ category_id: null })
      )
    );
  });

  it('coloca el error del servidor junto al campo que corresponde', async () => {
    api.post.mockRejectedValue(
      Object.assign(new Error('Datos inválidos'), {
        fields: { 'El resumen': 'El resumen no debe exceder 500 caracteres' },
      })
    );
    const user = userEvent.setup();
    renderEditor('/app/knowledge/new');

    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /Guardar borrador/ }));

    expect(await screen.findByText('El resumen no debe exceder 500 caracteres')).toBeInTheDocument();
    expect(field('Resumen *')).toHaveAttribute('aria-invalid', 'true');
  });

  it('muestra el error de la API y mantiene el formulario', async () => {
    api.post.mockRejectedValue(new Error('Ya tienes un artículo con ese título'));
    const user = userEvent.setup();
    renderEditor('/app/knowledge/new');

    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /Guardar borrador/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ya tienes un artículo con ese título');
    expect(screen.getByTestId('location')).toHaveTextContent('/app/knowledge/new');
  });

  it('el error de un campo desaparece al corregirlo', async () => {
    api.post.mockRejectedValue(
      Object.assign(new Error('Datos inválidos'), { fields: { 'El título': 'El título es obligatorio' } })
    );
    const user = userEvent.setup();
    renderEditor('/app/knowledge/new');

    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /Guardar borrador/ }));
    expect(await screen.findByText('El título es obligatorio')).toBeInTheDocument();

    await user.type(field('Título *'), 'X');
    expect(screen.queryByText('El título es obligatorio')).not.toBeInTheDocument();
  });

  it('previsualiza el Markdown escapando el HTML del usuario', async () => {
    const user = userEvent.setup();
    renderEditor('/app/knowledge/new');

    await user.type(await screen.findByLabelText('Solución *'), '## Pasos\n- uno\n<img src=x onerror=alert(1)>');
    await user.click(screen.getByRole('button', { name: 'Mostrar' }));

    const preview = screen.getByTestId('preview-solution');
    expect(preview.querySelector('h2')).toHaveTextContent('Pasos');
    expect(preview.querySelector('li')).toHaveTextContent('uno');
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('KnowledgeEditor · edición', () => {
  it('carga el artículo y lo guarda con PATCH', async () => {
    const user = userEvent.setup();
    renderEditor('/app/knowledge/5/edit');

    await waitFor(() => expect(field('Título *')).toHaveValue('Restablecer la contraseña de Outlook'));
    expect(field('Categoría')).toHaveValue('1');
    expect(field('Palabras clave')).toHaveValue('correo, contraseña');
    expect(screen.getByText('Publicado')).toBeInTheDocument();

    await user.clear(field('Resumen *'));
    await user.type(field('Resumen *'), 'Resumen revisado.');
    await user.click(screen.getByRole('button', { name: /Guardar cambios/ }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/kb-articles/5',
        expect.objectContaining({ summary: 'Resumen revisado.', title: 'Restablecer la contraseña de Outlook' })
      )
    );
  });

  it('aclara que guardar no despublica un artículo ya publicado', async () => {
    renderEditor('/app/knowledge/5/edit');

    expect(await screen.findByText(/Guardar los cambios no lo despublica/)).toBeInTheDocument();
  });

  it('cancela sin enviar nada', async () => {
    const user = userEvent.setup();
    renderEditor('/app/knowledge/5/edit');
    await waitFor(() => expect(field('Título *')).toHaveValue('Restablecer la contraseña de Outlook'));

    await user.click(screen.getByRole('link', { name: 'Cancelar' }));

    expect(api.patch).not.toHaveBeenCalled();
  });

  it('no ofrece editar el artículo de otro autor si no se administra la base', async () => {
    authState.user = { id: 9, permissions: ['kb.view', 'kb.create'] };
    renderEditor('/app/knowledge/5/edit');

    expect(await screen.findByText('No tiene permiso para editar este artículo')).toBeInTheDocument();
    expect(screen.queryByLabelText('Título *')).not.toBeInTheDocument();
  });

  it('un gestor sí puede editar el artículo de otro autor', async () => {
    authState.user = MANAGER;
    setupCategories();
    renderEditor('/app/knowledge/5/edit');

    await waitFor(() => expect(field('Título *')).toHaveValue('Restablecer la contraseña de Outlook'));
  });

  it('muestra el error y un enlace de vuelta si el artículo no existe', async () => {
    api.get.mockImplementation((url) =>
      url === CATEGORIES_URL ? Promise.resolve({ data: CATEGORIES }) : Promise.reject(new Error('Artículo no encontrado'))
    );

    renderEditor('/app/knowledge/5/edit');

    expect(await screen.findByText('Artículo no encontrado')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Volver a la base de conocimiento/ })).toBeInTheDocument();
  });

  it('incluye la categoría desactivada del artículo para poder conservarla', async () => {
    api.get.mockImplementation((url) =>
      url === CATEGORIES_URL
        ? Promise.resolve({ data: [CATEGORIES[1]] })
        : Promise.resolve({
            article: article({ category_id: 7, category_name: 'Histórico', category_color: '#64748b' }),
          })
    );

    renderEditor('/app/knowledge/5/edit');

    // Sin esta opción, el <select> quedaría sin nada seleccionado y al guardar se
    // enviaría un id que el servidor rechaza.
    await waitFor(() => expect(field('Categoría')).toHaveValue('7'));
    expect([...field('Categoría').options].map((o) => o.textContent)).toEqual([
      'Sin categoría',
      'Redes',
      'Histórico (desactivada)',
    ]);
  });
});

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MyTemplates from './MyTemplates';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});

const MINE_URL = '/api/canned-responses/mine';

const MINE = [
  {
    id: 5,
    title: 'Saludo inicial',
    body: 'Hola {{reporter_name}}, revisamos su ticket {{ticket_number}}.',
    scope: 'PERSONAL',
    owner_id: 7,
    team_id: null,
    is_active: 1,
    use_count: 12,
  },
  {
    id: 6,
    title: 'Cierre de caso',
    body: 'Se resolutionó el caso.',
    scope: 'PERSONAL',
    owner_id: 7,
    team_id: null,
    is_active: 0,
    use_count: 3,
  },
];

// Cuerpo hostil: debe verse literal y nunca ejecutarse ni convertirse en nodos.
const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function mine(list) {
  return Promise.resolve({ data: list });
}

beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockImplementation((url) => {
    if (url === MINE_URL) return mine(MINE);
    return Promise.reject(new Error(`404 ${url}`));
  });
  api.post.mockResolvedValue({ template: MINE[0] });
  api.patch.mockResolvedValue({ template: MINE[0] });
});

async function openEditor(title = 'Nueva plantilla', seed = {}) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '+ Nueva plantilla' }));
  const dialog = await screen.findByRole('dialog', { name: title });
  const filled = { title: '', body: '', ...seed };
  if (filled.title) await user.type(within(dialog).getByLabelText('Título *'), filled.title);
  if (filled.body) await user.type(within(dialog).getByLabelText('Cuerpo de la respuesta *'), filled.body);
  return { user, dialog };
}

async function openEditFor(user, name) {
  const card = screen.getByText(name).closest('li');
  await user.click(within(card).getByRole('button', { name: 'Editar' }));
  return screen.findByRole('dialog', { name: 'Editar plantilla' });
}

describe('MyTemplates · carga y listado', () => {
  it('pide únicamente las plantillas personales del usuario', async () => {
    renderWithProviders(<MyTemplates />);
    expect(await screen.findByText('Saludo inicial')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(MINE_URL);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('muestra título, cuerpo, contador de uso y el estado inactiva', async () => {
    renderWithProviders(<MyTemplates />);
    const row = (await screen.findByText('Saludo inicial')).closest('li');
    expect(within(row).getByText(/12 usos/)).toBeInTheDocument();

    const inactive = screen.getByText('Cierre de caso').closest('li');
    expect(within(inactive).getByText(/3 usos/)).toBeInTheDocument();
    expect(within(inactive).getByText(/inactiva/)).toBeInTheDocument();
  });

  it('no consulta ningún otro endpoint (ni equipos, niCatálogo, ni globales)', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const urls = api.get.mock.calls.map(([u]) => String(u));
    expect(urls.every((u) => u === MINE_URL)).toBe(true);
  });

  it('muestra el estado vacío sin plantillas', async () => {
    api.get.mockResolvedValue(mine([]));
    renderWithProviders(<MyTemplates />);
    expect(await screen.findByText('Sin respuestas rápidas')).toBeInTheDocument();
  });

  it('muestra el error si falla la carga', async () => {
    api.get.mockRejectedValue(new Error('No se pudieron cargar sus plantillas'));
    renderWithProviders(<MyTemplates />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar sus plantillas');
  });
});

describe('MyTemplates · aislamiento del ámbito personal', () => {
  it('no ofrece selectores de ámbito ni de equipo', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const { dialog } = await openEditor();
    expect(within(dialog).queryByLabelText('Ámbito *')).toBeNull();
    expect(within(dialog).queryByLabelText('Equipo *')).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
  });

  it('crea siempre en PERSONAL y nunca envía owner_id, team_id ni use_count', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const { user, dialog } = await openEditor('Nueva plantilla', { title: 'Nueva', body: 'Hola' });
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [url, payload] = api.post.mock.calls[0];
    expect(url).toBe('/api/canned-responses');
    expect(payload).toEqual({ title: 'Nueva', body: 'Hola', scope: 'PERSONAL' });
    expect(payload).not.toHaveProperty('owner_id');
    expect(payload).not.toHaveProperty('team_id');
    expect(payload).not.toHaveProperty('use_count');
    expect(payload).not.toHaveProperty('is_active');
  });

  it('al editar solo envía título y cuerpo: no puede cambiar de ámbito ni el contador', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const user = userEvent.setup();
    const dialog = await openEditFor(user, 'Saludo inicial');

    const title = within(dialog).getByLabelText('Título *');
    await user.clear(title);
    await user.type(title, 'Saludo cordial');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [url, payload] = api.patch.mock.calls[0];
    expect(url).toBe('/api/canned-responses/5');
    expect(payload).toEqual({ title: 'Saludo cordial', body: MINE[0].body });
    expect(payload).not.toHaveProperty('scope');
    expect(payload).not.toHaveProperty('use_count');
    expect(payload).not.toHaveProperty('owner_id');
  });

  it('no ofrece borrado físico: la baja es la desactivación', async () => {
    renderWithProviders(<MyTemplates />);
    const row = (await screen.findByText('Saludo inicial')).closest('li');
    expect(within(row).queryByRole('button', { name: /eliminar|borrar/i })).toBeNull();
    expect(within(row).getByRole('switch')).toBeInTheDocument();
    expect(api.del).not.toBeDefined();
  });
});

describe('MyTemplates · creación y edición', () => {
  it('crea una plantilla y cierra el modal al guardar bien', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const { user, dialog } = await openEditor('Nueva plantilla', { title: 'Confirmación', body: 'Confirmado.' });
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.post).toHaveBeenCalledWith('/api/canned-responses', {
      title: 'Confirmación',
      body: 'Confirmado.',
      scope: 'PERSONAL',
    });
  });

  it('precarga el modal de edición con los datos existentes', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const user = userEvent.setup();
    const dialog = await openEditFor(user, 'Cierre de caso');
    expect(within(dialog).getByLabelText('Título *')).toHaveValue('Cierre de caso');
    expect(within(dialog).getByLabelText('Cuerpo de la respuesta *')).toHaveValue('Se resolutionó el caso.');
  });

  it('descarta el modal al cancelar sin llamar a la API', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const { user, dialog } = await openEditor();
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('refresca el listado tras guardar', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    api.get.mockClear();
    const { user, dialog } = await openEditor('Nueva plantilla', { title: 'Otra', body: 'x' });
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(MINE_URL));
  });
});

describe('MyTemplates · activación y desactivación', () => {
  it('desactiva una plantilla activa', async () => {
    renderWithProviders(<MyTemplates />);
    const row = (await screen.findByText('Saludo inicial')).closest('li');
    const toggle = within(row).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.setup().click(toggle);

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/canned-responses/5', { is_active: false })
    );
  });

  it('reactiva una plantilla inactiva', async () => {
    renderWithProviders(<MyTemplates />);
    const row = (await screen.findByText('Cierre de caso')).closest('li');
    const toggle = within(row).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.setup().click(toggle);

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/canned-responses/6', { is_active: true })
    );
  });

  it('el interruptor no envía título ni cuerpo', async () => {
    renderWithProviders(<MyTemplates />);
    const row = (await screen.findByText('Saludo inicial')).closest('li');
    await userEvent.setup().click(within(row).getByRole('switch'));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1]).toEqual({ is_active: false });
  });
});

describe('MyTemplates · duplicación y validaciones', () => {
  it('muestra el error de título duplicado y mantiene el modal abierto', async () => {
    api.post.mockRejectedValue(
      new Error('Ya existe una plantilla activa con ese título en este ámbito')
    );
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const { user, dialog } = await openEditor('Nueva plantilla', { title: 'Saludo inicial', body: 'Otro' });
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ya existe una plantilla activa con ese título en este ámbito');
    // El usuario debe poder corregir el título sin reabrir el formulario.
    expect(screen.getByRole('dialog', { name: 'Nueva plantilla' })).toBeInTheDocument();
  });

  it('muestra el error de cuerpo obligatorio devuelto por el servidor', async () => {
    api.post.mockRejectedValue(new Error('El cuerpo de la plantilla es obligatorio'));
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const { user, dialog } = await openEditor('Nueva plantilla', { title: 'Sin cuerpo' });
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('El cuerpo de la plantilla es obligatorio');
  });

  it('limita el título a 100 caracteres y el cuerpo a 2000, con contador visible', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const { dialog } = await openEditor();
    expect(within(dialog).getByLabelText('Título *')).toHaveAttribute('maxlength', '100');
    expect(within(dialog).getByLabelText('Cuerpo de la respuesta *')).toHaveAttribute('maxlength', '2000');
    expect(within(dialog).getByText('0/2000 caracteres')).toBeInTheDocument();
  });

  it('el contador refleja lo escrito y el cuerpo no crece de 2000', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    const body = within(dialog).getByLabelText('Cuerpo de la respuesta *');
    await user.click(body);
    await user.paste('a'.repeat(2500));
    expect(body).toHaveValue('a'.repeat(2000));
    expect(within(dialog).getByText('2000/2000 caracteres')).toBeInTheDocument();
  });

  it('el error por campo del servidor se muestra unido en un solo aviso', async () => {
    const err = new Error('Error de validación');
    err.fields = { body: 'El cuerpo no debe exceder 2000 caracteres' };
    api.patch.mockRejectedValue(err);
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const user = userEvent.setup();
    const dialog = await openEditFor(user, 'Saludo inicial');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('El cuerpo no debe exceder 2000 caracteres');
  });
});

describe('MyTemplates · variables', () => {
  it('inserta la variable del catálogo en el cuerpo al pulsar su chip', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    await user.click(within(dialog).getByRole('button', { name: '{{reporter_name}}' }));
    expect(within(dialog).getByLabelText('Cuerpo de la respuesta *')).toHaveValue('{{reporter_name}}');
  });

  it('avisa de las variables fuera del catálogo sin bloquear el guardado', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    const body = within(dialog).getByLabelText('Cuerpo de la respuesta *');
    await user.click(body);
    await user.paste('Saludos {{no_existe}}');

    expect(within(dialog).getByText(/Fuera del catálogo: \{\{no_existe\}\}/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Guardar' })).toBeEnabled();
  });
});

describe('MyTemplates · protección frente a contenido malicioso', () => {
  it('la vista previa escapa el HTML del cuerpo y no crea nodos ejecutables', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    await user.click(within(dialog).getByLabelText('Cuerpo de la respuesta *'));
    await user.paste(XSS);

    const dialogEl = within(dialog).getByText('Vista previa').parentElement;
    expect(dialogEl.querySelector('img')).toBeNull();
    expect(dialogEl.querySelector('script')).toBeNull();
    expect(dialogEl.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('lista un cuerpo malicioso como texto, sin interpretarlo', async () => {
    api.get.mockResolvedValue(
      mine([{ ...MINE[0], id: 9, title: 'Hostil', body: XSS }])
    );
    const { container } = renderWithProviders(<MyTemplates />);
    const row = (await screen.findByText('Hostil')).closest('li');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('script')).toBeNull();
    expect(row.textContent).toContain('onerror="alert(1)"');
    expect(container.querySelector('script')).toBeNull();
  });

  it('envía el cuerpo verbatim: el escapado ocurre al renderizar, no al guardar', async () => {
    renderWithProviders(<MyTemplates />);
    await screen.findByText('Saludo inicial');
    const { user, dialog } = await openEditor('Nueva plantilla', { title: 'Hostil' });
    await user.click(within(dialog).getByLabelText('Cuerpo de la respuesta *'));
    await user.paste(XSS);
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].body).toBe(XSS);
  });
});

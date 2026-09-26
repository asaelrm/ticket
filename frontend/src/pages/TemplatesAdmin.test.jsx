import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TemplatesAdmin from './TemplatesAdmin';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

const { authState } = vi.hoisted(() => ({ authState: { user: null } }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});

const ADMIN = { id: 1, name: 'Ada', permissions: ['settings.manage', 'team.manage'] };
const SETTINGS_ONLY = { id: 2, name: 'Sol', permissions: ['settings.manage'] };
const TEAM_ONLY = { id: 3, name: 'Téc', permissions: ['team.manage'] };

const MANAGE_URL = '/api/canned-responses/manage';

const LIST = [
  {
    id: 1,
    title: 'Saludo global',
    body: 'Hola {{reporter_name}}.',
    scope: 'GLOBAL',
    owner_id: null,
    team_id: null,
    is_active: 1,
    use_count: 30,
  },
  {
    id: 2,
    title: 'Respuesta de equipo',
    body: 'Revisamos la red del área.',
    scope: 'TEAM',
    owner_id: null,
    team_id: 4,
    team_name: 'Soporte Nivel 1',
    is_active: 0,
    use_count: 8,
  },
];

const TEAMS = [
  { id: 4, name: 'Soporte Nivel 1' },
  { id: 5, name: 'Redes' },
];

// Cuerpo hostil: debe verse literal y nunca ejecutarse ni convertirse en nodos.
const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function manage(list) {
  return Promise.resolve({ data: list });
}

function lastGetUrlWith(fragment) {
  return api.get.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(fragment)).pop();
}

beforeEach(() => {
  vi.resetAllMocks();
  authState.user = ADMIN;
  api.get.mockImplementation((url) => {
    if (String(url).startsWith(MANAGE_URL)) return manage(LIST);
    if (url === '/api/teams') return Promise.resolve({ data: TEAMS });
    return Promise.reject(new Error(`404 ${url}`));
  });
  api.post.mockResolvedValue({ template: LIST[0] });
  api.patch.mockResolvedValue({ template: LIST[0] });
});

async function openEditor(title = 'Nueva plantilla') {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '+ Nueva plantilla' }));
  const dialog = await screen.findByRole('dialog', { name: title });
  return { user, dialog };
}

async function editCard(user, cardTitle) {
  const card = screen.getByText(cardTitle).closest('.card');
  await user.click(within(card).getByRole('button', { name: 'Editar' }));
  return screen.findByRole('dialog', { name: 'Editar plantilla' });
}

describe('TemplatesAdmin · listado y filtros', () => {
  it('lista globales y de equipo con su ámbito, equipo y contador de uso', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    const card = (await screen.findByText('Saludo global')).closest('.card');
    expect(within(card).getByText(/Global/)).toBeInTheDocument();
    expect(within(card).getByText(/30 usos/)).toBeInTheDocument();

    const teamCard = screen.getByText('Respuesta de equipo').closest('.card');
    expect(within(teamCard).getByText(/Equipo: Soporte Nivel 1/)).toBeInTheDocument();
    expect(within(teamCard).getByText(/8 usos/)).toBeInTheDocument();
  });

  it('recuerda que la pertenencia al equipo es de estado actual, no historial', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    expect(
      screen.getByText(/visibles solo para los miembros actuales del equipo/)
    ).toBeInTheDocument();
  });

  it('filtra por ámbito GLOBAL y por TEAM en el servidor', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');

    await user.selectOptions(screen.getByLabelText('Filtrar por ámbito'), 'GLOBAL');
    await waitFor(() => expect(lastGetUrlWith('scope=GLOBAL')).toBeTruthy());

    await user.selectOptions(screen.getByLabelText('Filtrar por ámbito'), 'TEAM');
    await waitFor(() => expect(lastGetUrlWith('scope=TEAM')).toBeTruthy());
  });

  it('busca por texto rebuilding la consulta con q', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');

    await user.type(screen.getByLabelText('Buscar plantillas'), 'red');
    await waitFor(() => expect(lastGetUrlWith('q=red')).toBeTruthy());
  });

  it('muestra el estado vacío y el error de carga', async () => {
    api.get.mockImplementation((url) =>
      String(url).startsWith(MANAGE_URL) ? manage([]) : Promise.reject(new Error('404'))
    );
    const { unmount } = renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    expect(await screen.findByText('Sin plantillas')).toBeInTheDocument();
    unmount();

    api.get.mockRejectedValue(new Error('No se pudo cargar'));
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar');
  });
});

describe('TemplatesAdmin · creación por ámbito', () => {
  it('crea una global sin equipo y la deja activa', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const { user, dialog } = await openEditor();
    await user.type(within(dialog).getByLabelText('Título *'), 'Nueva global');
    await user.type(within(dialog).getByLabelText('Cuerpo de la respuesta *'), 'Hola');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/canned-responses', {
      title: 'Nueva global',
      body: 'Hola',
      scope: 'GLOBAL',
      is_active: true,
      team_id: null,
    });
  });

  it('crea una de equipo solo cuando se elige equipo', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const { user, dialog } = await openEditor();
    await user.selectOptions(within(dialog).getByLabelText('Ámbito *'), 'TEAM');

    const teamSelect = await within(dialog).findByLabelText('Equipo *');
    expect(within(teamSelect).getByRole('option', { name: 'Redes' })).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Título *'), 'De red');
    await user.type(within(dialog).getByLabelText('Cuerpo de la respuesta *'), 'Revisamos la red.');
    await user.selectOptions(teamSelect, '5');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/canned-responses', {
      title: 'De red',
      body: 'Revisamos la red.',
      scope: 'TEAM',
      is_active: true,
      team_id: 5,
    });
  });

  it('no envía owner_id ni use_count: el contador no se manipula desde la UI', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const { user, dialog } = await openEditor();
    await user.type(within(dialog).getByLabelText('Título *'), 'X');
    await user.type(within(dialog).getByLabelText('Cuerpo de la respuesta *'), 'Y');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const payload = api.post.mock.calls[0][1];
    expect(payload).not.toHaveProperty('owner_id');
    expect(payload).not.toHaveProperty('use_count');
  });

  it('la casilla de activa forma parte del envío', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const { user, dialog } = await openEditor();
    await user.type(within(dialog).getByLabelText('Título *'), 'Inactiva de arranque');
    await user.type(within(dialog).getByLabelText('Cuerpo de la respuesta *'), 'z');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].is_active).toBe(false);
  });
});

describe('TemplatesAdmin · edición y duplicación', () => {
  it('precarga el modal con los datos de la fila, incluido su ámbito', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const user = userEvent.setup();
    const dialog = await editCard(user, 'Saludo global');
    expect(within(dialog).getByLabelText('Título *')).toHaveValue('Saludo global');
    expect(within(dialog).getByLabelText('Cuerpo de la respuesta *')).toHaveValue('Hola {{reporter_name}}.');
    expect(within(dialog).getByLabelText('Ámbito *')).toHaveValue('GLOBAL');
  });

  it('al editar una de equipo conserva su equipo seleccionado', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Respuesta de equipo');
    const user = userEvent.setup();
    const dialog = await editCard(user, 'Respuesta de equipo');
    expect(within(dialog).getByLabelText('Ámbito *')).toHaveValue('TEAM');
    expect(await within(dialog).findByLabelText('Equipo *')).toHaveValue('4');
  });

  it('envía el PATCH con el mismo contrato que la creación', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const user = userEvent.setup();
    const dialog = await editCard(user, 'Saludo global');
    const title = within(dialog).getByLabelText('Título *');
    await user.clear(title);
    await user.type(title, 'Saludo actualizado');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/api/canned-responses/1', {
      title: 'Saludo actualizado',
      body: 'Hola {{reporter_name}}.',
      scope: 'GLOBAL',
      is_active: true,
      team_id: null,
    });
  });

  it('muestra el error de título duplicado y mantiene el modal abierto', async () => {
    api.post.mockRejectedValue(
      new Error('Ya existe una plantilla activa con ese título en este ámbito')
    );
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const { user, dialog } = await openEditor();
    await user.type(within(dialog).getByLabelText('Título *'), 'Saludo global');
    await user.type(within(dialog).getByLabelText('Cuerpo de la respuesta *'), 'otro');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ya existe una plantilla activa con ese título en este ámbito');
    expect(screen.getByRole('dialog', { name: 'Nueva plantilla' })).toBeInTheDocument();
  });
});

describe('TemplatesAdmin · activación y desactivación', () => {
  it('desactiva una global activa', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    const card = (await screen.findByText('Saludo global')).closest('.card');
    const toggle = within(card).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.setup().click(toggle);

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/canned-responses/1', { is_active: false }));
  });

  it('reactiva una plantilla de equipo inactiva', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    const card = (await screen.findByText('Respuesta de equipo')).closest('.card');
    const toggle = within(card).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.setup().click(toggle);

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/canned-responses/2', { is_active: true }));
  });
});

describe('TemplatesAdmin · permisos por ámbito', () => {
  it('con settings.manage se ofrecen global y equipo, y se cargan los equipos', async () => {
    authState.user = SETTINGS_ONLY;
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    expect(api.get).toHaveBeenCalledWith('/api/teams');
  });

  it('con solo team.manage no se ofrece el ámbito GLOBAL', async () => {
    authState.user = TEAM_ONLY;
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const filter = screen.getByLabelText('Filtrar por ámbito');
    expect(within(filter).queryByRole('option', { name: 'Global' })).toBeNull();
    expect(within(filter).getByRole('option', { name: 'Equipo' })).toBeInTheDocument();

    const { user, dialog } = await openEditor();
    const scopeSelect = within(dialog).getByLabelText('Ámbito *');
    expect(within(scopeSelect).queryByRole('option', { name: 'Global' })).toBeNull();
    // Sin GLOBAL disponible, la nueva plantilla se crea de equipo.
    expect(scopeSelect).toHaveValue('TEAM');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  });

  it('con solo settings.manage no se ofrece el ámbito TEAM ni se cargan los equipos', async () => {
    authState.user = SETTINGS_ONLY;
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const filter = screen.getByLabelText('Filtrar por ámbito');
    expect(within(filter).queryByRole('option', { name: 'Equipo' })).toBeInTheDocument();

    const { dialog } = await openEditor();
    const scopeSelect = within(dialog).getByLabelText('Ámbito *');
    expect(within(scopeSelect).queryByRole('option', { name: 'Equipo' })).toBeNull();
    expect(within(dialog).queryByLabelText('Equipo *')).toBeNull();
    // La consulta de equipos no se dispara sin team.manage.
    expect(api.get).not.toHaveBeenCalledWith('/api/teams');
  });

  it('con solo team.manage no ofrece editar ni conmutar una global: el backend daría 404', async () => {
    authState.user = TEAM_ONLY;
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    const globalCard = (await screen.findByText('Saludo global')).closest('.card');
    expect(within(globalCard).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(within(globalCard).queryByRole('switch')).toBeNull();

    // La fila de su propio ámbito sí sigue siendo gestionable.
    const teamCard = screen.getByText('Respuesta de equipo').closest('.card');
    expect(within(teamCard).getByRole('button', { name: 'Editar' })).toBeInTheDocument();
    expect(within(teamCard).getByRole('switch')).toBeInTheDocument();
  });

  it('con solo settings.manage no ofrece editar ni conmutar una de equipo', async () => {
    authState.user = SETTINGS_ONLY;
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    const teamCard = (await screen.findByText('Respuesta de equipo')).closest('.card');
    expect(within(teamCard).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(within(teamCard).queryByRole('switch')).toBeNull();

    const globalCard = screen.getByText('Saludo global').closest('.card');
    expect(within(globalCard).getByRole('button', { name: 'Editar' })).toBeInTheDocument();
  });

  it('con ambos permisos se gestionan ambos ámbitos', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    expect(screen.getAllByRole('button', { name: 'Editar' })).toHaveLength(2);
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('toleran que falle la carga de equipos y no bloquea la pantalla', async () => {
    api.get.mockImplementation((url) => {
      if (String(url).startsWith(MANAGE_URL)) return manage(LIST);
      return Promise.reject(new Error('Sin conexión'));
    });
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('TemplatesAdmin · validaciones y longitud del comentario', () => {
  it('limita el título a 100, el cuerpo a 2000 y muestra el contador', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const { dialog } = await openEditor();
    expect(within(dialog).getByLabelText('Título *')).toHaveAttribute('maxlength', '100');
    expect(within(dialog).getByLabelText('Cuerpo de la respuesta *')).toHaveAttribute('maxlength', '2000');
    expect(within(dialog).getByText('0/2000 caracteres')).toBeInTheDocument();
  });

  it('bloquea el guardado si el texto expandido superaría los 4000 del comentario', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    const body = within(dialog).getByLabelText('Cuerpo de la respuesta *');
    await user.click(body);
    // 2000 + 120×20 = 4400 estimated, por encima del máximo del comentario.
    await user.paste('{{ticket_title}}'.repeat(120));

    expect(
      within(dialog).getByText(/superaría los 4000 caracteres del comentario/)
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Guardar' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('permite guardar un cuerpo de 2000 caracteres con pocas variables', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    const body = within(dialog).getByLabelText('Cuerpo de la respuesta *');
    await user.type(within(dialog).getByLabelText('Título *'), 'Largo');
    await user.click(body);
    await user.paste('a'.repeat(2000));

    expect(within(dialog).getByText('2000/2000 caracteres')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Guardar' })).toBeEnabled();
  });

  it('exige equipo al crear una de equipo: el servidor rechaza el(team_id null)', async () => {
    api.post.mockRejectedValue(new Error('Debe indicar el equipo de la plantilla'));
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const { user, dialog } = await openEditor();
    await user.type(within(dialog).getByLabelText('Título *'), 'Sin equipo');
    await user.type(within(dialog).getByLabelText('Cuerpo de la respuesta *'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Debe indicar el equipo de la plantilla');
    expect(api.post.mock.calls[0][1].team_id).toBeNull();
  });

  it('avisa de las variables fuera del catálogo y aclara que se insertan literales', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    const body = within(dialog).getByLabelText('Cuerpo de la respuesta *');
    await user.click(body);
    await user.paste('Hola {{no_existe}}');

    expect(
      within(dialog).getByText(/Variables fuera del catálogo: \{\{no_existe\}\}/)
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Se insertarán literalmente en el comentario/)).toBeInTheDocument();
  });

  it('inserta la variable del catálogo al pulsar su chip', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    await user.click(within(dialog).getByRole('button', { name: '{{category_name}}' }));
    expect(within(dialog).getByLabelText('Cuerpo de la respuesta *')).toHaveValue('{{category_name}}');
  });
});

describe('TemplatesAdmin · protección frente a contenido malicioso', () => {
  it('la vista previa escapa el HTML y no crea nodos ejecutables', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    await user.click(within(dialog).getByLabelText('Cuerpo de la respuesta *'));
    await user.paste(XSS);

    const preview = within(dialog).getByText('Vista previa').parentElement;
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('lista un cuerpo malicioso como texto, sin interpretarlo', async () => {
    api.get.mockImplementation((url) =>
      String(url).startsWith(MANAGE_URL) ? manage([{ ...LIST[0], id: 9, title: 'Hostil', body: XSS }]) : Promise.reject(new Error('404'))
    );
    const { container } = renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    const card = (await screen.findByText('Hostil')).closest('.card');
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('script')).toBeNull();
    expect(card.textContent).toContain('onerror="alert(1)"');
    expect(container.querySelector('script')).toBeNull();
  });

  it('un título malicioso tampoco se interpreta', async () => {
    api.get.mockImplementation((url) =>
      String(url).startsWith(MANAGE_URL) ? manage([{ ...LIST[0], id: 9, title: '<b>título</b>', body: 'x' }]) : Promise.reject(new Error('404'))
    );
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    const card = (await screen.findByText('<b>título</b>')).closest('.card');
    expect(card.querySelector('b')).toBeNull();
  });

  it('envía el cuerpo verbatim: el escapado ocurre al renderizar, no al guardar', async () => {
    renderWithProviders(<TemplatesAdmin />, { route: '/app/templates' });
    await screen.findByText('Saludo global');
    const user = userEvent.setup();
    const { dialog } = await openEditor();
    await user.type(within(dialog).getByLabelText('Título *'), 'Hostil');
    await user.click(within(dialog).getByLabelText('Cuerpo de la respuesta *'));
    await user.paste(XSS);
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].body).toBe(XSS);
  });
});

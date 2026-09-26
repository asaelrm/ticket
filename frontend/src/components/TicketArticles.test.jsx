import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TicketArticles from './TicketArticles';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

const { authState } = vi.hoisted(() => ({ authState: { user: null } }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

const READER = { id: 7, name: 'Lucía', permissions: ['ticket.view.all', 'kb.view'] };
const AUTHOR = {
  id: 7,
  name: 'Lucía',
  permissions: ['ticket.view.all', 'kb.view', 'kb.create', 'kb.publish'],
};

const TICKET = {
  id: 1,
  ticket_number: 'TCK-000001',
  title: 'El correo no sincroniza',
  description: 'Outlook se queda sin descargar desde ayer.',
  status: 'RESOLVED',
  resolution: 'Se recreó el perfil en el servidor de Exchange.',
  resolution_category: 'Configuración',
  root_cause: 'Perfil corrupto',
  category_id: 1,
  category_name: 'Software',
  reporter_id: 2,
  reporter_name: 'Ana Díaz',
  reporter_email: 'ana.diaz@ejemplo.com',
  reporter_phone: '+34 600 111 222',
  attachments: [{ id: 9, filename: 'captura-de-error.png' }],
  internal_note: 'El clientereviewed tiene VIP: no escalar a proveedor externo.',
};

const PREVIEW = {
  preview: {
    title: 'El correo no sincroniza',
    description: 'Outlook se queda sin descargar desde ayer.',
    solution: 'Se recreó el perfil en el servidor de Exchange.',
    keywords: '',
    category_id: null,
    ticket_id: 1,
    ticket_number: 'TCK-000001',
    ticket_category_id: 1,
    resolution_category: 'Configuración',
    root_cause: 'Perfil corrupto',
  },
};

const CATEGORIES = [{ id: 4, name: 'Correo' }];

function article(overrides = {}) {
  return {
    id: 5,
    title: 'Recrear el perfil de Outlook',
    summary: 'Pasos para recuperar la sincronización.',
    category_id: 4,
    category_name: 'Correo',
    status: 'PUBLISHED',
    author_id: 3,
    author_name: 'Carlos Ruiz',
    view_count: 12,
    ...overrides,
  };
}

let linked;
let results;

function mockGet(url) {
  if (url === '/api/tickets/1/articles') {
    return Promise.resolve({ data: linked, total: linked.length });
  }
  if (url.startsWith('/api/kb-articles?')) {
    return Promise.resolve({ data: results, total: results.length, page: 1, perPage: 5 });
  }
  if (url === '/api/kb-articles/from-ticket/1') return Promise.resolve(PREVIEW);
  if (url === '/api/kb-categories') return Promise.resolve({ data: CATEGORIES });
  return Promise.reject(new Error(`404 ${url}`));
}

function render(ticket = TICKET) {
  return renderWithProviders(<TicketArticles ticket={ticket} />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = AUTHOR;
  linked = [];
  results = [];
  api.get.mockImplementation(mockGet);
  api.post.mockResolvedValue({});
  api.del.mockResolvedValue({ ok: true });
});

describe('TicketArticles · permisos', () => {
  it('sin kb.view no renderiza nada ni consulta el ticket', () => {
    authState.user = { id: 7, name: 'Lucía', permissions: ['ticket.view.all'] };

    render();

    expect(screen.queryByText('Base de conocimiento')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/api/tickets/1/articles');
  });

  it('con kb.view pero sin kb.create solo consulta y no ofrece modificar el ticket', async () => {
    authState.user = READER;
    linked = [article()];

    render();

    expect(await screen.findByText('Recrear el perfil de Outlook')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/tickets/1/articles');
    expect(screen.queryByRole('button', { name: /Desvincular/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Vincular artículo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Crear borrador/ })).not.toBeInTheDocument();
  });
});

describe('TicketArticles · artículos vinculados', () => {
  it('lista los artículos con su categoría y sus consultas', async () => {
    linked = [article(), article({ id: 6, title: 'Liberar espacio en Outlook', view_count: 1 })];

    render();

    expect(await screen.findByText('Recrear el perfil de Outlook')).toBeInTheDocument();
    expect(screen.getByText('Liberar espacio en Outlook')).toBeInTheDocument();
    expect(screen.getByText(/12 consultas/)).toBeInTheDocument();
    expect(screen.getByText(/1 consulta$/)).toBeInTheDocument();
    expect(screen.getByText('2 vinculados')).toBeInTheDocument();
  });

  it('enlaza cada artículo con su ficha', async () => {
    linked = [article()];

    render();

    const link = await screen.findByRole('link', { name: 'Recrear el perfil de Outlook' });
    expect(link).toHaveAttribute('href', '/app/knowledge/5');
  });

  it('informa cuando el ticket no tiene artículos', async () => {
    render();

    expect(await screen.findByText(/no tiene artículos vinculados/)).toBeInTheDocument();
  });

  it('avisa del error de red sin romper el resto de la página', async () => {
    api.get.mockImplementation((url) =>
      url === '/api/tickets/1/articles' ? Promise.reject(new Error('Fallo de red')) : mockGet(url),
    );

    render();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Fallo de red');
    // La escritura sigue disponible aunque el listado falle.
    expect(screen.getByRole('button', { name: /Vincular artículo/ })).toBeInTheDocument();
  });
});

describe('TicketArticles · búsqueda y vínculos', () => {
  it('exige al menos dos caracteres antes de consultar', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /Vincular artículo/ }));
    await user.type(screen.getByLabelText('Buscar artículos publicados'), 'o');

    expect(await screen.findByText(/al menos dos caracteres/)).toBeInTheDocument();
    expect(api.get.mock.calls.filter(([u]) => u.startsWith('/api/kb-articles?'))).toHaveLength(0);
  });

  it('busca con el listado público, sin canal de estado ni borradores', async () => {
    const user = userEvent.setup();
    results = [article()];
    render();

    await user.click(await screen.findByRole('button', { name: /Vincular artículo/ }));
    await user.type(screen.getByLabelText('Buscar artículos publicados'), 'outlook');

    expect(await screen.findByText('Recrear el perfil de Outlook')).toBeInTheDocument();
    const [url] = api.get.mock.calls.filter(([u]) => u.startsWith('/api/kb-articles?')).pop();
    expect(url).toContain('q=outlook');
    expect(url).toContain('perPage=5');
    // Ni status=DRAFT ni otra vía para leer artículos no publicados.
    expect(url).not.toContain('status');
    expect(screen.getByText(/Los borradores no se enlazan desde aquí/)).toBeInTheDocument();
  });

  it('indica cuando la búsqueda no encuentra nada', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /Vincular artículo/ }));
    await user.type(screen.getByLabelText('Buscar artículos publicados'), 'zzz');

    expect(await screen.findByText(/Ningún artículo publicado coincide/)).toBeInTheDocument();
  });

  it('vincula el artículo buscado y refresca la lista', async () => {
    const user = userEvent.setup();
    results = [article()];
    linked = [];
    api.post.mockImplementation((url) => {
      if (url === '/api/kb-articles/5/tickets/1') {
        linked = [article()];
        return Promise.resolve({ data: { article_id: 5, ticket_id: 1 } });
      }
      return Promise.resolve({});
    });

    render();
    await user.click(await screen.findByRole('button', { name: /Vincular artículo/ }));
    await user.type(screen.getByLabelText('Buscar artículos publicados'), 'outlook');
    await user.click(await screen.findByRole('button', { name: 'Vincular' }));

    expect(api.post).toHaveBeenCalledWith('/api/kb-articles/5/tickets/1');
    expect(await screen.findByText('1 vinculados')).toBeInTheDocument();
  });

  it('no vuelve a enviar un artículo ya vinculado', async () => {
    const user = userEvent.setup();
    linked = [article()];
    results = [article()];

    render();
    await user.click(await screen.findByRole('button', { name: /Vincular artículo/ }));
    await user.type(screen.getByLabelText('Buscar artículos publicados'), 'outlook');

    const button = await screen.findByRole('button', { name: 'Vinculado' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('desvincula un artículo', async () => {
    const user = userEvent.setup();
    linked = [article()];

    render();
    await user.click(await screen.findByRole('button', { name: 'Desvincular' }));

    expect(api.del).toHaveBeenCalledWith('/api/kb-articles/5/tickets/1');
  });

  it('muestra el conflicto si el artículo ya estaba vinculado', async () => {
    const user = userEvent.setup();
    results = [article()];
    api.post.mockRejectedValue(new Error('El artículo ya está vinculado a este ticket'));

    render();
    await user.click(await screen.findByRole('button', { name: /Vincular artículo/ }));
    await user.type(screen.getByLabelText('Buscar artículos publicados'), 'outlook');
    await user.click(await screen.findByRole('button', { name: 'Vincular' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ya está vinculado');
  });
});

describe('TicketArticles · borrador desde el ticket', () => {
  it('solo ofrece crear borrador en tickets resueltos o cerrados', async () => {
    const user = userEvent.setup();
    render({ ...TICKET, status: 'OPEN' });

    expect(await screen.findByText(/no tiene artículos/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Crear borrador/ })).not.toBeInTheDocument();
  });

  it('precarga la previsualización y exige el resumen que la API no propone', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /Crear borrador desde el ticket/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Título')).toHaveValue('El correo no sincroniza');
    expect(within(dialog).getByLabelText(/^Descripción/)).toHaveValue('Outlook se queda sin descargar desde ayer.');
    expect(within(dialog).getByLabelText(/^Solución/)).toHaveValue('Se recreó el perfil en el servidor de Exchange.');
    expect(within(dialog).getByLabelText(/^Resumen/)).toHaveValue('');
    expect(within(dialog).getByText(/Configuración/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Perfil corrupto/)).toBeInTheDocument();

    // Sin resumen no se envía nada.
    await user.click(within(dialog).getByRole('button', { name: 'Crear borrador' }));
    expect(await within(dialog).findByText('Revise los campos marcados antes de crear el borrador.')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Campo obligatorio').length).toBeGreaterThan(0);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('envía solo los seis campos editoriales, como borrador y sin notas internas', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ article: { id: 9, title: 'El correo no sincroniza' } });

    render();
    await user.click(await screen.findByRole('button', { name: /Crear borrador desde el ticket/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Resumen/), 'Recrear el perfil de Exchange.');
    await user.type(within(dialog).getByLabelText('Palabras clave'), 'outlook, exchange');
    await user.selectOptions(within(dialog).getByLabelText('Categoría de conocimiento'), '4');
    await user.click(within(dialog).getByRole('button', { name: 'Crear borrador' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/kb-articles', {
        title: 'El correo no sincroniza',
        summary: 'Recrear el perfil de Exchange.',
        description: 'Outlook se queda sin descargar desde ayer.',
        solution: 'Se recreó el perfil en el servidor de Exchange.',
        keywords: 'outlook, exchange',
        category_id: 4,
      }),
    );

    const [, payload] = api.post.mock.calls[0];
    // Lista blanca estricta: ni estado, ni ticket, ni autor, ni datos del
    // reportante, ni notas internas, ni adjuntos.
    expect(Object.keys(payload).sort()).toEqual(
      ['category_id', 'description', 'keywords', 'solution', 'summary', 'title'],
    );
    const body = JSON.stringify(payload);
    for (const secreto of [
      TICKET.internal_note,
      TICKET.reporter_name,
      TICKET.reporter_email,
      TICKET.reporter_phone,
      TICKET.attachments[0].filename,
    ]) {
      expect(body).not.toContain(secreto);
    }
    expect(body).not.toContain('status');
    expect(body).not.toContain('ticket_id');
  });

  it('no muestra ni el texto de las notas internas ni los adjuntos del ticket', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /Crear borrador desde el ticket/ }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByText(/VIP/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/captura-de-error/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Ana Díaz/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/ana\.diaz@ejemplo\.com/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/600 111 222/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/no incluye notas internas, adjuntos ni datos personales/)).toBeInTheDocument();
  });

  it('confirma la creación, avisa de que es un borrador y enlaza a su ficha', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ article: { id: 9, title: 'El correo no sincroniza' } });

    render();
    await user.click(await screen.findByRole('button', { name: /Crear borrador desde el ticket/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/No se publica nada automáticamente/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Resumen/), 'Recrear el perfil de Exchange.');
    await user.click(within(dialog).getByRole('button', { name: 'Crear borrador' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Borrador creado');
    expect(within(status).getByRole('link', { name: 'El correo no sincroniza' })).toHaveAttribute(
      'href',
      '/app/knowledge/9',
    );
    expect(api.get.mock.calls.every(([u]) => !u.includes('/publish'))).toBe(true);
  });

  it('cancela sin enviar nada', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /Crear borrador desde el ticket/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('explica por qué un ticket no se puede convertir', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) =>
      url === '/api/kb-articles/from-ticket/1'
        ? Promise.reject(new Error('El ticket no tiene solución registrada'))
        : mockGet(url),
    );

    render();
    await user.click(await screen.findByRole('button', { name: /Crear borrador desde el ticket/ }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no tiene solución registrada');
    expect(within(dialog).getByText(/Solo los tickets resueltos o cerrados/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('coloca el error del servidor junto al campo que corresponde', async () => {
    const user = userEvent.setup();
    const err = new Error('Ya existe un artículo no archivado suyo con ese título');
    err.fields = { title: 'Ya existe un artículo no archivado suyo con ese título' };
    api.post.mockRejectedValue(err);

    render();
    await user.click(await screen.findByRole('button', { name: /Crear borrador desde el ticket/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Resumen/), 'Resumen provisional.');
    await user.click(within(dialog).getByRole('button', { name: 'Crear borrador' }));

    await waitFor(() => expect(within(dialog).getAllByText(/Ya existe un artículo/).length).toBeGreaterThan(0));
    expect(within(dialog).getByLabelText('Título')).toHaveAttribute('aria-invalid', 'true');
    // El formulario se conserva para corregir sin perder lo escrito.
    expect(within(dialog).getByLabelText(/^Resumen/)).toHaveValue('Resumen provisional.');
  });
});

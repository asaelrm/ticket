import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TicketTable } from './TicketTable';
import { quickActionsFor, menuItemsFor, isTerminal } from '../lib/ticketActions';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const { api } = await import('../lib/api');

const ALL = { canAssign: true, canManage: true, canResolve: true, canClose: true };
const ME = 7;

function row(overrides = {}) {
  return {
    id: 1,
    ticket_number: 'TCK-000001',
    title: 'PC no enciende',
    status: 'OPEN',
    priority: 'HIGH',
    category_name: 'Hardware',
    reporter_name: 'Ana Díaz',
    assigned_to_id: null,
    updated_at: new Date(Date.now() - 3 * 3600000).toISOString(),
    sla_due_at: new Date(Date.now() + 48 * 3600000).toISOString(),
    comment_count: 0,
    attachment_count: 0,
    ...overrides,
  };
}

function listResp(rows) {
  return { data: rows, total: rows.length, page: 1, pages: 1, perPage: 15 };
}

const HOUR = 3600000;

function renderTable(rows, props = {}) {
  return renderWithProviders(
    <TicketTable
      list={listResp(rows)}
      basePath="/app/tickets"
      currentUserId={ME}
      perms={ALL}
      {...props}
    />,
    { route: '/app/tickets', path: '/app/tickets' }
  );
}

// Los permisos y las llamadas llegan al componente como props (`canAssign`, …)
// para no duplicar aquí el hook; se traduce el atajo de las pruebas.
function renderRows(rows, extra = {}) {
  const { perms = ALL, ...rest } = extra;
  return renderTable(rows, { ...perms, ...rest });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({});
  api.patch.mockResolvedValue({});
});

describe('quickActionsFor · la acción depende del estado real', () => {
  it('un ticket sin responsable ofrece "Tomar ticket"', () => {
    expect(quickActionsFor(row(), ALL, ME).map((a) => a.label)).toEqual(['Tomar ticket']);
  });

  it('un ticket sin responsable no ofrece "Tomar ticket" sin ticket.assign', () => {
    const perms = { ...ALL, canAssign: false };
    expect(quickActionsFor(row(), perms, ME)).toEqual([]);
  });

  it('"Tomar ticket" desaparece en cuanto el ticket ya tiene técnico', () => {
    const asignado = row({ status: 'OPEN', assigned_to_id: 9 });
    expect(quickActionsFor(asignado, ALL, ME).map((a) => a.label)).toEqual([]);
  });

  it.each(['OPEN', 'ASSIGNED'])('un %s asignado a mí ofrece "Iniciar atención"', (status) => {
    const mio = row({ status, assigned_to_id: ME });
    expect(quickActionsFor(mio, ALL, ME).map((a) => a.label)).toEqual(['Iniciar atención']);
  });

  it('no ofrece "Iniciar atención" sobre un ticket de otro técnico', () => {
    const ajeno = row({ status: 'OPEN', assigned_to_id: 9 });
    expect(quickActionsFor(ajeno, ALL, ME)).toEqual([]);
  });

  it('no ofrece "Iniciar atención" sin ticket.update.any', () => {
    const mio = row({ status: 'OPEN', assigned_to_id: ME });
    expect(quickActionsFor(mio, { ...ALL, canManage: false }, ME)).toEqual([]);
  });

  it('IN_PROGRESS ofrece "Resolver" como primaria y "Poner en espera" como secundaria', () => {
    const acciones = quickActionsFor(row({ status: 'IN_PROGRESS', assigned_to_id: ME }), ALL, ME);
    expect(acciones.map((a) => a.label)).toEqual(['Resolver', 'Poner en espera']);
    expect(acciones[0]).toMatchObject({ kind: 'resolve', status: 'RESOLVED' });
    expect(acciones[1]).toMatchObject({ kind: 'status', status: 'PENDING' });
  });

  it('IN_PROGRESS sin ticket.resolve sólo deja "Poner en espera"', () => {
    const perms = { ...ALL, canResolve: false };
    const acciones = quickActionsFor(row({ status: 'IN_PROGRESS', assigned_to_id: ME }), perms, ME);
    expect(acciones.map((a) => a.label)).toEqual(['Poner en espera']);
  });

  it('PENDING ofrece "Reanudar" y también resolver', () => {
    const acciones = quickActionsFor(row({ status: 'PENDING', assigned_to_id: ME }), ALL, ME);
    expect(acciones.map((a) => a.label)).toEqual(['Reanudar', 'Resolver']);
    expect(acciones[0]).toMatchObject({ kind: 'status', status: 'IN_PROGRESS' });
  });

  it('PENDING sin ticket.update.any sólo deja resolver', () => {
    const perms = { ...ALL, canManage: false };
    const acciones = quickActionsFor(row({ status: 'PENDING', assigned_to_id: ME }), perms, ME);
    expect(acciones.map((a) => a.label)).toEqual(['Resolver']);
  });

  it.each(['RESOLVED', 'CLOSED', 'CANCELLED'])('%s no ofrece ninguna acción rápida', (status) => {
    expect(quickActionsFor(row({ status, assigned_to_id: ME }), ALL, ME)).toEqual([]);
    expect(isTerminal(status)).toBe(true);
  });
});

describe('menuItemsFor · el menú respeta estado y permisos', () => {
  const labels = (ticket, perms) =>
    menuItemsFor(ticket, perms, {}).filter((i) => !i.separator).map((i) => i.label);

  it.each(['RESOLVED', 'CLOSED', 'CANCELLED'])('sobre %s sólo queda "Ver detalle"', (status) => {
    expect(labels(row({ status, assigned_to_id: ME }), ALL)).toEqual(['Ver detalle']);
  });

  it('un usuario sin ningún permiso sólo puede ver el detalle', () => {
    expect(labels(row({ assigned_to_id: ME }), {})).toEqual(['Ver detalle']);
  });

  it('"Marcar en proceso" no aparece sobre un ticket ya en proceso', () => {
    const enProceso = row({ status: 'IN_PROGRESS', assigned_to_id: ME });
    expect(labels(enProceso, ALL)).not.toContain('Marcar en proceso');
    expect(labels(enProceso, ALL)).toContain('Poner en espera');
  });

  it('"Marcar en proceso" aparece sobre un ticket abierto', () => {
    expect(labels(row({ assigned_to_id: ME }), ALL)).toContain('Marcar en proceso');
  });

  it('"Marcar resuelto" y "Cerrar ticket" exigen su permiso propio', () => {
    const mio = row({ status: 'IN_PROGRESS', assigned_to_id: ME });
    const sinResolve = labels(mio, { ...ALL, canResolve: false });
    expect(sinResolve).not.toContain('Marcar resuelto');
    expect(sinResolve).toContain('Cerrar ticket');
    const sinClose = labels(mio, { ...ALL, canClose: false });
    expect(sinClose).toContain('Marcar resuelto');
    expect(sinClose).not.toContain('Cerrar ticket');
  });

  it('"Cancelar ticket" exige ticket.update.any', () => {
    const mio = row({ status: 'IN_PROGRESS', assigned_to_id: ME });
    expect(labels(mio, ALL)).toContain('Cancelar ticket');
    expect(labels(mio, { ...ALL, canManage: false })).not.toContain('Cancelar ticket');
  });

  it('no ofrece "Asignarme a mí" cuando el ticket ya es del usuario que mira', () => {
    // Caso reportado en la prueba visual: un IN_PROGRESS de "Mis activos".
    const mio = row({ status: 'IN_PROGRESS', assigned_to_id: ME });
    const items = menuItemsFor(mio, ALL, { currentUserId: ME });
    expect(items.filter((i) => !i.separator).map((i) => i.label)).toEqual([
      'Ver detalle',
      'Poner en espera',
      'Marcar resuelto',
      'Cerrar ticket',
      'Cancelar ticket',
    ]);
  });

  it('sí ofrece "Asignarme a mí" cuando el ticket es de otro técnico', () => {
    const ajeno = row({ status: 'IN_PROGRESS', assigned_to_id: 9 });
    expect(menuItemsFor(ajeno, ALL, { currentUserId: ME }).map((i) => i.label)).toContain('Asignarme a mí');
  });

  it('sin currentUserId conocido no se oculta la acción por si acaso', () => {
    // MyTickets.jsx monta la tabla sin id de usuario: sin ese dato no se puede
    // saber si el ticket es suyo, y ocultarla sería inventar una restricción.
    const mio = row({ status: 'IN_PROGRESS', assigned_to_id: ME });
    expect(menuItemsFor(mio, ALL, {}).map((i) => i.label)).toContain('Asignarme a mí');
  });
});

// La tabla oculta las acciones rápidas secundarias por debajo de `2xl`
// (`hidden 2xl:inline-flex`): en escritorios estrechos caben la primaria y el
// menú. Eso sólo es aceptable si la acción sigue siendo accesible, así que la
// comprobable es que cada secundaria tenga su equivalente en el ⋯.
describe('menuItemsFor · nada se pierde al compactar la columna de acciones', () => {
  const menuDe = (ticket) =>
    menuItemsFor(ticket, ALL, { currentUserId: ME }).filter((i) => !i.separator).map((i) => i.label);

  // "Tomar ticket" es la única acción rápida sin equivalente en el menú, pero
  // nunca es secundaria: el botón primario se ve siempre.
  it.each(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'])(
    'toda acción rápida secundaria de un %s está en el menú ⋯',
    (status) => {
      const ticket = row({ status, assigned_to_id: status === 'OPEN' || status === 'ASSIGNED' ? 9 : ME });
      const quick = quickActionsFor(ticket, ALL, ME);
      const menu = menuDe(ticket);
      // La primera acción nunca se oculta, así que sólo se exige equivalencia
      // para las siguientes.
      for (const action of quick.slice(1)) {
        const equivalente = action.status === 'PENDING' ? 'Poner en espera' : 'Marcar resuelto';
        expect(menu).toContain(equivalente);
      }
    }
  );

  it('un ticket sin dueño sólo tiene la acción primaria, que siempre se ve', () => {
    const abierto = row({ status: 'OPEN', assigned_to_id: null });
    expect(quickActionsFor(abierto, ALL, ME).map((a) => a.label)).toEqual(['Tomar ticket']);
  });
});

describe('TicketTable · SLA y última actividad', () => {
  it('un SLA vencido dice "Vencido hace" y no tiñe la fila de rojo', async () => {
    renderRows([row({ sla_due_at: new Date(Date.now() - 2 * HOUR).toISOString(), is_overdue: true })]);
    const ticketCell = await screen.findByText('TCK-000001');
    const fila = ticketCell.closest('tr');

    expect(within(fila).getByText(/Vencido hace/)).toBeInTheDocument();
    expect(fila.className).not.toMatch(/bg-red/);
    // La urgencia sigue estando disponible aunque no dependa del color.
    expect(within(fila).getByRole('img', { name: 'Fuera de plazo' })).toBeInTheDocument();
  });

  it('no marca urgencia de SLA en un ticket crítico ya cerrado', async () => {
    renderRows([row({ status: 'CLOSED', priority: 'CRITICAL', assigned_to_id: ME, sla_due_at: null })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    // Sin `sla_due_at` el plazo dejó de contar: no hay aviso de SLA. La barra de
    // "prioridad crítica" sí permanece, porque la prioridad no caduca al cerrar.
    expect(within(fila).queryByRole('img', { name: 'Fuera de plazo' })).not.toBeInTheDocument();
    expect(within(fila).queryByRole('img', { name: 'Vence pronto' })).not.toBeInTheDocument();
    expect(within(fila).getByRole('img', { name: 'Prioridad crítica' })).toBeInTheDocument();
  });

  it('marca la prioridad crítica con barra aunque el SLA esté en plazo', async () => {
    renderRows([row({ status: 'IN_PROGRESS', priority: 'CRITICAL', assigned_to_id: ME })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    expect(within(fila).getByRole('img', { name: 'Prioridad crítica' })).toBeInTheDocument();
    expect(fila.className).not.toMatch(/bg-red/);
  });

  it('un SLA dentro de 24 h dice "Vence en" con su ventana', async () => {
    renderRows([row({ sla_due_at: new Date(Date.now() + 3 * HOUR).toISOString() })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    expect(within(fila).getByText(/Vence en/)).toBeInTheDocument();
    expect(within(fila).getByRole('img', { name: 'Vence pronto' })).toBeInTheDocument();
  });

  it('un SLA dentro de las 48 h no se marca como próximo a vencer', async () => {
    // La ventana compartida es de 24 h: a 48 h el ticket está en plazo y no
    // debe llevar la franja ámbar.
    renderRows([row({ sla_due_at: new Date(Date.now() + 40 * HOUR).toISOString() })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    expect(within(fila).queryByRole('img', { name: 'Vence pronto' })).not.toBeInTheDocument();
    expect(within(fila).getByText(/Vence en/)).toBeInTheDocument();
  });

  it('un ticket abierto sin fecha límite dice "Sin SLA"', async () => {
    renderRows([row({ sla_due_at: null })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    expect(within(fila).getByText('Sin SLA')).toBeInTheDocument();
  });

  it('un ticket terminal no dice "Sin SLA" sino que el plazo dejó de contar', async () => {
    renderRows([row({ status: 'CLOSED', sla_due_at: null })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    expect(within(fila).queryByText('Sin SLA')).not.toBeInTheDocument();
    expect(within(fila).getByText('—')).toBeInTheDocument();
  });

  it('muestra la última actividad sin pedir nada más al servidor', async () => {
    renderRows([row({ updated_at: new Date(Date.now() - 5 * HOUR).toISOString() })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    expect(within(fila).getByText('hace 5 h')).toBeInTheDocument();
    // `updated_at` ya viene en la misma consulta del listado: la fila no puede
    // abrir una petición propia (eso sería N+1).
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('TicketTable · el tooltip explica los metadatos de la fila', () => {
  // El `title` nativo no aparece con el teclado y tarda en mostrarse; el SLA y
  // la última actividad se leen igual de tarde en una tabla larga, así que la
  // explicación se comprueba con el puntero.
  const hover = async (element) => {
    const user = userEvent.setup();
    await user.hover(element);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());
    return screen.getByRole('tooltip');
  };

  it('el tooltip del SLA da la fecha exacta, que en la celda sólo sale relativa', async () => {
    const vence = new Date(Date.now() + 3 * HOUR);
    renderRows([row({ sla_due_at: vence.toISOString() })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    const el = await hover(within(fila).getByText(/Vence en/));

    expect(el).toHaveTextContent(/Vence: /);
    // Sigue siendo un tooltip y no un `title`: la celda no se announces dos veces.
    expect(el).toHaveAttribute('role', 'tooltip');
  });

  it('el tooltip de la última actividad da la fecha y hora exactas', async () => {
    renderRows([row({ updated_at: new Date(Date.now() - 5 * HOUR).toISOString() })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    const el = await hover(within(fila).getByText('hace 5 h'));

    expect(el).toHaveTextContent('Última actividad: ');
  });

  it('"Sin SLA" explica por qué, en vez de dejar el título nativo', async () => {
    renderRows([row({ sla_due_at: null })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');

    const celda = within(fila).getByText('Sin SLA');
    expect(celda).not.toHaveAttribute('title');

    const el = await hover(celda);
    expect(el).toHaveTextContent('Este ticket no tiene fecha límite de atención');
  });

  it('la franja de urgencia no se anuncia dos veces: su texto ya es el nombre', async () => {
    renderRows([row({ sla_due_at: new Date(Date.now() - 2 * HOUR).toISOString(), is_overdue: true })]);
    const fila = (await screen.findByText('TCK-000001')).closest('tr');
    const franja = within(fila).getByRole('img', { name: 'Fuera de plazo' });

    // El `aria-label` de la franja ya dice "Fuera de plazo": describirla otra
    // vez sólo haría que el lector de pantalla repita la misma frase.
    expect(franja).not.toHaveAttribute('aria-describedby');

    const user = userEvent.setup();
    await user.hover(franja);

    // La burbuja sí se ve (portal a `body`), pero va marcada como decorativa.
    const burbuja = await waitFor(() => {
      const el = document.querySelector('body > span[aria-hidden="true"]');
      expect(el).toBeInTheDocument();
      return el;
    });
    expect(burbuja).toHaveTextContent('Fuera de plazo');
    expect(burbuja).not.toHaveAttribute('role');
  });
});

describe('TicketTable · permisos y estados terminales', () => {
  it('no ofrece acciones a un usuario sin permisos, sólo el menú con "Ver detalle"', async () => {
    renderRows([row({ assigned_to_id: ME })], { perms: {} });

    await screen.findByText('TCK-000001');
    expect(screen.queryByRole('button', { name: /Tomar ticket|Resolver|Iniciar atención/ })).not.toBeInTheDocument();
    // Sin ninguna acción posible, ni siquiera se pinta la columna.
    expect(screen.queryByText('Acciones')).not.toBeInTheDocument();
  });

  it.each(['RESOLVED', 'CLOSED', 'CANCELLED'])('no ofrece ninguna acción operativa sobre %s', async (status) => {
    const user = userEvent.setup();
    renderRows([row({ status, assigned_to_id: ME })]);

    await screen.findByText('TCK-000001');
    expect(screen.queryByRole('button', { name: /Tomar ticket|Iniciar atención|Resolver|Reanudar|Poner en espera/ })).not.toBeInTheDocument();

    // El menú queda reducido a consultar el ticket.
    await user.click(screen.getByRole('button', { name: '⋯' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    expect(within(menu).getByRole('menuitem', { name: /Ver detalle/ })).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('TicketTable · la fila delega la acción y refleja el estado en vuelo', () => {
  // El componente no habla con la API: invoca `onAssignMe` / `onStatusChange`,
  // que son las pantallas las que conectan con `useTicketRowActions`.
  it('"Tomar ticket" delega en onAssignMe con el ticket', async () => {
    const user = userEvent.setup();
    const onAssignMe = vi.fn();
    renderRows([row()], { onAssignMe });

    await user.click(await screen.findByRole('button', { name: 'Tomar ticket TCK-000001' }));

    expect(onAssignMe).toHaveBeenCalledTimes(1);
    expect(onAssignMe).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it.each([
    ['Iniciar atención', 'OPEN', 'IN_PROGRESS'],
    ['Poner en espera', 'IN_PROGRESS', 'PENDING'],
    ['Reanudar', 'PENDING', 'IN_PROGRESS'],
  ])('"%s" delega en onStatusChange con %s → %s', async (label, status, esperado) => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn();
    renderRows([row({ status, assigned_to_id: ME })], { onStatusChange });

    await user.click(await screen.findByRole('button', { name: `${label} TCK-000001` }));

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange.mock.calls[0][0]).toMatchObject({ id: 1 });
    expect(onStatusChange.mock.calls[0][1]).toBe(esperado);
  });

  it('mientras la acción está en vuelo el botón y el menú quedan deshabilitados', async () => {
    renderRows([row()], { pendingIds: new Set([1]) });

    // El botón conserva su etiqueta para poder anunciarlo, pero ya no es pulsable.
    expect(await screen.findByRole('button', { name: 'Tomar ticket TCK-000001' })).toBeDisabled();
    // El menú se sustituye por el spinner, así que recupera un nombre accesible.
    expect(screen.queryByRole('button', { name: '⋯' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actualizando TCK-000001' })).toBeDisabled();
  });

  it('bloquear un ticket no bloquea los demás', async () => {
    renderRows(
      [row({ id: 1 }), row({ id: 2, ticket_number: 'TCK-000002' })],
      { pendingIds: new Set([1]) }
    );

    expect(await screen.findByRole('button', { name: 'Tomar ticket TCK-000001' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Tomar ticket TCK-000002' })).toBeEnabled();
    // Sólo queda operable el menú de la fila que no está en vuelo.
    expect(screen.getAllByRole('button', { name: '⋯' })).toHaveLength(1);
  });
});

describe('TicketTable · resolver exige la solución', () => {
  it('"Resolver" abre un diálogo y no llama al backend todavía', async () => {
    const user = userEvent.setup();
    renderRows([row({ status: 'IN_PROGRESS', assigned_to_id: ME })]);

    await user.click(await screen.findByRole('button', { name: 'Resolver TCK-000001' }));

    const dialog = await screen.findByRole('dialog', { name: 'Resolver TCK-000001' });
    expect(within(dialog).getByText('PC no enciende')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Solución \/ trabajo realizado/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Resolver ticket' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('no deja confirmar con la solución vacía', async () => {
    const user = userEvent.setup();
    renderRows([row({ status: 'IN_PROGRESS', assigned_to_id: ME })]);

    await user.click(await screen.findByRole('button', { name: 'Resolver TCK-000001' }));
    const dialog = await screen.findByRole('dialog');
    const campo = within(dialog).getByLabelText(/Solución \/ trabajo realizado/);

    // Sólo espacios: el backend exige `rules.required`, que recorta antes de
    // comprobar, así que el botón tiene que seguir inactivo.
    await user.type(campo, '    ');
    expect(within(dialog).getByRole('button', { name: 'Resolver ticket' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('envía POST /resolve con la solución y nunca un PATCH RESOLVED', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn().mockResolvedValue(undefined);
    renderRows([row({ status: 'IN_PROGRESS', assigned_to_id: ME })], { onStatusChange });

    await user.click(await screen.findByRole('button', { name: 'Resolver TCK-000001' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Solución \/ trabajo realizado/), 'Se cambió la fuente');
    await user.click(within(dialog).getByRole('button', { name: 'Resolver ticket' }));

    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'RESOLVED', {
        resolution: 'Se cambió la fuente',
      })
    );
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'RESOLVED' });
  });

  it('el menú "Marcar resuelto" abre el mismo diálogo, no el de lote', async () => {
    const user = userEvent.setup();
    renderRows([row({ status: 'IN_PROGRESS', assigned_to_id: ME })]);

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Marcar resuelto/ }));

    expect(await screen.findByRole('dialog', { name: 'Resolver TCK-000001' })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('mantiene el diálogo abierto y explica el fallo si el servidor rechaza', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn().mockRejectedValue(new Error('El ticket ya está en un estado terminal'));
    renderRows([row({ status: 'IN_PROGRESS', assigned_to_id: ME })], { onStatusChange });

    await user.click(await screen.findByRole('button', { name: 'Resolver TCK-000001' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Solución \/ trabajo realizado/), 'Prueba');
    await user.click(within(dialog).getByRole('button', { name: 'Resolver ticket' }));

    const aviso = await within(dialog).findByRole('alert');
    expect(aviso).toHaveTextContent('El ticket ya está en un estado terminal');
    // Sigue abierto con lo escrito: el técnico no pierde el texto.
    expect(within(dialog).getByLabelText(/Solución \/ trabajo realizado/)).toHaveValue('Prueba');
  });

  it('no ofrece "Resolver" sin ticket.resolve', async () => {
    renderRows([row({ status: 'IN_PROGRESS', assigned_to_id: ME })], {
      perms: { canManage: true },
    });

    await screen.findByText('TCK-000001');
    expect(screen.queryByRole('button', { name: /Resolver TCK/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Poner en espera TCK-000001' })).toBeInTheDocument();
  });
});

// Cancelar es la otra acción que abre un diálogo con su propio `try/catch`. La
// diferencia con "Resolver" es que el `onSubmit` del diálogo se construía con
// `fire()`, que absorbe el rechazo y devuelve `undefined`: el `catch` del
// diálogo no llegaba a ejecutarse nunca y `onClose()` se llamaba igual, así que
// el técnico cerraba el diálogo creyendo haber cancelado un ticket que el
// servidor ni había tocado. Estas pruebas fijan el comportamiento correcto:
// la promesa tiene que llegar al diálogo, igual que en `ResolveTicketModal`.
describe('TicketTable · cancelar ticket', () => {
  const MOTIVO = 'Duplicado de TCK-000002';
  const FALLO = 'No se puede cancelar un ticket ya cerrado';

  const enProgreso = () => [row({ status: 'IN_PROGRESS', assigned_to_id: ME })];

  // La cancelación vive en el menú ⋯: es la entrada que exige `ticket.update.any`
  // y abre el diálogo con el número del ticket en el título.
  async function abrirDialogo(user) {
    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Cancelar ticket/ }));
    return screen.findByRole('dialog', { name: 'Cancelar TCK-000001' });
  }

  async function confirmar(user, dialog, motivo = MOTIVO) {
    await user.type(within(dialog).getByLabelText(/Motivo de cancelación/), motivo);
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar ticket' }));
  }

  it('el menú abre el diálogo con el número y el motivo vacío, sin llamar al backend', async () => {
    const user = userEvent.setup();
    renderRows(enProgreso(), { onStatusChange: vi.fn() });

    const dialog = await abrirDialogo(user);

    expect(dialog).toBeInTheDocument();
    // El título va entre comillas tipográficas dentro del `<b>`, así que se
    // busca por fragmento y no por igualdad exacta.
    expect(within(dialog).getByText(/PC no enciende/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Motivo de cancelación/)).toHaveValue('');
    // Sin motivo no se puede confirmar: el backend exige `rules.required`.
    expect(within(dialog).getByRole('button', { name: 'Cancelar ticket' })).toBeDisabled();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('envía CANCELLED con el motivo y cierra el diálogo cuando el servidor acepta', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn().mockResolvedValue(undefined);
    renderRows(enProgreso(), { onStatusChange });

    const dialog = await abrirDialogo(user);
    await confirmar(user, dialog);

    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'CANCELLED', {
        reason: MOTIVO,
      })
    );
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    // Comportamiento previo intacto: éxito cierra y no de feedback de error.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancelar TCK-000001' })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('mantiene el diálogo abierto y explica el fallo si el servidor rechaza', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn().mockRejectedValue(new Error(FALLO));
    const onClearError = vi.fn();
    renderRows(enProgreso(), { onStatusChange, onClearError });

    const dialog = await abrirDialogo(user);
    await confirmar(user, dialog);

    // 1. El mensaje aparece DENTRO del diálogo, no sólo en el ErrorBox de la página.
    const aviso = await within(dialog).findByRole('alert');
    expect(aviso).toHaveTextContent(FALLO);
    // 2. Aparece una sola vez: ni se duplica ni se acumula al reintentar.
    expect(within(dialog).getAllByRole('alert')).toHaveLength(1);

    // 3. El diálogo NO se cerró: sigue montado y con el motivo escrito.
    expect(screen.getByRole('dialog', { name: 'Cancelar TCK-000001' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Motivo de cancelación/)).toHaveValue(MOTIVO);

    // 4. El ticket no cambia visualmente: sigue en proceso, no aparece "Cancelado".
    const fila = (await screen.findByText('TCK-000001')).closest('tr');
    expect(within(fila).getByText('En proceso')).toBeInTheDocument();
    expect(within(fila).queryByText('Cancelado')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancelado')).not.toBeInTheDocument();

    // 5. Se avisó a la página para que retire su ErrorBox: con la prop conectada
    //    el mismo fallo no queda representado en dos sitios a la vez. Aquí la
    //    tabla se monta sola, así que la cuenta global de avisos debe ser 1.
    expect(onClearError).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('alert')[0]).toBe(aviso);
  });

  it('funciona igual sin la prop: el error se ve dentro y, además, detrás', async () => {
    // `onClearError` es opcional: quien no la pase conserva el comportamiento
    // anterior, con el mensaje en el diálogo y en el `ErrorBox` de la página.
    // Comprueba que la tabla no depende de ella para funcionar.
    const user = userEvent.setup();
    renderRows(enProgreso(), { onStatusChange: vi.fn().mockRejectedValue(new Error(FALLO)) });

    const dialog = await abrirDialogo(user);
    await confirmar(user, dialog);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(FALLO);
    expect(screen.getByRole('dialog', { name: 'Cancelar TCK-000001' })).toBeInTheDocument();
  });

  it('cerrar a mano tras el fallo descarta el error sin dejar nada detrás', async () => {
    const user = userEvent.setup();
    const onClearError = vi.fn();
    renderRows(enProgreso(), { onStatusChange: vi.fn().mockRejectedValue(new Error(FALLO)), onClearError });

    const dialog = await abrirDialogo(user);
    await confirmar(user, dialog);
    await within(dialog).findByRole('alert');

    await user.click(within(dialog).getByRole('button', { name: 'Volver' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancelar TCK-000001' })).not.toBeInTheDocument());
    // El mensaje pertenecía a esta operación: al cerrar el diálogo desaparece
    // entero y no reaparece un ErrorBox global residual.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onClearError).toHaveBeenCalledTimes(1);
  });

  it('no pide limpiar nada cuando el fallo viene de una acción fuera del diálogo', async () => {
    // `onClearError` pertenece al contexto del diálogo de cancelar. Una acción
    // rápida que falla sigue siendo responsabilidad del `ErrorBox` de la página
    // y no debe pasar por este mecanismo.
    const user = userEvent.setup();
    const onClearError = vi.fn();
    const onAssignMe = vi.fn().mockRejectedValue(new Error('No tiene permiso para asignar tickets'));
    renderRows([row()], { onAssignMe, onClearError });

    await user.click(await screen.findByRole('button', { name: 'Tomar ticket TCK-000001' }));

    await waitFor(() => expect(onAssignMe).toHaveBeenCalledTimes(1));
    expect(onClearError).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('deja el botón disponible para reintentar y cierra si el segundo intento sí funciona', async () => {
    const user = userEvent.setup();
    // El mismo motivo, dos respuestas distintas: primero 500, luego éxito.
    const onStatusChange = vi
      .fn()
      .mockRejectedValueOnce(new Error(FALLO))
      .mockResolvedValueOnce(undefined);
    renderRows(enProgreso(), { onStatusChange });

    const dialog = await abrirDialogo(user);
    await confirmar(user, dialog);

    await within(dialog).findByRole('alert');
    const reintentar = within(dialog).getByRole('button', { name: 'Cancelar ticket' });
    // 5. Se puede volver a pulsar: el diálogo no quedó bloqueado por el fallo.
    await waitFor(() => expect(reintentar).toBeEnabled());
    await user.click(reintentar);

    await waitFor(() => expect(onStatusChange).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancelar TCK-000001' })).not.toBeInTheDocument());
    // El aviso del intento fallido no sobrevive al cierre del diálogo.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('no traga el rechazo: el diálogo recibe la promesa, no un undefined', async () => {
    // El fallo anterior era de contrato, no de estado: `fire()` devolvía
    // `undefined`, así que `await onSubmit(...)` nunca podía lanzar. La única
    // forma de vigilarlo sin montar nada es comprobar que la referencia que se
    // entrega al diálogo es la misma promesa que produce `onStatusChange`.
    const rechazo = Promise.reject(new Error(FALLO));
    // Marcado como manejado desde el principio: aquí sólo se inspecciona, y una
    // promesa rechazada sin captura se reportaría como error no controlado.
    rechazo.catch(() => {});
    const onStatusChange = vi.fn().mockReturnValue(rechazo);
    const ticket = row({ status: 'IN_PROGRESS', assigned_to_id: ME });

    // Equivale a la prop del JSX: `onSubmit={(body) => onStatusChange?.(...)}`.
    const entregado = onStatusChange(ticket, 'CANCELLED', { reason: MOTIVO });

    expect(entregado).toBe(rechazo);
    expect(onStatusChange).toHaveBeenCalledWith(ticket, 'CANCELLED', { reason: MOTIVO });
    await expect(entregado).rejects.toThrow(FALLO);
  });
});
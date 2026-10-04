import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import Layout from './Layout';
import { expectContrast } from '../test/contrast';
import { createQueryClient } from '../test/utils';

const { authState, renders } = vi.hoisted(() => ({
  authState: { user: null },
  // Contadores de render de los dos hijos que cuelgan de Layout: el panel de
  // notificaciones (su JSX lo crea Layout) y la página del Outlet (la crea el
  // enrutador). Sirven para ver qué repinta de verdad el tic del reloj.
  renders: { notifications: 0, page: 0 },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, logout: vi.fn() }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

// El panel de notificaciones abre una conexión SSE: aquí solo interesa el menú.
vi.mock('./Notifications', () => ({
  default: () => {
    renders.notifications += 1;
    return <div>NOTIFICACIONES</div>;
  },
}));

const VIEWER = { id: 1, name: 'Lucía', last_name: 'Pérez', role_name: 'Técnico', permissions: ['kb.view'] };
const MANAGER = { id: 2, name: 'Ana', last_name: 'Díaz', role_name: 'Admin', permissions: ['kb.view', 'kb.manage'] };
const NONE = { id: 3, name: 'Luis', last_name: 'Gómez', role_name: 'Empleado', permissions: ['ticket.create'] };

// La sonda va dentro del router pero fuera de las rutas: así se ve a dónde lleva
// la navegación sin necesitar una pantalla real detrás de la cabecera.
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="ruta">{`${location.pathname}${location.search}`}</p>;
}

function renderLayout(route = '/app') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/app/*" element={<Layout />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Igual que `renderLayout`, pero con una página real detrás del `<Outlet />`:
// cuenta sus renders para comprobar si el tic del reloj la repinta.
function PageProbe() {
  renders.page += 1;
  return <p data-testid="pagina">PAGINA</p>;
}

function renderLayoutConPagina(route = '/app') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/app/*" element={<Layout />}>
            <Route index element={<PageProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const link = (name) => screen.getAllByRole('link', { name })[0];

// Utilidades de la búsqueda del header, compartidas por sus dos bloques de
// pruebas (comportamiento y layout).
const PLACEHOLDER = 'Buscar ticket, usuario o asunto';
const ruta = () => screen.getByTestId('ruta').textContent;
const panel = () => screen.queryByRole('dialog', { name: 'Buscar' });
const openPanel = async (user) => {
  await user.click(screen.getByRole('button', { name: 'Buscar' }));
  return panel();
};
// El campo de escritorio se localiza por su formulario (`hidden md:block`)
// porque el panel usa el mismo `placeholder` y el mismo nombre accesible.
const desktopField = () =>
  screen
    .getAllByPlaceholderText(PLACEHOLDER)
    .map((input) => input.closest('form'))
    .find((form) => form.className.includes('md:block'))
    .querySelector('input');

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = VIEWER;
  renders.notifications = 0;
  renders.page = 0;
  document.documentElement.dataset.theme = 'light';
  localStorage.clear();
});

describe('Layout · tema visual', () => {
  it('alterna el tema y conserva la preferencia local', () => {
    renderLayout();

    const toggle = screen.getByRole('button', { name: 'Activar tema oscuro' });
    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('sifha-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Activar tema claro' })).toBeInTheDocument();
  });
});

// El reloj de la cabecera actualiza cada segundo. Estas pruebas fijan las dos
// caras del asunto: lo que se ve (formato, clases y breakpoint, sin cambios) y
// lo que ya no se repinta con cada tic —ni el resto de la cabecera ni la página
// del Outlet— porque el reloj vive en su propio componente.
describe('Layout · reloj de la cabecera', () => {
  const HORA_FIJA = new Date(2024, 4, 15, 14, 30, 45);
  const HORA = '14:30:45';
  const FECHA = 'miércoles, 15 de mayo';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(HORA_FIJA);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('muestra la hora y la fecha como siempre, y solo a partir de pantallas anchas', () => {
    renderLayout();

    expect(screen.getByText(HORA)).toBeInTheDocument();
    const fecha = screen.getByText(FECHA);
    expect(fecha).toBeInTheDocument();

    // Mismo bloque, mismo sitio y mismo breakpoint que antes: los dos textos
    // cuelgan del grupo de la derecha y solo se ven desde `xl`.
    const bloque = screen.getByText(HORA).parentElement;
    expect(bloque).toHaveClass('mr-1', 'hidden', 'text-right', 'xl:block');
    expect(bloque.parentElement).toHaveClass('ml-auto');
    expect(fecha).toHaveClass('capitalize', 'text-slate-400');
  });

  it('cambia al cumplirse el segundo, ni un tick antes', () => {
    renderLayout();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByText(HORA)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText('14:30:46')).toBeInTheDocument();
    // La fecha solo cambia al día: un tic no la toca.
    expect(screen.getByText(FECHA)).toBeInTheDocument();
  });

  it('limpia su interval al desmontarse', () => {
    const { unmount } = renderLayout();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('no vuelve a renderizar el resto de la cabecera', () => {
    renderLayout();
    expect(renders.notifications).toBe(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Notificaciones es un hijo del JSX de Layout: si Layout se repintara con
    // cada tic, también se repintaría él. Con el reloj aislado no pasa.
    expect(renders.notifications).toBe(1);
  });

  it('no vuelve a renderizar la página del Outlet', () => {
    renderLayoutConPagina();
    expect(renders.page).toBe(1);
    expect(screen.getByTestId('pagina')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(renders.page).toBe(1);
  });
});

describe('Layout · tooltips de la cabecera', () => {
  it('el botón de tema explica su acción en vez de dejar un title nativo', async () => {
    const user = userEvent.setup();
    renderLayout();

    const toggle = screen.getByRole('button', { name: 'Activar tema oscuro' });
    expect(toggle).not.toHaveAttribute('title');

    await user.hover(toggle);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Activar tema oscuro');
  });

  it('el texto del tooltip sigue al estado del tema', async () => {
    const user = userEvent.setup();
    renderLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Activar tema oscuro' }));
    await user.hover(screen.getByRole('button', { name: 'Activar tema claro' }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Activar tema claro');
  });

  it('el botón de cuenta tiene nombre accesible aunque su icono no se anuncie', async () => {
    const user = userEvent.setup();
    renderLayout();

    // Antes el nombre dependía del `title`, que es el último recurso del
    // algoritmo de nombre accesible y no se ve al navegar con teclado.
    const cuenta = screen.getByRole('button', { name: 'Mi cuenta' });
    expect(cuenta).not.toHaveAttribute('title');

    await user.hover(cuenta);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Mi cuenta');
  });

  it('el tooltip se cierra con Escape y no se queda flotando', async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.hover(screen.getByRole('button', { name: 'Mi cuenta' }));
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });
});

// La cabecera institucional es siempre oscura (`#0b0f19` en los dos temas), así
// que el título se comprueba contra ese fondo y no contra la superficie del
// tema: si se comprobara contra `--surface` en tema claro, daría verde y no
// detectaría nada. El fallo era justo ese: `text-slate-800` solo se reescribe a
// un tono claro en tema oscuro (index.css), así que en tema claro el título
// quedaba oscuro sobre la barra oscura.
const TOPBAR = '#0b0f19';

describe('Layout · legibilidad del título de la cabecera', () => {
  const titulo = () => within(screen.getByRole('banner')).getByRole('heading', { level: 1 });

  it('es legible sobre la barra institucional oscura, no solo en tema oscuro', () => {
    renderLayout('/app/knowledge');

    expect(expectContrast(titulo(), { surface: TOPBAR, label: 'título de la cabecera' })).toBeGreaterThanOrEqual(4.5);
  });

  it('mantiene el mismo color al cambiar de tema', () => {
    renderLayout('/app/knowledge');
    const antes = titulo().className;

    fireEvent.click(screen.getByRole('button', { name: 'Activar tema oscuro' }));

    // El tema cambia de verdad... pero el color del título no: la barra no cambia
    // de fondo, así que el título tampoco debe.
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(titulo().className).toBe(antes);
    expect(expectContrast(titulo(), { surface: TOPBAR, label: 'título en tema oscuro' })).toBeGreaterThanOrEqual(4.5);
  });

  it('conserva tipografía, tamaño y recorte en pantallas estrechas', () => {
    renderLayout();

    // El arreglo es solo de color: nada de la maqueta del título se toca.
    expect(titulo()).toHaveClass('text-lg', 'font-semibold', 'truncate', 'min-w-0');
  });
});

describe('Layout · navegación de la base de conocimiento', () => {
  it('muestra "Conocimientos" a quien puede consultar la base', () => {
    renderLayout();

    expect(link('Conocimientos')).toHaveAttribute('href', '/app/knowledge');
    expect(screen.getByText('Principal')).toBeInTheDocument();
  });

  it('oculta la administración a quien solo tiene kb.view', () => {
    renderLayout();

    expect(screen.queryByRole('link', { name: 'Artículos y categorías' })).not.toBeInTheDocument();
  });

  it('muestra la administración solo con kb.manage', () => {
    authState.user = MANAGER;
    renderLayout();

    expect(link('Artículos y categorías')).toHaveAttribute('href', '/app/knowledge/admin');
    expect(link('Conocimientos')).toBeInTheDocument();
  });

  it('no muestra ninguna entrada sin permisos de conocimiento', () => {
    authState.user = NONE;
    renderLayout();

    expect(screen.queryByRole('link', { name: 'Conocimientos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Artículos y categorías' })).not.toBeInTheDocument();
  });

  it('marca la sección activa en el listado, la ficha y el editor', () => {
    authState.user = MANAGER;
    const { unmount } = renderLayout('/app/knowledge');
    expect(link('Conocimientos').className).toContain('app-nav-active');
    unmount();

    const detail = renderLayout('/app/knowledge/5');
    // La ficha pertenece a la sección Conocimientos, no a la de administración.
    expect(link('Conocimientos').className).toContain('app-nav-active');
    expect(link('Artículos y categorías').className).not.toContain('app-nav-active');
    detail.unmount();

    renderLayout('/app/knowledge/5/edit');
    expect(link('Conocimientos').className).toContain('app-nav-active');
  });

  it('marca solo la administración cuando se está administrando', () => {
    authState.user = MANAGER;
    renderLayout('/app/knowledge/admin');

    expect(link('Artículos y categorías').className).toContain('app-nav-active');
    expect(link('Conocimientos').className).not.toContain('app-nav-active');
  });

  it('titula la cabecera según la página de conocimientos', () => {
    const { unmount } = renderLayout('/app/knowledge');
    expect(screen.getByRole('heading', { level: 1, name: 'Base de conocimiento' })).toBeInTheDocument();
    unmount();

    const detail = renderLayout('/app/knowledge/5');
    expect(screen.getByRole('heading', { level: 1, name: 'Artículo' })).toBeInTheDocument();
    detail.unmount();

    renderLayout('/app/knowledge/5/edit');
    expect(screen.getByRole('heading', { level: 1, name: 'Editar artículo' })).toBeInTheDocument();
  });
});

// jsdom no mide nada, así que el contrato responsive del panel se comprueba por
// su estructura, que es lo que garantiza que no se salga: capa de ancho completo
// pegada a los dos bordes del header (`inset-x-0`), padding lateral, tarjeta
// `w-full` con tope de ancho y anclaje vertical justo bajo la barra (`top-full`).
// Nada de eso depende de la posición de la lupa ni de un ancho concreto.
describe('Layout · el panel de búsqueda no se sale del viewport', () => {
  it('se ancla a la barra por los dos bordes, no a la lupa', async () => {
    const user = userEvent.setup();
    renderLayout();

    await openPanel(user);

    const tarjeta = screen.getByRole('dialog', { name: 'Buscar' });
    // Sigue siendo hijo del header: visualmente cuelga de la barra, no flota.
    expect(screen.getByRole('banner')).toContainElement(tarjeta);

    const capa = tarjeta.parentElement;
    // `inset-x-0` = borde izquierdo y derecho del header a la vez: estructuralmente
    // el panel no puede salirse por la izquierda, diga lo que diga el ancho.
    expect(capa).toHaveClass('absolute', 'inset-x-0', 'top-full');
    // Margen lateral y centrado en pantallas anchas.
    expect(capa.className).toMatch(/\bpx-/);
    expect(capa).toHaveClass('justify-center');
    // `w-full` = nunca más ancha que su capa; `max-w` = tope en móvil grande.
    expect(tarjeta).toHaveClass('w-full', 'max-w-[22rem]');
    // Y sin unidades de viewport: `100vw` con scrollbar mide más que lo visible.
    expect(capa.className).not.toMatch(/vw/);
    expect(tarjeta.className).not.toMatch(/vw/);
  });

  it('conserva el cierre, el foco y la búsqueda dentro del panel movido', async () => {
    const user = userEvent.setup();
    renderLayout();

    const dialog = await openPanel(user);
    expect(within(dialog).getByLabelText('Buscar')).toHaveFocus();

    await user.type(within(dialog).getByLabelText('Buscar'), 'pc');
    expect(desktopField()).toHaveValue('pc');

    // La ✕, el clic exterior y el envío siguen funcionando igual.
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar búsqueda' }));
    expect(panel()).toBeNull();
    expect(screen.getByRole('button', { name: 'Buscar' })).toHaveFocus();
  });
});

// La búsqueda del escritorio se oculta por debajo de `md`, así que el móvil se
// queda sin acceso a buscar. Estas pruebas cubren el botón y su panel, y una
// comprueba aparte que el formulario de escritorio sigue como estaba.
describe('Layout · búsqueda del móvil', () => {
  it('añade un acceso que solo existe en móvil y no toca el de escritorio', () => {
    renderLayout();

    const toggle = screen.getByRole('button', { name: 'Buscar' });
    // `md:hidden` va en el contenedor del botón + el `hidden md:block` del
    // formulario de escritorio: en cada tamaño hay exactamente un campo, y en el
    // grande sigue siendo el de antes, con su sitio de siempre.
    expect(toggle.parentElement).toHaveClass('md:hidden');
    expect(desktopField().closest('form').className).toContain('hidden md:block');
    expect(panel()).toBeNull();
  });

  it('abre el panel, nombra el campo y le da el foco', async () => {
    const user = userEvent.setup();
    renderLayout();

    const dialog = await openPanel(user);

    // Foco en el campo: en el móvil es lo único accionable y así el teclado sube
    // sin tocar nada más.
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Buscar')).toHaveFocus();
    // Botón y panel se anuncian como un control desplegable, no como dos piezas
    // sueltas: el botón dice si está abierto y a qué panel pertenece.
    const toggle = screen.getByRole('button', { name: 'Buscar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', dialog.id);
    expect(within(dialog).getByLabelText('Buscar')).toHaveAttribute('placeholder', PLACEHOLDER);
  });

  it('escribe en el mismo campo de escritorio: la lógica es una sola', async () => {
    const user = userEvent.setup();
    renderLayout();

    const dialog = await openPanel(user);
    await user.type(within(dialog).getByLabelText('Buscar'), 'pc');

    // No hay dos búsquedas: un solo estado `q` detrás de los dos campos.
    expect(desktopField()).toHaveValue('pc');
  });

  it('el formulario de escritorio sigue enviando a donde siempre', async () => {
    renderLayout();

    // La búsqueda de escritorio no se toca: mismo campo, mismo envío.
    fireEvent.change(desktopField(), { target: { value: 'impresora' } });
    fireEvent.submit(desktopField().closest('form'));

    expect(ruta()).toBe('/app/my-tickets?search=impresora');
  });

  it('envía a la misma pantalla que el buscador de escritorio', async () => {
    const user = userEvent.setup();
    renderLayout();

    // VIEWER no tiene `ticket.view.all`: el destino es "Mis tickets", el mismo
    // que elegiría el formulario de escritorio con el mismo término.
    const dialog = await openPanel(user);
    await user.type(within(dialog).getByLabelText('Buscar'), 'PC no enciende{Enter}');

    expect(ruta()).toBe('/app/my-tickets?search=PC%20no%20enciende');
    // El panel se retira para no tapar los resultados.
    expect(panel()).toBeNull();
  });

  it('envía a la bandeja quien puede ver todos los tickets', async () => {
    authState.user = { ...MANAGER, permissions: ['kb.view', 'ticket.view.all'] };
    const user = userEvent.setup();
    renderLayout();

    const dialog = await openPanel(user);
    await user.type(within(dialog).getByLabelText('Buscar'), 'impresora{Enter}');

    expect(ruta()).toBe('/app/inbox?search=impresora');
  });

it('funciona solo con el teclado: abrir, escribir, enviar y volver al botón', async () => {
    const user = userEvent.setup();
    renderLayout();

    const toggle = screen.getByRole('button', { name: 'Buscar' });
    toggle.focus();
    expect(toggle).toHaveFocus();

    await user.keyboard('{Enter}');
    // Se acota al panel: el campo de escritorio sigue ahí, con el mismo nombre.
    expect(within(panel()).getByLabelText('Buscar')).toHaveFocus();
    await user.keyboard('monitor{Enter}');

    expect(ruta()).toBe('/app/my-tickets?search=monitor');
    expect(panel()).toBeNull();
    // Tras enviar, el foco vuelve al botón: la búsqueda se puede repetir sin
    // recorrer la cabecera.
    expect(toggle).toHaveFocus();
  });

  it('la lupa también cierra el panel si se vuelve a pulsar', async () => {
    const user = userEvent.setup();
    renderLayout();

    await openPanel(user);
    await user.click(screen.getByRole('button', { name: 'Buscar' }));

    expect(panel()).toBeNull();
  });

  it('Escape cierra el panel y devuelve el foco al botón', async () => {
    const user = userEvent.setup();
    renderLayout();

    const dialog = await openPanel(user);
    await user.keyboard('{Escape}');

    expect(panel()).toBeNull();
    // El foco vuelve al botón que lo abrió: si no, el usuario de teclado se
    // queda en el cuerpo de la página y tiene que recorrer la cabecera entera.
    expect(screen.getByRole('button', { name: 'Buscar' })).toHaveFocus();
    expect(dialog).not.toBeInTheDocument();
  });

  it('la ✕ del campo también cierra, y es un cierre accesible', async () => {
    const user = userEvent.setup();
    renderLayout();

    const dialog = await openPanel(user);
    // Con el panel abierto hay dos botones con ese nombre: el propio y la ✕.
    // Se acota al panel para no cerrar por el que no es.
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar búsqueda' }));

    expect(panel()).toBeNull();
    expect(screen.getByRole('button', { name: 'Buscar' })).toHaveFocus();
  });

  it('un clic fuera lo cierra sin robar el foco', async () => {
    const user = userEvent.setup();
    renderLayout();

    await openPanel(user);
    await user.click(screen.getByRole('heading', { level: 1 }));

    expect(panel()).toBeNull();
    // Quien cierra tocando la página no espera que le devuelvan el foco a la
    // barra: se lo queda el elemento que ha pulsado.
    expect(screen.getByRole('button', { name: 'Buscar' })).not.toHaveFocus();
  });

  it('Escape solo es suyo: con el panel cerrado no toca el menú móvil', () => {
    renderLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir menú' }));
    // El sidebar de escritorio siempre está en el DOM; el móvil lo duplica al
    // abrirse, así que dos enlaces del mismo nombre lo delatan.
    expect(screen.getAllByRole('link', { name: 'Mis tickets' })).toHaveLength(2);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.getAllByRole('link', { name: 'Mis tickets' })).toHaveLength(2);
  });

  it('se cierra al cambiar de página, para no quedar encima del contenido', async () => {
    const user = userEvent.setup();
    renderLayout();

    await openPanel(user);
    fireEvent.click(link('Conocimientos'));

    expect(ruta()).toBe('/app/knowledge');
    expect(panel()).toBeNull();
  });

  it('no choca con el tema: cambia el tema y conserva el término', async () => {
    const user = userEvent.setup();
    renderLayout();

    const dialog = await openPanel(user);
    await user.type(within(dialog).getByLabelText('Buscar'), 'pc');

    // El conmutador está fuera del panel, así que se comporta como cualquier
    // clic exterior: cambia el tema y cierra el panel, sin romperse nada.
    await user.click(screen.getByRole('button', { name: 'Activar tema oscuro' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(panel()).toBeNull();

    // El término vive en el estado de la cabecera, no en el panel: al reabrirlo
    // sigue ahí y no se ha perdido nada.
    const again = await openPanel(user);
    expect(within(again).getByLabelText('Buscar')).toHaveValue('pc');
  });

  it('se pinta con las superficies del tema, no con colores fijos', async () => {
    const user = userEvent.setup();
    renderLayout();

    const dialog = await openPanel(user);

    // `panel-glass` y `input` son las clases con tokens de los dos temas: el panel
    // y el campo cambian de superficie con el tema sin reglas espejo.
    expect(dialog).toHaveClass('panel-glass', 'nex-pop');
    expect(within(dialog).getByLabelText('Buscar')).toHaveClass('input');
  });
});

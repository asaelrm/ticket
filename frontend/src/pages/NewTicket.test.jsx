import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import NewTicket from './NewTicket';
import { api } from '../lib/api';
import { createQueryClient, renderWithProviders, pickOption, optionLabels } from '../test/utils';

const { authState } = vi.hoisted(() => ({
  authState: { user: null },
}));

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

const USER = { id: 5, name: 'Javier', department_id: 3, department_name: 'TI', permissions: [] };

function renderWithNavigation(ui, { route }) {
  const client = createQueryClient();
  return {
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/new-ticket" element={ui} />
            <Route path="/app/my-tickets/:id" element={<p>Creación OK</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    ),
    queryClient: client,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = USER;
  api.get.mockImplementation((url) => {
    if (url === '/api/categories?active=1') return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }, { id: 2, name: 'Software' }] });
    if (url === '/api/departments?active=1') return Promise.resolve({ data: [{ id: 3, name: 'TI' }, { id: 4, name: 'Contabilidad' }] });
    return Promise.reject(new Error(`404 ${url}`));
  });
  api.post.mockResolvedValue({ ticket: { id: 42 } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NewTicket', () => {
  it('renderiza el formulario y preselecciona el departamento del usuario', async () => {
    renderWithProviders(<NewTicket />, { route: '/new-ticket' });

    expect(await screen.findByLabelText(/Título/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Categoría/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Prioridad/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Descripción detallada/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crear ticket' })).toBeInTheDocument();

    // El valor numérico vive en el rótulo del control, no en un atributo `value`.
    expect(screen.getByLabelText(/^Departamento$/)).toHaveTextContent('TI');
    expect(screen.getByText(/Por defecto se usa su departamento \(TI\)/)).toBeInTheDocument();
  });

  it('la categoría no ofrece opción vacía porque el <select> la tenía deshabilitada', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewTicket />, { route: '/new-ticket' });
    await screen.findByLabelText(/Título/);

    const category = screen.getByLabelText(/Categoría/);
    expect(await optionLabels(user, category)).toEqual(['Hardware', 'Software']);
    // El `required` del `<select>` era inerte (`noValidate`); el rótulo inicial
    // se mantiene como `placeholder` y el backend sigue validando.
    expect(category).toHaveTextContent('Seleccione…');
    expect(category).toHaveAttribute('data-placeholder', 'true');
  });

  it('el departamento vuelve a "Sin departamento" y lo envía vacío', async () => {
    const user = userEvent.setup();
    renderWithNavigation(<NewTicket />, { route: '/new-ticket' });

    // El departamento venía preseleccionado y su `<option value="">` era
    // seleccionable, así que se podía quitar sin recargar la pantalla.
    const department = await screen.findByLabelText(/^Departamento$/);
    expect(department).toHaveTextContent('TI');
    expect(await optionLabels(user, department)).toEqual(['Sin departamento', 'TI', 'Contabilidad']);
    await pickOption(user, department, 'Sin departamento');
    expect(department).toHaveTextContent('Sin departamento');

    await user.type(screen.getByLabelText(/Título/), 'Sin departamento');
    await pickOption(user, screen.getByLabelText(/Categoría/), 'Hardware');
    await user.type(screen.getByLabelText(/Descripción detallada/), 'Prueba');
    await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets', null, expect.any(FormData)));
    const [, , fd] = api.post.mock.calls.find(([url]) => url === '/api/tickets');
    // El `FormData` se arma a mano y solo añade el campo si tiene valor, así que
    // sin departamento el campo no viaja: igual que con el `<select>` nativo.
    expect(fd.get('department_id')).toBeNull();
  });

  it('rechaza archivos demasiado grandes sin crear el ticket', async () => {
    const { container } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
    await screen.findByLabelText(/Título/);

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [{ name: 'big.pdf', size: 6 * 1024 * 1024, type: 'application/pdf' }] } });

    expect(screen.getByRole('alert')).toHaveTextContent('Archivos demasiado grandes: big.pdf. Máximo 5 MB por archivo.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('crea el ticket con los datos del formulario y navega al detalle', async () => {
    const user = userEvent.setup();
    renderWithNavigation(<NewTicket />, { route: '/new-ticket' });

    await user.type(await screen.findByLabelText(/Título/), 'No puedo imprimir');
    await pickOption(user, screen.getByLabelText(/Categoría/), 'Hardware');
    await user.type(screen.getByLabelText(/Descripción detallada/), 'La impresora no responde');
    await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

    expect(await screen.findByText('Creación OK')).toBeInTheDocument();

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets', null, expect.any(FormData)));
    const [, , fd] = api.post.mock.calls.find(([url]) => url === '/api/tickets');
    expect(fd.get('title')).toBe('No puedo imprimir');
    expect(fd.get('description')).toBe('La impresora no responde');
    expect(fd.get('category_id')).toBe('1');
    expect(fd.get('department_id')).toBe('3');
    expect(fd.get('priority')).toBe('MEDIUM');
  });

  it('muestra el error de la API y deja reintentar', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new Error('No se pudo crear el ticket'));

    renderWithProviders(<NewTicket />, { route: '/new-ticket' });
    await user.type(await screen.findByLabelText(/Título/), 'Sin conexión a red');
    await pickOption(user, screen.getByLabelText(/Categoría/), 'Hardware');
    await user.type(screen.getByLabelText(/Descripción detallada/), 'No tengo internet');
    await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo crear el ticket');
    expect(screen.getByRole('button', { name: 'Crear ticket' })).toBeEnabled();
  });

  it('no restringe el acceso por permisos en el cliente', async () => {
    authState.user = { id: 5, department_id: 3, permissions: [] };

    renderWithProviders(<NewTicket />, { route: '/new-ticket' });
    expect(await screen.findByLabelText(/Título/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crear ticket' })).toBeInTheDocument();
  });

  it('libera la URL de la miniatura al quitar el archivo y al desmontar', async () => {
    // Regresión de memoria: antes se creaba la URL en el render y solo se
    // revocaba en onLoad, de modo que una imagen que se quitaba o se
    // desmontaba antes de cargar retenía el File y su URL en blobs.
    const revoked = [];
    const createObjectURL = vi.fn(() => `blob:mock/${createObjectURL.mock.calls.length}`);
    const revokeObjectURL = vi.fn((u) => revoked.push(u));
    // Se sustituye la referencia global en vez de mutar URL, para no dejar
    // createObjectURL/revokeObjectURL falsos en el resto del fichero.
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    const { container, unmount } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
    await screen.findByLabelText(/Título/);
    const input = container.querySelector('input[type="file"]');

    fireEvent.change(input, {
      target: { files: [new File(['x'], 'captura.png', { type: 'image/png' })] },
    });

    // alt="" hace que la miniatura no exponga el rol img, así que se busca el
    // nodo directamente.
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(container.querySelector('img').getAttribute('src')).toBe('blob:mock/1');
    // La imagen no se ha "cargado": onLoad nunca llega a dispararse en un
    // entorno sin descarga real, que es justo cuando la URL se quedaba viva.
    expect(revokeObjectURL).not.toHaveBeenCalled();

    // Quitar el archivo desmonta la miniatura y debe liberar su URL.
    fireEvent.click(screen.getByRole('button', { name: 'Quitar archivo' }));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock/1'));
    expect(container.querySelector('img')).toBeNull();

    // Y al desmontar el formulario entero.
    fireEvent.change(input, {
      target: { files: [new File(['y'], 'otra.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(container.querySelector('img').getAttribute('src')).toBe('blob:mock/2');

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock/2');
    expect(revoked).toEqual(['blob:mock/1', 'blob:mock/2']);
  });

  // Archivos de prueba sin imagen a propósito: las miniaturas de las imágenes
  // necesitan `URL.createObjectURL`, que aquí no existe. El límite de cantidad
  // y el de tamaño no dependen del tipo, así que el PDF sirve para todos los
  // casos de cantidad.
  // Se usan `File` de verdad (y no objetos sueltos) para que su nombre siga
  // viajeando en el `FormData` del POST. El tamaño va en MB; el límite del
  // formulario son 5 MB.
  function adjunto(name, sizeMb = 0.1) {
    return new File([new Uint8Array(Math.round(sizeMb * 1024 * 1024))], name, { type: 'application/pdf' });
  }

  async function rellenarFormulario(user, { title = 'No puedo imprimir', categoria = true, descripcion = 'La impresora no responde' } = {}) {
    if (title) await user.type(screen.getByLabelText(/Título/), title);
    if (categoria) await pickOption(user, screen.getByLabelText(/Categoría/), 'Hardware');
    if (descripcion) await user.type(screen.getByLabelText(/Descripción detallada/), descripcion);
  }

  function inputDeArchivos(container) {
    return container.querySelector('input[type="file"]');
  }

  function nombresDeArchivos() {
    return screen.queryAllByRole('button', { name: 'Quitar archivo' }).length;
  }

  function textoDeArchivo(name) {
    return screen.getByText(name);
  }

  describe('validación antes de enviar', () => {
    it('no envía el POST y muestra el error inline si falta el título', async () => {
      const user = userEvent.setup();
      renderWithNavigation(<NewTicket />, { route: '/new-ticket' });

      // Se rellena todo menos el título.
      await user.type(await screen.findByLabelText(/Descripción detallada/), 'La impresora no responde');
      await pickOption(user, screen.getByLabelText(/Categoría/), 'Hardware');
      await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

      expect(screen.getByText('Título es obligatorio')).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();

      // El error va junto a su campo, no en el aviso general de la API.
      const title = screen.getByLabelText(/Título/);
      expect(title).toHaveAttribute('aria-invalid', 'true');
      expect(title).toHaveAttribute('aria-describedby', 'title-error');
      expect(document.getElementById('title-error')).toHaveTextContent('Título es obligatorio');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // Los demás valores siguen intactos.
      expect(screen.getByLabelText(/Categoría/)).toHaveTextContent('Hardware');
      expect(screen.getByLabelText(/Descripción detallada/)).toHaveValue('La impresora no responde');
    });

    it('marca todos los campos vacíos y lleva el foco al primero', async () => {
      const user = userEvent.setup();
      renderWithNavigation(<NewTicket />, { route: '/new-ticket' });

      await screen.findByLabelText(/Título/);
      await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

      expect(screen.getByText('Título es obligatorio')).toBeInTheDocument();
      expect(screen.getByText('Categoría es obligatorio')).toBeInTheDocument();
      expect(screen.getByText('Descripción es obligatorio')).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();

      // El foco va al primer campo en el orden del formulario.
      expect(screen.getByLabelText(/Título/)).toHaveFocus();
      expect(screen.getByLabelText(/Categoría/)).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText(/Descripción detallada/)).toHaveAttribute('aria-invalid', 'true');
    });

    it('lleva el foco al primer campo pendiente cuando el título ya está bien', async () => {
      const user = userEvent.setup();
      renderWithNavigation(<NewTicket />, { route: '/new-ticket' });

      await user.type(await screen.findByLabelText(/Título/), 'No puedo imprimir');
      await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

      // Ya no hay error de título: el foco salta a la categoría, que es el
      // siguiente control del formulario.
      expect(screen.queryByText('Título es obligatorio')).not.toBeInTheDocument();
      expect(screen.getByLabelText(/Categoría/)).toHaveFocus();
      expect(screen.getByText('Descripción es obligatorio')).toBeInTheDocument();
    });

    it('deja enviar en cuanto se corrigen los campos', async () => {
      const user = userEvent.setup();
      renderWithNavigation(<NewTicket />, { route: '/new-ticket' });

      await user.type(await screen.findByLabelText(/Título/), 'No puedo imprimir');
      await user.click(screen.getByRole('button', { name: 'Crear ticket' }));
      expect(api.post).not.toHaveBeenCalled();

      // El error del campo desaparece al corregirlo, sin tocar el botón.
      await pickOption(user, screen.getByLabelText(/Categoría/), 'Hardware');
      expect(screen.queryByText('Categoría es obligatorio')).not.toBeInTheDocument();

      await user.type(screen.getByLabelText(/Descripción detallada/), 'La impresora no responde');
      expect(screen.queryByText('Descripción es obligatorio')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Crear ticket' })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

      expect(await screen.findByText('Creación OK')).toBeInTheDocument();
      const [, , fd] = api.post.mock.calls.find(([url]) => url === '/api/tickets');
      expect(fd.get('title')).toBe('No puedo imprimir');
      expect(fd.get('category_id')).toBe('1');
      expect(fd.get('description')).toBe('La impresora no responde');
    });

    it('conserva los adjuntos y los datos escritos tras un envío inválido', async () => {
      const user = userEvent.setup();
      const { container } = renderWithNavigation(<NewTicket />, { route: '/new-ticket' });

      await user.type(await screen.findByLabelText(/Título/), 'No puedo imprimir');
      fireEvent.change(inputDeArchivos(container), {
        target: { files: [adjunto('contrato.pdf'), adjunto('foto.pdf')] },
      });
      expect(nombresDeArchivos()).toBe(2);

      // Falta la descripción: no se envía nada.
      await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

      expect(screen.getByText('Descripción es obligatorio')).toBeInTheDocument();
      expect(screen.getByText('Categoría es obligatorio')).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();

      // Ni el texto ni los adjuntos se pierden.
      expect(screen.getByLabelText(/Título/)).toHaveValue('No puedo imprimir');
      expect(textoDeArchivo('contrato.pdf')).toBeInTheDocument();
      expect(textoDeArchivo('foto.pdf')).toBeInTheDocument();

      // Corregido lo que faltaba, el envío sale con los adjuntos intactos.
      await pickOption(user, screen.getByLabelText(/Categoría/), 'Hardware');
      await user.type(screen.getByLabelText(/Descripción detallada/), 'La impresora no responde');
      await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
      const [, , fd] = api.post.mock.calls.find(([url]) => url === '/api/tickets');
      expect(fd.getAll('files').map((f) => f.name)).toEqual(['contrato.pdf', 'foto.pdf']);
    });

    it('pinta junto a su campo los errores de validación que devuelve el servidor', async () => {
      const user = userEvent.setup();
      // `err.fields` es la validación por campo del backend. Antes se mostraba su
      // mensaje en crudo ("Validation failed"); ahora cada uno va a su campo.
      const err = new Error('Validation failed');
      err.fields = { title: 'Título es obligatorio' };
      api.post.mockRejectedValue(err);

      renderWithProviders(<NewTicket />, { route: '/new-ticket' });
      await user.type(await screen.findByLabelText(/Título/), 'x');
      await pickOption(user, screen.getByLabelText(/Categoría/), 'Hardware');
      await user.type(screen.getByLabelText(/Descripción detallada/), 'y');
      await user.click(screen.getByRole('button', { name: 'Crear ticket' }));

      expect(await screen.findByText('Título es obligatorio')).toBeInTheDocument();
      expect(screen.queryByText('Validation failed')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Crear ticket' })).toBeEnabled();
    });
  });

  describe('límite de adjuntos', () => {
    it('conserva todos los archivos hasta el máximo y no avisa de exceso', async () => {
      const { container } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
      await screen.findByLabelText(/Título/);

      fireEvent.change(inputDeArchivos(container), {
        target: { files: [1, 2, 3, 4, 5].map((n) => adjunto(`doc${n}.pdf`)) },
      });

      expect(nombresDeArchivos()).toBe(5);
      for (const n of [1, 2, 3, 4, 5]) expect(textoDeArchivo(`doc${n}.pdf`)).toBeInTheDocument();
      // Llegar justo al máximo no es un error.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('agrega sólo los permitidos y avisa al pasarse de MAX_FILES de una vez', async () => {
      const { container } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
      await screen.findByLabelText(/Título/);

      // 7 de golpe con MAX_FILES = 5.
      fireEvent.change(inputDeArchivos(container), {
        target: { files: [1, 2, 3, 4, 5, 6, 7].map((n) => adjunto(`doc${n}.pdf`)) },
      });

      expect(nombresDeArchivos()).toBe(5);
      // Nada se descarta en silencio: el aviso dice el límite y qué quedó fuera.
      const aviso = screen.getByRole('alert');
      expect(aviso).toHaveTextContent('Máximo 5 archivos por ticket');
      expect(aviso).toHaveTextContent('No se agregaron 2 archivos: doc6.pdf, doc7.pdf');
      for (const n of [1, 2, 3, 4, 5]) expect(textoDeArchivo(`doc${n}.pdf`)).toBeInTheDocument();
      expect(screen.queryByText('doc6.pdf')).not.toBeInTheDocument();
      expect(screen.queryByText('doc7.pdf')).not.toBeInTheDocument();
    });

    it('avisa en singular cuando sólo sobra un archivo', async () => {
      const { container } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
      await screen.findByLabelText(/Título/);

      fireEvent.change(inputDeArchivos(container), {
        target: { files: [1, 2, 3, 4, 5, 6].map((n) => adjunto(`doc${n}.pdf`)) },
      });

      expect(nombresDeArchivos()).toBe(5);
      expect(screen.getByRole('alert')).toHaveTextContent('No se agregó doc6.pdf');
    });

    it('respeta el máximo al añadir a archivos que ya estaban', async () => {
      const { container } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
      await screen.findByLabelText(/Título/);

      // 4 previos…
      fireEvent.change(inputDeArchivos(container), {
        target: { files: [1, 2, 3, 4].map((n) => adjunto(`previo${n}.pdf`)) },
      });
      expect(nombresDeArchivos()).toBe(4);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // …y 3 más: sólo entra 1 y se avisa de los 2 sobrantes.
      fireEvent.change(inputDeArchivos(container), {
        target: { files: [5, 6, 7].map((n) => adjunto(`extra${n}.pdf`)) },
      });

      expect(nombresDeArchivos()).toBe(5);
      expect(textoDeArchivo('previo4.pdf')).toBeInTheDocument();
      expect(textoDeArchivo('extra5.pdf')).toBeInTheDocument();
      const aviso = screen.getByRole('alert');
      expect(aviso).toHaveTextContent('Máximo 5 archivos por ticket');
      expect(aviso).toHaveTextContent('No se agregaron 2 archivos: extra6.pdf, extra7.pdf');
    });

    it('quitar un archivo libera espacio para volver a agregar', async () => {
      const { container } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
      await screen.findByLabelText(/Título/);

      fireEvent.change(inputDeArchivos(container), {
        target: { files: [1, 2, 3, 4, 5].map((n) => adjunto(`doc${n}.pdf`)) },
      });
      expect(nombresDeArchivos()).toBe(5);

      // Sin hueco: el nuevo se avisa y no se agrega.
      fireEvent.change(inputDeArchivos(container), { target: { files: [adjunto('extra.pdf')] } });
      expect(nombresDeArchivos()).toBe(5);
      expect(screen.getByRole('alert')).toHaveTextContent('No se agregó extra.pdf');

      // Al quitar uno, el hueco se reutiliza y el aviso se va.
      await userEvent.setup().click(screen.getAllByRole('button', { name: 'Quitar archivo' })[0]);
      expect(nombresDeArchivos()).toBe(4);
      fireEvent.change(inputDeArchivos(container), { target: { files: [adjunto('extra.pdf')] } });

      expect(nombresDeArchivos()).toBe(5);
      expect(textoDeArchivo('extra.pdf')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('sigue rechazando los archivos demasiado grandes y lo dice', async () => {
      const { container } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
      await screen.findByLabelText(/Título/);

      fireEvent.change(inputDeArchivos(container), {
        target: { files: [adjunto('grande.pdf', 6)] },
      });

      // Mismo criterio y mismo comienzo de mensaje que antes; ahora se aclara
      // que no se agregó nada, para que la selección no parezca aceptada.
      const aviso = screen.getByRole('alert');
      expect(aviso).toHaveTextContent('Archivos demasiado grandes: grande.pdf. Máximo 5 MB por archivo.');
      expect(aviso).toHaveTextContent('No se agregó ningún archivo.');
      expect(nombresDeArchivos()).toBe(0);
    });

    it('con un archivo grande y la lista llena explica el tamaño, no la cantidad', async () => {
      const { container } = renderWithProviders(<NewTicket />, { route: '/new-ticket' });
      await screen.findByLabelText(/Título/);

      // 5 archivos ya en la lista (sin espacio) y una selección con un grande y
      // otro válido. Manda el tamaño, igual que antes, y el aviso no promete que
      // se haya agregado algo.
      fireEvent.change(inputDeArchivos(container), {
        target: { files: [1, 2, 3, 4, 5].map((n) => adjunto(`doc${n}.pdf`)) },
      });
      fireEvent.change(inputDeArchivos(container), {
        target: { files: [adjunto('valido.pdf'), adjunto('grande.pdf', 6)] },
      });

      expect(nombresDeArchivos()).toBe(5);
      const aviso = screen.getByRole('alert');
      expect(aviso).toHaveTextContent('Archivos demasiado grandes: grande.pdf');
      expect(aviso).toHaveTextContent('No se agregó ningún archivo.');
      // El archivo válido tampoco entró: el aviso lo dice, no se insinúa lo contrario.
      expect(screen.queryByText('valido.pdf')).not.toBeInTheDocument();
    });
  });
});
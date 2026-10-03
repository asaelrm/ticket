import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ErrorBoundary from './ErrorBoundary';

function renderBoundary(ui, { route = '/app' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ErrorBoundary>{ui}</ErrorBoundary>
    </MemoryRouter>
  );
}

/**
 * Pantalla que falla mientras el módulo marque `fallo`, como la real.
 *
 * El estado vive fuera del componente a propósito: al reintentar, React vuelve
 * a pintar el mismo elemento con las mismas props, así que un fallo guardado en
 * una prop se repetiría siempre. Un fallo transitorio —un chunk que no se pudo
 * cargar y ya sí, un dato que aún no había llegado— se comporta como aquí.
 */
let fallo = false;
function Pantalla() {
  if (fallo) throw new Error('fallo al pintar');
  return <p>Pantalla correcta</p>;
}

let consoleError;
beforeEach(() => {
  fallo = true;
  // React registra en consola cualquier error capturado por el boundary, y el
  // propio boundary lo deja registrado a propósito. Aquí se silencia para no
  // ensuciar la salida, y se comprueba aparte con `it('registra el fallo')`.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  fallo = false;
});

describe('ErrorBoundary', () => {
  it('deja pasar los hijos mientras todo vaya bien', () => {
    fallo = false;
    renderBoundary(<Pantalla />);

    expect(screen.getByText('Pantalla correcta')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Algo ha ido mal' })).not.toBeInTheDocument();
  });

  it('ofrece una salida cuando una pantalla lanza al pintarse', () => {
    renderBoundary(<Pantalla />);

    expect(screen.getByRole('heading', { level: 1, name: 'Algo ha ido mal' })).toBeInTheDocument();
    expect(screen.getByText(/Se ha producido un error inesperado/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/app');
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    // El logotipo mantiene la identidad aunque la aplicación no llegara a
    // pintar su cabecera.
    expect(screen.getByAltText('SIFHA')).toBeInTheDocument();
    expect(screen.queryByText('Pantalla correcta')).not.toBeInTheDocument();
  });

  it('no inventa un código de error HTTP, que aquí no describe lo ocurrido', () => {
    renderBoundary(<Pantalla />);

    expect(screen.queryByText('404')).not.toBeInTheDocument();
    expect(screen.queryByText('500')).not.toBeInTheDocument();
  });

  it('"Reintentar" vuelve a montar la pantalla cuando el fallo ya no se repite', async () => {
    renderBoundary(<Pantalla />);
    expect(screen.getByRole('heading', { name: 'Algo ha ido mal' })).toBeInTheDocument();

    fallo = false;
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(screen.getByText('Pantalla correcta')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Algo ha ido mal' })).not.toBeInTheDocument();
  });

  it('registra el fallo para que quede diagnosticado', () => {
    renderBoundary(<Pantalla />);

    // Sin esto el error desaparecería en producción y no habría forma de saber
    // qué pantalla lo provocó.
    const registrado = consoleError.mock.calls.some((args) =>
      args.some((arg) => typeof arg?.message === 'string' && arg.message.includes('fallo al pintar'))
    );
    expect(registrado).toBe(true);
  });

  it('el fallo queda registrado con el origen en el árbol de React', () => {
    renderBoundary(<Pantalla />);

    const delBoundary = consoleError.mock.calls.find((args) => String(args[0]).includes('[SIFHA]'));
    expect(delBoundary).toBeDefined();
    expect(String(delBoundary?.[2] || '')).toMatch(/Pantalla/);
  });
});
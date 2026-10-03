import React from 'react';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import NotFound from './NotFound';

function LocationProbe() {
  return <p data-testid="ruta">{useLocation().pathname}</p>;
}

function renderNotFound({ entries = ['/no-existe'], embedded = false } = {}) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <Routes>
        <Route path="*" element={<><NotFound embedded={embedded} /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  // Punto de partida: el usuario ha cargado esta dirección directamente, sin
  // venir de ninguna otra. Es el estado de `history.state` que deja el
  // navegador en la primera entrada.
  window.history.replaceState(null, '', '/');
});

afterAll(() => {
  window.history.replaceState(null, '', '/');
});

describe('NotFound · mensaje y salidas', () => {
  it('explica qué ha pasado y ofrece volver al inicio', () => {
    renderNotFound();

    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Página no encontrada' })).toBeInTheDocument();
    expect(screen.getByText(/La dirección solicitada no existe en SIFHA/)).toBeInTheDocument();
    // Un enlace, no un botón: la acción se puede abrir en pestaña nueva y se
    // anuncia como enlace.
    const inicio = screen.getByRole('link', { name: 'Volver al inicio' });
    expect(inicio).toHaveAttribute('href', '/app');
  });

  it('muestra la ruta que falló, con sus parámetros de búsqueda', () => {
    renderNotFound({ entries: ['/app/tickets?filtro=abierto'] });

    expect(screen.getByText(/Ruta solicitada: \/app\/tickets\?filtro=abierto/)).toBeInTheDocument();
  });

  it('no necesita sesión ni consulta permisos', () => {
    // Sin `AuthProvider` alrededor: la pantalla se pinta igual. Así una
    // dirección mal escrita no revela si hay alguien autenticado.
    render(
      <MemoryRouter initialEntries={['/no-existe']}>
        <NotFound />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Página no encontrada' })).toBeInTheDocument();
  });
});

describe('NotFound · dentro y fuera de la aplicación', () => {
  it('en pantalla completa lleva identidad propia de SIFHA', () => {
    renderNotFound();

    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByAltText('SIFHA')).toBeInTheDocument();
    expect(screen.getByText('SIFHA · Mesa de Ayuda')).toBeInTheDocument();
  });

  it('dentro de la aplicación cede el landmark y el título a Layout', () => {
    renderNotFound({ entries: ['/app/no-existe'], embedded: true });

    expect(screen.getByRole('heading', { level: 2, name: 'Página no encontrada' })).toBeInTheDocument();
    // `Layout` ya aporta `main`, `h1` y el logotipo en la cabecera.
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(screen.queryByAltText('SIFHA')).not.toBeInTheDocument();
  });
});

describe('NotFound · volver atrás', () => {
  it('no se ofrece si el usuario llegó directamente a la dirección', () => {
    renderNotFound();

    // Sin entrada anterior sería un botón muerto.
    expect(screen.queryByRole('button', { name: 'Volver atrás' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toBeInTheDocument();
  });

  it('se ofrece y funciona cuando sí hay una entrada anterior', async () => {
    // Es lo que guarda el `history` de React Router al apilar una entrada.
    window.history.pushState({ usr: null, key: 'k1', idx: 1 }, '', '/no-existe');
    renderNotFound({ entries: ['/app/dashboard', '/app/no-existe'] });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Volver atrás' }));

    expect(screen.getByTestId('ruta')).toHaveTextContent('/app/dashboard');
  });
});
import { describe, it, expect } from 'vitest';
import { contrastRatio, resolveColor, themeColors } from './contrast';

// La paleta del proyecto NO es la de Tailwind. Estos tests documentan el
// supuesto del que dependen el resto de comprobaciones de contraste de la
// aplicación, para que un cambio de paleta no pase inadvertido.

const THEME = themeColors();

describe('Paleta del tema (index.css @theme)', () => {
  it('está invertida para el tema oscuro: slate-50..300 son superficies oscuras', () => {
    // Un color oscuro tiene ratio ALTO contra blanco. Si alguien "corrige" la
    // paleta a los valores estándar de Tailwind, este test falla y avisa de
    // que hay que revisar todos los usos de la aplicación, no solo el editor.
    for (const dark of ['slate-50', 'slate-100', 'slate-200', 'slate-300']) {
      expect(contrastRatio(THEME[dark], '#ffffff'), `${dark} debería ser oscuro`).toBeGreaterThan(4.5);
    }
  });

  it('slate-400..950 son tonos de texto claros', () => {
    for (const light of ['slate-400', 'slate-500', 'slate-600', 'slate-700', 'slate-800', 'slate-900']) {
      expect(contrastRatio(THEME[light], '#000000'), `${light} debería ser claro`).toBeGreaterThan(4.5);
    }
  });

  it('la causa raíz del editor: slate-100 es un azul marino, no un blanco', () => {
    // Con la paleta estándar de Tailwind, text-slate-100 sería casi blanco.
    // Aquí resuelve a #0C3347, y sobre el fondo del editor (#0b3046) queda un
    // ratio de ~1:1: el texto que se escribe es invisible.
    expect(THEME['slate-100'].toLowerCase()).toBe('#0c3347');
    expect(contrastRatio(resolveColor('slate-100'), '#0b3046')).toBeLessThan(1.2);
  });
});

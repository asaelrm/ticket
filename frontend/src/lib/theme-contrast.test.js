import { describe, it, expect } from 'vitest';
import { contrastRatio, themeColors } from '../test/contrast';

// Esta prueba protege el contrato visual SIFHA: la escala slate vuelve a ser
// neutral y el azul institucional sustituye la anterior identidad UCE oscura.
const THEME = themeColors();

describe('Paleta SIFHA (index.css @theme)', () => {
  it('usa superficies slate neutrales y legibles en tema claro', () => {
    expect(THEME['slate-50'].toLowerCase()).toBe('#f8fafc');
    expect(THEME['slate-900'].toLowerCase()).toBe('#0f172a');
    expect(contrastRatio(THEME['slate-900'], THEME['slate-50'])).toBeGreaterThan(12);
  });

  it('centraliza el azul institucional como escala brand', () => {
    expect(THEME['brand-900'].toLowerCase()).toBe('#0a2540');
    expect(THEME['brand-600'].toLowerCase()).toBe('#1d4ed8');
    expect(contrastRatio('#ffffff', THEME['brand-600'])).toBeGreaterThan(4.5);
  });
});

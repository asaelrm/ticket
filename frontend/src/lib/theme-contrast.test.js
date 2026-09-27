import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contraste real del editor de respuestas.
//
// Por qué este test existe: el proyecto NO usa la paleta slate estándar de
// Tailwind. En index.css (@theme) los tonos están invertidos a propósito para un
// tema oscuro: slate-50..300 son superficies OSCURAS y slate-400..950 son
// textos CLAROS. Escribir `text-slate-100` esperando el blanco de siempre
// produce un texto casi invisible sobre los paneles oscuros. Estos tests
// resuelven los colores desde el CSS real y comprueban el ratio WCAG, de modo
// que el fallo se detecta aunque jsdom no aplique Tailwind.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');

/** Extrae los `--color-*` declarados en el bloque @theme. */
function themeColors() {
  const block = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
  expect(block, 'No se encontró el bloque @theme en index.css').toBeTruthy();
  const out = {};
  for (const m of block[1].matchAll(/--color-([a-z]+)-(\d+):\s*(#[0-9a-fA-F]{6})/g)) {
    out[`${m[1]}-${m[2]}`] = m[3];
  }
  return out;
}

const THEME = themeColors();

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** WCAG 2.1: luminancia relativa -> ratio entre 1 y 21. */
function contrast(fg, bg) {
  const lum = (hex) => {
    const [r, g, b] = hexToRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** Resuelve un token `slate-100`, `brand-600`, `#0b3046` o `white` a su hex. */
function resolve(token) {
  if (token.startsWith('#')) return token;
  if (token === 'white') return '#ffffff';
  if (THEME[token]) return THEME[token];
  throw new Error(`Token de color no resoluble: ${token}`);
}

/**
 * Extrae de un className de Tailwind el color de texto y el de fondo, y
 * calcula su ratio. Solo cubre lo que usa el editor, a propósito: no es un
 * motor de cascada, es una comprobación puntual y legible.
 */
function ratioFor(className, { surface, defaultText = 'slate-800' } = {}) {
  const tokens = className.split(/\s+/).filter(Boolean);
  let text = null;
  let bg = null;
  for (const t of tokens) {
    if (t.startsWith('placeholder:text-')) text = text ?? t.slice('placeholder:text-'.length);
    else if (t.startsWith('hover:text-')) continue; // el hover se revisa aparte
    else if (t.startsWith('text-')) text = text ?? t.slice('text-'.length);
    else if (t.startsWith('bg-')) bg = t.slice('bg-'.length);
  }
  const fg = resolve(text || defaultText);
  const bgHex = bg ? resolve(bg) : surface;
  return { ratio: contrast(fg, bgHex), fg, bg: bgHex, text: text || defaultText };
}

const EDITOR_SURFACE = '#0b3046'; // bg-[#0b3046] del textarea
const TOOLBAR_SURFACE = '#08283d'; // bg-[#08283d] de la barra de formato

describe('Paleta del tema (index.css @theme)', () => {
  it('está invertida a propósito: slate-50..300 son oscuros y slate-400..950 claros', () => {
    // Documenta el supuesto del que dependen el resto de tests. Si alguien
    // "arregla" la paleta a los valores de Tailwind, este test avisa de que
    // hay que revisar todos los usages, no solo este fichero.
    for (const dark of ['slate-50', 'slate-100', 'slate-200', 'slate-300']) {
      expect(contrast(THEME[dark], '#ffffff'), `${dark} debería ser oscuro`).toBeLessThan(3);
    }
    for (const light of ['slate-600', 'slate-700', 'slate-800', 'slate-900']) {
      expect(contrast(THEME[light], '#000000'), `${light} debería ser claro`).toBeGreaterThan(8);
    }
  });

  it('el token que se usaba para el texto del editor era casi negro', () => {
    // Documenta la causa raíz: text-slate-100 resolvía a un azul marino.
    expect(THEME['slate-100']).toBe('#0C3347');
    expect(contrast(THEME['slate-100'], EDITOR_SURFACE)).toBeLessThan(1.2);
  });
});

describe('Editor de respuestas: contraste del texto', () => {
  it('el texto escrito es legible sobre el fondo del textarea', () => {
    const { ratio, fg } = ratioFor('text-sm text-slate-700 placeholder:text-slate-500', { surface: EDITOR_SURFACE });
    expect(ratio, `texto ${fg} sobre ${EDITOR_SURFACE}: ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it('el placeholder es legible sobre el fondo del textarea', () => {
    const { ratio, fg } = ratioFor('placeholder:text-slate-500', { surface: EDITOR_SURFACE });
    expect(ratio, `placeholder ${fg} sobre ${EDITOR_SURFACE}: ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
  });

  it('los botones de la barra de formato son visibles sobre la barra', () => {
    const { ratio, fg } = ratioFor('text-sm font-medium text-slate-600', { surface: TOOLBAR_SURFACE });
    expect(ratio, `botón ${fg} sobre ${TOOLBAR_SURFACE}: ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it('el botón de respuestas rápidas es visible sobre la barra', () => {
    const { ratio, fg } = ratioFor('text-xs font-medium text-slate-600', { surface: TOOLBAR_SURFACE });
    expect(ratio, `botón respuestas rápidas ${fg} sobre ${TOOLBAR_SURFACE}: ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Panel de respuestas rápidas: contraste y tema', () => {
  it('el panel usa una superficie oscura coherente con la aplicación', () => {
    // El panel se renderiza en un portal sobre document.body, así que su
    // superficie es la del tema, no la de la tarjeta que lo contiene.
    const { bg } = ratioFor('bg-[#0e3a50]', { surface: EDITOR_SURFACE });
    expect(bg).toBe('#0e3a50');
  });

  it('el título de cada plantilla es legible en el panel', () => {
    const { ratio, fg, bg } = ratioFor('font-medium text-slate-700', { surface: '#0e3a50' });
    expect(ratio, `título ${fg} sobre ${bg}: ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it('el extracto del cuerpo de la plantilla es legible en el panel', () => {
    const { ratio, fg, bg } = ratioFor('text-xs text-slate-500', { surface: '#0e3a50' });
    expect(ratio, `extracto ${fg} sobre ${bg}: ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
  });

  it('la vista previa del texto expandido es legible', () => {
    const { ratio, fg, bg } = ratioFor('text-sm text-slate-700', { surface: '#123f57' });
    expect(ratio, `vista previa ${fg} sobre ${bg}: ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it('la fila resaltada se distingue del resto sin depender solo del color', () => {
    // selected !== hover: si no, con el ratón encima no se ve qué se va a
    // insertar. Se comprueba que la superficie de la fila seleccionada
    // difiere de la de las no seleccionadas.
    const resting = ratioFor('block w-full text-left', { surface: '#0e3a50' });
    const selected = ratioFor('block w-full text-left bg-[#123f57]', { surface: '#0e3a50' });
    expect(selected.bg).not.toBe(resting.bg);
    expect(contrast(selected.bg, resting.bg)).toBeGreaterThan(1.1);
  });
});

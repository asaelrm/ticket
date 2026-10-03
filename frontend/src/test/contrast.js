import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Utilidades de contraste para las pruebas de UI.
//
// El proyecto redefine la paleta slate de Tailwind en index.css (@theme) para
// un tema oscuro: slate-50..300 son superficies OSCURAS y slate-400..950 son
// textos CLAROS. Escribir `text-slate-100` esperando el blanco habitual
// produce texto invisible sobre los paneles oscuros, que es exactamente lo que
// pasó en el editor de respuestas.
//
// jsdom no aplica Tailwind, así que aquí no se calcula el color computado: se
// resuelve el token que el componente declara en su className contra el valor
// real del tema y se comprueba el ratio WCAG. Es una comprobación puntual, no un
// motor de cascada: cubre las clases que usa el editor, y si alguien introduce
// un color literal o un alpha que no se sabe resolver, falla en vez de pasar en
// silencio.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedCss = null;

// Tonos de la paleta estándar de Tailwind que el proyecto NO redefine en
// @theme. Sirven solo de respaldo, cuando el token no aparece ahí, para que las
// pruebas puedan resolver clases destructivas como `!text-red-400`: sin esto no
// hay forma de comprobar que un botón de "Cancelar" no queda en un rojo oscuro
// sobre el panel.
const DEFAULT_PALETTE = {
  'red-400': '#f98a8a',
  'red-500': '#ef4444',
  'red-600': '#dc2626',
};

let cachedFile = null;

/** El texto de index.css, que es donde vive la identidad visual del proyecto. */
function cssFile() {
  if (!cachedFile) cachedFile = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
  return cachedFile;
}

/**
 * Las variables CSS de un bloque de `index.css`, para comprobar el contraste
 * real de cada tema.
 *
 * `readColors` resuelve clases contra la paleta de `@theme`, que es el tema
 * claro; en oscuro casi todas las superficies cambian de valor y hay que leer
 * el bloque `:root[data-theme='dark']`. Sirve para los componentes que usan
 * tokens (`var(--text)`, `var(--brand)`…), que en ambos temas son los mismos
 * nombres con distinto valor.
 */
export function cssVariables(selector = ':root') {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = cssFile().match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!block) throw new Error(`No se encontró el bloque "${selector}" en index.css`);
  const out = {};
  for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  if (!Object.keys(out).length) throw new Error(`El bloque "${selector}" no declara variables`);
  return out;
}

/** Los tokens de color declarados en @theme. */
export function themeColors() {
  if (cachedCss) return { ...cachedCss };
  const css = cssFile();
  const block = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
  if (!block) throw new Error('No se encontró el bloque @theme en index.css');
  const out = {};
  for (const m of block[1].matchAll(/--color-([a-z]+)-(\d+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    out[`${m[1]}-${m[2]}`] = m[3];
  }
  cachedCss = out;
  return { ...out };
}

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Luminancia relativa WCAG de un color, de 0 (negro) a 1 (blanco). */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ratio de contraste WCAG 2.1 entre dos colores, de 1 a 21. */
export function contrastRatio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/**
 * Compone un color con alfa sobre un fondo, en hexadecimal opaco.
 * `alpha` acepta tanto fracción (0.25) como porcentaje de Tailwind (25).
 */
export function composite(fgHex, alpha, bgHex) {
  const a = alpha > 1 ? alpha / 100 : alpha;
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  return rgbToHex(fg.map((v, i) => v * a + bg[i] * (1 - a)));
}

/**
 * Resuelve un token de color de Tailwind a hexadecimal opaco.
 * Acepta `slate-100`, `brand-600`, `white`, `#0b3046` y `white/10`.
 * `alphaBase` es la superficie sobre la que se compone un color con alfa.
 */
export function resolveColor(token, alphaBase = '#ffffff') {
  if (!token) throw new Error('Token de color vacío');
  const [rawName, alpha] = token.split('/');
  const name = unwrap(rawName);
  let hex;
  if (name === 'white') hex = '#ffffff';
  else if (name === 'black') hex = '#000000';
  else if (name.startsWith('#')) hex = name;
  else {
    hex = themeColors()[name] || DEFAULT_PALETTE[name];
    if (!hex) throw new Error(`Token de color no definido en @theme: ${name}`);
  }
  if (alpha === undefined) return hex;
  return composite(hex, Number(alpha), alphaBase);
}

/** Quita los corchetes de las utilidades arbitrarias: `[#0b3046]` -> `#0b3046`. */
function unwrap(token) {
  return token.startsWith('[') && token.endsWith(']') ? token.slice(1, -1) : token;
}

/**
 * Un token es un color si es un hex literal, blanco/negro, o un par
 * `familia-tono` definido en @theme. Así `text-sm` (tamaño) y `text-[11px]`
 * no se confunden con `text-slate-100` (color).
 */
function isColorToken(token) {
  const name = unwrap(token.split('/')[0]);
  if (name.startsWith('#')) return true;
  if (name === 'white' || name === 'black') return true;
  if (!/^[a-z]+-\d{2,3}$/.test(name)) return false;
  return Boolean(themeColors()[name] || DEFAULT_PALETTE[name]);
}

/**
 * Extrae de un className el token de texto, de placeholder y de fondo que
 * apliquen en el estado base (ignora variantes hover/focus y breakpoints).
 * Devuelve null en los que el elemento no declara ese color, para que quien
 * llame decida si eso es un error.
 */
export function readColors(className) {
  const tokens = String(className || '').split(/\s+/).filter(Boolean);
  const out = { text: null, placeholder: null, bg: null };
  for (const raw of tokens) {
    // El modificador `!` de Tailwind va en el propio nombre de la clase
    // (`!text-red-400`); sin quitarlo, el color se declaraba pero no se veía y
    // las pruebas lo leerían como si el elemento no declarara ningún texto.
    const token = raw.startsWith('!') ? raw.slice(1) : raw;
    if (/^(hover|focus|focus-within|focus-visible|active|group-hover|peer-checked|sm|md|lg|xl|2xl|dark):/.test(token)) continue;
    const t = token;
    if (t.startsWith('placeholder:text-')) {
      const value = t.slice('placeholder:text-'.length);
      if (isColorToken(value)) out.placeholder ??= value;
    } else if (t.startsWith('text-')) {
      const value = t.slice('text-'.length);
      // Un tamaño de fuente no es un color: si no resuelve como color, se ignora.
      if (isColorToken(value)) out.text ??= value;
    } else if (t.startsWith('bg-')) {
      const value = t.slice('bg-'.length);
      if (isColorToken(value)) out.bg ??= value;
    }
  }
  return out;
}

/**
 * Convierte una superficie a hexadecimal opaco. Si el className declara un
 * `bg-...` sin alfa, ese es el fondo; si lo declara con alfa, se compone sobre
 * la superficie que se le indique.
 */
export function backgroundOf(className, inheritedSurface) {
  const { bg } = readColors(className);
  if (!bg) return inheritedSurface;
  if (!bg.includes('/')) return resolveColor(bg);
  return resolveColor(bg, inheritedSurface);
}

/**
 * Comprueba el contraste del texto de un elemento y describe el fallo con los
 * hexadecimales resueltos, que es lo que hace falta para diagnosticarlo.
 */
export function expectContrast(element, { surface, min = 4.5, label = 'texto' } = {}) {
  const { text, placeholder } = readColors(element.className);
  const own = backgroundOf(element.className, surface);
  if (!text) {
    throw new Error(
      `El elemento ${label} no declara ningún color de texto (class="${element.className}"). ` +
        'Si hereda el color del contenedor, hay que pasar surface y comprobarlo a mano.'
    );
  }
  const fg = resolveColor(text, own);
  const ratio = contrastRatio(fg, own);
  if (ratio < min) {
    throw new Error(
      `Contraste insuficiente en ${label}: ${text} (${fg}) sobre ${own} da ${ratio.toFixed(2)}:1 y se exige ${min}:1`
    );
  }
  return ratio;
}

/** Igual que expectContrast, pero para el placeholder de un input o textarea. */
export function expectPlaceholderContrast(element, { surface, min = 3, label = 'placeholder' } = {}) {
  const { placeholder } = readColors(element.className);
  const own = backgroundOf(element.className, surface);
  if (!placeholder) {
    throw new Error(`El elemento ${label} no declara placeholder:text-* (class="${element.className}")`);
  }
  const fg = resolveColor(placeholder, own);
  const ratio = contrastRatio(fg, own);
  if (ratio < min) {
    throw new Error(
      `Contraste insuficiente en ${label}: ${placeholder} (${fg}) sobre ${own} da ${ratio.toFixed(2)}:1 y se exige ${min}:1`
    );
  }
  return ratio;
}

/** Superficies del editor, mirroring TicketDetail.jsx. */
export const EDITOR_SURFACE = '#ffffff';
export const TOOLBAR_SURFACE = '#f8fafc';

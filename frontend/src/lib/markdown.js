// Renderizador mínimo y seguro para el texto de los tickets, las respuestas
// rápidas y los artículos de la base de conocimiento.
// Primero escapa el HTML y luego aplica un subconjunto de formato tipo Markdown.
//
// REGLA DE SEGURIDAD: el escapado ocurre SIEMPRE antes de aplicar cualquier
// formato y nunca se interpreta una URL. No se genera ningún atributo `href`,
// `src`, `style` ni `on*` a partir del texto del usuario, de modo que la única
// forma de inyectar HTML es pagar el coste del escapado. Añadir enlaces aquí
// exigiría una lista blanca de protocolos; es Ampliar más de lo necesario.
// Se escapa también el apóstrofo aunque hoy todo lo que sale entre comillas son
// literales del propio renderizador: es una bomba de relojería para el día que
// alguien añada un `title='${texto}'` o un `data-x='${valor}'`.
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code class="rounded bg-slate-100 px-1 py-0.5 text-[0.85em]">$1</code>');
}

// Estilos de encabezado escritos a mano: el proyecto no usa el plugin
// `prose` de Tailwind, así que no hay una clase que aplicar y el HTML lleva las
// suyas. h1 queda en text-lg para no desbordar la ficha de un artículo.
const HEADING_CLASS = {
  1: 'mt-4 mb-1.5 text-lg font-bold text-slate-800 first:mt-0',
  2: 'mt-4 mb-1.5 text-base font-bold text-slate-800 first:mt-0',
  3: 'mt-3 mb-1 text-sm font-semibold text-slate-700 first:mt-0',
  4: 'mt-3 mb-1 text-sm font-semibold text-slate-700 first:mt-0',
  5: 'mt-2 mb-1 text-sm font-semibold text-slate-600 first:mt-0',
  6: 'mt-2 mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 first:mt-0',
};

/**
 * Convierte Markdown en HTML seguro.
 *
 * Subconjunto soportado: párrafos, negrita, cursiva, código en línea,
 * encabezados ATX (`#` … `######`), listas con viñetas y listas ordenadas.
 *
 * Se mantiene el renderizado por líneas, sin gramática de inglés ni dependencias
 * externas. Una lista se cierra en cuanto aparece una línea que no es de la
 * lista, y cambiar de viñeta a numerada cierra la anterior para que el HTML
 * siga siendo válido.
 * @param {string} raw
 * @returns {string} HTML listo para dangerouslySetInnerHTML
 */
export function renderMessage(raw) {
  const escaped = escapeHtml(raw).replace(/\r\n/g, '\n');
  const lines = escaped.split('\n');
  const html = [];
  // 'ul' | 'ol' | null: qué lista está abierta, para no anidar por accidente.
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(listType === 'ol' ? '</ol>' : '</ul>');
      listType = null;
    }
  };

  // Abre la lista del tipo pedido si no hay una del mismo tipo abierta.
  const openList = (type) => {
    if (listType === type) return;
    closeList();
    html.push(
      type === 'ol'
        ? '<ol class="my-1 ml-4 list-decimal space-y-0.5">'
        : '<ul class="my-1 ml-4 list-disc space-y-0.5">'
    );
    listType = type;
  };

  for (const line of lines) {
    // Encabezado ATX. Exige al menos un espacio tras las almohadillas para no
    // convertir un "#hashtag" en un título, se limita a 6 niveles y admite
    // sangría inicial igual que las listas.
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level} class="${HEADING_CLASS[level]}">${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      openList('ul');
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    // Lista ordenada. Acepta `1.` y `1)`, como en Markdown. Una línea como
    // "2024. Informe anual" se interpreta como elemento, igual que haría
    // cualquier Markdown estándar.
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      openList('ol');
      html.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }

    closeList();
    if (line.trim() === '') {
      html.push('<div class="h-2"></div>');
    } else {
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return html.join('');
}

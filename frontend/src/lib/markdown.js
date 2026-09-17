// Renderizador mínimo y seguro para el editor de texto del ticket.
// Primero escapa el HTML y luego aplica un subconjunto de formato tipo Markdown.
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code class="rounded bg-slate-100 px-1 py-0.5 text-[0.85em]">$1</code>');
}

export function renderMessage(raw) {
  const escaped = escapeHtml(raw).replace(/\r\n/g, '\n');
  const lines = escaped.split('\n');
  const html = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        html.push('<ul class="my-1 ml-4 list-disc space-y-0.5">');
        inList = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
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

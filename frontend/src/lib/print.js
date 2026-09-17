function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Abre una ventana con un documento listo para "Guardar como PDF" (Ctrl+P).
export function printDocument({ title, subtitle = '', meta = [], sections = [] }) {
  const win = window.open('', '_blank', 'width=980,height=760');
  if (!win) return false;

  const metaHtml = meta.length
    ? `<div class="meta">${meta
        .map(([label, value]) => `<div class="meta-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`)
        .join('')}</div>`
    : '';

  const sectionsHtml = sections
    .filter((s) => s && s.rows && s.rows.length)
    .map(
      (s) => `
      <section>
        <h2>${esc(s.title)}</h2>
        <table>
          <thead><tr>${(s.headers || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>
            ${s.rows
              .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
              .join('')}
          </tbody>
        </table>
      </section>`
    )
    .join('');

  win.document.write(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1e293b; margin: 32px; }
  header { border-bottom: 3px solid #4f46e5; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { color: #64748b; font-size: 13px; }
  .meta { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
  .meta-item { flex: 1 1 150px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; background: #f8fafc; }
  .meta-item span { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  .meta-item strong { font-size: 18px; color: #0f172a; }
  section { margin-bottom: 22px; page-break-inside: avoid; }
  h2 { font-size: 14px; margin: 0 0 8px; color: #334155; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; }
  th { background: #f1f5f9; color: #475569; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 11px; }
  @media print { body { margin: 12mm; } }
</style>
</head>
<body>
  <header>
    <h1>${esc(title)}</h1>
    ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
  </header>
  ${metaHtml}
  ${sectionsHtml}
  <footer>Generado el ${esc(new Date().toLocaleString('es-ES'))}</footer>
</body>
</html>`);

  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
  return true;
}

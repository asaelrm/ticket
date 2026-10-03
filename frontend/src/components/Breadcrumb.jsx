import { Link } from 'react-router-dom';

/**
 * Miga de pan discreta: dónde estoy y a qué lista se vuelve.
 *
 * `items` es la ruta de menos a más: `[{ label, to }, …]`. El ÚLTIMO elemento es
 * siempre la página actual, así que se pinta como texto con `aria-current="page"`
 * y no es un enlace: un enlace a la propia página no lleva a ninguna parte y
 * añade un tabulador sin acción.
 *
 * Los saltos son enlaces de verdad (`Link`), nunca `history.back()`: el destino
 * se puede leer, compartir y abrir en pestaña nueva, y vuelve siempre al mismo
 * listado aunque el usuario haya entrado por otra vía (bandeja, dashboard,
 * auditoría…). Quien quiera exactamente "la pantalla de la que vine", con sus
 * filtros, sigue teniendo el botón "Volver" de la página.
 *
 * Los colores son tokens del tema (`--text-muted`, `--text`, `--border-strong`,
 * `--brand-hover`), no utilidades de paleta: así el mismo componente se lee
 * igual en claro y en oscuro sin reglas espejo.
 */
export default function Breadcrumb({ items, label = 'Ruta de navegación', className = '' }) {
  const crumbs = (items || []).filter(Boolean);
  if (!crumbs.length) return null;

  return (
    <nav aria-label={label} className={className}>
      <ol className="flex flex-wrap items-center gap-1.5 text-xs">
        {crumbs.map((item, index) => {
          const current = index === crumbs.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {current ? (
                <span aria-current="page" className="truncate font-medium text-[var(--text)]">
                  {item.label}
                </span>
              ) : (
                <Link
                  to={item.to}
                  className="rounded text-[var(--text-muted)] transition-colors hover:text-[var(--brand-hover)]"
                >
                  {item.label}
                </Link>
              )}
              {!current && (
                // Separador: es adorno, se oculta al lector de pantalla para que
                // la ruta se anuncie como "Tickets, TCK-000123" y no con flechas.
                <span aria-hidden="true" className="shrink-0 text-[var(--border-strong)]">
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

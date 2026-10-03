import React from 'react';

/**
 * Vista de error reutilizable de SIFHA (404, 403, error inesperado…).
 *
 * No decide nada por su cuenta: recibe el texto, el detalle y las acciones, de
 * modo que la misma pieza sirve para una ruta inexistente y para un fallo de
 * render sin duplicar la identidad visual.
 *
 * `embedded` separa los dos usos:
 *  - `false`: pantalla completa, con su propio landmark `<main>`, el logotipo
 *    de SIFHA y el pie. Es el caso de las rutas públicas (login, 404 suelto).
 *  - `true`: bloque dentro del `<main>` que ya aporta `Layout`, con la cabecera
 *    y el menú visibles. Por eso el título baja a `<h2>`: `Layout` ya tiene su
 *    propio `<h1>` y dos encabezados de nivel 1 en la misma pantalla desorientan
 *    a quien navega por encabezados.
 *
 * Los colores son tokens del tema (`var(--text)`, `var(--brand)`…) y no clases
 * `slate`, para que el mismo marcado se lea igual en claro y en oscuro sin
 * depender de los remapeos de `index.css`.
 */
export default function ErrorPage({
  code,
  icon,
  title,
  description,
  detail,
  actions,
  embedded = false,
  showLogo = false,
}) {
  const Wrapper = embedded ? 'div' : 'main';
  const Heading = embedded ? 'h2' : 'h1';

  const card = (
    <div className="card nex-pop p-6 sm:p-8">
      <div className="flex flex-col items-center gap-3 text-center">
        {showLogo && (
          <span className="flex h-24 w-full max-w-xs items-center rounded-xl bg-[var(--surface-inverse)] p-3 shadow-xl">
            <img alt="SIFHA" className="h-full w-full object-contain" src="/logo/TSIFHA-PNG.png" />
          </span>
        )}

        {code && (
          <p className="text-4xl font-extrabold leading-none tracking-tight text-[var(--brand)] sm:text-5xl">
            {code}
          </p>
        )}
        {icon && (
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-secondary)] text-[var(--warning)]">
            {icon}
          </span>
        )}

        <Heading className="text-xl font-semibold text-[var(--text)] sm:text-2xl">{title}</Heading>

        {description && (
          <p className="max-w-md text-sm text-[var(--text-muted)] sm:text-base">{description}</p>
        )}

        {detail && (
          // `--text` y no `--text-muted`: sobre `--surface-secondary` el gris
          // secundario se queda en 4.34:1 en claro, por debajo del 4.5:1 que
          // WCAG AA exige a este tamaño, y la ruta es justo lo que hace falta
          // leer con precisión.
          <p className="mt-1 w-full max-w-md break-words rounded-lg bg-[var(--surface-secondary)] px-3 py-2 text-left font-mono text-xs text-[var(--text)]">
            {detail}
          </p>
        )}

        {actions && (
          // Columna en móvil para que los botones ocupen el ancho y no queden
          // dos controles estrechos lado a lado; fila centradas a partir de `sm`.
          <div className="mt-2 flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
            {actions}
          </div>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="mx-auto w-full max-w-xl">
        {card}
      </div>
    );
  }

  return (
    <Wrapper className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        {card}
        <p className="mt-5 text-center text-xs text-[var(--text-muted)]">SIFHA · Mesa de Ayuda</p>
      </div>
    </Wrapper>
  );
}
import { Skeleton, SkeletonGroup } from './ui';

/*
 * Esqueleto de carga del dashboard (prueba piloto del esqueleto).
 *
 * Sólo cambia lo que se ve mientras los datos llegan: mismas rejillas, mismos
 * `padding` y mismas clases `.card`, `.th` y `.td` que las piezas reales del
 * Dashboard, con la altura de cada fila y cada bloque calibrada contra la del
 * contenido que sustituye. Así el esqueleto ocupa la pantalla casi idéntica y
 * cuando aparecen los datos no hay salto de maquetación ni de scroll.
 *
 * Ni una sola condición de datos, consulta o permiso vive aquí: esto no sabe qué
 * hay en el dashboard, sólo cómo se ve el hueco mientras no lo hay. Eso lo
 * mantiene sincronizable con la pantalla: cuando una sección crece, se replica
 * el hueco aquí y nada más.
 */

// Cabecera de un panel: rótulo y bajada a la izquierda, enlace a la derecha.
// Replica las medidas de la cabecera real —`px-5 py-4`, rótulo de `text-sm`
// (línea de 20 px) y bajada de `text-xs` (16 px)— para que la tarjeta no crezca
// al pasar de esqueleto a datos.
function PanelHeader({ titleWidth = 'w-40', subtitleWidth = 'w-64', linkWidth = 'w-28' }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
      <div>
        <Skeleton className={`h-5 ${titleWidth}`} />
        <Skeleton className={`mt-2 h-4 ${subtitleWidth}`} />
      </div>
      <Skeleton className={`h-5 ${linkWidth}`} />
    </div>
  );
}

// Acceso rápido. Reproduce el `flex items-center gap-3 p-4` de `Card` con un
// icono de h-10, un rótulo y la cifra a `text-3xl leading-tight` (30 px), más la
// pista inferior: la caja queda de la misma altura que la real.
function ShortcutSkeleton() {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-8 w-10" />
        </div>
      </div>
      <Skeleton className="mt-2 h-4 w-24" />
    </div>
  );
}

// Tarjeta de cifra de un panel. Misma retícula que `SlaStat` (`items-start gap-3`,
// `px-4 py-3`, icono de h-9) y un bloque por cada renglón: rótulo, cifra y pista.
function StatSkeleton() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <Skeleton className="mt-0.5 h-9 w-9 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-1.5 h-8 w-12" />
        <Skeleton className="mt-1.5 h-3 w-28" />
      </div>
    </div>
  );
}

// Tabla de esqueleto. Repite el marcado real —`<table>`, `.th`, `.td`, el
// `overflow-x-auto` y las columnas que se ocultan por ancho— porque la altura de
// una fila la fija el relleno de la celda: con otras celdas el hueco queda más
// bajo que la tabla que sustituye y la tarjeta se encoge. `divider` permite
// quitar la línea de separación en el panel cuya cabecera ya la lleva.
function TableSkeleton({ columns, rows = 3, divider = 'border-t border-slate-200' }) {
  return (
    <div className={`overflow-x-auto ${divider}`}>
      <table className="w-full">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={`th ${c.hidden || ''}`}>
                <Skeleton className="h-4 w-14" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {columns.map((c) => (
                <td key={c.key} className={`td ${c.hidden || ''}`}>
                  <Skeleton className={`h-4 ${c.width || 'w-24'}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Fila de un panel de listado (categorías o departamentos): el mismo `flex
// items-center gap-2` con el punto de color, el nombre, la cifra y la cuenta de
// abiertos, medidos como bloques en vez de texto. El `py-2` sustituye al `py-1.5`
// de la fila real para que el bloque mida lo mismo que su línea de texto.
function ListRowSkeleton({ dot }) {
  return (
    <li className="flex items-center gap-2 rounded-lg px-2 py-2">
      {dot && <Skeleton className="h-2.5 w-2.5 shrink-0 rounded-full" />}
      <Skeleton className="h-4 flex-1" />
      <Skeleton className="h-4 w-6 shrink-0" />
      <Skeleton className="h-3 w-16 shrink-0" />
    </li>
  );
}

// Barra de estado: rótulo a la izquierda, cifra a la derecha y la pista de
// progreso debajo, con el mismo `mb-1` y el mismo `h-2` que usa la barra real.
function StatusRowSkeleton() {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-6" />
      </div>
      <Skeleton className="h-2 w-full rounded-full" />
    </div>
  );
}

// Gráfica de barras. Las alturas salen de una serie FIJA, no de un azar en
// render: si variaran entre renders, el esqueleto cambiaría de forma sin motivo.
// Se ve la silueta real —dos series por día y la fila de días debajo— dentro de
// la misma `h-40` que usa la gráfica.
const TREND_SHAPE = [38, 62, 44, 80, 55, 30, 70, 92, 48, 66, 36, 58, 74, 50];

function TrendSkeleton() {
  return (
    <div className="flex h-40 items-end gap-1">
      {TREND_SHAPE.map((height, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1">
          <div className="flex w-full flex-1 items-end justify-center gap-0.5">
            <Skeleton className="w-2.5 rounded-t" style={{ height: `${height}%` }} />
            <Skeleton className="w-2.5 rounded-t" style={{ height: `${Math.round(height * 0.6)}%` }} />
          </div>
          <Skeleton className="h-2 w-3" />
        </div>
      ))}
    </div>
  );
}

export default function DashboardSkeleton() {
  return (
    <SkeletonGroup label="Cargando dashboard…" className="space-y-6">
      {/* Franja de estado ("En vivo" y hora de actualización) */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Skeleton className="h-2.5 w-2.5 rounded-full" />
        <Skeleton className="h-3 w-40" />
      </div>

      {/* Accesos rápidos: misma rejilla 2 / 3 / 6 columnas que el contenido. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <ShortcutSkeleton key={i} />
        ))}
      </div>

      {/* Tiempos de atención */}
      <div className="card overflow-hidden">
        <PanelHeader />
        <div className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-3">
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
        </div>
        <TableSkeleton
          columns={[
            { key: 'ticket', width: 'w-24' },
            { key: 'title', width: 'w-full' },
            { key: 'reporter', width: 'w-28', hidden: 'hidden md:table-cell' },
            { key: 'priority', width: 'w-20' },
            { key: 'time', width: 'w-24' },
          ]}
        />
      </div>

      {/* Carga por técnico */}
      <div className="card overflow-hidden">
        <PanelHeader />
        <div className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-3">
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
        </div>
        <TableSkeleton
          columns={[
            { key: 'technician', width: 'w-40' },
            { key: 'active', width: 'w-20' },
            { key: 'open', width: 'w-12' },
            { key: 'assigned', width: 'w-16', hidden: 'hidden sm:table-cell' },
            { key: 'progress', width: 'w-16' },
            { key: 'pending', width: 'w-16', hidden: 'hidden md:table-cell' },
            { key: 'overdue', width: 'w-16' },
          ]}
          rows={4}
        />
      </div>

      {/* Tendencia, estado, categoría y departamento: la misma rejilla de dos
          columnas y los mismos cuatro huecos, para que los bloques caigan donde
          caerán los datos. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <Skeleton className="h-5 w-48" />
            <div className="flex gap-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>
          <TrendSkeleton />
        </div>

        <div className="card p-5">
          <Skeleton className="mb-4 h-5 w-36" />
          <div className="space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              <StatusRowSkeleton key={i} />
            ))}
          </div>
        </div>

        <div className="card p-5">
          <Skeleton className="mb-4 h-5 w-40" />
          <ul className="space-y-1">
            {Array.from({ length: 4 }, (_, i) => (
              <ListRowSkeleton key={i} dot />
            ))}
          </ul>
        </div>

        <div className="card p-5">
          <Skeleton className="mb-4 h-5 w-48" />
          <ul className="space-y-1">
            {Array.from({ length: 4 }, (_, i) => (
              <ListRowSkeleton key={i} />
            ))}
          </ul>
        </div>
      </div>

      {/* Tickets recientes. Su cabecera ya lleva `border-b`, así que la tabla no
          repite la línea de separación. */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-5 w-20" />
        </div>
        <TableSkeleton
          divider=""
          columns={[
            { key: 'ticket', width: 'w-24' },
            { key: 'title', width: 'w-full' },
            { key: 'category', width: 'w-28' },
            { key: 'priority', width: 'w-20' },
            { key: 'status', width: 'w-24' },
            { key: 'technician', width: 'w-32', hidden: 'hidden lg:table-cell' },
            { key: 'date', width: 'w-24' },
          ]}
          rows={5}
        />
      </div>
    </SkeletonGroup>
  );
}

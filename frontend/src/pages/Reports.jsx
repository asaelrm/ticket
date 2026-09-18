import { useEffect, useMemo, useState } from 'react';
import { api, download, STATUS_LABEL, PRIORITY_LABEL } from '../lib/api';
import { LoadingScreen, ErrorBox } from '../components/ui';
import { printDocument } from '../lib/print';

const STATUS_COLORS = {
  OPEN: '#f59e0b',
  ASSIGNED: '#2196f3',
  IN_PROGRESS: '#22c77a',
  PENDING: '#38bdf8',
  RESOLVED: '#20c7b7',
  CLOSED: '#94a3b8',
  CANCELLED: '#ef4444',
};

const PRIORITY_COLORS = { LOW: '#94a3b8', MEDIUM: '#38bdf8', HIGH: '#f97316', CRITICAL: '#ef4444' };

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PRESETS = [
  { key: 'all', label: 'Todo', range: () => ({ from: '', to: '' }) },
  {
    key: 'month',
    label: 'Este mes',
    range: () => {
      const n = new Date();
      return { from: isoDate(new Date(n.getFullYear(), n.getMonth(), 1)), to: isoDate(n) };
    },
  },
  {
    key: 'last-month',
    label: 'Mes anterior',
    range: () => {
      const n = new Date();
      return {
        from: isoDate(new Date(n.getFullYear(), n.getMonth() - 1, 1)),
        to: isoDate(new Date(n.getFullYear(), n.getMonth(), 0)),
      };
    },
  },
  {
    key: 'days30',
    label: 'Últimos 30 días',
    range: () => ({ from: isoDate(new Date(Date.now() - 30 * 86400000)), to: isoDate(new Date()) }),
  },
  {
    key: 'year',
    label: 'Este año',
    range: () => {
      const n = new Date();
      return { from: `${n.getFullYear()}-01-01`, to: isoDate(n) };
    },
  },
];

function rangeLabel(range) {
  if (!range.from && !range.to) return 'Todo el historial';
  return `Del ${range.from || 'inicio'} al ${range.to || 'hoy'}`;
}

export default function Reports() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState({ from: '', to: '' });
  const [query, setQuery] = useState({ from: '', to: '' });

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (query.from) p.append('from', query.from);
    if (query.to) p.append('to', query.to);
    return p.toString() ? `?${p.toString()}` : '';
  }, [query]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    // Una sola petición: el backend calcula cada sección una única vez.
    api
      .get(`/api/reports/full${qs}`)
      .then((r) => {
        if (!active) return;
        setData({
          summary: r.summary,
          byStatus: r.byStatus,
          byPriority: r.byPriority,
          byCategory: r.byCategory,
          byDepartment: r.byDepartment,
          performance: { by_day: r.byDay, by_user: r.byUser },
        });
      })
      .catch((err) => {
        if (active) setError(err.message || 'No se pudieron cargar los reportes');
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [qs, reloadKey]);

  function applyPreset(preset) {
    const r = preset.range();
    setForm(r);
    setQuery(r);
  }

  function exportCsv() {
    download(`/api/reports/export${qs}`);
  }

  function exportPdf() {
    if (!data) return;
    const avgH = data.summary.avg_resolution_hours;
    const avgLabel = avgH >= 24 ? `${(avgH / 24).toFixed(1)} días` : `${avgH} h`;
    const opened = printDocument({
      title: 'Reporte de tickets',
      subtitle: rangeLabel(query),
      meta: [
        ['Total tickets', data.summary.total],
        ['Tickets abiertos', data.summary.open],
        ['Resueltos + cerrados', data.summary.resolved],
        ['Sin resolver > 7 días', data.summary.unresolved_week],
        ['Tiempo medio resolución', avgLabel],
      ],
      sections: [
        {
          title: 'Tickets por estado',
          headers: ['Estado', 'Cantidad'],
          rows: data.byStatus.map((d) => [STATUS_LABEL[d.status] || d.status, d.n]),
        },
        {
          title: 'Tickets abiertos por prioridad',
          headers: ['Prioridad', 'Cantidad'],
          rows: data.byPriority.map((d) => [PRIORITY_LABEL[d.priority] || d.priority, d.n]),
        },
        {
          title: 'Tickets por categoría',
          headers: ['Categoría', 'Total', 'Abiertos'],
          rows: data.byCategory.map((d) => [d.name, d.n, d.open]),
        },
        {
          title: 'Tickets por departamento',
          headers: ['Departamento', 'Total', 'Abiertos'],
          rows: data.byDepartment.map((d) => [d.name, d.n, d.open]),
        },
        {
          title: 'Top reporteros',
          headers: ['Empleado', 'Total', 'Abiertos'],
          rows: data.performance.by_user.map((u) => [u.reporter, u.total, u.open]),
        },
        {
          title: 'Resueltos por día',
          headers: ['Día', 'Cantidad'],
          rows: data.performance.by_day.map((d) => [d.day, d.n]),
        },
      ],
    });
    if (!opened) {
      alert('El navegador bloqueó la ventana del PDF. Habilite las ventanas emergentes e intente nuevamente.');
    }
  }

  if (loading && !data) return <LoadingScreen text="Cargando reportes…" />;
  if (!data) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorBox message={error || 'No se pudieron cargar los reportes'} />
        <button className="btn-secondary mt-4" onClick={() => setReloadKey((k) => k + 1)}>
          Reintentar
        </button>
      </div>
    );
  }

  const maxStatus = Math.max(...data.byStatus.map((d) => d.n), 1);
  const maxDept = Math.max(...data.byDepartment.map((d) => d.n), 1);
  const maxPrio = Math.max(...data.byPriority.map((d) => d.n), 1);
  const avgH = data.summary.avg_resolution_hours;
  const avgLabel = avgH >= 24 ? `${(avgH / 24).toFixed(1)} días` : `${avgH} h`;

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-800">Reportes de operación</h2>
            <p className="text-sm text-slate-500">
              {rangeLabel(query)}
              {loading && <span className="ml-2 text-slate-400">actualizando…</span>}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={exportCsv}>
              Exportar CSV
            </button>
            <button className="btn-primary" onClick={exportPdf}>
              Descargar PDF
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4">
          <div>
            <label className="label" htmlFor="from">Desde</label>
            <input
              id="from"
              type="date"
              className="input !w-auto"
              value={form.from}
              max={form.to || undefined}
              onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
            />
          </div>
          <div>
            <label className="label" htmlFor="to">Hasta</label>
            <input
              id="to"
              type="date"
              className="input !w-auto"
              value={form.to}
              min={form.from || undefined}
              onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
            />
          </div>
          <button className="btn-primary" onClick={() => setQuery(form)}>
            Aplicar
          </button>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.key} className="btn-ghost !px-2.5 !py-1.5 text-xs" onClick={() => applyPreset(p)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Total tickets" value={data.summary.total} />
        <Kpi label="Tickets abiertos" value={data.summary.open} color="text-blue-600" />
        <Kpi label="Resueltos + cerrados" value={data.summary.resolved} color="text-emerald-600" />
        <Kpi label="Sin resolver > 7 días" value={data.summary.unresolved_week} color="text-red-600" />
        <Kpi label="Tiempo medio resolución" value={avgLabel} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Tickets por estado" bodyClass="!h-auto">
          {data.byStatus.length === 0 && <p className="text-sm text-slate-400">Sin datos</p>}
          {data.byStatus.map((d) => (
            <Bar key={d.status} label={STATUS_LABEL[d.status]} n={d.n} pct={maxStatus ? (d.n / maxStatus) * 100 : 0} color={STATUS_COLORS[d.status]} />
          ))}
        </ChartCard>

        <ChartCard title="Tickets abiertos por prioridad">
          {data.byPriority.length === 0 && <p className="text-sm text-slate-400">Sin datos</p>}
          {data.byPriority.map((d) => (
            <Bar key={d.priority} label={PRIORITY_LABEL[d.priority]} n={d.n} pct={maxPrio ? (d.n / maxPrio) * 100 : 0} color={PRIORITY_COLORS[d.priority]} />
          ))}
        </ChartCard>

        <ChartCard title="Tickets por categoría">
          {data.byCategory.length === 0 && <p className="text-sm text-slate-400">Sin datos</p>}
          {data.byCategory.map((d) => (
            <li key={d.name} className="flex items-center gap-2 text-sm">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
              <span className="min-w-0 flex-1 truncate text-slate-600">{d.name}</span>
              <span className="font-semibold text-slate-800">{d.n}</span>
              <span className="w-10 text-right text-xs text-slate-400">{d.open} abiertos</span>
            </li>
          ))}
        </ChartCard>

        <ChartCard title="Tickets por departamento">
          {data.byDepartment.length === 0 && <p className="text-sm text-slate-400">Sin datos</p>}
          {data.byDepartment.map((d) => (
            <Bar key={d.name} label={d.name} n={d.n} pct={maxDept ? (d.n / maxDept) * 100 : 0} color="#20c7b7" />
          ))}
        </ChartCard>
      </div>

      <div className="card p-5">
        <h3 className="mb-4 text-sm font-semibold text-slate-700">Top reporteros</h3>
        {data.performance.by_user.length === 0 ? (
          <p className="text-sm text-slate-400">Sin datos</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Empleado</th>
                  <th className="th">Total</th>
                  <th className="th">Abiertos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.performance.by_user.map((u) => (
                  <tr key={u.reporter} className="hover:bg-slate-50">
                    <td className="td font-medium text-slate-800">{u.reporter}</td>
                    <td className="td">{u.total}</td>
                    <td className="td">{u.open}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, color = 'text-slate-800' }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function ChartCard({ title, children, bodyClass = '' }) {
  return (
    <div className="card p-5">
      <h3 className="mb-4 text-sm font-semibold text-slate-700">{title}</h3>
      <ul className={`space-y-3 ${bodyClass}`}>{children}</ul>
    </div>
  );
}

function Bar({ label, n, pct, color }) {
  return (
    <li>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-semibold text-slate-800">{n}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </li>
  );
}

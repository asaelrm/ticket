import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, download, STATUS_LABEL, PRIORITY_LABEL, STATUSES, PRIORITIES } from '../lib/api';
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
const SECTIONS = [
  ['summary', 'Resumen'],
  ['status', 'Estados'],
  ['priority', 'Prioridades'],
  ['category', 'Categorías'],
  ['department', 'Departamentos'],
  ['reporters', 'Reporteros'],
  ['resolved', 'Resueltos por día'],
  ['details', 'Detalle de tickets'],
];

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
  const [form, setForm] = useState({ from: '', to: '', status: '', priority: '', department: '', category: '' });
  const [query, setQuery] = useState({ from: '', to: '', status: '', priority: '', department: '', category: '' });
  const [departments, setDepartments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [sections, setSections] = useState(SECTIONS.map(([key]) => key));

  const { data: departmentsData } = useQuery({
    queryKey: ['active-departments'],
    queryFn: () => api.get('/api/departments?active=1').then((d) => d.data || []),
    retry: false,
  });
  const { data: categoriesData } = useQuery({
    queryKey: ['categories-active'],
    queryFn: () => api.get('/api/categories?active=1').then((d) => d.data || []),
    retry: false,
  });

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const key of ['from', 'to', 'status', 'priority', 'department', 'category']) {
      if (query[key]) p.append(key, query[key]);
    }
    return p.toString() ? `?${p.toString()}` : '';
  }, [query]);

  const exportQs = `${qs}${qs ? '&' : '?'}sections=${encodeURIComponent(sections.join(','))}`;

  const {
    data,
    error,
    refetch,
    isLoading,
    isFetching,
  } = useQuery({
    queryKey: ['reports-full', qs],
    // Una sola petición: el backend calcula cada sección una única vez.
    queryFn: () =>
      api.get(`/api/reports/full${qs}`).then((r) => ({
        summary: r.summary,
        byStatus: r.byStatus,
        byPriority: r.byPriority,
        byCategory: r.byCategory,
        byDepartment: r.byDepartment,
        performance: { by_day: r.byDay, by_user: r.byUser },
        details: r.details,
      })),
    // Conserva los reportes previos al cambiar de filtros mientras carga la nueva consulta.
    placeholderData: keepPreviousData,
  });

  const departments = departmentsData || [];
  const categories = categoriesData || [];

  const departments = departmentsData || [];
  const categories = categoriesData || [];

  function applyPreset(preset) {
    const r = preset.range();
    setForm((current) => ({ ...current, ...r }));
    setQuery((current) => ({ ...current, ...r }));
  }

  function exportCsv() {
    if (!sections.length) return;
    download(`/api/reports/export${exportQs}`);
  }

  function exportPdf() {
    if (!data || !sections.length) return;
    const avgH = data.summary.avg_resolution_hours;
    const avgLabel = avgH >= 24 ? `${(avgH / 24).toFixed(1)} días` : `${avgH} h`;
    const reportSections = [
      ['summary', 'Resumen', ['Métrica', 'Valor'], [
        ['Total de tickets', data.summary.total],
        ['Tickets abiertos', data.summary.open],
        ['Resueltos + cerrados', data.summary.resolved],
        ['Sin resolver > 7 días', data.summary.unresolved_week],
        ['Tiempo medio resolución', avgLabel],
      ]],
      ['status', 'Tickets por estado', ['Estado', 'Cantidad'], data.byStatus.map((d) => [STATUS_LABEL[d.status] || d.status, d.n])],
      ['priority', 'Tickets abiertos por prioridad', ['Prioridad', 'Cantidad'], data.byPriority.map((d) => [PRIORITY_LABEL[d.priority] || d.priority, d.n])],
      ['category', 'Tickets por categoría', ['Categoría', 'Total', 'Abiertos'], data.byCategory.map((d) => [d.name, d.n, d.open])],
      ['department', 'Tickets por departamento', ['Departamento', 'Total', 'Abiertos'], data.byDepartment.map((d) => [d.name, d.n, d.open])],
      ['reporters', 'Top reporteros', ['Empleado', 'Total', 'Abiertos'], data.performance.by_user.map((u) => [u.reporter, u.total, u.open])],
      ['resolved', 'Resueltos por día', ['Día', 'Cantidad'], data.performance.by_day.map((d) => [d.day, d.n])],
      ['details', 'Detalle de tickets', ['Ticket', 'Título', 'Estado', 'Prioridad', 'Reportero', 'Asignado a', 'Departamento', 'Categoría', 'Creado', 'Resuelto/cerrado'], data.details.map((t) => [t.ticket_number, t.title, STATUS_LABEL[t.status] || t.status, PRIORITY_LABEL[t.priority] || t.priority, t.reporter, t.assigned_to, t.department, t.category, t.created_at, t.resolved_at || t.closed_at || ''])],
    ];
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
      sections: reportSections
        .filter(([key]) => sections.includes(key))
        .map(([, title, headers, rows]) => ({ title, headers, rows })),
    });
    if (!opened) {
      alert('El navegador bloqueó la ventana del PDF. Habilite las ventanas emergentes e intente nuevamente.');
    }
  }

  if (isLoading && !data) return <LoadingScreen text="Cargando reportes…" />;
  if (!data) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorBox message={error?.message || 'No se pudieron cargar los reportes'} />
        <button className="btn-secondary mt-4" onClick={() => refetch()}>
          Reintentar
        </button>
      </div>
    );
  }

  const departments = departmentsData || [];
  const categories = categoriesData || [];
  const loading = isFetching;

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
            <button className="btn-white" onClick={exportCsv}>
              Exportar CSV
            </button>
            <button className="btn-primary" onClick={exportPdf} disabled={!sections.length}>
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
          <div>
            <label className="label" htmlFor="report-status">Estado</label>
            <select id="report-status" className="input !w-auto" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
              <option value="">Todos</option>
              {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="report-priority">Prioridad</label>
            <select id="report-priority" className="input !w-auto" value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
              <option value="">Todas</option>
              {PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="report-department">Departamento</label>
            <select id="report-department" className="input !w-auto" value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))}>
              <option value="">Todos</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="report-category">Categoría</label>
            <select id="report-category" className="input !w-auto" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
              <option value="">Todas</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.key} className="btn-ghost !px-2.5 !py-1.5 text-xs" onClick={() => applyPreset(p)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <fieldset className="mt-4 border-t border-slate-200 pt-4">
          <legend className="mb-2 text-sm font-medium text-slate-500">Incluir en la exportación</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {SECTIONS.map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600"
                  checked={sections.includes(key)}
                  onChange={() => setSections((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
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

      <div className="card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-700">Detalle de tickets</h3>
          <span className="text-xs text-slate-400">{data.details.length} registro(s), máximo 500 en exportación</span>
        </div>
        {data.details.length === 0 ? (
          <p className="text-sm text-slate-400">Sin datos</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50"><tr><th className="th">Ticket</th><th className="th">Título</th><th className="th">Estado</th><th className="th">Prioridad</th><th className="th">Departamento</th><th className="th">Reportero</th><th className="th">Creado</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.details.slice(0, 20).map((ticket) => (
                  <tr key={ticket.ticket_number} className="hover:bg-slate-50"><td className="td font-mono text-xs">{ticket.ticket_number}</td><td className="td">{ticket.title}</td><td className="td">{STATUS_LABEL[ticket.status] || ticket.status}</td><td className="td">{PRIORITY_LABEL[ticket.priority] || ticket.priority}</td><td className="td">{ticket.department}</td><td className="td">{ticket.reporter}</td><td className="td whitespace-nowrap">{ticket.created_at}</td></tr>
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

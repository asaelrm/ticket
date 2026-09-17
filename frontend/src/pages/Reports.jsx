import { useEffect, useState } from 'react';
import { api, STATUS_LABEL, PRIORITY_LABEL } from '../lib/api';
import { LoadingScreen } from '../components/ui';

const STATUS_COLORS = {
  OPEN: '#3b82f6',
  ASSIGNED: '#6366f1',
  IN_PROGRESS: '#f59e0b',
  PENDING: '#a855f7',
  RESOLVED: '#10b981',
  CLOSED: '#94a3b8',
  CANCELLED: '#ef4444',
};

const PRIORITY_COLORS = { LOW: '#94a3b8', MEDIUM: '#0ea5e9', HIGH: '#f97316', CRITICAL: '#dc2626' };

export default function Reports() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get('/api/reports/summary'),
      api.get('/api/reports/by-status'),
      api.get('/api/reports/by-priority'),
      api.get('/api/reports/by-category'),
      api.get('/api/reports/by-department'),
      api.get('/api/reports/performance'),
    ])
      .then(([s, st, pr, ca, de, pf]) => {
        if (!active) return;
        setData({ summary: s, byStatus: st.data, byPriority: pr.data, byCategory: ca.data, byDepartment: de.data, performance: pf });
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  if (loading || !data) return <LoadingScreen text="Cargando reportes…" />;

  const maxStatus = Math.max(...data.byStatus.map((d) => d.n), 1);
  const maxDept = Math.max(...data.byDepartment.map((d) => d.n), 1);
  const maxPrio = Math.max(...data.byPriority.map((d) => d.n), 1);
  const avgH = data.summary.avg_resolution_hours;
  const avgLabel = avgH >= 24 ? `${(avgH / 24).toFixed(1)} días` : `${avgH} h`;

  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold text-slate-800">Reportes de operación</h2>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Total tickets" value={data.summary.total} />
        <Kpi label="Tickets abiertos" value={data.summary.open} color="text-blue-600" />
        <Kpi label="Resueltos + cerrados" value={data.summary.resolved} color="text-emerald-600" />
        <Kpi label="Sin resolver > 7 días" value={data.summary.unresolved_week} color="text-red-600" />
        <Kpi label="Tiempo medio resolución" value={avgLabel} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Tickets por estado" bodyClass="!h-auto">
          {data.byStatus.map((d) => (
            <Bar key={d.status} label={STATUS_LABEL[d.status]} n={d.n} pct={maxStatus ? (d.n / maxStatus) * 100 : 0} color={STATUS_COLORS[d.status]} />
          ))}
        </ChartCard>

        <ChartCard title="Tickets abiertos por prioridad">
          {data.byPriority.map((d) => (
            <Bar key={d.priority} label={PRIORITY_LABEL[d.priority]} n={d.n} pct={maxPrio ? (d.n / maxPrio) * 100 : 0} color={PRIORITY_COLORS[d.priority]} />
          ))}
        </ChartCard>

        <ChartCard title="Tickets por categoría">
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
          {data.byDepartment.map((d) => (
            <Bar key={d.name} label={d.name} n={d.n} pct={maxDept ? (d.n / maxDept) * 100 : 0} color="#6366f1" />
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
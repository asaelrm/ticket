import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, STATUS_LABEL, PRIORITY_LABEL, formatDate } from '../lib/api';
import { LoadingScreen, Spinner } from '../components/ui';

const STATUS_COLORS = {
  OPEN: '#3b82f6',
  ASSIGNED: '#6366f1',
  IN_PROGRESS: '#f59e0b',
  PENDING: '#a855f7',
  RESOLVED: '#10b981',
  CLOSED: '#94a3b8',
  CANCELLED: '#ef4444',
};

function Card({ label, value, hint, color = 'bg-brand-600' }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-3xl font-bold text-slate-800">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [summary, setSummary] = useState(null);
  const [byStatus, setByStatus] = useState([]);
  const [byPriority, setByPriority] = useState([]);
  const [byCategory, setByCategory] = useState([]);
  const [byDepartment, setByDepartment] = useState([]);
  const [trend, setTrend] = useState([]);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get('/api/dashboard/summary'),
      api.get('/api/dashboard/by-status'),
      api.get('/api/dashboard/by-priority'),
      api.get('/api/dashboard/by-category'),
      api.get('/api/dashboard/by-department'),
      api.get('/api/dashboard/trend?range=day'),
      api.get('/api/dashboard/recent'),
    ])
      .then(([s, st, pr, ca, de, tr, re]) => {
        if (!active) return;
        setSummary(s);
        setByStatus(st.data || []);
        setByPriority(pr.data || []);
        setByCategory(ca.data || []);
        setByDepartment(de.data || []);
        setTrend(tr.data || []);
        setRecent(re.data || []);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <LoadingScreen text="Cargando dashboard…" />;

  const statusTotal = byStatus.reduce((a, b) => a + b.n, 0) || 1;
  const maxStatus = Math.max(...byStatus.map((d) => d.n), 1);
  const maxTrend = Math.max(...trend.flatMap((d) => [d.created, d.resolved]), 1);

  const order = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED'];
  const statusSorted = [...byStatus].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card label="Abiertos" value={summary.counts.OPEN} color="bg-blue-500" />
        <Card label="Asignados" value={summary.counts.ASSIGNED} color="bg-indigo-500" />
        <Card label="En proceso" value={summary.counts.IN_PROGRESS} color="bg-amber-500" />
        <Card label="Pendientes" value={summary.counts.PENDING} color="bg-purple-500" />
        <Card label="Resueltos" value={summary.counts.RESOLVED} color="bg-emerald-500" />
        <Card label="Críticos" value={summary.critical} color="bg-red-600" hint="Tickets críticos abiertos" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Tendencia */}
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">Tendencia últimos 14 días</h3>
            <span className="flex gap-3 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand-600" /> Creados</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Resueltos</span>
            </span>
          </div>
          <div className="flex h-40 items-end gap-1">
            {trend.map((d) => (
              <div key={d.label} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex w-full flex-1 items-end justify-center gap-0.5">
                  <div
                    className="w-2.5 rounded-t bg-brand-600"
                    style={{ height: `${Math.max((d.created / maxTrend) * 100, 2)}%` }}
                    title={`${d.label}: ${d.created} creados`}
                  />
                  <div
                    className="w-2.5 rounded-t bg-emerald-500"
                    style={{ height: `${Math.max((d.resolved / maxTrend) * 100, 2)}%` }}
                    title={`${d.label}: ${d.resolved} resueltos`}
                  />
                </div>
                <span className="text-[9px] text-slate-400">{d.label.slice(8)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Por estado */}
        <div className="card p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Tickets por estado</h3>
          <div className="space-y-3">
            {statusSorted.map((d) => (
              <div key={d.status}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="text-slate-600">{STATUS_LABEL[d.status]}</span>
                  <span className="font-semibold text-slate-800">{d.n}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${(d.n / statusTotal) * 100}%`, backgroundColor: STATUS_COLORS[d.status] }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Por categoría */}
        <div className="card p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Tickets por categoría</h3>
          {byCategory.length === 0 ? (
            <p className="text-sm text-slate-400">Sin datos</p>
          ) : (
            <ul className="space-y-2">
              {byCategory.map((d) => (
                <li key={d.name} className="flex items-center gap-2 text-sm">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.color || '#64748b' }} />
                  <span className="min-w-0 flex-1 truncate text-slate-600">{d.name}</span>
                  <span className="font-semibold text-slate-800">{d.n}</span>
                  <span className="w-10 text-right text-xs text-slate-400">{d.open} abiertos</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Por departamento */}
        <div className="card p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Tickets por departamento</h3>
          {byDepartment.length === 0 ? (
            <p className="text-sm text-slate-400">Sin datos</p>
          ) : (
            <ul className="space-y-2">
              {byDepartment.map((d) => (
                <li key={d.name} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-slate-600">{d.name}</span>
                  <span className="font-semibold text-slate-800">{d.n}</span>
                  <span className="w-10 text-right text-xs text-slate-400">{d.open} abiertos</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Recientes */}
      <div className="card">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-700">Tickets recientes</h3>
          <Link to="/app/tickets" className="text-sm font-medium text-brand-600 hover:text-brand-700">
            Ver todos →
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Ticket</th>
                <th className="th">Título</th>
                <th className="th">Categoría</th>
                <th className="th">Prioridad</th>
                <th className="th">Estado</th>
                <th className="th">Fecha</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recent.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="td font-semibold text-brand-600">
                    <Link to={`/app/tickets/${t.id}`} className="hover:underline">{t.ticket_number}</Link>
                  </td>
                  <td className="td max-w-[220px]">
                    <Link to={`/app/tickets/${t.id}`} className="block truncate text-slate-700 hover:text-brand-700">{t.title}</Link>
                  </td>
                  <td className="td text-slate-500">{t.category_name || '—'}</td>
                  <td className="td">{PRIORITY_LABEL[t.priority]}</td>
                  <td className="td">{STATUS_LABEL[t.status]}</td>
                  <td className="td whitespace-nowrap text-slate-500">{formatDate(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
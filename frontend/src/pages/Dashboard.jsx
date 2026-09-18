import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, STATUS_LABEL, PRIORITY_LABEL, formatDate } from '../lib/api';
import { LoadingScreen, Spinner, ErrorBox } from '../components/ui';

const STATUS_COLORS = {
  OPEN: '#f59e0b',
  ASSIGNED: '#2196f3',
  IN_PROGRESS: '#22c77a',
  PENDING: '#38bdf8',
  RESOLVED: '#20c7b7',
  CLOSED: '#94a3b8',
  CANCELLED: '#ef4444',
};

const ICON = {
  open: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M9.5 9.5l5 5m0-5l-5 5" />
    </svg>
  ),
  assigned: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM12 16a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l2 2 3-3" />
    </svg>
  ),
  progress: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
    </svg>
  ),
  pending: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M10 8.5v7M14 8.5v7" />
    </svg>
  ),
  resolved: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  ),
  critical: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4L3 20h18L12 4z" />
      <path strokeLinecap="round" d="M12 9v4m0 3h.01" />
    </svg>
  ),
};

function Card({ label, value, hint, icon, color = '#22c77a' }) {
  return (
    <div className="card relative overflow-hidden p-4">
      <span
        className="absolute inset-x-0 top-0 h-0.5"
        style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }}
      />
      <div className="flex items-center gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
          style={{ background: `${color}1f`, color, boxShadow: `0 0 0 1px ${color}40` }}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
          <p className="text-3xl font-extrabold leading-tight text-slate-800">{value}</p>
        </div>
      </div>
      {hint && <p className="mt-2 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function SlaStat({ label, value, tone, hint }) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border px-4 py-3"
      style={{ borderColor: `${tone}40`, background: `${tone}14` }}
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
        style={{ background: `${tone}22`, color: tone }}
      >
        <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
        <p className="text-2xl font-extrabold leading-tight text-slate-800">{value}</p>
      </div>
      {hint && <p className="ml-auto hidden text-right text-[11px] text-slate-400 sm:block">{hint}</p>}
    </div>
  );
}

function slaRel(iso, overdue) {
  if (!iso) return 'Sin plazo';
  const ms = Math.abs(new Date(iso).getTime() - Date.now());
  const h = ms / 3600000;
  const t = h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
  return overdue ? `Vencido hace ${t}` : `Vence en ${t}`;
}

export default function Dashboard() {
  const [summary, setSummary] = useState(null);
  const [byStatus, setByStatus] = useState([]);
  const [byPriority, setByPriority] = useState([]);
  const [byCategory, setByCategory] = useState([]);
  const [byDepartment, setByDepartment] = useState([]);
  const [trend, setTrend] = useState([]);
  const [recent, setRecent] = useState([]);
  const [sla, setSla] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const loadedOnce = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      api.get('/api/dashboard/summary'),
      api.get('/api/dashboard/by-status'),
      api.get('/api/dashboard/by-priority'),
      api.get('/api/dashboard/by-category'),
      api.get('/api/dashboard/by-department'),
      api.get('/api/dashboard/trend?range=day'),
      api.get('/api/dashboard/recent'),
      api.get('/api/dashboard/sla').catch(() => null),
    ])
      .then(([s, st, pr, ca, de, tr, re, sla]) => {
        if (!active) return;
        setSummary(s);
        setByStatus(st.data || []);
        setByPriority(pr.data || []);
        setByCategory(ca.data || []);
        setByDepartment(de.data || []);
        setTrend(tr.data || []);
        setRecent(re.data || []);
        setSla(sla);
        setLastUpdate(new Date());
        loadedOnce.current = true;
      })
      .catch((err) => {
        if (active) setError(err.message || 'No se pudo cargar el dashboard');
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [reloadKey]);

  // Refresco silencioso en vivo cada 30 s (solo cuando la pestaña es visible).
  useEffect(() => {
    if (!loadedOnce.current) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      Promise.all([
        api.get('/api/dashboard/summary'),
        api.get('/api/dashboard/by-status'),
        api.get('/api/dashboard/by-priority'),
        api.get('/api/dashboard/by-category'),
        api.get('/api/dashboard/by-department'),
        api.get('/api/dashboard/trend?range=day'),
        api.get('/api/dashboard/recent'),
        api.get('/api/dashboard/sla').catch(() => null),
      ])
        .then(([s, st, pr, ca, de, tr, re, sla]) => {
          setSummary(s);
          setByStatus(st.data || []);
          setByPriority(pr.data || []);
          setByCategory(ca.data || []);
          setByDepartment(de.data || []);
          setTrend(tr.data || []);
          setRecent(re.data || []);
          setSla(sla);
          setLastUpdate(new Date());
        })
        .catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, []);

  if (loading) return <LoadingScreen text="Cargando dashboard…" />;
  if (error && !summary) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorBox message={error} />
        <button className="btn-secondary mt-4" onClick={() => setReloadKey((k) => k + 1)}>
          Reintentar
        </button>
      </div>
    );
  }

  const counts = summary?.counts || {};

  const statusTotal = byStatus.reduce((a, b) => a + b.n, 0) || 1;
  const maxStatus = Math.max(...byStatus.map((d) => d.n), 1);
  const maxTrend = Math.max(...trend.flatMap((d) => [d.created, d.resolved]), 1);

  const order = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED'];
  const statusSorted = [...byStatus].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <span className="text-xs font-semibold uppercase tracking-wider text-emerald-300">En vivo</span>
        </div>
        {lastUpdate && (
          <p className="text-xs text-slate-400">
            Actualizado a las{' '}
            {lastUpdate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card label="Abiertos" value={counts.OPEN ?? 0} icon={ICON.open} color="#f59e0b" hint="En espera de atención" />
        <Card label="Asignados" value={counts.ASSIGNED ?? 0} icon={ICON.assigned} color="#20c7b7" hint="Llamado por el equipo" />
        <Card label="En proceso" value={counts.IN_PROGRESS ?? 0} icon={ICON.progress} color="#22c77a" hint="Siendo atendido" />
        <Card label="Pendientes" value={counts.PENDING ?? 0} icon={ICON.pending} color="#2196f3" hint="Programados o en pausa" />
        <Card label="Resueltos" value={counts.RESOLVED ?? 0} icon={ICON.resolved} color="#59b77c" hint="Atención completada" />
        <Card label="Críticos" value={summary?.critical ?? 0} icon={ICON.critical} color="#dc2626" hint="Críticos abiertos" />
      </div>

      {/* SLA · Estado de atención */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">SLA · Estado de atención</h3>
            <p className="text-xs text-slate-400">Plazo estimado de resolución según prioridad</p>
          </div>
          <Link
            to="/app/tickets?view=overdue"
            className="inline-flex items-center gap-1 text-sm font-semibold text-brand-300 hover:text-brand-200"
          >
            Ver retrasados <span aria-hidden>→</span>
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-3">
          <SlaStat label="Vencidos" value={sla?.overdue ?? 0} tone="#ef4444" hint="Fuera del plazo SLA" />
          <SlaStat label="Próximas 24 h" value={sla?.atRisk ?? 0} tone="#f59e0b" hint="Vencen en menos de 24 h" />
          <SlaStat label="Dentro de plazo" value={sla?.healthy ?? 0} tone="#22c77a" hint="Con SLA en orden" />
        </div>

        {sla?.top?.length ? (
          <div className="overflow-x-auto border-t border-slate-200">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Ticket</th>
                  <th className="th">Título</th>
                  <th className="th hidden md:table-cell">Solicitante</th>
                  <th className="th">Prioridad</th>
                  <th className="th">SLA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sla.top.map((t) => (
                  <tr key={t.id} className="group">
                    <td className="td whitespace-nowrap font-semibold text-brand-300">
                      <Link to={`/app/tickets/${t.id}`} className="group-hover:underline">
                        #{t.ticket_number}
                      </Link>
                    </td>
                    <td className="td max-w-xs">
                      <Link to={`/app/tickets/${t.id}`} className="block truncate font-medium text-slate-700 group-hover:text-brand-300">
                        {t.title}
                      </Link>
                    </td>
                    <td className="td hidden whitespace-nowrap text-slate-500 md:table-cell">{t.reporter_name}</td>
                    <td className="td whitespace-nowrap text-sm text-slate-500">{PRIORITY_LABEL[t.priority] || t.priority}</td>
                    <td className="td whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                          t.is_overdue ? 'text-red-500' : 'text-slate-400'
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${t.is_overdue ? 'bg-red-500' : 'bg-emerald-500'}`} />
                        {slaRel(t.sla_due_at, t.is_overdue)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border-t border-slate-200 px-5 py-6 text-center text-sm text-slate-400">
            Sin tickets abiertos con SLA definido.
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Tendencia */}
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">Tendencia últimos 14 días</h3>
            <span className="flex gap-3 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand-600" /> Creados</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-teal-400" /> Resueltos</span>
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
                    className="w-2.5 rounded-t bg-teal-400"
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
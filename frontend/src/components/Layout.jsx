import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, can } from '../context/AuthContext';
import Notifications from './Notifications';

const ICONS = {
  home: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 10.5L12 3l9 7.5M5 9.5V21h14V9.5M9 21v-6h6v6" />
    </svg>
  ),
  add: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
    </svg>
  ),
  tickets: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18v4a2 2 0 0 0 0 4v4H3zM7 10v2" />
    </svg>
  ),
  users: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm13 10v-2a4 4 0 0 0-3-3.87m-1-12a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  categories: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M3 12h18M3 18h18" />
      <circle cx="7" cy="6" r="1.4" fill="currentColor" />
      <circle cx="11" cy="12" r="1.4" fill="currentColor" />
      <circle cx="15" cy="18" r="1.4" fill="currentColor" />
    </svg>
  ),
  departments: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V8l7-4 7 4v13M9 21v-6h6v6" />
    </svg>
  ),
  teams: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 20v-1a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 9v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  roles: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm6-3h.01M18 12h.01M6 12h.01" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  ),
  reports: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10m6 10V4m6 16v-7m4 7H2" />
    </svg>
  ),
  settings: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7.4 7.4 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.4 7.4 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7.4 7.4 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.4 7.4 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z" />
    </svg>
  ),
  inbox: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm-2 4l-5 4-5-4" />
    </svg>
  ),
  audit: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9l2 2 4-4" />
    </svg>
  ),
};

const TITLES = {
  '/app/dashboard': 'Dashboard',
  '/app/tickets': 'Todos los tickets',
  '/app/new-ticket': 'Reportar incidencia',
  '/app/my-tickets': 'Mis tickets',
  '/app/users': 'Usuarios',
  '/app/categories': 'Categorías',
  '/app/departments': 'Departamentos',
  '/app/teams': 'Equipos de trabajo',
  '/app/roles': 'Roles',
  '/app/reports': 'Reportes',
  '/app/settings': 'Configuración',
  '/app/profile': 'Mi cuenta',
  '/app/inbox': 'Bandeja',
  '/app/audit': 'Auditoría',
};

export default function Layout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [now, setNow] = useState(() => new Date());
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  function onGlobalSearch(e) {
    e.preventDefault();
    const term = q.trim();
    const target = can(user, 'ticket.view.all') ? '/app/inbox' : '/app/my-tickets';
    navigate(term ? `${target}?search=${encodeURIComponent(term)}` : target);
  }

  const primary = [];
  if (can(user, 'dashboard.view')) primary.push({ to: '/app/dashboard', label: 'Dashboard', icon: ICONS.home });
  primary.push({ to: '/app/my-tickets', label: 'Mis tickets', icon: ICONS.tickets });
  if (can(user, 'ticket.view.all')) {
    primary.push({ to: '/app/inbox', label: 'Bandeja de soporte', icon: ICONS.inbox });
  }

  const management = [];
  if (can(user, 'ticket.view.all')) management.push({ to: '/app/tickets', label: 'Todos los tickets', icon: ICONS.tickets });
  if (can(user, 'user.view')) management.push({ to: '/app/users', label: 'Usuarios', icon: ICONS.users });
  if (can(user, 'category.manage')) management.push({ to: '/app/categories', label: 'Categorías', icon: ICONS.categories });
  if (can(user, 'department.manage')) management.push({ to: '/app/departments', label: 'Departamentos', icon: ICONS.departments });
  if (can(user, 'team.manage')) management.push({ to: '/app/teams', label: 'Equipos', icon: ICONS.teams });
  if (can(user, 'role.manage')) management.push({ to: '/app/roles', label: 'Roles', icon: ICONS.roles });

  const system = [];
  if (can(user, 'report.view')) system.push({ to: '/app/reports', label: 'Reportes', icon: ICONS.reports });
  if (can(user, 'settings.manage')) system.push({ to: '/app/settings', label: 'Configuración', icon: ICONS.settings });
  if (can(user, 'settings.manage')) system.push({ to: '/app/audit', label: 'Auditoría', icon: ICONS.audit });

  const sections = [
    { title: 'Principal', items: primary },
    { title: 'Gestión', items: management },
    { title: 'Sistema', items: system },
  ].filter((s) => s.items.length);

  const currentTitle = TITLES[location.pathname] || 'Tickets';
  const initials = user
    ? `${user.name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase()
    : '?';

  const sidebar = (
    <div className="flex h-full flex-col">
      <button
        className="flex items-center gap-3 px-5 pb-4 pt-5 text-left"
        onClick={() => navigate('/app')}
        title="Centro Médico UCE · NexTurn"
      >
        <span className="flex h-16 w-36 shrink-0 items-center rounded-2xl bg-[#0a253a] p-2 shadow-lg shadow-slate-950/20">
          <img
            alt="Centro Médico UCE"
            className="h-full w-full object-contain"
            src="/logo-centro-medico-uce.png"
          />
        </span>
        <span className="hidden min-w-0 md:block">
          <span className="block text-lg font-extrabold leading-tight text-slate-800">Tickets</span>
          <span className="block truncate text-[11px] text-slate-400">Gestión de incidencias</span>
        </span>
      </button>

      {can(user, 'ticket.create') && (
        <div className="px-3 pb-3">
          <NavLink to="/app/new-ticket" className="btn-primary w-full justify-center">
            {ICONS.add}
            Reportar incidencia
          </NavLink>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-3 pb-2">
        {sections.map((section) => (
          <div key={section.title} className="mb-1">
            <p className="app-nav-section px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider">
              {section.title}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/app/dashboard' || item.to === '/app/my-tickets' || item.to === '/app/inbox'}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                      isActive ? 'app-nav-active' : `app-nav-item${item.alwaysWhite ? ' app-nav-item-white' : ''}`
                    }`
                  }
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-2 border-t border-white/10 p-3">
        <p className="px-2 pb-2 text-center text-[11px] font-medium italic text-emerald-200/70">
          “Tu salud, nuestra prioridad”
        </p>
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-xs font-bold text-emerald-200">
            {initials}
          </span>
          <div className="min-w-0 flex-1 hidden md:block">
            <p className="truncate text-sm font-semibold text-slate-800">
              {user?.name} {user?.last_name}
            </p>
            <p className="truncate text-xs text-slate-400">{user?.role_name}</p>
          </div>
          <button
            onClick={() => logout().then(() => navigate('/login'))}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
            title="Cerrar sesión"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v1" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      {/* Sidebar escritorio */}
      <aside className="app-sidebar fixed inset-y-0 left-0 z-30 hidden w-64 border-r lg:block">
        {sidebar}
      </aside>

      {/* Sidebar móvil */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50 nex-fade" onClick={() => setOpen(false)} />
          <aside className="app-sidebar absolute inset-y-0 left-0 w-72 nex-slide">{sidebar}</aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="app-topbar sticky top-0 z-20 flex items-center gap-3 px-4 py-3 lg:px-8">
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 lg:hidden"
            aria-label="Abrir menú"
          >
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="text-lg font-semibold text-slate-800">{currentTitle}</h1>

          <form onSubmit={onGlobalSearch} className="relative ml-1 hidden md:block">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar paciente, cédula o turno…"
              aria-label="Buscar"
              className="w-52 rounded-full border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder-slate-400 transition duration-150 focus:border-emerald-300/50 focus:outline-none focus:ring-2 focus:ring-emerald-400/20 lg:w-64"
            />
          </form>

          <div className="ml-auto flex items-center gap-2">
            <div className="mr-1 hidden text-right xl:block">
              <p className="text-sm font-semibold leading-tight text-slate-200">
                {now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </p>
              <p className="text-[11px] capitalize leading-tight text-slate-400">
                {now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}
              </p>
            </div>
            <Notifications />
            <button
              onClick={() => navigate('/app/profile')}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-100"
              title="Mi cuenta"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7z" />
              </svg>
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

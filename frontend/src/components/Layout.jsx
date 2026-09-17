import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, can } from '../context/AuthContext';

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
};

const TITLES = {
  '/app/dashboard': 'Dashboard',
  '/app/tickets': 'Tickets',
  '/app/new-ticket': 'Reportar incidencia',
  '/app/my-tickets': 'Mis tickets',
  '/app/users': 'Usuarios',
  '/app/categories': 'Categorías',
  '/app/departments': 'Departamentos',
  '/app/roles': 'Roles',
  '/app/reports': 'Reportes',
  '/app/settings': 'Configuración',
  '/app/profile': 'Mi cuenta',
};

export default function Layout() {
  const { user, logout, appName } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const items = [];
  if (can(user, 'ticket.create')) items.push({ to: '/app/new-ticket', label: 'Reportar incidencia', icon: ICONS.add });
  items.push({ to: '/app/my-tickets', label: 'Mis tickets', icon: ICONS.tickets });
  if (can(user, 'dashboard.view')) items.push({ to: '/app/dashboard', label: 'Dashboard', icon: ICONS.home });
  if (can(user, 'ticket.view.all')) items.push({ to: '/app/tickets', label: 'Tickets', icon: ICONS.tickets });
  if (can(user, 'user.view')) items.push({ to: '/app/users', label: 'Usuarios', icon: ICONS.users });
  if (can(user, 'category.manage')) items.push({ to: '/app/categories', label: 'Categorías', icon: ICONS.categories });
  if (can(user, 'department.manage')) items.push({ to: '/app/departments', label: 'Departamentos', icon: ICONS.departments });
  if (can(user, 'role.manage')) items.push({ to: '/app/roles', label: 'Roles', icon: ICONS.roles });
  if (can(user, 'report.view')) items.push({ to: '/app/reports', label: 'Reportes', icon: ICONS.reports });
  if (can(user, 'settings.manage')) items.push({ to: '/app/settings', label: 'Configuración', icon: ICONS.settings });

  const currentTitle = TITLES[location.pathname] || 'Ticket Flow';
  const initials = user
    ? `${user.name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase()
    : '?';

  const sidebar = (
    <div className="flex h-full flex-col">
      <button
        className="flex items-center gap-2 px-5 py-5 text-left"
        onClick={() => navigate('/app')}
      >
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-white">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" d="M6 6h12v2H6zM6 11h12v2H6zM6 16h7v2H6z" />
          </svg>
        </span>
        <span className="hidden md:block">
          <span className="block text-sm font-bold leading-tight text-slate-800">{appName}</span>
          <span className="block text-xs text-slate-400">Gestión de incidencias</span>
        </span>
      </button>

      <nav className="flex-1 space-y-1 px-3">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/app/dashboard' || item.to === '/app/my-tickets'}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`
            }
          >
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-slate-200 p-3 mt-2">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
            {initials}
          </span>
          <div className="min-w-0 flex-1 hidden md:block">
            <p className="truncate text-sm font-semibold text-slate-800">
              {user?.name} {user?.last_name}
            </p>
            <p className="truncate text-xs text-slate-500">{user?.role_name}</p>
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
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-200 bg-white lg:block">
        {sidebar}
      </aside>

      {/* Sidebar móvil */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-pop">{sidebar}</aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:px-8">
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
            aria-label="Abrir menú"
          >
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="text-lg font-semibold text-slate-800">{currentTitle}</h1>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => navigate('/app/profile')}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
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
import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, can } from '../context/AuthContext';
import Notifications from './Notifications';
import Tooltip from './Tooltip';

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
  templates: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
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
  knowledge: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.5S10 4 5.5 4H3v14h2.5C9 18 12 20.5 12 20.5S15 18 18.5 18H21V4h-2.5C14 4 12 6.5 12 6.5zm0 0V20.5" />
    </svg>
  ),
  kbAdmin: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h16v4H4zM4 12h7v8H4zM15 12h5v8h-5z" />
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
  '/app/templates': 'Respuestas rápidas',
  '/app/settings': 'Configuración',
  '/app/profile': 'Mi cuenta',
  '/app/inbox': 'Bandeja',
  '/app/audit': 'Auditoría',
  '/app/knowledge': 'Base de conocimiento',
  '/app/knowledge/new': 'Nuevo artículo',
  '/app/knowledge/admin': 'Administrar conocimientos',
};

// El reloj es lo único que cambia cada segundo, así que vive aquí y no en
// Layout: con el estado arriba, cada tic repintaba la cabecera entera
// (notificaciones, tooltips, enlaces del menú) aunque solo un texto hubiera
// cambiado. Aquí solo se repinta este bloque.
function HeaderClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="mr-1 hidden text-right xl:block">
      <p className="text-sm font-semibold leading-tight text-white">
        {now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </p>
      <p className="text-[11px] capitalize leading-tight text-slate-400">
        {now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}
      </p>
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'));
  const [q, setQ] = useState('');
  const searchPanelRef = useRef(null);
  const searchToggleRef = useRef(null);
  const searchInputRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setOpen(false);
    setSearchOpen(false);
  }, [location.pathname]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('sifha-theme', next);
    setTheme(next);
  }

  function onGlobalSearch(e) {
    e.preventDefault();
    const term = q.trim();
    const target = can(user, 'ticket.view.all') ? '/app/inbox' : '/app/my-tickets';
    navigate(term ? `${target}?search=${encodeURIComponent(term)}` : target);
  }

  // El panel de búsqueda del móvil se apoya en el formulario de escritorio:
  // mismo estado `q` y mismo `onGlobalSearch`, así que lo que se busca y a
  // dónde se llega son exactamente los mismos en los dos tamaños.
  //
  // `focus` distingue dos cierres: al cerrar con el teclado (Escape) o al
  // enviar, el foco vuelve al botón que abrió el panel —si no, se perdía en el
  // cuerpo de la página y el usuario de teclado tenía que recorrer toda la
  // cabecera para volver a él—. Al cerrar tocando fuera no se recupera: quien
  // cierra con el dedo no espera que le devuelvan el foco a la barra.
  function closeSearch({ focus = true } = {}) {
    setSearchOpen(false);
    if (focus) searchToggleRef.current?.focus();
  }

  function onMobileSearchSubmit(e) {
    onGlobalSearch(e);
    // El panel se retira para no tapar los resultados. No hace falta esperar a la
    // navegación: si ya se estaba en el listado, la ruta no cambia y el panel se
    // quedaría encima.
    closeSearch();
  }

  useEffect(() => {
    if (!searchOpen) return undefined;
    // Foco en el campo al abrir: en móvil es lo único accionable y así el
    // teclado sube directamente. En el efecto y no en el clic porque el campo
    // todavía no existe cuando se atiende el evento.
    searchInputRef.current?.focus();
    // Igual que el panel de notificaciones: se cierra con Escape o al tocar
    // fuera. Además, así los dos paneles de la cabecera no pueden quedar
    // abiertos a la vez —el clic en el otro es un clic fuera de este—.
    //
    // El botón que abre el panel NO cuenta como clic exterior: si contara, el
    // `mousedown` lo cerraría y el `click` del mismo toque lo volvería a abrir,
    // y la lupa no serviría para cerrar.
    const onClick = (e) => {
      const dentro = searchPanelRef.current?.contains(e.target) || searchToggleRef.current?.contains(e.target);
      if (!dentro) closeSearch({ focus: false });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') closeSearch();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen]);

  const primary = [];
  if (can(user, 'dashboard.view')) primary.push({ to: '/app/dashboard', label: 'Dashboard', icon: ICONS.home });
  primary.push({ to: '/app/my-tickets', label: 'Mis tickets', icon: ICONS.tickets });
  if (can(user, 'ticket.view.all')) {
    primary.push({ to: '/app/inbox', label: 'Bandeja de soporte', icon: ICONS.inbox });
  }
  // La base de conocimiento va en «Principal» porque es consulta, no gestión:
  // cualquiera con kb.view la consulta a diario. Se marca activa en el listado,
  // la ficha y el editor, pero no en /admin, que tiene su propia entrada.
  if (can(user, 'kb.view')) {
    primary.push({
      to: '/app/knowledge',
      label: 'Conocimientos',
      icon: ICONS.knowledge,
      active: (path) => path === '/app/knowledge' || /^\/app\/knowledge\/\d+(\/edit)?$/.test(path),
    });
  }

  const management = [];
  if (can(user, 'ticket.view.all')) management.push({ to: '/app/tickets', label: 'Todos los tickets', icon: ICONS.tickets });
  if (can(user, 'user.view')) management.push({ to: '/app/users', label: 'Usuarios', icon: ICONS.users });
  if (can(user, 'category.manage')) management.push({ to: '/app/categories', label: 'Categorías', icon: ICONS.categories });
  if (can(user, 'department.manage')) management.push({ to: '/app/departments', label: 'Departamentos', icon: ICONS.departments });
  if (can(user, 'team.manage')) management.push({ to: '/app/teams', label: 'Equipos', icon: ICONS.teams });
  if (can(user, 'role.manage')) management.push({ to: '/app/roles', label: 'Roles', icon: ICONS.roles });
  if (can(user, 'kb.manage')) {
    management.push({ to: '/app/knowledge/admin', label: 'Artículos y categorías', icon: ICONS.kbAdmin, end: true });
  }

  const system = [];
  if (can(user, 'report.view')) system.push({ to: '/app/reports', label: 'Reportes', icon: ICONS.reports });
  if (can(user, 'settings.manage') || can(user, 'team.manage')) {
    system.push({ to: '/app/templates', label: 'Respuestas rápidas', icon: ICONS.templates });
  }
  if (can(user, 'settings.manage')) system.push({ to: '/app/settings', label: 'Configuración', icon: ICONS.settings });
  if (can(user, 'settings.manage')) system.push({ to: '/app/audit', label: 'Auditoría', icon: ICONS.audit });

  const sections = [
    { title: 'Principal', items: primary },
    { title: 'Gestión', items: management },
    { title: 'Sistema', items: system },
  ].filter((s) => s.items.length);

  // /app/knowledge y sus subrutas comparten cabecera: TITLES solo trae la ruta
  // exacta, así que el detalle y el editor se resuelven por prefijo.
  const currentTitle =
    TITLES[location.pathname] ||
    (location.pathname.startsWith('/app/knowledge/')
      ? location.pathname.endsWith('/edit')
        ? 'Editar artículo'
        : 'Artículo'
      : 'Tickets');
  const initials = user
    ? `${user.name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase()
    : '?';

  const sidebar = (
    <div className="flex h-full flex-col">
      <button
        className="mx-3 mb-3 mt-3 flex flex-col items-center rounded-xl px-4 py-4 text-center"
        onClick={() => navigate('/app')}
        title="SIFHA · Mesa de Ayuda"
      >
        <span className="flex h-14 w-full items-center justify-center">
          <img
            alt="SIFHA"
            className="h-full w-full object-contain"
            src="/logo/TSIFHA-PNG.png"
          />
        </span>
        <span className="block min-w-0">
          <span className="block text-base font-extrabold leading-tight text-white">Mesa de Ayuda</span>
          <span className="mt-0.5 block text-[11px] text-slate-300/70">Gestión de incidencias</span>
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

      <nav className="app-sidebar-scroll flex-1 overflow-y-auto px-3 pb-2">
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
                  end={item.end || item.to === '/app/dashboard' || item.to === '/app/my-tickets' || item.to === '/app/inbox'}
                  className={({ isActive }) => {
                    const active = item.active ? item.active(location.pathname) : isActive;
                    return `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                      active ? 'app-nav-active' : `app-nav-item${item.alwaysWhite ? ' app-nav-item-white' : ''}`
                    }`;
                  }}
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
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
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
          <img src="/logo/TSIFHA-PNG.png" alt="SIFHA" className="hidden h-8 w-auto max-w-32 object-contain sm:block lg:hidden" />
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 lg:hidden"
            aria-label="Abrir menú"
          >
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
{/* El título lleva el mismo texto claro que el resto de la barra (la hora, el
              conmutador de tema). Antes iba `text-slate-800` y eso lo apagaba: la
              barra institucional es siempre oscura (`#0b0f19`, en los dos temas) y
              las utilidades slate solo se reescriben a un tono claro en tema
              oscuro, así que en tema claro el título quedaba oscuro sobre oscuro
              (1.3:1). Con `text-white` son 19.2:1 en los dos temas: sin regla por
              tema y sin tocar el fondo de la barra. `min-w-0 truncate` se conserva
              para que el título ceda espacio en pantallas estrechas. */}
          <h1 className="min-w-0 truncate text-lg font-semibold text-white">{currentTitle}</h1>

          {/* Búsqueda del móvil. El formulario de escritorio se oculta por debajo de
              `md` (más abajo), así que sin este botón quien navega con el dedo se
              queda sin ninguna forma de buscar. Reutiliza su estado `q` y su
              `onGlobalSearch`: el término y el destino son los mismos.

              Va justo antes del grupo de la derecha para que notificaciones, tema
              y perfil se sigan leyendo como un bloque, y `ml-auto` lo deja pegado
              a ese bloque en vez de junto al título. `md:hidden` lo mantiene lejos
              del menú móvil, que es un overlay `z-40` por encima de todo.

              El panel no cuelga de este botón sino del propio `header`, que es
              `sticky` y por tanto bloque contenedor de sus hijos absolutos: así
              sus dimensiones no dependen de dónde caiga la lupa ni de lo que
              mida la fila. Antes, `right-0` + `w-[min(92vw,380px)]` medidos
              desde una caja de 36px dejaban el margen izquierdo en el aire
              (≈10px a 320px, y negativo en cuanto la fila se ensanchaba) y
              `top-full` lo arrancaba 14px antes del borde inferior de la barra,
              por lo que el panel se salía por la izquierda y se comía la barra.

              El botón conserva siempre el nombre "Buscar" y comunica el estado
              con `aria-expanded`, como cualquier control desplegable: así el
              nombre no aparece dos veces al abrir (el del botón y el de la ✕) y
              quien usa lector de pantalla oye si el panel está abierto. */}
          <div className="ml-auto md:hidden">
            <button
              ref={searchToggleRef}
              type="button"
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              className="rounded-lg p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
              aria-label="Buscar"
              aria-expanded={searchOpen}
              aria-controls="header-search-mobile"
              title="Buscar"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path strokeLinecap="round" d="m20 20-3.5-3.5" />
              </svg>
            </button>
          </div>

          {searchOpen && (
            /* Capa a todo el ancho de la barra: `inset-x-0` la ata a los bordes
               izquierdo y derecho del header, así que el panel no puede
               desbordarse sea cual sea el viewport, y `top-full` lo deja justo
               debajo de la barra. El `px-4` repite el padding del header (16px
               de margen a cada lado) y `justify-center` + `max-w` lo centran en
               pantallas anchas en lugar de pegarlo a un borde. Nada de `vw`: con
               scrollbar el `100vw` mide más que el ancho visible. */
            <div className="absolute inset-x-0 top-full z-50 mt-2 flex justify-center px-4">
              <div
                id="header-search-mobile"
                ref={searchPanelRef}
                role="dialog"
                aria-label="Buscar"
                className="panel-glass nex-pop w-full max-w-[22rem] rounded-2xl p-2"
              >
                <form onSubmit={onMobileSearchSubmit}>
                  <div className="relative">
                    <svg
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <circle cx="11" cy="11" r="7" />
                      <path strokeLinecap="round" d="m20 20-3.5-3.5" />
                    </svg>
                    {/* Mismo `input` y mismo `!pl-9` que los filtros de las
                        páginas: la lupa queda dentro del campo. `!pr-12` deja
                        sitio a la ✕ de cerrar. `type` sin especificar a
                        propósito: en `type="search"` el navegador se come el
                        Escape para vaciar el campo y el panel no cerraría. */}
                    <input
                      ref={searchInputRef}
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Buscar ticket, usuario o asunto"
                      aria-label="Buscar"
                      className="input !pl-9 !pr-12"
                    />
                    <button
                      type="button"
                      onClick={() => closeSearch()}
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded-lg p-2.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-secondary)] hover:text-[var(--text)]"
                      aria-label="Cerrar búsqueda"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

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
              placeholder="Buscar ticket, usuario o asunto"
              aria-label="Buscar"
              className="w-52 rounded-full border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder-slate-400 transition duration-150 focus:border-blue-300/50 focus:outline-none focus:ring-2 focus:ring-blue-400/20 lg:w-64"
            />
          </form>

          <div className="ml-auto flex items-center gap-2">
            <HeaderClock />
            <Notifications />
            <Tooltip text={theme === 'dark' ? 'Activar tema claro' : 'Activar tema oscuro'}>
              <button
                type="button"
                onClick={toggleTheme}
                className="rounded-lg p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
                aria-label={theme === 'dark' ? 'Activar tema claro' : 'Activar tema oscuro'}
              >
                {theme === 'dark' ? (
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path strokeLinecap="round" d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
                ) : (
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" /></svg>
                )}
              </button>
            </Tooltip>
            {/* El icono no se anuncia, así que este botón dependía del `title`
                como último recurso del nombre accesible. El tooltip no sustituye
                a ese nombre: por eso el `aria-label` se queda. */}
            <Tooltip text="Mi cuenta">
              <button
                onClick={() => navigate('/app/profile')}
                className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-100"
                aria-label="Mi cuenta"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7z" />
                </svg>
              </button>
            </Tooltip>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

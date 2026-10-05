import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  api,
  STATUSES,
  PRIORITIES,
  STATUS_LABEL,
  PRIORITY_LABEL,
  STATUS_COLOR,
  PRIORITY_COLOR,
  formatDateTime,
  formatSla,
  slaInfo,
  ticketStreamUrl,
} from '../lib/api';
import { useAuth, can } from '../context/AuthContext';
import { ErrorBox, Spinner, LoadingScreen, Modal, Drawer, Avatar } from '../components/ui';
import Breadcrumb from '../components/Breadcrumb';
import Tooltip from '../components/Tooltip';
import TicketTimeline from '../components/TicketTimeline';
import AttachmentList from '../components/Attachments';
import Select from '../components/Select';
import ResolveDrawer from '../components/ResolveDrawer';
import TemplatePicker from '../components/TemplatePicker';
import TicketArticles from '../components/TicketArticles';
import { buildVariableContext, MAX_COMMENT_LENGTH } from '../lib/templateVars';

// Estados desde los que sólo se sale por el flujo dedicado POST /:id/reopen
// (tickets.js). CANCELLED no entra: su regla es "no se cambia de estado" y se
// mantiene tal cual.
const REOPENABLE_STATUSES = ['RESOLVED', 'CLOSED'];

// A qué listado vuelve la miga de pan de la ficha.
//
// La ruta ya dice de dónde se viene: `Tickets` e `Inbox` llevan a
// `/app/tickets/:id` y `MyTickets` (y el alta de ticket) a `/app/my-tickets/:id`,
// así que el destino se deduce sin recordar nada ni pasar estado al navegar.
//
// Sólo hay un caso en el que la ruta miente: una ficha abierta en
// `/app/tickets/:id` por quien no tiene `ticket.view.all` —un empleado que llega
// desde su historial en Perfil o desde un enlace de la base de conocimiento—.
// Para esa persona `/app/tickets` no existe como pantalla: la ruta la devuelve a
// `/app`, que no es volver a ningún sitio. En ese caso la miga apunta a "Mis
// tickets", el único listado que siempre puede abrir. La comprobación usa el mismo
// `can` que protege las rutas en App.jsx, con el mismo permiso.
//
// La Bandeja no se distingue aquí a propósito: comparte ruta con `Tickets` y su
// estado vive en la URL de la propia bandeja. El breadcrumb es la vuelta
// predecible; el botón "Volver" de abajo sigue siendo la vuelta exacta.
function breadcrumbRoot(pathname, user) {
  const mine = { label: 'Mis tickets', to: '/app/my-tickets' };
  if (pathname.startsWith('/app/my-tickets/')) return mine;
  if (!can(user, 'ticket.view.all')) return mine;
  return { label: 'Tickets', to: '/app/tickets' };
}

export default function TicketDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const ticketId = Number(id);

  const [message, setMessage] = useState('');
  const [files, setFiles] = useState([]);
  const [internalMode, setInternalMode] = useState(false);

  const [statusDraft, setStatusDraft] = useState('');
  const [priorityDraft, setPriorityDraft] = useState('');
  const [assignDraft, setAssignDraft] = useState('');
  const [teamDraft, setTeamDraft] = useState('');
  const [categoryDraft, setCategoryDraft] = useState('');

  const [resolveOpen, setResolveOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeNote, setCloseNote] = useState('');
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [pendingOpen, setPendingOpen] = useState(false);
  const [pendingReason, setPendingReason] = useState('');
  const [pendingDetail, setPendingDetail] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [csatRating, setCsatRating] = useState(0);
  const [csatComment, setCsatComment] = useState('');
  const [csatSent, setCsatSent] = useState(false);
  // Origen de la respuesta: ids de las plantillas insertadas en este borrador.
  // Se envían junto al comentario solo para contabilizar el uso.
  const [usedTemplateIds, setUsedTemplateIds] = useState([]);

  const editorRef = useRef(null);
  const textareaRef = useRef(null);
  const scrollRef = useRef(null);
  const seenComments = useRef(new Set());
  const dataRef = useRef(null);
  const typingTimers = useRef({});
  const refreshTimer = useRef(null);
  const lastTypingSent = useRef(0);

  const [live, setLive] = useState(false);
  const [typingUsers, setTypingUsers] = useState([]);

  const queryClient = useQueryClient();

  const { data, error: queryError, refetch: reload } = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () => api.get(`/api/tickets/${id}`),
    // Sin reintentos: el error debe reflejarse de inmediato como antes.
    retry: 0,
    // Mantiene visible el ticket anterior mientras se carga el siguiente
    // (comportamiento original de load()).
    placeholderData: keepPreviousData,
  });

  const { data: options } = useQuery({
    queryKey: ['ticket-options'],
    queryFn: () => api.get('/api/tickets/options').catch(() => ({})),
  });

  const { data: users = [] } = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get('/api/users/assignable').then((d) => d.data || []).catch(() => []),
    enabled: !!data?.can?.assign,
  });

  const { data: teams = [] } = useQuery({
    queryKey: ['assignable-teams'],
    queryFn: () => api.get('/api/teams/assignable').then((d) => d.data || []).catch(() => []),
    enabled: !!data?.can?.assign,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories-active'],
    queryFn: () => api.get('/api/categories?active=1').then((d) => d.data || []).catch(() => []),
    enabled: !!data?.can?.manage,
  });

  // Opciones del panel de gestión. Mismos rótulos y mismo orden que los
  // `<option>` que había antes, incluidas las entradas vacías de asignación,
  // equipo y categoría. No se marca ninguna opción como deshabilitada: los
  // permisos se aplican antes, decidiendo si el control se pinta siquiera.
  //
  // Desde un RESOLVED/CLOSED el backend ya no acepta volver a la cola por el PATCH
  // genérico, así que aquí tampoco se ofrece: la reapertura va sólo por el modal
  // que exige motivo. "Abierto" se muestra únicamente con ticket.reopen, que es
  // quien puede ejecutarla; el estado actual siempre se incluye para que el
  // control siga mostrando su valor en lugar del placeholder.
  const statusOptions = useMemo(() => {
    const all = STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }));
    if (!REOPENABLE_STATUSES.includes(data?.ticket?.status)) return all;
    return all.filter((o) => o.value === data.ticket.status || (data?.can?.reopen && o.value === 'OPEN'));
  }, [data?.ticket?.status, data?.can?.reopen]);
  const priorityOptions = useMemo(() => PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })), []);
  const assigneeOptions = useMemo(
    () => [
      { value: '', label: 'Sin asignar' },
      ...users.map((u) => ({ value: u.id, label: `${u.name} ${u.last_name}` })),
    ],
    [users]
  );
  const teamOptions = useMemo(
    () => [
      { value: '', label: 'Sin equipo' },
      ...teams.map((tm) => ({ value: tm.id, label: tm.name })),
    ],
    [teams]
  );
  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'Sin categoría' },
      ...categories.map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories]
  );
  const pendingReasonOptions = useMemo(
    () => (options?.pending_reasons || []).map((r) => ({ value: r, label: r })),
    [options]
  );

  const handleResolved = () => queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });

  // Al llegar datos (carga inicial, refetch, SSE) se sincronizan los borradores
  // del panel de gestión y se deduplican los comentarios ya vistos.
  useEffect(() => {
    if (!data?.ticket) return;
    if (dataRef.current !== data.ticket.id) {
      seenComments.current = new Set();
      dataRef.current = data.ticket.id;
    }
    for (const c of data.comments) seenComments.current.add(c.id);
    setStatusDraft(data.ticket.status);
    setPriorityDraft(data.ticket.priority);
    setAssignDraft(data.ticket.assigned_to_id ? String(data.ticket.assigned_to_id) : '');
    setTeamDraft(data.ticket.assigned_team_id ? String(data.ticket.assigned_team_id) : '');
    setCategoryDraft(data.ticket.category_id ? String(data.ticket.category_id) : '');
  }, [data]);

  // Conexión en vivo: recibe comentarios, cambios de estado y "escribiendo…".
  useEffect(() => {
    if (!id) return undefined;
    const es = new EventSource(ticketStreamUrl(id));
    const clearTyping = (userId) => setTypingUsers((prev) => prev.filter((u) => u.id !== userId));

    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.addEventListener('ready', () => setLive(true));

    es.addEventListener('comment', (e) => {
      let payload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      const c = payload.comment;
      if (!c || seenComments.current.has(c.id)) return;
      seenComments.current.add(c.id);
      clearTyping(c.user_id);
      queryClient.setQueryData(['ticket', ticketId], (prev) => {
        if (!prev || String(prev.ticket.id) !== String(id)) return prev;
        return {
          ...prev,
          comments: [...prev.comments, c],
          attachments: [...prev.attachments, ...(payload.attachments || [])],
        };
      });
    });

    es.addEventListener('typing', (e) => {
      let payload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!payload.user_id) return;
      setTypingUsers((prev) =>
        prev.some((u) => u.id === payload.user_id) ? prev : [...prev, { id: payload.user_id, name: payload.user_name }]
      );
      clearTimeout(typingTimers.current[payload.user_id]);
      typingTimers.current[payload.user_id] = setTimeout(() => clearTyping(payload.user_id), 3500);
    });

    es.addEventListener('refresh', () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] }), 200);
    });

    return () => {
      es.close();
      setLive(false);
      setTypingUsers([]);
      clearTimeout(refreshTimer.current);
      Object.values(typingTimers.current).forEach(clearTimeout);
      typingTimers.current = {};
    };
  }, [id]);

  // Auto-scroll suave hacia el final si el usuario está cerca del borde inferior.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [data?.comments?.length]);

  // Las opciones de gestión (usuarios/equipos/categorías asignables) se cargan
  // mediante useQuery habilitadas por data.can (ver arriba).

  // Escrituras sobre el ticket (estado, prioridad, asignación, cierre, etc.).
  // Una sola mutation genérica: la rama API se elige por descriptor y UI/errores
  // se conservan igual que antes. Debe declararse antes de los retornos
  // tempranos (loading/error) para mantener el orden de hooks entre renders.
  const apiAction = useMutation({
    mutationFn: ({ method, path, body, formData }) => api[method](path, body, formData),
    onMutate: () => {
      setSaving(true);
      setError('');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
    },
    onError: (err, variables) => {
      setError(err.message || variables.errorMessage || 'No se pudo actualizar el ticket');
    },
    onSettled: () => {
      setSaving(false);
    },
  });

  if ((error || queryError) && !data) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorBox message={error || queryError?.message || 'No se pudo cargar el ticket'} />
        <button className="btn-secondary mt-4" onClick={() => { setError(''); reload(); }}>
          Reintentar
        </button>
      </div>
    );
  }
  if (!data) return <LoadingScreen text="Cargando ticket…" />;

  const t = data.ticket;
  const can = data.can || {};
  const sla = slaInfo(t);
  const locked = ['RESOLVED', 'CLOSED', 'CANCELLED'].includes(t.status);
  const isReporter = Number(t.reporter_id) === Number(user?.id);

  async function patchTicket(payload) {
    try {
      await apiAction.mutateAsync({
        method: 'patch',
        path: `/api/tickets/${t.id}`,
        body: payload,
        errorMessage: 'No se pudo actualizar el ticket',
      });
    } catch (err) {
      // Restaurar borradores al estado servidor (como con load() en el error anterior).
      setStatusDraft(t.status);
      setPriorityDraft(t.priority);
      setCategoryDraft(t.category_id ? String(t.category_id) : '');
      setAssignDraft(t.assigned_to_id ? String(t.assigned_to_id) : '');
      setTeamDraft(t.assigned_team_id ? String(t.assigned_team_id) : '');
      throw err;
    }
  }

  // Los handlers reciben el valor ya convertido, no el evento: es lo que entrega
  // `Select`. La lógica de permisos, los diálogos de transición y las llamadas a
  // la API son los mismos que antes, sin cambios.
  function onStatusSelect(value) {
    if (value === t.status) return;
    if (value === 'RESOLVED' && can.resolve) {
      setResolveOpen(true);
      return;
    }
    if (value === 'CLOSED' && can.close) {
      setCloseOpen(true);
      return;
    }
    if (value === 'PENDING') {
      setPendingOpen(true);
      return;
    }
    if (value === 'OPEN' && REOPENABLE_STATUSES.includes(t.status) && can.reopen) {
      setReopenOpen(true);
      return;
    }
    setStatusDraft(value);
    patchTicket({ status: value }).catch(() => {});
  }

  function onPriority(value) {
    setPriorityDraft(value);
    if (value !== t.priority) patchTicket({ priority: value }).catch(() => {});
  }
  function onAssign(raw) {
    setAssignDraft(raw);
    const value = raw ? Number(raw) : null;
    if (value !== t.assigned_to_id) patchTicket({ assigned_to_id: value }).catch(() => {});
  }
  function onTeam(raw) {
    setTeamDraft(raw);
    const value = raw ? Number(raw) : null;
    if (value !== t.assigned_team_id) patchTicket({ assigned_team_id: value }).catch(() => {});
  }
  function onCategory(raw) {
    setCategoryDraft(raw);
    const value = raw ? Number(raw) : null;
    if (value !== t.category_id) patchTicket({ category_id: value }).catch(() => {});
  }

  function focusEditor(internal) {
    setInternalMode(!!internal);
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => textareaRef.current?.focus(), 250);
  }

  function submitClose() {
    apiAction.mutate(
      { method: 'post', path: `/api/tickets/${t.id}/close`, body: { note: closeNote.trim() || undefined }, errorMessage: 'No se pudo cerrar el ticket' },
      { onSuccess: () => { setCloseOpen(false); setCloseNote(''); } }
    );
  }

  function submitReopen() {
    if (!reopenReason.trim()) return;
    apiAction.mutate(
      { method: 'post', path: `/api/tickets/${t.id}/reopen`, body: { reason: reopenReason.trim() }, errorMessage: 'No se pudo reabrir el ticket' },
      { onSuccess: () => { setReopenOpen(false); setReopenReason(''); } }
    );
  }

  function submitPending() {
    const reason = pendingDetail.trim() || pendingReason;
    apiAction.mutate(
      { method: 'patch', path: `/api/tickets/${t.id}`, body: { status: 'PENDING', pending_reason: reason || null }, errorMessage: 'No se pudo marcar como pendiente' },
      { onSuccess: () => { setPendingOpen(false); setPendingDetail(''); } }
    );
  }

  function submitCancel() {
    apiAction.mutate(
      { method: 'post', path: `/api/tickets/${t.id}/cancel`, body: { reason: cancelReason.trim() }, errorMessage: 'No se pudo cancelar el ticket' },
      { onSuccess: () => { setCancelOpen(false); setCancelReason(''); } }
    );
  }

  function submitCsat() {
    if (!csatRating) return;
    apiAction.mutate(
      { method: 'post', path: `/api/tickets/${t.id}/csat`, body: { rating: csatRating, comment: csatComment.trim() || undefined }, errorMessage: 'No se pudo enviar la calificación' },
      { onSuccess: () => setCsatSent(true) }
    );
  }

  function onSubmitComment(e) {
    e.preventDefault();
    if (!message.trim() && files.length === 0) return;
    // El texto final ya viene expandido desde el selector; aun así se valida
    // aquí el máximo definitivo antes de enviarlo.
    if (message.length > MAX_COMMENT_LENGTH) {
      setError(`El mensaje supera el máximo de ${MAX_COMMENT_LENGTH} caracteres`);
      return;
    }
    const fd = new FormData();
    if (message.trim()) fd.append('message', message.trim());
    if (internalMode) fd.append('is_internal', '1');
    // Contabiliza el uso de cada plantilla en el servidor, después de guardar
    // el comentario. Si no se usó ninguna, no se envía el campo.
    for (const tid of usedTemplateIds) fd.append('canned_response_id', String(tid));
    for (const f of files) fd.append('files', f);
    apiAction.mutate(
      { method: 'post', path: `/api/tickets/${t.id}/comments`, formData: fd, errorMessage: 'No se pudo enviar el mensaje' },
      { onSuccess: () => { setMessage(''); setFiles([]); setUsedTemplateIds([]); } }
    );
  }

  /**
   * Inserta el texto de una respuesta rápida en el textarea SIN enviarlo.
   * Usa setMessage() directamente (y no onMessageChange) para no disparar el
   * indicador de "escribiendo…" de quien solo está eligiendo una plantilla.
   */
  function onInsertTemplate({ text, template, mode }) {
    const el = textareaRef.current;
    const remember = () => setUsedTemplateIds((prev) => [...new Set([...prev, template.id])]);
    if (mode === 'replace') {
      // La última línea de defensa: el selector ya bloquea esto, pero el
      //.replace no debe poder dejar un comentario por encima del máximo.
      if (text.length > MAX_COMMENT_LENGTH) return;
      setMessage(text);
      remember();
      return;
    }
    if (!el) {
      setMessage((prev) => {
        const next = `${prev}${prev ? '\n' : ''}${text}`;
        return next.length > MAX_COMMENT_LENGTH ? prev : next;
      });
      remember();
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = message.slice(0, start) + text + message.slice(end);
    if (next.length > MAX_COMMENT_LENGTH) return;
    setMessage(next);
    remember();
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = start + text.length;
      el.selectionEnd = start + text.length;
    });
  }

  function onMessageChange(value) {
    setMessage(value);
    if (internalMode) return; // las notas internas no se anuncian
    const now = Date.now();
    if (now - lastTypingSent.current < 2500) return;
    lastTypingSent.current = now;
    api.post(`/api/tickets/${t.id}/typing`, {}).catch(() => {});
  }

  function applyFormat(before, after = before, placeholder = 'texto') {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = message.slice(start, end) || placeholder;
    setMessage(message.slice(0, start) + before + selected + after + message.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = start + before.length;
      el.selectionEnd = start + before.length + selected.length;
    });
  }

  const ticketAttachments = data.attachments.filter((a) => !a.comment_id);
  const commentsWithAttachments = data.comments.map((c) => ({
    ...c,
    attachments: data.attachments.filter((a) => a.comment_id === c.id),
  }));
  // El recuento de adjuntos se desglosa porque los de la descripción y los de
  // la conversación se ven en sitios distintos de la pantalla: un total único
  // no correspondía con nada de lo que hay a la vista.
  const conversationAttachmentCount = data.attachments.length - ticketAttachments.length;
  const attachmentSummary =
    [
      ticketAttachments.length > 0 ? `${ticketAttachments.length} en la descripción` : null,
      conversationAttachmentCount > 0 ? `${conversationAttachmentCount} en la conversación` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Sin archivos';

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Miga de pan y barra de acciones. La miga va por encima de la barra, no
          dentro de ella: su sitio natural es la esquina superior izquierda de la
          pantalla, y así los botones de gestión conservan el alineado de siempre.
          `space-y-3` las junta para que la miga lea como parte de la cabecera y
          no como una fila suelta. */}
      <div className="space-y-3">
        <Breadcrumb items={[breadcrumbRoot(location.pathname, user), { label: t.ticket_number }]} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" className="btn-ghost !px-2 text-sm" onClick={() => navigate(-1)}>
            ← Volver
          </button>
          <div className="flex flex-wrap items-center gap-2">
            {can.comment && (
              <button type="button" className="btn-secondary" onClick={() => focusEditor(false)}>
                Responder
              </button>
            )}
            {can.note && (
              <button type="button" className="btn-secondary" onClick={() => focusEditor(true)}>
                <LockIcon /> Nota interna
              </button>
            )}
            {can.resolve && !locked && (
              <button type="button" className="btn-primary" onClick={() => setResolveOpen(true)}>
                Resolver ticket
              </button>
            )}
            {can.reopen && REOPENABLE_STATUSES.includes(t.status) && (
              <button type="button" className="btn-secondary" onClick={() => setReopenOpen(true)}>
                Reabrir
              </button>
            )}
            {can.close && t.status !== 'CLOSED' && (
              <button type="button" className="btn-secondary" onClick={() => setCloseOpen(true)}>
                Cerrar
              </button>
            )}
            {/* Cancelar es la única acción que cierra el ticket sin resolverlo y
                avisa al reportante: se separa del resto para que no se pulse por
                inercia al lado de "Cerrar". */}
            {can.cancel && !['CLOSED', 'CANCELLED', 'RESOLVED'].includes(t.status) && (
              <>
                <span aria-hidden="true" className="hidden h-6 w-px bg-white/10 sm:block" />
                {/* red-400, no red-600: el tema solo reescribe el token `text-red-600`
                    sin `!`, así que `!text-red-600` dejaba el texto en un rojo
                    oscuro que no cumplía AA sobre el botón. */}
                <button type="button" className="btn-secondary !text-red-400" onClick={() => setCancelOpen(true)}>
                  Cancelar ticket
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Encabezado */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-sm font-semibold text-brand-700">{t.ticket_number}</span>
          <span className={`badge ring-1 ${STATUS_COLOR[t.status] || ''}`}>{STATUS_LABEL[t.status] || t.status}</span>
          <span className={`badge ring-1 ${PRIORITY_COLOR[t.priority] || ''}`}>
            {PRIORITY_LABEL[t.priority] || t.priority}
          </span>
          {t.category_name && <span className="badge bg-slate-100 text-slate-600 ring-1 ring-slate-500/20">{t.category_name}</span>}
          {sla && (
            <span
              className={`badge ring-1 ${
                sla.overdue ? 'bg-red-50 text-red-700 ring-red-600/20' : 'bg-slate-100 text-slate-600 ring-slate-500/20'
              }`}
            >
              {formatSla(t)}
            </span>
          )}
        </div>
        <h1 className="mt-2 text-xl font-semibold text-slate-800">{t.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
          <span className="inline-flex items-center gap-2">
            <Avatar name={t.reporter_name} size="sm" />
            <span>
              <b className="font-medium text-slate-700">{t.reporter_name}</b> reportó
            </span>
          </span>
          {t.department_name && <span>· {t.department_name}</span>}
          <span>· Creado {formatDateTime(t.created_at)}</span>
          {t.updated_at && t.updated_at !== t.created_at && <span>· Actualizado {formatDateTime(t.updated_at)}</span>}
        </div>
        {/* Quién atiende el ticket es lo primero que se consulta al abrirlo, así
            que vive en la cabecera y el panel lateral solo ofrece el control. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Asignación</span>
          {t.assigned_name ? (
            <span className="inline-flex items-center gap-1.5 text-sm">
              <Avatar name={t.assigned_name} size="sm" />
              <b className="font-medium text-slate-700">{t.assigned_name}</b>
            </span>
          ) : (
            <span className="badge bg-amber-50 text-amber-700 ring-1 ring-amber-600/20">Sin asignar</span>
          )}
          {t.team_name && <span className="badge bg-slate-100 text-slate-600 ring-1 ring-slate-500/20">{t.team_name}</span>}
        </div>
      </div>

      {(error || queryError) && <ErrorBox message={error || queryError?.message || 'No se pudo cargar el ticket'} />}

      {isReporter && ['RESOLVED', 'CLOSED'].includes(t.status) && !t.csat_answered_at && options?.csat_enabled !== false && (
        <div className="card border-[var(--border-strong)] bg-[var(--surface)] p-5">
          <h3 className="text-sm font-semibold text-[var(--text)]">¿Cómo fue la atención recibida?</h3>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">Su opinión nos ayuda a mejorar el servicio.</p>
          <div className="mt-3 flex items-center gap-1.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`${n} estrellas`}
                onClick={() => setCsatRating(n)}
                /* El punte global :focus-visible (outline --focus) cubre el foco de
                   teclado; `rounded` sólo evita que ese contorno se dibuje como un
                   rectángulo sobre el glifo. */
                className={`rounded px-0.5 text-3xl leading-none transition ${
                  n <= csatRating ? 'text-[var(--warning)]' : 'text-[var(--text-muted)] hover:text-[var(--warning)]'
                }`}
              >
                ★
              </button>
            ))}
            {csatRating > 0 && <span className="ml-2 text-sm font-medium text-[var(--text)]">{csatRating}/5</span>}
          </div>
          <textarea
            className="input mt-3 min-h-[70px] resize-y"
            placeholder="Comentario (opcional)…"
            value={csatComment}
            onChange={(e) => setCsatComment(e.target.value)}
            maxLength={2000}
          />
          <div className="mt-3 flex justify-end">
            <button className="btn-primary" onClick={submitCsat} disabled={!csatRating || saving || csatSent}>
              {saving && <Spinner className="h-4 w-4 text-white" />}
              {csatSent ? '¡Gracias!' : 'Enviar calificación'}
            </button>
          </div>
        </div>
      )}

      {t.csat_answered_at && (
        <div className="card p-4">
          <p className="text-sm text-slate-600">
            <span className="font-medium">Satisfacción del usuario:</span>{' '}
            <span className="text-[var(--warning)]">{'★'.repeat(t.csat_rating || 0)}{'☆'.repeat(5 - (t.csat_rating || 0))}</span>{' '}
            <span className="font-semibold text-slate-700">{t.csat_rating}/5</span>
            {t.csat_comment ? ` — ${t.csat_comment}` : ''}
          </p>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Columna principal */}
        <main className="space-y-5">
          <div className="card p-5">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Descripción</h3>
            {t.description?.trim() ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{t.description}</p>
            ) : (
              <p className="text-sm italic text-slate-400">El ticket se creó sin descripción.</p>
            )}
            {ticketAttachments.length > 0 && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Adjuntos ({ticketAttachments.length})
                </p>
                <AttachmentList items={ticketAttachments} />
              </div>
            )}
          </div>

          <div className="card p-5">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Conversación</h3>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400">
                  {data.comments.length} {data.comments.length === 1 ? 'mensaje' : 'mensajes'}
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                    live ? 'text-emerald-600' : 'text-slate-400'
                  }`}
                  title={live ? 'Conectado en tiempo real' : 'Reconectando…'}
                >
                  <span className={`h-2 w-2 rounded-full ${live ? 'animate-pulse bg-emerald-500' : 'bg-slate-400'}`} />
                  {live ? 'En vivo' : 'Sin conexión'}
                </span>
              </div>
            </div>
            <div ref={scrollRef} className="max-h-[560px] overflow-y-auto pr-1 app-scrollbar">
              <TicketTimeline history={data.history} comments={commentsWithAttachments} />
            </div>
            {typingUsers.length > 0 && (
              <div className="mt-3 flex items-center gap-2 text-xs text-brand-600">
                <span className="flex items-end gap-0.5">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-500 [animation-delay:-0.2s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-500 [animation-delay:-0.1s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-500" />
                </span>
                {typingUsers.map((u) => u.name).join(', ')}{' '}
                {typingUsers.length > 1 ? 'están escribiendo…' : 'está escribiendo…'}
              </div>
            )}
          </div>

          {(can.comment || can.note) && (
            <div className="card p-5" ref={editorRef}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
                  <button
                    type="button"
                    onClick={() => setInternalMode(false)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                      !internalMode ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    Respuesta pública
                  </button>
                  {can.note && (
                    <button
                      type="button"
                      onClick={() => setInternalMode(true)}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                        internalMode ? 'bg-white text-amber-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      <LockIcon /> Nota interna
                    </button>
                  )}
                </div>
                {internalMode && (
                  <span className="text-xs text-amber-600">Solo visible para técnicos y administradores.</span>
                )}
              </div>

              <form onSubmit={onSubmitComment} className="space-y-3" noValidate>
                <div className="overflow-hidden rounded-xl border border-slate-300 bg-white focus-within:border-brand-400">
                  <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
                    <ToolbarButton label="Negrita" onClick={() => applyFormat('**', '**', 'negrita')}>
                      <b>N</b>
                    </ToolbarButton>
                    <ToolbarButton label="Cursiva" onClick={() => applyFormat('*', '*', 'cursiva')}>
                      <i>I</i>
                    </ToolbarButton>
                    <ToolbarButton label="Lista" onClick={() => applyFormat('- ', '', 'elemento')}>
                      •
                    </ToolbarButton>
                    <ToolbarButton label="Código" onClick={() => applyFormat('`', '`', 'código')}>
                      {'</>'}
                    </ToolbarButton>
                    {(can.comment || can.note) && (
                      <TemplatePicker
                        context={buildVariableContext({ ticket: t, user })}
                        onInsert={onInsertTemplate}
                        onManagePersonal={() => navigate('/app/profile')}
                        onManageGlobal={() => navigate('/app/templates')}
                        canManageGlobal={!!user?.permissions?.includes('settings.manage') || !!user?.permissions?.includes('team.manage')}
                      />
                    )}
                  </div>
                  <textarea
                    ref={textareaRef}
                    aria-label={internalMode ? 'Nota interna' : 'Comentario'}
                    // La paleta de index.css está invertida para el tema oscuro:
                    // slate-50..300 son superficies oscuras y slate-400..950 son
                    // textos claros. Con text-slate-100 (un azul marino) sobre este
                    // fondo el texto quedaba en 1.04:1, es decir invisible.
                    className="min-h-[110px] w-full resize-y border-0 bg-white px-3.5 py-3 text-sm text-slate-700 caret-brand-600 placeholder:text-slate-500 focus:outline-none"
                    value={message}
                    onChange={(e) => onMessageChange(e.target.value)}
                    placeholder={
                      internalMode
                        ? 'Escriba una nota interna (no visible para el empleado)…'
                        : 'Escriba una respuesta para el empleado…'
                    }
                  />
                </div>

                {message.length > MAX_COMMENT_LENGTH - 400 && (
                  <p
                    className={`text-xs ${
                      message.length > MAX_COMMENT_LENGTH ? 'font-semibold text-red-400' : 'text-cyan-200/70'
                    }`}
                  >
                    {message.length}/{MAX_COMMENT_LENGTH} caracteres
                    {message.length > MAX_COMMENT_LENGTH && ' · supera el máximo del comentario'}
                  </p>
                )}

                {files.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {files.map((f, i) => (
                      <li key={`${f.name}-${i}`} className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600">
                        📎 {f.name}
                        <button
                          type="button"
                          className="text-slate-400 hover:text-red-500"
                          onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                          aria-label={`Quitar ${f.name}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-brand-600">
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1.5M8 7.5L12 3l4 4.5M12 3v11" />
                    </svg>
                    Adjuntar archivos
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files || [])])}
                    />
                  </label>
                  <button
                    type="submit"
                    className={internalMode ? 'btn-primary !bg-amber-600 hover:!bg-amber-700' : 'btn-primary'}
                    disabled={saving || (!message.trim() && !files.length)}
                  >
                    {saving && <Spinner className="h-4 w-4 text-white" />}
                    {internalMode ? 'Guardar nota interna' : 'Enviar respuesta'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </main>

        {/* Barra lateral */}
        <aside className="space-y-5">
          {t.status === 'PENDING' && t.pending_reason && (
            <div className="card p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Motivo de espera</h3>
              <p className="mt-1 text-sm text-amber-700">{t.pending_reason}</p>
            </div>
          )}

          {/* Solo aparecen los campos que este usuario puede cambiar. Los valores
              que ya no puede tocar (estado, prioridad, categoría, asignación) se
              leen en la cabecera, así que repetirlos aquí solo duplicaba datos. */}
          {(can.manage || can.assign) && (
            <div className="card p-5">
              <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">Gestión</h3>
              <div className="space-y-3.5">
                {can.manage && (
                  <Field id="ticket-status" label="Estado">
                    <Select
                      id="ticket-status"
                      options={statusOptions}
                      value={statusDraft}
                      onChange={onStatusSelect}
                      disabled={saving}
                    />
                  </Field>
                )}

                {can.manage && (
                  <Field id="ticket-priority" label="Prioridad">
                    <Select
                      id="ticket-priority"
                      options={priorityOptions}
                      value={priorityDraft}
                      onChange={onPriority}
                      disabled={saving}
                    />
                  </Field>
                )}

                {can.assign && (
                  <Field id="ticket-assignee" label="Asignado a">
                    <Select
                      id="ticket-assignee"
                      options={assigneeOptions}
                      value={assignDraft}
                      onChange={onAssign}
                      disabled={saving}
                    />
                  </Field>
                )}

                {can.assign && (
                  <Field id="ticket-team" label="Equipo">
                    <Select
                      id="ticket-team"
                      options={teamOptions}
                      value={teamDraft}
                      onChange={onTeam}
                      disabled={saving}
                    />
                  </Field>
                )}

                {can.manage && (
                  <Field id="ticket-category" label="Categoría">
                    <Select
                      id="ticket-category"
                      options={categoryOptions}
                      value={categoryDraft}
                      onChange={onCategory}
                      disabled={saving}
                    />
                  </Field>
                )}
              </div>
            </div>
          )}

          {(t.resolution || t.resolved_at || t.reopen_reason || t.cancel_reason || t.cancelled_at) && (
            <div className="card p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                {t.status === 'CANCELLED' ? 'Cancelación' : 'Resolución'}
              </h3>
              {t.resolution && (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{t.resolution}</p>
              )}
              <dl className="mt-3 space-y-2.5">
                {t.resolution_category && <Info label="Categoría de solución" value={t.resolution_category} />}
                {t.root_cause && <Info label="Causa" value={t.root_cause} />}
                {t.time_spent_minutes != null && (
                  <Info label="Tiempo empleado" value={formatMinutes(t.time_spent_minutes)} />
                )}
                {t.resolved_by_name && <Info label="Resuelto por" value={t.resolved_by_name} />}
                {t.resolved_at && <Info label="Fecha de resolución" value={formatDateTime(t.resolved_at)} />}
                {t.closed_by_name && <Info label="Cerrado por" value={t.closed_by_name} />}
                {t.closed_at && <Info label="Fecha de cierre" value={formatDateTime(t.closed_at)} />}
                {t.resolution_notified ? (
                  <div className="text-xs text-emerald-600">✓ Usuario notificado de la resolución</div>
                ) : null}
                {t.reopen_reason && (
                  <div className="rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-700">
                    Reabierto: {t.reopen_reason}
                    {t.reopened_by_name ? ` — ${t.reopened_by_name}` : ''}
                  </div>
                )}
                {t.cancel_reason && (
                  <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    <b className="font-semibold">Motivo:</b> {t.cancel_reason}
                  </div>
                )}
                {t.cancelled_at && <Info label="Fecha de cancelación" value={formatDateTime(t.cancelled_at)} />}
              </dl>
            </div>
          )}

          <div className="card p-5">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Detalles</h3>
            <dl className="space-y-2.5">
              {t.reporter_email && <Info label="Correo del reportante" value={t.reporter_email} />}
              <Info
                label="Vence el"
                value={t.sla_due_at ? formatDateTime(t.sla_due_at) : 'Sin tiempo de atención definido'}
              />
              {/* El recuento se desglosa porque los adjuntos de la descripción
                  y los de la conversación no se ven en el mismo sitio. */}
              <Info label="Archivos adjuntos" value={attachmentSummary} />
            </dl>
          </div>

          {/* Artículos de conocimiento: solo se monta y se consulta si el
              usuario tiene kb.view; el componente no se renderiza sin él. */}
          <TicketArticles ticket={t} />
        </aside>
      </div>

      <ResolveDrawer
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        ticket={t}
        options={options}
        onDone={handleResolved}
      />

      <Modal open={closeOpen} onClose={() => setCloseOpen(false)} title="Cerrar ticket">
        <p className="text-sm text-slate-600">
          El ticket pasará a estado <b>Cerrado</b>. Asegúrese de que el problema fue resuelto correctamente.
        </p>
        <label className="label mt-4">Nota de cierre (opcional)</label>
        <textarea
          className="input min-h-[80px] resize-y"
          value={closeNote}
          onChange={(e) => setCloseNote(e.target.value)}
          placeholder="Comentario interno sobre el cierre…"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setCloseOpen(false)}>
            Cancelar
          </button>
          <button className="btn-primary" onClick={submitClose} disabled={saving}>
            {saving && <Spinner className="h-4 w-4 text-white" />}
            Cerrar ticket
          </button>
        </div>
      </Modal>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancelar ticket">
        <p className="text-sm text-slate-600">
          Esta acción cancelará el ticket y notificará al reportante. Indique el motivo.
        </p>
        <label className="label mt-4" htmlFor="cancel-reason">Motivo de cancelación *</label>
        <textarea
          id="cancel-reason"
          className="input min-h-[100px] resize-y"
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder="Explique por qué se cancela el ticket..."
          maxLength={2000}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setCancelOpen(false)}>
            Volver
          </button>
          <button className="btn-secondary !text-red-400" onClick={submitCancel} disabled={saving || !cancelReason.trim()}>
            {saving && <Spinner className="h-4 w-4 text-red-600" />}
            Cancelar ticket
          </button>
        </div>
      </Modal>

      <Drawer
        open={reopenOpen}
        onClose={() => setReopenOpen(false)}
        title="Reabrir ticket"
        subtitle={t.ticket_number}
        footer={
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setReopenOpen(false)}>
              Cancelar
            </button>
            <button className="btn-primary" onClick={submitReopen} disabled={saving || !reopenReason.trim()}>
              {saving && <Spinner className="h-4 w-4 text-white" />}
              Reabrir
            </button>
          </div>
        }
      >
        <label className="label">Motivo de la reapertura *</label>
        <textarea
          className="input min-h-[120px] resize-y"
          value={reopenReason}
          onChange={(e) => setReopenReason(e.target.value)}
          placeholder="Explique por qué el ticket debe reabrirse…"
        />
        <p className="mt-2 text-xs text-slate-400">
          La resolución anterior se conserva en el historial. El ticket volverá a estado Abierto.
        </p>
      </Drawer>

      <Drawer
        open={pendingOpen}
        onClose={() => setPendingOpen(false)}
        title="Marcar como pendiente"
        subtitle={t.ticket_number}
        footer={
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setPendingOpen(false)}>
              Cancelar
            </button>
            <button className="btn-primary" onClick={submitPending} disabled={saving}>
              {saving && <Spinner className="h-4 w-4 text-white" />}
              Marcar pendiente
            </button>
          </div>
        }
      >
        <label className="label" htmlFor="ticket-pending-reason">
          Motivo
        </label>
        <Select
          id="ticket-pending-reason"
          options={pendingReasonOptions}
          value={pendingReason}
          onChange={setPendingReason}
          placeholder="Sin motivos configurados"
        />
        <label className="label mt-4">Detalle (opcional)</label>
        <input
          className="input"
          value={pendingDetail}
          onChange={(e) => setPendingDetail(e.target.value)}
          placeholder="Ej.: Esperando respuesta del usuario desde el 12/09…"
        />
      </Drawer>
    </div>
  );
}

function Field({ id, label, children }) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-700">{value || '—'}</dd>
    </div>
  );
}

function LockIcon({ className = 'h-4 w-4' }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path strokeLinecap="round" d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function ToolbarButton({ label, onClick, children }) {
  return (
    <Tooltip text={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        // slate-600, no slate-200: con la paleta invertida, slate-200 es un teal
        // oscuro que sobre la barra (#08283d) quedaba en 1.64:1.
        className="grid h-8 w-8 place-items-center rounded-md text-sm font-medium text-slate-600 transition hover:bg-white hover:text-brand-700"
      >
        {children}
      </button>
    </Tooltip>
  );
}

function formatMinutes(minutes) {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

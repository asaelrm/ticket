import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatRelative } from '../lib/api';
import { Spinner } from './ui';

const TYPE_ICON = {
  ASSIGNED: '🙋',
  COMMENT: '💬',
  RESOLVED: '✅',
  CLOSED: '📁',
  CANCELLED: '🚫',
  CSAT: '⭐',
  CSAT_RATED: '⭐',
  SLA_OVERDUE: '⏰',
  ESCALATED: '🚨',
  CRITICAL_UNRESOLVED: '🔥',
};

function iconFor(type) {
  return TYPE_ICON[type] || '🔔';
}

export default function Notifications() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [unread, setUnread] = useState(0);
  const panelRef = useRef(null);
  const navigate = useNavigate();

  const refreshCount = () => {
    api.get('/api/notifications/unread-count').then((d) => setUnread(d.unread || 0)).catch(() => {});
  };

  const openPanel = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setItems(null);
      api.get('/api/notifications').then((d) => setItems(d.data || [])).catch(() => setItems([]));
    }
    refreshCount();
  };

  useEffect(() => {
    refreshCount();
    const t = setInterval(refreshCount, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function markAllRead() {
    setUnread(0);
    setItems((prev) => (prev || []).map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
    try {
      await api.post('/api/notifications/read', { all: true });
    } catch {
      refreshCount();
    }
  }

  async function openItem(n) {
    setOpen(false);
    if (!n.read_at) {
      setUnread((u) => Math.max(0, u - 1));
      api.post('/api/notifications/read', { ids: [n.id] }).catch(() => {});
    }
    navigate(n.link || '/app');
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={openPanel}
        className="relative rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
        title="Notificaciones"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-4-5.66V5a2 2 0 1 0-4 0v.34A6 6 0 0 0 6 11v3.2c0 .53-.21 1.04-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-4 text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 z-50 mt-1 flex max-h-[70vh] w-[min(92vw,380px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-pop"
          role="dialog"
          aria-label="Notificaciones"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-800">Notificaciones</h3>
            {unread > 0 && (
              <button className="text-xs font-medium text-brand-600 hover:underline" onClick={markAllRead}>
                Marcar todas leídas
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {!items ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
                <Spinner className="h-4 w-4 text-brand-600" /> Cargando…
              </div>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">Sin notificaciones</p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => openItem(n)}
                  className={`flex w-full items-start gap-3 border-b border-slate-50 px-4 py-3 text-left transition hover:bg-slate-50 ${
                    n.read_at ? '' : 'bg-brand-50/40'
                  }`}
                >
                  <span className="mt-0.5 text-lg leading-none">{iconFor(n.type)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-800">{n.title}</span>
                    {n.body && <span className="block truncate text-xs text-slate-500">{n.body}</span>}
                    <span className="mt-0.5 block text-[11px] text-slate-400">{formatRelative(n.created_at)}</span>
                  </span>
                  {!n.read_at && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand-600" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
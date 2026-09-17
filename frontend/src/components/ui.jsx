import { useEffect } from 'react';
import { STATUS_LABEL, STATUS_COLOR, PRIORITY_LABEL, PRIORITY_COLOR } from '../lib/api';

export function Spinner({ className = '' }) {
  return (
    <svg
      className={`animate-spin ${className || 'h-5 w-5 text-brand-600'}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

export function LoadingScreen({ text = 'Cargando…' }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-slate-500">
      <Spinner className="h-8 w-8 text-brand-600" />
      <span className="text-sm">{text}</span>
    </div>
  );
}

export function StatusBadge({ status }) {
  return (
    <span className={`badge ring-1 ${STATUS_COLOR[status] || STATUS_COLOR.OPEN}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

export function PriorityBadge({ priority }) {
  return (
    <span className={`badge ring-1 ${PRIORITY_COLOR[priority] || PRIORITY_COLOR.MEDIUM}`}>
      {PRIORITY_LABEL[priority] || priority}
    </span>
  );
}

export function PriorityDot({ priority }) {
  const map = { LOW: 'bg-slate-400', MEDIUM: 'bg-sky-500', HIGH: 'bg-orange-500', CRITICAL: 'bg-red-600' };
  return <span className={`inline-block h-2 w-2 rounded-full ${map[priority] || map.MEDIUM}`} aria-hidden="true" />;
}

export function ErrorBox({ message }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
      {message}
    </div>
  );
}

export function EmptyState({ icon = '📋', title, subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-3xl" aria-hidden="true">
        {icon}
      </div>
      <p className="font-medium text-slate-700">{title}</p>
      {subtitle && <p className="max-w-sm text-sm text-slate-500">{subtitle}</p>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`relative max-h-[90vh] w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} overflow-y-auto rounded-2xl bg-white shadow-pop`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h3 className="text-base font-semibold text-slate-800">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label="Cerrar"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Pagination({ page, pages, total, onChange }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <span className="text-slate-500">
        Página <b>{page}</b> de <b>{pages}</b> · {total} registros
      </span>
      <div className="flex gap-2">
        <button className="btn-secondary !px-3 !py-1.5" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          ← Anterior
        </button>
        <button className="btn-secondary !px-3 !py-1.5" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Siguiente →
        </button>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirmar', danger }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm text-slate-600">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>
          Cancelar
        </button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function ConfirmToggle({ active, onToggle, name, labelActivate, labelDeactivate }) {
  const btn = active ? 'bg-emerald-500' : 'bg-slate-300';
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${btn}`}
      role="switch"
      aria-checked={active}
      aria-label={name}
      title={active ? labelDeactivate : labelActivate}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${active ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}
import { fileUrl, isImage, formatSize, formatDateTime, formatRelative } from '../lib/api';
import { renderMessage } from '../lib/markdown';

const EVENT_META = {
  CREATED: { icon: '✦', tint: 'bg-brand-50 text-brand-600' },
  ASSIGNED: { icon: '👤', tint: 'bg-indigo-50 text-indigo-600' },
  ASSIGNED_TEAM: { icon: '👥', tint: 'bg-indigo-50 text-indigo-600' },
  STATUS_CHANGED: { icon: '🔄', tint: 'bg-amber-50 text-amber-600' },
  REOPENED: { icon: '↩️', tint: 'bg-orange-50 text-orange-600' },
  PRIORITY_CHANGED: { icon: '⚡', tint: 'bg-orange-50 text-orange-600' },
  CATEGORY_CHANGED: { icon: '🗂', tint: 'bg-slate-100 text-slate-600' },
  UPDATED: { icon: '✏️', tint: 'bg-slate-100 text-slate-600' },
  COMMENT_ADDED: { icon: '💬', tint: 'bg-brand-50 text-brand-600' },
  NOTE_ADDED: { icon: '🔒', tint: 'bg-amber-100 text-amber-700' },
  ATTACHMENT_ADDED: { icon: '📎', tint: 'bg-slate-100 text-slate-600' },
  RESOLVED: { icon: '✅', tint: 'bg-emerald-50 text-emerald-600' },
  CLOSED: { icon: '📁', tint: 'bg-slate-100 text-slate-600' },
  PENDING_REASON_SET: { icon: '⏸', tint: 'bg-purple-50 text-purple-600' },
};

export default function TicketTimeline({ history = [], comments = [] }) {
  const items = [
    ...history.map((h) => ({ kind: 'event', at: h.created_at, key: `h${h.id}`, h })),
    ...comments.map((c) => ({ kind: 'comment', at: c.created_at, key: `c${c.id}`, c })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : 1));

  if (!items.length) {
    return <p className="py-6 text-center text-sm text-slate-400">Sin actividad todavía.</p>;
  }

  return (
    <ol className="space-y-0">
      {items.map((item, i) => (
        <li key={item.key} className="relative flex gap-3">
          <div className="flex flex-col items-center">
            {item.kind === 'event' ? (
              <span
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs ${
                  (EVENT_META[item.h.action] || {}).tint || 'bg-slate-100 text-slate-600'
                }`}
              >
                {(EVENT_META[item.h.action] || {}).icon || '•'}
              </span>
            ) : (
              <span
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ${
                  item.c.is_internal ? 'bg-amber-100 text-amber-700' : 'bg-brand-100 text-brand-700'
                }`}
              >
                {item.c.is_internal ? '🔒' : (item.c.user_name || 'U').slice(0, 1).toUpperCase()}
              </span>
            )}
            {i < items.length - 1 && <span className="my-1 w-px flex-1 bg-slate-200" />}
          </div>

          <div className={`min-w-0 flex-1 ${i < items.length - 1 ? 'pb-5' : ''}`}>
            {item.kind === 'event' ? (
              <EventRow h={item.h} />
            ) : (
              <CommentBlock comment={item.c} />
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function EventRow({ h }) {
  return (
    <div className="pt-1.5">
      <p className="text-sm leading-snug text-slate-600">
        <span className="font-semibold text-slate-800">{h.user_name || 'Sistema'}</span>{' '}
        {h.description || h.action}
      </p>
      <p className="mt-0.5 text-xs text-slate-400" title={formatDateTime(h.created_at)}>
        {formatRelative(h.created_at)} · {formatDateTime(h.created_at)}
      </p>
    </div>
  );
}

function CommentBlock({ comment }) {
  const internal = !!comment.is_internal;
  return (
    <div
      className={`rounded-xl border p-3.5 ${
        internal ? 'border-amber-200 bg-amber-50/70' : 'border-slate-200 bg-white'
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-800">{comment.user_name || 'Usuario'}</span>
        {internal && (
          <span className="badge bg-amber-100 text-amber-800 ring-1 ring-amber-300/50">Nota interna</span>
        )}
        <span className="ml-auto text-xs text-slate-400" title={formatDateTime(comment.created_at)}>
          {formatDateTime(comment.created_at)}
        </span>
      </div>
      <div
        className="text-sm leading-relaxed text-slate-700 [&_ul]:list-disc"
        dangerouslySetInnerHTML={{ __html: renderMessage(comment.message) }}
      />
      {comment.attachments?.length > 0 && <AttachmentList items={comment.attachments} />}
    </div>
  );
}

function AttachmentList({ items }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((a) =>
        isImage(a.mime_type) ? (
          <a key={a.id} href={fileUrl(a.id)} target="_blank" rel="noreferrer" title={a.original_name}>
            <img
              src={fileUrl(a.id)}
              alt={a.original_name}
              className="h-20 w-20 rounded-lg object-cover ring-1 ring-slate-200 hover:opacity-80"
            />
          </a>
        ) : (
          <a
            key={a.id}
            href={fileUrl(a.id)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200"
          >
            📎 {a.original_name || 'Archivo'}
            <span className="text-slate-400">{formatSize(a.size_bytes)}</span>
          </a>
        )
      )}
    </div>
  );
}

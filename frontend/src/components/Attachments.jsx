import { fileUrl, isImage, formatSize } from '../lib/api';

/**
 * Lista de adjuntos. La comparten el detalle del ticket (archivos de la
 * descripción) y la conversación (archivos de cada comentario), de modo que un
 * mismo archivo se presenta igual en ambos sitios: miniatura para imágenes y
 * enlace con el peso para el resto.
 */
export default function AttachmentList({ items, className = '' }) {
  if (!items?.length) return null;
  return (
    <div className={`flex flex-wrap gap-2.5 ${className}`}>
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

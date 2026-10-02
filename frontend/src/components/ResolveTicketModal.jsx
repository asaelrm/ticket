import { useEffect, useId, useState } from 'react';
import { Modal, Spinner } from './ui';

// Resolución de UN ticket.
//
// `POST /api/tickets/:id/resolve` exige `resolution` (backend/src/routes/tickets.js)
// y aplica la auditoría, el aviso al reportante y el reinicio del CSAT que el
// PATCH genérico no puede hacer. Por eso no hay atajo que lo esquive: si el
// técnico pulsa "Resolver", primero se rellena aquí.
//
// A diferencia del modal de lote, éste conoce el ticket y por eso puede titular
// con su número, mostrar su título y mantener el error dentro del diálogo: si el
// servidor rechaza la operación, el usuario ve por qué sin perder lo escrito.
export default function ResolveTicketModal({ ticket, busy = false, onClose, onSubmit }) {
  const [resolution, setResolution] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fieldId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!ticket) return;
    setResolution('');
    setError('');
    setSaving(false);
  }, [ticket?.id]);

  if (!ticket) return null;

  const locked = busy || saving;

  async function submit(e) {
    e.preventDefault();
    // Validación local espejo de `rules.required` del servidor: no se gasta una
    // petición en un envío que el backend va a rechazar con un 400.
    if (!resolution.trim()) {
      setError('La solución es obligatoria.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSubmit(resolution.trim());
      onClose();
    } catch (err) {
      // El error ya está en el ErrorBox de la pantalla; aquí se repite junto al
      // campo para que quien está en el diálogo no tenga que cerrarlo.
      setError(err?.message || 'No se pudo resolver el ticket');
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Resolver ${ticket.ticket_number}`}>
      <form onSubmit={submit} noValidate>
        {ticket.title && <p className="text-sm text-slate-600">{ticket.title}</p>}

        <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor={fieldId}>
          Solución / trabajo realizado <span className="text-red-500">*</span>
        </label>
        <textarea
          id={fieldId}
          className="input mt-1 min-h-[110px]"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          placeholder="Ej. Se cambió la fuente de poder y se verificó con el usuario."
          maxLength={10000}
          required
          disabled={locked}
          aria-required="true"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <p className="mt-1 text-xs text-slate-400">
          Este texto queda registrado como solución del ticket y es obligatorio para resolverlo.
        </p>

        {error && (
          <p id={errorId} role="alert" className="mt-2 text-sm text-red-600">
            {error}
          </p>
        )}

        {/* Pie estable. El cuerpo del diálogo se desplaza cuando la pantalla es
            baja (o con zoom), así que unos botones que se fueran con el scroll
            dejarían la confirmación fuera de alcance. `sticky bottom-0` los
            mantiene a la vista sin sacarlos del `<form>` ni duplicar el
            sistema de diálogo; los márgenes negativos hacen que el pie llegue
            al borde de la tarjeta en vez de flotar dentro del relleno. */}
        <div className="sticky bottom-0 -mx-5 -mb-4 mt-5 flex shrink-0 justify-end gap-2 border-t border-slate-200 bg-[var(--surface-2)] px-5 py-3">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={locked}>
            Volver
          </button>
          <button type="submit" className="btn-primary" disabled={locked || !resolution.trim()}>
            {locked && <Spinner className="h-4 w-4 text-white" />}
            {locked ? 'Guardando…' : 'Resolver ticket'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
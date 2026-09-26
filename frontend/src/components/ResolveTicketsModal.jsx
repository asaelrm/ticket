import { useEffect, useState } from 'react';
import { Modal } from './ui';

// El endpoint /resolve exige `resolution` (tickets.js). Esta caja recoge ese
// dato obligatorio tanto para un ticket como para una selección múltiple, de
// modo que la acción nunca se envíe con un payload incompleto.
export default function ResolveTicketsModal({ open, onClose, count, onConfirm, busy = false }) {
  const [resolution, setResolution] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setResolution('');
    setError('');
  }, [open, count]);

  const submit = () => {
    if (!resolution.trim()) {
      setError('La solución es obligatoria.');
      return;
    }
    onConfirm(resolution.trim());
  };

  return (
    <Modal open={open} onClose={onClose} title={`Resolver ${count} ticket(s)`}>
      <p className="text-sm text-slate-600">
        Se aplicará la misma solución a {count === 1 ? 'el ticket seleccionado' : `los ${count} tickets seleccionados`}.
      </p>
      <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="bulk-resolution">
        Solución / trabajo realizado <span className="text-red-500">*</span>
      </label>
      <textarea
        id="bulk-resolution"
        className="input mt-1 min-h-[90px]"
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
        placeholder="Ej.: Se_solutionó en sitio y se verificó con el usuario."
        maxLength={10000}
      />
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Volver
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={submit}
          disabled={busy || !resolution.trim()}
        >
          Resolver {count} ticket(s)
        </button>
      </div>
    </Modal>
  );
}

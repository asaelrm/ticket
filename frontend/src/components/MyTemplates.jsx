import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Modal, ErrorBox, Spinner, ConfirmToggle, EmptyState } from './ui';
import { renderMessage } from '../lib/markdown';
import { extractVariables, TEMPLATE_VARIABLES, MAX_TEMPLATE_BODY } from '../lib/templateVars';

const EMPTY = { title: '', body: '' };

/**
 * Gestión de las respuestas rápidas personales del usuario actual.
 *
 * Solo opera sobre plantillas de ámbito PERSONAL: el backend ignora cualquier
 * owner_id enviado por el cliente y filtra siempre por la sesión, de modo que
 * aquí no hay ningún selector de ámbito ni de equipo.
 */
export default function MyTemplates() {
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(null);

  const { data: list, isLoading, error: queryError } = useQuery({
    queryKey: ['canned-responses-mine'],
    queryFn: () => api.get('/api/canned-responses/mine').then((d) => d.data || []),
  });

  const saveMutation = useMutation({
    mutationFn: (form) =>
      form.id
        ? api.patch(`/api/canned-responses/${form.id}`, { title: form.title, body: form.body })
        : api.post('/api/canned-responses', { title: form.title, body: form.body, scope: 'PERSONAL' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canned-responses-mine'] });
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
      setModal(null);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (t) => api.patch(`/api/canned-responses/${t.id}`, { is_active: !t.is_active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canned-responses-mine'] });
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
    },
  });

  const vars = modal ? extractVariables(modal.form.body) : { unknown: [] };
  const error = saveMutation.error || toggleMutation.error;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          Plantillas solo suyas. Se muestran en el selector de respuestas rápidas del ticket.
        </p>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            saveMutation.reset();
            setModal({ id: null, form: { ...EMPTY } });
          }}
        >
          + Nueva plantilla
        </button>
      </div>

      <div className="mb-3 space-y-2">
        {queryError && <ErrorBox message={queryError.message || 'Error al cargar sus plantillas'} />}
        {error && (
          <ErrorBox
            message={error.fields ? Object.values(error.fields).join('. ') : error.message || 'Error al guardar'}
          />
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-500">
          <Spinner className="h-4 w-4" /> Cargando…
        </div>
      ) : !list?.length ? (
        <EmptyState icon="⚡" title="Sin respuestas rápidas" subtitle="Cree una para responder más rápido." />
      ) : (
        <ul className="space-y-2">
          {list.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 p-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">{t.title}</p>
                <p className="truncate text-xs text-slate-500">
                  {t.body} · {t.use_count} usos
                  {!t.is_active && <span className="ml-1 font-medium text-amber-700">· inactiva</span>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ConfirmToggle
                  active={!!t.is_active}
                  name={t.title}
                  labelActivate="Desactivar"
                  labelDeactivate="Activar"
                  onToggle={() => toggleMutation.mutate(t)}
                />
                <button
                  type="button"
                  className="btn-ghost !px-2 !py-1 text-xs"
                  onClick={() => {
                    saveMutation.reset();
                    setModal({ id: t.id, form: { title: t.title, body: t.body } });
                  }}
                >
                  Editar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.id ? 'Editar plantilla' : 'Nueva plantilla'}>
        {modal && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveMutation.mutate({ ...modal.form, id: modal.id });
            }}
            className="space-y-4"
            noValidate
          >
            <div>
              <label className="label" htmlFor="my-tpl-title">
                Título *
              </label>
              <input
                id="my-tpl-title"
                className="input"
                value={modal.form.title}
                maxLength={100}
                onChange={(e) => setModal({ ...modal, form: { ...modal.form, title: e.target.value } })}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="my-tpl-body">
                Cuerpo de la respuesta *
              </label>
              <textarea
                id="my-tpl-body"
                className="input min-h-[150px]"
                value={modal.form.body}
                maxLength={MAX_TEMPLATE_BODY}
                onChange={(e) => setModal({ ...modal, form: { ...modal.form, body: e.target.value } })}
              />
              <p className="mt-1 text-xs text-slate-400">
                {modal.form.body.length}/{MAX_TEMPLATE_BODY} caracteres
              </p>
            </div>
            <div>
              <p className="label">Variables</p>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATE_VARIABLES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-brand-100 hover:text-brand-700"
                    onClick={() =>
                      setModal({ ...modal, form: { ...modal.form, body: `${modal.form.body}{{${v.key}}}` } })
                    }
                  >
                    {`{{${v.key}}}`}
                  </button>
                ))}
              </div>
              {vars.unknown.length > 0 && (
                <p className="mt-2 text-xs font-medium text-amber-700">
                  Fuera del catálogo: {vars.unknown.map((k) => `{{${k}}}`).join(', ')}
                </p>
              )}
            </div>
            <div>
              <p className="label">Vista previa</p>
              <div
                className="min-h-[50px] rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm text-slate-700"
                dangerouslySetInnerHTML={{ __html: renderMessage(modal.form.body) }}
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setModal(null)}>
                Cancelar
              </button>
              <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
                {saveMutation.isPending && <Spinner className="h-4 w-4 text-white" />}
                Guardar
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

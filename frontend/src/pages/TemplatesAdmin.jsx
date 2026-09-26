import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Modal, ErrorBox, Spinner, LoadingScreen, ConfirmToggle, EmptyState } from '../components/ui';
import { renderMessage } from '../lib/markdown';
import {
  extractVariables,
  TEMPLATE_VARIABLES,
  MAX_TEMPLATE_BODY,
  MAX_COMMENT_LENGTH,
} from '../lib/templateVars';

const SCOPE_LABEL = { GLOBAL: 'Global', TEAM: 'Equipo' };

function emptyForm() {
  return { title: '', body: '', scope: 'GLOBAL', team_id: '', is_active: true };
}

// Un ejemplo de texto expandido con los datos de ejemplo del catálogo sirve para
// estimar el largo final sin tocar datos de ningún ticket.
function estimateLength(body) {
  const longest = TEMPLATE_VARIABLES.reduce(
    (max, v) => Math.max(max, v.example.length),
    0
  );
  return body.length + longest * (body.match(/\{\{/g) || []).length;
}

export default function TemplatesAdmin() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(null);
  const [scope, setScope] = useState('');
  const [q, setQ] = useState('');

  const canGlobal = !!user?.permissions?.includes('settings.manage');
  const canTeam = !!user?.permissions?.includes('team.manage');

  const { data: list, isLoading, error: queryError } = useQuery({
    queryKey: ['canned-responses-manage', scope, q],
    queryFn: () =>
      api
        .get(`/api/canned-responses/manage?scope=${scope}&q=${encodeURIComponent(q)}`)
        .then((d) => d.data || []),
  });

  const { data: teams = [] } = useQuery({
    queryKey: ['canned-teams'],
    queryFn: () => api.get('/api/teams').then((d) => d.data || []).catch(() => []),
    enabled: canTeam,
  });

  const saveMutation = useMutation({
    mutationFn: (form) => {
      const payload = {
        title: form.title,
        body: form.body,
        scope: form.scope,
        is_active: form.is_active,
        team_id: form.scope === 'TEAM' ? Number(form.team_id) || null : null,
      };
      return form.id
        ? api.patch(`/api/canned-responses/${form.id}`, payload)
        : api.post('/api/canned-responses', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canned-responses-manage'] });
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
      setModal(null);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (t) => api.patch(`/api/canned-responses/${t.id}`, { is_active: !t.is_active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canned-responses-manage'] });
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
    },
  });

  const templateVars = useMemo(
    () => (modal ? extractVariables(modal.form.body) : { used: [], unknown: [] }),
    [modal]
  );

  const estimate = modal ? estimateLength(modal.form.body) : 0;
  const estimateTooLong = estimate > MAX_COMMENT_LENGTH;

  function openNew() {
    saveMutation.reset();
    setModal({ id: null, form: { ...emptyForm(), scope: canGlobal ? 'GLOBAL' : 'TEAM' } });
  }

  function openEdit(t) {
    saveMutation.reset();
    setModal({
      id: t.id,
      form: {
        title: t.title,
        body: t.body,
        scope: t.scope,
        team_id: t.team_id ? String(t.team_id) : '',
        is_active: !!t.is_active,
      },
    });
  }

  const error = saveMutation.error || toggleMutation.error;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="tpl-filter-scope">
            Filtrar por ámbito
          </label>
          <select
            id="tpl-filter-scope"
            className="input !w-auto"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">Todos los ámbitos</option>
            {canGlobal && <option value="GLOBAL">Global</option>}
            {canTeam && <option value="TEAM">Equipo</option>}
          </select>
          <label className="sr-only" htmlFor="tpl-filter-q">
            Buscar plantillas
          </label>
          <input
            id="tpl-filter-q"
            className="input !w-auto"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar…"
          />
        </div>
        <button type="button" className="btn-primary" onClick={openNew}>
          + Nueva plantilla
        </button>
      </div>

      <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Las plantillas de equipo son visibles solo para los miembros actuales del equipo: el sistema no guarda historial de
        pertenencia. No Platzholders ni datos de un cliente concreto en el texto de la plantilla.
      </p>

      <div className="mb-3 space-y-2">
        {queryError && <ErrorBox message={queryError.message || 'Error al cargar'} />}
        {error && (
          <ErrorBox
            message={
              error.fields ? Object.values(error.fields).join('. ') : error.message || 'Error al guardar'
            }
          />
        )}
      </div>

      {isLoading ? (
        <LoadingScreen />
      ) : !list?.length ? (
        <div className="card">
          <EmptyState icon="⚡" title="Sin plantillas" subtitle="Cree la primera plantilla global o de equipo." />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((t) => (
            <div key={t.id} className="card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-800">{t.title}</p>
                  <p className="text-xs text-slate-400">
                    {SCOPE_LABEL[t.scope]}
                    {t.scope === 'TEAM' && t.team_name ? `: ${t.team_name}` : ''} · {t.use_count} usos
                  </p>
                </div>
                <ConfirmToggle
                  active={!!t.is_active}
                  name={t.title}
                  labelActivate="Desactivar"
                  labelDeactivate="Activar"
                  onToggle={() => toggleMutation.mutate(t)}
                />
              </div>
              <p className="mt-2 line-clamp-3 text-sm text-slate-500">{t.body}</p>
              <button
                type="button"
                className="btn-ghost mt-3 !px-2 !py-1 text-xs"
                onClick={() => openEdit(t)}
              >
                Editar
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal?.id ? 'Editar plantilla' : 'Nueva plantilla'}
        wide
      >
        {modal && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveMutation.mutate({ ...modal.form, id: modal.id });
            }}
            className="space-y-4"
            noValidate
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="tpl-title">
                  Título *
                </label>
                <input
                  id="tpl-title"
                  className="input"
                  value={modal.form.title}
                  maxLength={100}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, title: e.target.value } })}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="tpl-scope">
                  Ámbito *
                </label>
                <select
                  id="tpl-scope"
                  className="input"
                  value={modal.form.scope}
                  onChange={(e) =>
                    setModal({ ...modal, form: { ...modal.form, scope: e.target.value, team_id: '' } })
                  }
                >
                  {canGlobal && <option value="GLOBAL">Global</option>}
                  {canTeam && <option value="TEAM">Equipo</option>}
                </select>
              </div>
            </div>

            {modal.form.scope === 'TEAM' && (
              <div>
                <label className="label" htmlFor="tpl-team">
                  Equipo *
                </label>
                <select
                  id="tpl-team"
                  className="input"
                  value={modal.form.team_id}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, team_id: e.target.value } })}
                >
                  <option value="">Seleccione un equipo…</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="label" htmlFor="tpl-body">
                Cuerpo de la respuesta *
              </label>
              <textarea
                id="tpl-body"
                className="input min-h-[160px]"
                value={modal.form.body}
                maxLength={MAX_TEMPLATE_BODY}
                onChange={(e) => setModal({ ...modal, form: { ...modal.form, body: e.target.value } })}
              />
              <p className="mt-1 text-xs text-slate-400">
                {modal.form.body.length}/{MAX_TEMPLATE_BODY} caracteres
              </p>
            </div>

            <div>
              <p className="label">Variables disponibles</p>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATE_VARIABLES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-brand-100 hover:text-brand-700"
                    onClick={() =>
                      setModal({
                        ...modal,
                        form: { ...modal.form, body: `${modal.form.body}${{ [`${v.key}`]: '' }[v.key] ? '' : `{{${v.key}}}`}` },
                      })
                    }
                  >
                    {`{{${v.key}}}`}
                  </button>
                ))}
              </div>
              {templateVars.unknown.length > 0 && (
                <p className="mt-2 text-xs font-medium text-amber-700">
                  Variables fuera del catálogo: {templateVars.unknown.map((k) => `{{${k}}}`).join(', ')}. Se insertarán
                  literalmente en el comentario.
                </p>
              )}
              {estimateTooLong && (
                <p className="mt-1 text-xs font-medium text-red-600">
                  El texto expandido superaría los {MAX_COMMENT_LENGTH} caracteres del comentario.
                </p>
              )}
            </div>

            <div>
              <p className="label">Vista previa</p>
              <div
                className="min-h-[60px] rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm text-slate-700"
                dangerouslySetInnerHTML={{ __html: renderMessage(modal.form.body) }}
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-brand-600"
                checked={modal.form.is_active}
                onChange={(e) =>
                  setModal({ ...modal, form: { ...modal.form, is_active: e.target.checked } })
                }
              />
              Activa (visible en el selector de los técnicos)
            </label>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setModal(null)}>
                Cancelar
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={saveMutation.isPending || estimateTooLong}
              >
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

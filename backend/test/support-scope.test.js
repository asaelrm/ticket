import assert from 'node:assert/strict';
import test from 'node:test';
import { canViewTicket } from '../src/routes/tickets.js';

const internal = { id: 10, organization_id: 1, reporter_id: 20, support_scope: 'INTERNAL' };
const central = { id: 11, organization_id: 2, reporter_id: 30, support_scope: 'SIFHA' };

test('técnico con doble función conserva acceso interno y obtiene solo empresas SIFHA autorizadas', () => {
  const user = {
    id: 10, organization_id: 1, permissions: ['ticket.view.all', 'ticket.sifha.view'],
    sifha_organization_ids: [2],
  };
  assert.equal(canViewTicket(user, internal), true);
  assert.equal(canViewTicket(user, central), true);
  assert.equal(canViewTicket(user, { ...central, organization_id: 3 }), false);
});

test('revocar el permiso SIFHA elimina el acceso sin afectar el soporte local', () => {
  const user = { id: 10, organization_id: 1, permissions: ['ticket.view.all'], sifha_organization_ids: [2] };
  assert.equal(canViewTicket(user, internal), true);
  assert.equal(canViewTicket(user, central), false);
});

test('manipular el identificador no cruza empresas ni convierte un ticket interno en central', () => {
  const user = { id: 10, organization_id: 1, permissions: ['ticket.sifha.view'], sifha_organization_ids: [2] };
  assert.equal(canViewTicket(user, { ...central, id: 999, organization_id: 3 }), false);
  assert.equal(canViewTicket(user, { ...internal, id: 999, organization_id: 2 }), false);
});

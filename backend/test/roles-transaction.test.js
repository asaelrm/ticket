import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { createClient } from './helpers.js';

let admin;
let role;

function permissionCodes(roleId) {
  return db.prepare(`
    SELECT p.code FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ?
    ORDER BY p.code
  `).all(roleId).map((row) => row.code);
}

before(async () => {
  admin = createClient();
  await admin.login('admin', '123456');
  const roles = await admin.get('/api/roles');
  role = roles.body.roles.find((item) => item.code === 'TECHNICIAN');
  assert.ok(role);
});

describe('reemplazo transaccional de permisos de rol', () => {
  it('confirma el reemplazo completo y conserva la respuesta HTTP', async () => {
    const original = permissionCodes(role.id);
    const replacement = ['ticket.comment', 'ticket.create'];
    try {
      const response = await admin.patch(`/api/roles/${role.id}/permissions`, { permissions: replacement });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true });
      assert.deepEqual(permissionCodes(role.id), replacement.slice().sort());
    } finally {
      await admin.patch(`/api/roles/${role.id}/permissions`, { permissions: original });
    }
  });

  it('revierte el DELETE si un INSERT posterior falla', async () => {
    const original = permissionCodes(role.id);
    const duplicateValidCode = original[0];
    const response = await admin.patch(`/api/roles/${role.id}/permissions`, {
      permissions: [duplicateValidCode, duplicateValidCode],
    });
    assert.equal(response.status, 500);
    assert.deepEqual(permissionCodes(role.id), original);
  });
});

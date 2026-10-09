import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { seed } from '../src/seed.js';

function permissionsFor(roleId) {
  return db.prepare(
    `SELECT p.code FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = ? ORDER BY p.code`
  ).all(roleId).map((row) => row.code);
}

describe('Seed: permisos iniciales de roles', () => {
  it('crea ADMIN con sus permisos por defecto y conserva una personalización al reiniciar', () => {
    const adminRole = db.prepare("SELECT id FROM roles WHERE code = 'ADMIN'").get();
    const exportPermission = db.prepare("SELECT id FROM permissions WHERE code = 'ticket.export'").get();
    assert.ok(permissionsFor(adminRole.id).includes('ticket.export'), 'una instalación inicial conserva el permiso predeterminado');

    db.prepare('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?')
      .run(adminRole.id, exportPermission.id);
    assert.ok(!permissionsFor(adminRole.id).includes('ticket.export'));

    seed();
    assert.ok(!permissionsFor(adminRole.id).includes('ticket.export'), 'el seed no repone permisos retirados desde la interfaz');
  });
});

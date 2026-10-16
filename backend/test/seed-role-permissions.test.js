import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db/runtime.js';
import { seed } from '../src/seed.js';

async function permissionsFor(roleId) {
  return (
    await db.queryMany(
      `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? ORDER BY p.code`,
      roleId
    )
  ).map((row) => row.code);
}

describe('Seed: permisos iniciales de roles', () => {
  it('crea ADMIN con sus permisos por defecto y conserva una personalización al reiniciar', async () => {
    const adminRole = await db.queryOne("SELECT id FROM roles WHERE code = 'ADMIN'");
    const exportPermission = await db.queryOne("SELECT id FROM permissions WHERE code = 'ticket.export'");
    assert.ok((await permissionsFor(adminRole.id)).includes('ticket.export'), 'una instalación inicial conserva el permiso predeterminado');

    await db.execute('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?',
      adminRole.id, exportPermission.id);
    assert.ok(!(await permissionsFor(adminRole.id)).includes('ticket.export'));

    await seed();
    assert.ok(!(await permissionsFor(adminRole.id)).includes('ticket.export'), 'el seed no repone permisos retirados desde la interfaz');
  });
});

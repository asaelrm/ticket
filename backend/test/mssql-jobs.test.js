// Pruebas de integración MSSQL: Jobs de mantenimiento
// Ejecutar: npm run test:mssql

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminClient, createEmpleadoClient, uniqueSuffix } from './helpers-mssql.js';
import { ensureMssqlTestSetup } from './setup-mssql.js';
import { runMaintenance } from '../src/utils/jobs.js';
import { setOrgSetting } from '../src/utils/settingsStore.js';

let adminClient;
let empleadoClient;
let testSuffix;

before(async () => {
  await ensureMssqlTestSetup();
  testSuffix = uniqueSuffix();
  
  adminClient = await createAdminClient(testSuffix);
  empleadoClient = await createEmpleadoClient(testSuffix);
});

describe('MSSQL Integration: Jobs de mantenimiento', () => {
  it('runMaintenance() ejecuta sin errores', async () => {
    const result = await runMaintenance();
    assert.ok(typeof result === 'object');
    assert.ok(typeof result.overdue === 'number');
    assert.ok(typeof result.escalated === 'number');
    assert.ok(typeof result.critical === 'number');
    assert.ok(typeof result.pruned === 'number');
  });
  
  it('SLA vencido genera notificaciones (estructura)', async () => {
    // Crear ticket base
    const title = `SLA Vencido MSSQL ${testSuffix}`;
    const t = await adminClient.post('/api/tickets', { 
      title, 
      description: 'D', 
      category_id: 1, 
      priority: 'HIGH' 
    });
    assert.ok(t.body.ticket.id);
    
    // El job usa sla_due_at; la prueba de integración completa requeriría
    // manipular fechas directamente en BD o configurar SLA inmediato.
    // Aquí validamos que el job se ejecuta y devuelve estructura correcta.
    const result = await runMaintenance();
    assert.ok(result.overdue >= 0);
  });
  
  it('escalación de tickets sin asignar (estructura)', async () => {
    // Configurar regla de escalación para la organización actual
    await setOrgSetting(1, 'rule_unassigned_hours', '1');
    await setOrgSetting(1, 'rule_unassigned_priority', 'HIGH');
    
    const title = `Sin Asignar MSSQL ${testSuffix}`;
    const t = await adminClient.post('/api/tickets', { 
      title, 
      description: 'D', 
      category_id: 1, 
      priority: 'LOW' 
    });
    assert.ok(t.body.ticket.id);
    
    const result = await runMaintenance();
    assert.ok(result.escalated >= 0);
  });
  
  it('alerta crítica de tickets abiertos mucho tiempo (estructura)', async () => {
    await setOrgSetting(1, 'rule_critical_hours', '1');
    
    const title = `Crítico MSSQL ${testSuffix}`;
    const t = await adminClient.post('/api/tickets', { 
      title, 
      description: 'D', 
      category_id: 1, 
      priority: 'CRITICAL' 
    });
    assert.ok(t.body.ticket.id);
    
    const result = await runMaintenance();
    assert.ok(result.critical >= 0);
  });
  
  it('poda de notificaciones antiguas', async () => {
    const result = await runMaintenance();
    assert.ok(result.pruned >= 0);
  });
});
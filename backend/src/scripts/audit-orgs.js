import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditOrganizationConsistency } from '../orgPolicy.js';

// Auditoría de solo lectura sobre SQL Server: no aplica migraciones ni modifica
// datos. El esquema se valida/gestiona fuera de línea.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const issues = await auditOrganizationConsistency();
  if (issues.length === 0) {
    console.log('Auditoría de organizaciones: sin inconsistencias.');
  } else {
    console.error(`Auditoría de organizaciones: ${issues.length} inconsistencia(s) detectada(s).`);
    for (const issue of issues) {
      console.error(`  [${issue.type}] ${issue.detail}`);
    }
    console.error('Nada fue modificado: revise los datos y corríjalos manualmente.');
    process.exitCode = 1;
  }
}
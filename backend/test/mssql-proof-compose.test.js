// Guarda estática del compose de prueba contra SQL Server: no debe tocar los
// contenedores actuales, no debe exponer `backend/.env`, no debe publicar
// puertos en conflicto, no debe apuntar a DEV ni guardar credenciales, y debe
// arrancar en modo MSSQL sin escrituras (JOBS_ENABLED=false). No se ejecuta
// Docker aquí: solo se lee el archivo. Las comprobaciones ignoran las líneas de
// comentario (`# ...`) para no confundir la documentación con la configuración.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE = path.join(__dirname, '..', '..', 'docker-compose.mssql-proof.yml');

const source = fs.readFileSync(COMPOSE, 'utf8');
const body = source
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('compose de prueba MSSQL: aislamiento y seguridad', () => {
  it('usa las variables del entorno y no escribe la contraseña en el archivo', () => {
    assert.match(body, /DB_PASSWORD:\s*"\$\{DB_PASSWORD:\?/);
    assert.match(body, /DB_USER:\s*"\$\{DB_USER:\?/);
    assert.doesNotMatch(body, /DB_PASSWORD:\s*"[^$]/);
  });

  it('no monta el directorio backend completo ni expone backend/.env', () => {
    assert.doesNotMatch(body, /\.\/backend:\/app\/backend/);
    assert.doesNotMatch(body, /\.env/);
    assert.doesNotMatch(body, /--env-file/);
    assert.match(body, /\.\/backend\/src:\/app\/backend\/src/);
    assert.match(body, /\.\/backend\/package-lock\.json:\/app\/backend\/package-lock\.json/);
  });

  it('fija el destino M5 autorizado y nunca a DEV', () => {
    assert.match(body, /DB_CLIENT:\s*mssql/);
    assert.match(body, /MSSQL_RUNTIME:\s*"true"/);
    assert.match(body, /DB_SERVER:\s*"100\.100\.4\.60"/);
    assert.match(body, /DB_DATABASE:\s*SIFHA_Tickets_M5_Validation/);
    assert.match(body, /DB_INSTANCE:\s*SIFHADEV/);
    assert.doesNotMatch(body, /SIFHA_Tickets_DEV/);
    assert.doesNotMatch(body, /ticket_dev_data|ticket_dev_uploads/);
  });

  it('verifica el destino en el comando de arranque antes de conectar', () => {
    assert.match(body, /DB_SERVER" = "100\.100\.4\.60/);
    assert.match(body, /DB_DATABASE" = "SIFHA_Tickets_M5_Validation/);
    assert.match(body, /DB_CLIENT" = "mssql/);
  });

  it('desactiva el mantenimiento para no escribir en la base al arrancar', () => {
    assert.match(body, /JOBS_ENABLED:\s*"false"/);
    assert.match(body, /JOBS_ENABLED" = "false/);
  });

  it('publica el puerto 4001 y no los de desarrollo (4000/5173)', () => {
    assert.match(body, /"4001:4000"/);
    assert.doesNotMatch(body, /"4000:4000"/);
    assert.doesNotMatch(body, /["']5173:/);
  });

  it('no arranca el frontend ni reutiliza sus volúmenes', () => {
    assert.doesNotMatch(body, /^\s{2}frontend:/m);
    assert.doesNotMatch(body, /frontend_node_modules/);
  });
});

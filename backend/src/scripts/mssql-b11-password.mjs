// B11-B1 · genera la contraseña sintética y su hash bcrypt para el script SQL.
//
// Los fixtures se crean desde SSMS con Windows Authentication, y T-SQL no sabe
// calcular bcrypt. Este comando cubre esa única pieza: genera una contraseña
// aleatoria, calcula su hash con el MISMO factor de coste que producción y
// entrega el hash listo para pegar en el :setvar del .sql.
//
// Lo que NO hace y NO debe hacer:
//   - imprimir la contraseña: se queda en el manifiesto temporal;
//   - imprimir el manifiesto completo (contiene la contraseña);
//   - escribir nada en la base de datos: no abre conexión;
//   - guardar nada dentro del repositorio: el manifiesto vive en %TEMP%.
//
// Uso:
//   node src/scripts/mssql-b11-password.mjs            genera marcador y hash
//   node src/scripts/mssql-b11-password.mjs --forget   borra el manifiesto
//
// En B11-B1 este comando NO se ha ejecutado.

import {
  B11_ROLE_MANAGER,
  B11_ROLE_NO_MANAGE,
  B11_TARGET_ROLE,
  B11_PERMISSION_ROLE_MANAGE,
  B11_PERMISSION_NO_MANAGE,
  createMarker,
  createFixturePassword,
  describeFixtures,
  hashFixturePassword,
  writeManifest,
  findLatestManifest,
  removeManifest,
  sqlcmdBlock,
} from '../fixtures/mssql.b11.js';

const forget = process.argv.includes('--forget');

if (forget) {
  const marker = process.env.B11_MARKER || findLatestManifest().manifest?.marker;
  if (!marker) {
    console.log('No hay manifiesto de B11 que borrar.');
  } else {
    removeManifest(marker);
    console.log(`Manifiesto de ${marker} eliminado.`);
  }
} else {
  const marker = process.env.B11_MARKER || createMarker();
  const manifest = describeFixtures(marker, { password: createFixturePassword() });
  const hash = await hashFixturePassword(manifest.password);

  // El manifiesto es el único sitio donde queda la contraseña en claro, y está
  // fuera del repositorio. La prueba HTTP lo leerá de aquí para hacer login.
  const target = writeManifest(manifest);

  console.log('Marcador de fixtures B11:');
  console.log(`  ${marker}`);
  console.log('');
  console.log('Cuentas que se crearán (todas @example.invalid):');
  for (const user of manifest.users) {
    console.log(`  ${user.key.padEnd(9)} ${user.username}`);
  }
  console.log('');
  console.log('Roles y permisos que se crearán:');
  console.log(`  ${B11_ROLE_MANAGER}  -> ${B11_PERMISSION_ROLE_MANAGE}`);
  console.log(`  ${B11_ROLE_NO_MANAGE} -> ${B11_PERMISSION_NO_MANAGE}`);
  console.log(`  ${B11_TARGET_ROLE}   -> (sin permisos)`);
  console.log('');
  console.log('Hash bcrypt sintético (copiar en el :setvar B11_PWD_HASH del .sql):');
  console.log(`  ${hash}`);
  console.log('');
  console.log('Bloque :setvar listo para pegar en mssql-b11-fixtures.sql:');
  for (const line of sqlcmdBlock({ marker, passwordHash: hash })) console.log(`  ${line}`);
  console.log('');
  console.log(`Manifiesto (contiene la contraseña de fixture) escrito en: ${target}`);
  console.log('La contraseña NO se ha mostrado. Para el login HTTP la leerá la prueba desde ahí.');
  console.log('Este hash es el de una contraseña sintética de una base DEV; no da acceso a nada real.');
}
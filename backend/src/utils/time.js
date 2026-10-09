// Utilidad pura de tiempo, sin dependencia de ningún motor de base de datos.
//
// Vivía en src/db.js, que abre la conexión SQLite al importarse. Los módulos
// que solo necesitan una marca temporal ISO no deben arrastrar esa conexión
// (ni el archivo SQLite) al cargarse, así que la función se extrajo aquí.

export function nowIso() {
  return new Date().toISOString();
}

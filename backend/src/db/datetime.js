// Representación canónica compartida para DATETIME2 de SQL Server y TEXT ISO
// de SQLite. Solo se normalizan instancias Date: números epoch, cadenas y JSON
// son datos de dominio y no se deben reinterpretar en el borde del contrato.
export function normalizeDateParameter(value, name) {
  if (!(value instanceof Date)) return value;
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`Parámetro "${name}" contiene una fecha inválida.`);
  }
  return value.toISOString();
}

// tedious devuelve DATETIME2 como Date. SQLite ya devuelve el TEXT ISO que se
// guardó. Devolver ISO UTC en ambos casos mantiene estable el contrato/API sin
// convertir otros tipos de columna.
export function normalizeDateResult(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export function normalizeDateRow(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeDateResult(value)]));
}

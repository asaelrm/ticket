// Canonical representation shared by SQL Server DATETIME2 and SQLite ISO TEXT.
export function normalizeDateParameter(value, name) {
  if (!(value instanceof Date)) return value;
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`Parámetro "${name}" contiene una fecha inválida.`);
  }
  return value.toISOString();
}

export function normalizeDateResult(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export function normalizeDateRow(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeDateResult(value)]));
}

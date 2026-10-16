// Constantes de organización compartidas, sin dependencia de ningún motor de
// base de datos.
//
// Vivían en src/seed.js, que abre la conexión SQLite al importarse. Un módulo
// que solo necesita estos datos (por ejemplo el directorio de usuarios) no debe
// arrastrar la conexión ni el archivo SQLite, así que se extrajeron aquí.

// Organización inicial (ETAPA 1A). Es la organización a la que se asocian los
// datos existentes sin pérdida de información. Las siguientes organizaciones
// llegarán en etapas posteriores, no en esta.
export const INITIAL_ORGANIZATION = {
  code: 'UCE',
  name: 'Centro Médico UCE',
  description: 'Organización inicial del sistema',
};

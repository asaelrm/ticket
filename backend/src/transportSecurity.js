// Política de transporte: decide a quién se cree que llegue la petición por
// HTTPS y si la respuesta lleva HSTS.
//
// Contexto que motiva este módulo: la misma instancia Express sirve hoy las
// dos vías de acceso, HTTPS por Cloudflare y HTTP desde la red local. Como la
// instancia es única, NO se puede decidir la atributos de las cookies "si la
// petición parece HTTPS": cualquier cliente podría enviar esa cabecera y
// degradar la cookie, o el camino HTTP dejaría de funcionar de forma
// inexplicable. Por eso la política es estática y configurable, y la
// detección de proxy se limita a rangos concretos en lugar de `true`.

// Un `true` ciego haría que Express creyese cualquier `X-Forwarded-Proto` de
// cualquier cliente, incluido el que se está intentando atacar. `1` cuenta
// saltos: sirve solo si hay exactamente un proxy delante y nadie más puede
// inyectar la cabecera, lo que tampoco es asumible desde una LAN.
const BLIND_VALUES = new Set(['true', 'yes', 'on', 'all']);

export function resolveTrustProxy(raw) {
  const value = String(raw ?? '').trim();

  if (!value) return false;
  if (value.toLowerCase() === 'false' || value.toLowerCase() === 'off') return false;

  if (BLIND_VALUES.has(value.toLowerCase())) {
    return { value: true, warning: 'TRUST_PROXY está en modo "confiar en cualquiera": cualquier cliente puede falsificar X-Forwarded-Proto. Limítelo a la IP o el CIDR del proxy.' };
  }

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return {
      value: hops,
      warning:
        hops > 0
          ? `TRUST_PROXY cuenta ${hops} salto(s) de proxy: cualquier cliente que alcance la aplicación sin pasar por el proxy puede inyectar X-Forwarded-Proto.`
          : null,
    };
  }

  // Lista separada por comas de IP literales, CIDR o `loopback`, `linklocal`
  // y `uniquelocal`, que son los nombres que acepta Express.
  const entries = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!entries.length) {
    return { value: false, warning: `TRUST_PROXY tiene un valor no reconocido ("${value}"): se ignora y no se confía en ninguna cabecera.` };
  }

  return { value: entries, warning: null };
}

// Hosts (sin puerto) que deben recibir HSTS. HSTS es por host, así que solo se
// emite para los nombres públicos declared en PUBLIC_HOSTS; el nombre interno
// de la LAN nunca se ancla, y así un despliegue de pruebas por HTTP no queda
// inutilizado en el navegador.
export function normalizeHost(host) {
  return String(host || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter(Boolean);
}

export function isPublicHost(host, publicHosts) {
  const hosts = normalizeHost(host);
  if (!hosts.length) return false;
  return normalizeHost(publicHosts).includes(hosts[0]);
}

// HSTS solo si el host es público Y la petición llegó de forma verificablemente
// cifrada. La segunda condición evita fijar el dominio cuando alguien lo abre
// por http:// en la LAN.
export function shouldSendHsts({ host, isHttps, publicHosts }) {
  if (!isHttps) return false;
  return isPublicHost(host, publicHosts);
}

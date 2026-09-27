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
const TRUSTED_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
// Compresión IPv6 suficiente para validar; no hace falta interpretarla.
const IPV6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;

function isIpOrCidr(entry) {
  if (TRUSTED_KEYWORDS.has(entry)) return true;
  if (IPV4.test(entry)) {
    const [addr, prefix] = entry.split('/');
    const octets = addr.split('.').map(Number);
    if (octets.some((o) => o > 255)) return false;
    if (prefix === undefined) return true;
    return Number(prefix) <= 32;
  }
  if (IPV6.test(entry) && entry.includes(':')) {
    const [, prefix] = entry.split('/');
    return prefix === undefined || Number(prefix) <= 128;
  }
  return false;
}

export function resolveTrustProxy(raw) {
  const value = String(raw ?? '').trim();

  if (!value) return { value: false, warning: null };
  if (value.toLowerCase() === 'false' || value.toLowerCase() === 'off') return { value: false, warning: null };

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

  // Lista separada por comas de IP literales, CIDR o las palabras que acepta
  // Express (loopback, linklocal, uniquelocal). Cualquier otra cosa se
  // descarta: un valor mal escrito no debe abrir la puerta por sorpresa.
  const entries = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = entries.filter(isIpOrCidr);
  const rejected = entries.filter((e) => !isIpOrCidr(e));

  if (!valid.length) {
    return { value: false, warning: `TRUST_PROXY no contiene ninguna IP o CIDR válido ("${value}"): se ignora y no se confía en ninguna cabecera.` };
  }

  return {
    value: valid,
    warning: rejected.length ? `TRUST_PROXY: se ignoran las entradas no válidas (${rejected.join(', ')}).` : null,
  };
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

import { describe, it, expect } from 'vitest';
import { renderMessage } from './markdown';

// Este archivo fija dos cosas a la vez:
//
//  1. Que el subconjunto Markdown que ya usaban los comentarios de los tickets
//     y las respuestas rápidas sigue produciendo EXACTAMENTE el mismo HTML.
//     Cualquier cambio accidental en párrafos, viñetas, negritas, cursivas o
//     código rompe una prueba de aquí antes de llegar a producción.
//  2. Que lo añadido para los artículos de la base de conocimiento
//     (encabezados y listas ordenadas) no abre la puerta a HTML peligroso.

describe('markdown: compatibilidad con lo que ya se renderizaba', () => {
  it('conserva los párrafos exactamente como antes', () => {
    expect(renderMessage('Hola')).toBe('<p>Hola</p>');
    expect(renderMessage('uno\ndos')).toBe('<p>uno</p><p>dos</p>');
  });

  it('conserva el separador de los renglones en blanco', () => {
    expect(renderMessage('uno\n\ndos')).toBe('<p>uno</p><div class="h-2"></div><p>dos</p>');
  });

  it('conserva las listas con viñetas y su sangría original', () => {
    expect(renderMessage('- uno\n- dos')).toBe(
      '<ul class="my-1 ml-4 list-disc space-y-0.5"><li>uno</li><li>dos</li></ul>'
    );
    expect(renderMessage('  - sangrado')).toBe(
      '<ul class="my-1 ml-4 list-disc space-y-0.5"><li>sangrado</li></ul>'
    );
  });

  it('conserva negrita, cursiva y código en línea', () => {
    expect(renderMessage('**fuerte**')).toBe('<p><strong>fuerte</strong></p>');
    expect(renderMessage('*suave*')).toBe('<p><em>suave</em></p>');
    expect(renderMessage('_suave_')).toBe('<p><em>suave</em></p>');
    expect(renderMessage('`npm run test`')).toBe(
      '<p><code class="rounded bg-slate-100 px-1 py-0.5 text-[0.85em]">npm run test</code></p>'
    );
  });

  it('conserva el cierre de la lista al volver a un párrafo', () => {
    expect(renderMessage('- uno\ntexto')).toBe(
      '<ul class="my-1 ml-4 list-disc space-y-0.5"><li>uno</li></ul><p>texto</p>'
    );
  });

  it('normaliza CRLF y tolera valores vacíos o nulos', () => {
    expect(renderMessage('uno\r\ndos')).toBe('<p>uno</p><p>dos</p>');
    // Una cadena vacía es una línea en blanco: el separador es el resultado
    // histórico y no debe cambiar.
    expect(renderMessage('')).toBe('<div class="h-2"></div>');
    expect(renderMessage(null)).toBe('<div class="h-2"></div>');
    expect(renderMessage(undefined)).toBe('<div class="h-2"></div>');
  });
});

describe('markdown: encabezados', () => {
  it('convierte los seis niveles ATX', () => {
    expect(renderMessage('# Uno')).toMatch(/^<h1 class="[^"]+">Uno<\/h1>$/);
    expect(renderMessage('## Dos')).toMatch(/^<h2 class="[^"]+">Dos<\/h2>$/);
    expect(renderMessage('### Tres')).toMatch(/^<h3 class="[^"]+">Tres<\/h3>$/);
    expect(renderMessage('#### Cuatro')).toMatch(/^<h4 class="[^"]+">Cuatro<\/h4>$/);
    expect(renderMessage('##### Cinco')).toMatch(/^<h5 class="[^"]+">Cinco<\/h5>$/);
    expect(renderMessage('###### Seis')).toMatch(/^<h6 class="[^"]+">Seis<\/h6>$/);
  });

  it('aplica el formato dentro del encabezado', () => {
    expect(renderMessage('## Pasos **clave**')).toContain('<strong>clave</strong>');
  });

  it('no convierte un hashtag sin espacio ni más de seis almohadillas', () => {
    expect(renderMessage('#hashtag')).toBe('<p>#hashtag</p>');
    expect(renderMessage('#######')).toBe('<p>#######</p>');
    expect(renderMessage('####### siete')).toBe('<p>####### siete</p>');
  });

  it('ignora los almohadillas que no están al principio de la línea', () => {
    expect(renderMessage('texto # Uno')).toBe('<p>texto # Uno</p>');
  });

  it('cierra la lista abierta antes de un encabezado', () => {
    expect(renderMessage('- uno\n# Dos')).toBe(
      '<ul class="my-1 ml-4 list-disc space-y-0.5"><li>uno</li></ul>' +
        '<h1 class="mt-4 mb-1.5 text-lg font-bold text-slate-800 first:mt-0">Dos</h1>'
    );
  });

  it('admite sangría antes de las almohadillas', () => {
    expect(renderMessage('  # Uno')).toMatch(/^<h1 /);
  });
});

describe('markdown: listas ordenadas', () => {
  it('agrupa los elementos consecutivos en una sola lista', () => {
    expect(renderMessage('1. Verificar\n2. Reiniciar\n3. Documentar')).toBe(
      '<ol class="my-1 ml-4 list-decimal space-y-0.5">' +
        '<li>Verificar</li><li>Reiniciar</li><li>Documentar</li></ol>'
    );
  });

  it('acepta el punto y el paréntesis como separadores', () => {
    expect(renderMessage('1) uno\n2) dos')).toContain('<ol');
    expect(renderMessage('1) uno\n2) dos')).toContain('<li>uno</li>');
  });

  it('admite sangría y formato en línea', () => {
    expect(renderMessage('  1. **Paso**')).toBe(
      '<ol class="my-1 ml-4 list-decimal space-y-0.5"><li><strong>Paso</strong></li></ol>'
    );
  });

  it('no mezcla una lista numerada con una de viñetas', () => {
    expect(renderMessage('1. uno\n- dos')).toBe(
      '<ol class="my-1 ml-4 list-decimal space-y-0.5"><li>uno</li></ol>' +
        '<ul class="my-1 ml-4 list-disc space-y-0.5"><li>dos</li></ul>'
    );
    expect(renderMessage('- uno\n2. dos')).toBe(
      '<ul class="my-1 ml-4 list-disc space-y-0.5"><li>uno</li></ul>' +
        '<ol class="my-1 ml-4 list-decimal space-y-0.5"><li>dos</li></ol>'
    );
  });

  it('cierra la lista numerada al volver a un párrafo', () => {
    expect(renderMessage('1. uno\ntexto')).toBe(
      '<ol class="my-1 ml-4 list-decimal space-y-0.5"><li>uno</li></ol><p>texto</p>'
    );
  });

  it('no interpreta como lista una línea con número pegado al texto', () => {
    expect(renderMessage('v1.5')).toBe('<p>v1.5</p>');
    expect(renderMessage('3.5 pulgadas')).toBe('<p>3.5 pulgadas</p>');
  });

  it('sí interpreta un año como elemento, igual que hace Markdown', () => {
    // Criterio documentado, no un descuido: `2024. Informe anual` es una lista
    // ordenada en cualquier Markdown estándar y el número se ve igual.
    expect(renderMessage('2024. Informe anual')).toBe(
      '<ol class="my-1 ml-4 list-decimal space-y-0.5"><li>Informe anual</li></ol>'
    );
  });

  it('deja sin lista un número sin contenido detrás', () => {
    expect(renderMessage('1.')).toBe('<p>1.</p>');
  });
});

describe('markdown: el HTML peligroso sigue escapado', () => {
  // Comprobar que la cadena NO contiene "onload" no sirve de nada: el texto
  // escapado lo contiene legítimamente. Lo que importa es qué elemento y qué
  // atributo acaba teniendo el DOM, así que se analiza el resultado.
  const ALLOWED_TAGS = new Set(['P', 'STRONG', 'EM', 'CODE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'DIV']);

  function inspect(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    const elements = [...host.querySelectorAll('*')];
    return {
      tags: elements.map((el) => el.tagName),
      attrs: elements.flatMap((el) => [...el.attributes].map((a) => a.name)),
      text: host.textContent,
      host,
    };
  }

  function expectNothingDangerous(html) {
    const { tags, attrs } = inspect(html);
    for (const tag of tags) {
      expect(ALLOWED_TAGS.has(tag), `etiqueta no permitida: ${tag}`).toBe(true);
    }
    for (const attr of attrs) {
      expect(attr, `atributo no permitido: ${attr}`).not.toMatch(/^on/i);
      expect(['href', 'src', 'style', 'srcdoc', 'formaction']).not.toContain(attr);
    }
    return attrs;
  }

  it('neutraliza una etiqueta de script', () => {
    expect(renderMessage('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'
    );
  });

  it('un img con onerror dentro de un encabezado no crea ningún elemento img', () => {
    const html = renderMessage('# <img src=x onerror=alert(1)>');
    expectNothingDangerous(html);
    expect(inspect(html).tags).not.toContain('IMG');
    expect(html).toContain('&lt;img');
  });

  it('un svg con onload dentro de un elemento de lista no crea ningún elemento svg', () => {
    const html = renderMessage('1. <svg/onload=alert(1)>');
    expectNothingDangerous(html);
    expect(inspect(html).tags).not.toContain('SVG');
  });

  it('un iframe dentro de una viñeta no crea ningún iframe', () => {
    const html = renderMessage('- <iframe src="javascript:alert(1)"></iframe>');
    expectNothingDangerous(html);
    expect(inspect(html).tags).not.toContain('IFRAME');
  });

  it('una etiqueta de cierre suelta no altera la estructura del documento', () => {
    const html = renderMessage('</h1></ul></div><h1>titulo');
    expectNothingDangerous(html);
  });

  it('las comillas que podrían cerrar un atributo quedan escapadas', () => {
    const html = renderMessage('# " onmouseover="alert(1)');
    expectNothingDangerous(html);
    expect(html).toContain('&quot;');
  });

  it('no genera href, src ni style a partir de un enlace Markdown', () => {
    const html = renderMessage('# [x](javascript:alert(1))\n1. https://x.test\n- <a href="/x">y</a>');
    expectNothingDangerous(html);
    // La sintaxis de enlace no se interpreta: se muestra tal cual.
    expect(inspect(html).text).toContain('[x](javascript:alert(1))');
  });

  it('no se inyecta ningún atributo al formatear el texto escapado', () => {
    const html = renderMessage('**<b>x</b>** _y_ `z`');
    expectNothingDangerous(html);
  });

  it('escapa ampersand una sola vez, sin romper el texto ya escapado', () => {
    expect(renderMessage('a &amp; b')).toBe('<p>a &amp;amp; b</p>');
    expect(renderMessage('a & b')).toBe('<p>a &amp; b</p>');
  });

  it('escapa también el apóstrofo, que podría cerrar un atributo con comillas simples', () => {
    // Hoy el renderizador solo usa literales propios, pero nada impide que un
    // título o un atributo future usen comillas simples. Este test falla si
    // alguien quita el escapado del apóstrofe.
    const html = renderMessage("' onfocus='alert(1)");
    expect(html).toContain('&#39;');
    expect(html).not.toContain("onfocus='");
  });
});

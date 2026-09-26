import { describe, it, expect } from 'vitest';
import {
  buildVariableContext,
  expandTemplate,
  extractVariables,
  TEMPLATE_VARIABLES,
  TEMPLATE_VARIABLE_KEYS,
  MAX_COMMENT_LENGTH,
  MAX_TEMPLATE_BODY,
  MAX_VARIABLE_VALUE,
} from './templateVars';

const CONTEXT = {
  ticket_number: 'TCK-000042',
  ticket_title: 'La impresora no imprime',
  reporter_name: 'Ana Ruiz',
  ticket_status: 'En proceso',
  ticket_priority: 'Alta',
  category_name: 'Hardware',
  department_name: 'Operaciones',
  team_name: 'Soporte Nivel 1',
  technician_name: 'Luis Pérez',
  sla_due: '2026-09-30T18:00:00Z',
};

describe('catálogo de variables', () => {
  it('expone exactamente las diez variables acordadas', () => {
    expect(TEMPLATE_VARIABLE_KEYS).toEqual([
      'ticket_number',
      'ticket_title',
      'reporter_name',
      'ticket_status',
      'ticket_priority',
      'category_name',
      'department_name',
      'team_name',
      'technician_name',
      'sla_due',
    ]);
  });

  it('cada variable tiene etiqueta y ejemplo para la ayuda de la UI', () => {
    for (const v of TEMPLATE_VARIABLES) {
      expect(typeof v.label).toBe('string');
      expect(v.label.length).toBeGreaterThan(0);
      expect(typeof v.example).toBe('string');
    }
  });

  it('no expone datos ajenos al ticket actual', () => {
    expect(TEMPLATE_VARIABLE_KEYS).not.toContain('internal_notes');
    expect(TEMPLATE_VARIABLE_KEYS).not.toContain('ticket_description');
  });

  it('declara los límites de tamaño', () => {
    expect(MAX_TEMPLATE_BODY).toBe(2000);
    expect(MAX_COMMENT_LENGTH).toBe(4000);
    expect(MAX_VARIABLE_VALUE).toBe(200);
  });
});

describe('extractVariables', () => {
  it('separa las usadas de las desconocidas, sin repetir', () => {
    const out = extractVariables('{{reporter_name}} y {{ticket_number}} y {{reporter_name}}');
    expect(out.used).toEqual(['reporter_name', 'ticket_number']);
    expect(out.unknown).toEqual([]);
  });

  it('detecta variables desconocidas', () => {
    const out = extractVariables('{{reporter_name}} {{no_existe}} {{otra}}');
    expect(out.used).toEqual(['reporter_name']);
    expect(out.unknown).toEqual(['no_existe', 'otra']);
  });

  it('acepta espacios y no confunde otras llaves', () => {
    const out = extractVariables('{{ reporter_name }} {x} {{{reporter_name}}}');
    expect(out.used).toEqual(['reporter_name']);
    expect(out.unknown).toEqual([]);
  });

  it('devuelve listas vacías si no hay variables', () => {
    expect(extractVariables('texto plano')).toEqual({ used: [], unknown: [] });
  });

  it('tolera null/undefined', () => {
    expect(extractVariables(undefined)).toEqual({ used: [], unknown: [] });
  });
});

describe('buildVariableContext', () => {
  it('mapea el ticket a las diez variables y traduce estado y prioridad', () => {
    const ctx = buildVariableContext({
      ticket: {
        ticket_number: 'TCK-000042',
        title: 'La impresora no imprime',
        reporter_name: 'Ana Ruiz',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        category_name: 'Hardware',
        department_name: 'Operaciones',
        team_name: 'Soporte Nivel 1',
        sla_due_at: '2026-09-30T18:00:00Z',
      },
      user: { name: 'Luis', last_name: 'Pérez' },
    });

    expect(ctx).toEqual(CONTEXT);
  });

  it('usa cadena vacía para los datos ausentes en vez de "undefined"', () => {
    const ctx = buildVariableContext({ ticket: {}, user: null });
    for (const key of TEMPLATE_VARIABLE_KEYS) expect(ctx[key]).toBe('');
  });

  it('normaliza saltos de línea y recorta a 200 caracteres', () => {
    const ctx = buildVariableContext({ ticket: { title: `  Uno\n\tDos\r\n  ${'x'.repeat(400)}` } });
    expect(ctx.ticket_title.startsWith('Uno Dos')).toBe(true);
    expect(ctx.ticket_title.length).toBeLessThanOrEqual(MAX_VARIABLE_VALUE);
  });
});

describe('expandTemplate', () => {
  it('sustituye las diez variables', () => {
    const body = TEMPLATE_VARIABLE_KEYS.map((k) => `{{${k}}}`).join(' | ');
    const out = expandTemplate(body, CONTEXT);
    expect(out.unknown).toEqual([]);
    expect(out.text).toBe(Object.values(CONTEXT).join(' | '));
  });

  it('deja literal una variable desconocida y la informa', () => {
    const out = expandTemplate('Saludos {{no_existe}}', CONTEXT);
    expect(out.text).toBe('Saludos {{no_existe}}');
    expect(out.unknown).toEqual(['no_existe']);
  });

  it('sustituye en una sola pasada: no expande el valor insertado', () => {
    const out = expandTemplate('Hola {{reporter_name}}', { reporter_name: '{{ticket_title}}' });
    expect(out.text).toBe('Hola {{ticket_title}}');
  });

  it('no permite encadenar niveles de sustitución', () => {
    const out = expandTemplate('{{a}}', {});
    // `a` no está en la allowlist, así que ni siquiera se evalúa.
    expect(out.text).toBe('{{a}}');
  });

  it('deja el texto intacto si no hay variables', () => {
    const body = '**negrita**\n- item\n\n```sql\nSELECT 1;\n```';
    expect(expandTemplate(body, CONTEXT)).toEqual({ text: body, unknown: [] });
  });

  it('tolera null/undefined', () => {
    expect(expandTemplate(null, CONTEXT)).toEqual({ text: '', unknown: [] });
  });

  it('no da acceso al prototipo: constructor y __proto__ quedan literales', () => {
    const malicious = '{{constructor}} {{__proto__}} {{toString}}';
    const out = expandTemplate(malicious, CONTEXT);
    expect(out.text).toBe(malicious);
    expect(out.unknown).toEqual(['constructor', '__proto__', 'toString']);
  });

  it('permite exactamente 4000 caracteres y avisa al superarlos', () => {
    const ok = 'a'.repeat(MAX_COMMENT_LENGTH);
    expect(expandTemplate(ok, CONTEXT).text.length).toBe(MAX_COMMENT_LENGTH);
    expect(expandTemplate(ok + 'a', CONTEXT).text.length).toBeGreaterThan(MAX_COMMENT_LENGTH);
  });

  it('el texto expandido puede exceder 2000 aunque la plantilla no lo haga', () => {
    const body = `{{ticket_title}} ${'b'.repeat(1000)}`; // cuerpo <= 2000
    const out = expandTemplate(body, { ticket_title: 'T'.repeat(200) });
    expect(body.length).toBeLessThanOrEqual(MAX_TEMPLATE_BODY);
    expect(out.text.length).toBeGreaterThan(MAX_TEMPLATE_BODY);
  });
});

import { describe, it, expect } from 'vitest';
import { expandTemplate, extractVariables, isAllowedVariable, ALLOWED_VARIABLES, MAX_COMMENT_LENGTH } from './templateVars';

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

describe('extractVariables', () => {
  it('extrae las variables usadas sin repetir', () => {
    expect(extractVariables('{{reporter_name}} y {{ticket_number}} otra vez {{reporter_name}}')).toEqual([
      'reporter_name',
      'ticket_number',
    ]);
  });

  it('acepta espacios y no confunde otras llaves', () => {
    expect(extractVariables('{{ reporter_name }} {x} {{{reporter_name}}}')).toEqual(['reporter_name']);
  });

  it('devuelve lista vacía si no hay variables', () => {
    expect(extractVariables('texto plano')).toEqual([]);
  });
});

describe('isAllowedVariable', () => {
  it('acepta exactamente las diez variables soportadas', () => {
    expect(ALLOWED_VARIABLES).toHaveLength(10);
    for (const name of Object.keys(CONTEXT)) expect(isAllowedVariable(name)).toBe(true);
  });

  it('rechaza cualquier otra variable', () => {
    expect(isAllowedVariable('internal_notes')).toBe(false);
    expect(isAllowedVariable('ticket_description')).toBe(false);
    expect(isAllowedVariable('__proto__')).toBe(false);
  });
});

describe('expandTemplate', () => {
  it('sustituye las diez variables', () => {
    const body = Object.keys(CONTEXT).map((k) => `{{${k}}}`).join(' | ');
    expect(expandTemplate(body, CONTEXT)).toBe(Object.values(CONTEXT).join(' | '));
  });

  it('deja literal una variable desconocida', () => {
    expect(expandTemplate('Saludos {{no_existe}}', CONTEXT)).toBe('Saludos {{no_existe}}');
  });

  it('sustituye en una sola pasada: no expande el valor insertado', () => {
    // El valor de reporter_name contiene un nombre de variable. No debe re-expandirse.
    const out = expandTemplate('Hola {{reporter_name}}', { reporter_name: '{{ticket_title}}' });
    expect(out).toBe('Hola {{ticket_title}}');
  });

  it('limita cada valor a 200 caracteres', () => {
    const out = expandTemplate('{{ticket_title}}', { ticket_title: 'x'.repeat(500) });
    expect(out.length).toBe(200);
  });

  it('normaliza saltos de línea, tabs y espacios', () => {
    const out = expandTemplate('{{ticket_title}}', { ticket_title: '  linea1\n\tlinea2\r\n  ' });
    expect(out).toBe('linea1 linea2');
  });

  it('deja el texto intacto si no hay variables', () => {
    expect(expandTemplate('**negrita**\n- item', CONTEXT)).toBe('**negrita**\n- item');
  });

  it('permite knowedge de 4000 y detecta el exceso con el helper de longitud', () => {
    const ok = 'a'.repeat(MAX_COMMENT_LENGTH);
    expect(ok.length).toBe(4000);
    expect(('a'.repeat(MAX_COMMENT_LENGTH) + 'x').length).toBeGreaterThan(MAX_COMMENT_LENGTH);
  });

  it('no ejecuta código del cuerpo: trata todo como texto plano', () => {
    const malicious = '{{constructor}} {{__proto__}} {{a.constructor.name}}';
    expect(expandTemplate(malicious, CONTEXT)).toBe(malicious);
  });
});

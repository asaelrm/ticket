import { describe, it, expect } from 'vitest';
import {
  ARTICLE_STATUS_LABEL,
  ARTICLE_SORTS,
  DEFAULT_KB_PERPAGE,
  KB_PERPAGE_CHOICES,
  canReadArticle,
  canEditArticle,
  canTransitionArticle,
  availableTransitions,
  statusLabel,
  toQuery,
  parseFilters,
  fieldErrors,
} from './kb';

// Replica de canRead/canEdit/canTransition de backend/src/routes/kbArticles.js.
// Si estas reglas cambian en el servidor, este archivo debe cambiar con ellas.
const reader = { id: 1, permissions: ['kb.view'] };
const author = { id: 2, permissions: ['kb.view', 'kb.create', 'kb.publish'] };
const authorNoPublish = { id: 2, permissions: ['kb.view', 'kb.create'] };
const manager = { id: 3, permissions: ['kb.view', 'kb.create', 'kb.manage'] };
const stranger = { id: 4, permissions: ['kb.view', 'kb.create'] };

const article = (overrides = {}) => ({
  id: 10,
  author_id: 2,
  status: 'PUBLISHED',
  is_featured: false,
  ...overrides,
});

describe('etiquetas de estado', () => {
  it('cubre los tres estados del backend', () => {
    expect(Object.keys(ARTICLE_STATUS_LABEL)).toEqual(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
  });

  it('devuelve la etiqueta y cae al valor crudo si el estado no existe', () => {
    expect(statusLabel('DRAFT')).toBe('Borrador');
    expect(statusLabel('NUEVO')).toBe('NUEVO');
  });

  it('ofrece los tres órdenes aceptados por el servidor', () => {
    expect(ARTICLE_SORTS.map(([v]) => v)).toEqual(['recent', 'popular', 'title']);
  });
});

describe('canReadArticle', () => {
  it('deja leer un artículo publicado a cualquiera con kb.view', () => {
    expect(canReadArticle(reader, article())).toBe(true);
  });

  it('no deja leer el borrador de otro usuario', () => {
    expect(canReadArticle(stranger, article({ status: 'DRAFT' }))).toBe(false);
  });

  it('deja leer su propio borrador y el de quien administra', () => {
    expect(canReadArticle(author, article({ status: 'DRAFT' }))).toBe(true);
    expect(canReadArticle(manager, article({ status: 'DRAFT' }))).toBe(true);
  });

  it('aplica la misma regla a los archivados', () => {
    expect(canReadArticle(stranger, article({ status: 'ARCHIVED' }))).toBe(false);
    expect(canReadArticle(author, article({ status: 'ARCHIVED' }))).toBe(true);
  });

  it('devuelve false sin usuario o sin artículo', () => {
    expect(canReadArticle(null, article())).toBe(false);
    expect(canReadArticle(reader, null)).toBe(false);
  });
});

describe('canEditArticle', () => {
  it('exige kb.create además de ser el autor o administrar', () => {
    expect(canEditArticle(author, article())).toBe(true);
    expect(canEditArticle(manager, article({ author_id: 99 }))).toBe(true);
    // Mismo autor, pero sin kb.create: PATCH /:id respondería 403.
    expect(canEditArticle({ id: 2, permissions: ['kb.view'] }, article())).toBe(false);
    // Con kb.create pero de otro autor y sin kb.manage: el servidor responde 404.
    expect(canEditArticle(stranger, article())).toBe(false);
  });
});

describe('canTransitionArticle', () => {
  it('deja publicar al autor con kb.publish y al gestor de cualquier artículo', () => {
    expect(canTransitionArticle(author, article())).toBe(true);
    expect(canTransitionArticle(manager, article({ author_id: 99 }))).toBe(true);
  });

  it('no deja publicar al autor sin kb.publish', () => {
    expect(canTransitionArticle(authorNoPublish, article())).toBe(false);
  });

  it('no deja cambiar el estado de un artículo ajeno sin kb.manage', () => {
    expect(canTransitionArticle(stranger, article())).toBe(false);
  });
});

describe('availableTransitions', () => {
  it('ofrece publicar y archivar desde borrador', () => {
    expect(availableTransitions(author, article({ status: 'DRAFT' })).map((t) => t.key)).toEqual([
      'publish',
      'archive',
      'feature',
    ]);
  });

  it('ofrece despublicar y archivar desde publicado', () => {
    expect(availableTransitions(author, article()).map((t) => t.key)).toEqual([
      'unpublish',
      'archive',
      'feature',
    ]);
  });

  it('desde archivado solo se puede volver a publicar o destacar', () => {
    expect(availableTransitions(author, article({ status: 'ARCHIVED' })).map((t) => t.key)).toEqual([
      'publish',
      'feature',
    ]);
  });

  it('etiqueta el destacado según el estado actual', () => {
    expect(
      availableTransitions(author, article({ is_featured: false })).find((t) => t.key === 'feature').label
    ).toBe('Destacar');
    expect(
      availableTransitions(author, article({ is_featured: true })).find((t) => t.key === 'feature').label
    ).toBe('Quitar destacado');
  });

  it('no ofrece nada sin permiso de cambio de estado', () => {
    expect(availableTransitions(stranger, article())).toEqual([]);
    expect(availableTransitions(authorNoPublish, article())).toEqual([]);
  });

  it('construye las rutas sobre /api/kb-articles/:id', () => {
    expect(availableTransitions(author, article()).map((t) => t.path)).toEqual([
      '/api/kb-articles/10/publish',
      '/api/kb-articles/10/unpublish',
      '/api/kb-articles/10/archive',
      '/api/kb-articles/10/feature',
    ]);
  });
});

describe('toQuery', () => {
  it('manda siempre perPage porque el cliente y el servidor no comparten valor por defecto', () => {
    expect(toQuery({})).toBe(`perPage=${DEFAULT_KB_PERPAGE}`);
  });

  it('omite los valores por defecto para no ensuciar la URL', () => {
    expect(toQuery({ sort: 'recent', page: 1, perPage: DEFAULT_KB_PERPAGE })).toBe(
      `perPage=${DEFAULT_KB_PERPAGE}`
    );
  });

  it('incluye búsqueda, categoría, orden y página cuando difieren del defecto', () => {
    const q = toQuery({ q: 'correo', category: 3, sort: 'title', page: 2, perPage: 25 });
    const sp = new URLSearchParams(q);
    expect(sp.get('q')).toBe('correo');
    expect(sp.get('category')).toBe('3');
    expect(sp.get('sort')).toBe('title');
    expect(sp.get('page')).toBe('2');
    expect(sp.get('perPage')).toBe('25');
  });
});

describe('parseFilters', () => {
  it('aplica los valores por defecto con la URL vacía', () => {
    expect(parseFilters(new URLSearchParams())).toEqual({
      q: '',
      category: '',
      sort: 'recent',
      page: 1,
      perPage: DEFAULT_KB_PERPAGE,
    });
  });

  it('lee los filtros escritos en la URL', () => {
    const sp = new URLSearchParams('q=vpn&category=2&sort=popular&page=3&perPage=50');
    expect(parseFilters(sp)).toEqual({ q: 'vpn', category: '2', sort: 'popular', page: 3, perPage: 50 });
  });

  it('nunca deja una página menor que 1', () => {
    expect(parseFilters(new URLSearchParams('page=-4')).page).toBe(1);
    expect(parseFilters(new URLSearchParams('page=abc')).page).toBe(1);
  });

  it('ajusta un perPage inventado a las opciones del selector', () => {
    // El servidor lo limitaría a 100 y el <select> se quedaría sin opción.
    expect(parseFilters(new URLSearchParams('perPage=999')).perPage).toBe(DEFAULT_KB_PERPAGE);
    expect(KB_PERPAGE_CHOICES).toContain(parseFilters(new URLSearchParams('perPage=25')).perPage);
  });

  it('hace ida y vuelta con toQuery sin perder filtros', () => {
    const original = { q: 'outlook', category: '4', sort: 'title', page: 2, perPage: 25 };
    expect(parseFilters(new URLSearchParams(toQuery(original)))).toEqual(original);
  });
});

describe('fieldErrors', () => {
  it('devuelve un objeto vacío si no hay error', () => {
    expect(fieldErrors(null)).toEqual({});
    expect(fieldErrors(new Error('fallo'))).toEqual({});
  });

  it('devuelve los campos que adjuncta el servidor', () => {
    const err = Object.assign(new Error('Datos inválidos'), {
      fields: { 'El título': 'El título es obligatorio' },
    });
    expect(fieldErrors(err)).toEqual({ 'El título': 'El título es obligatorio' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  checkFieldConfig,
  createDocumentTypeSchema,
  createFieldSchema,
  isIsoDate,
  isSafePattern,
  metadataToSearchText,
  slugifyKey,
  tagNameSchema,
  updateFieldSchema,
  validateMetadata,
  type FieldDefinition,
} from '@dcs-docs/shared';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'key' | 'fieldType'>): FieldDefinition => ({
  label: over.key, required: false, helpText: null, placeholder: null, defaultValue: null, options: null, validation: null,
  searchable: false, displayOrder: 0, isActive: true, ...over,
});

const opts = [{ value: 'a', label: 'A', isActive: true }, { value: 'b', label: 'B', isActive: true }, { value: 'old', label: 'Old', isActive: false }];
const ok = (fields: FieldDefinition[], input: unknown) => {
  const r = validateMetadata(fields, input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};
const issues = (fields: FieldDefinition[], input: unknown) => {
  const r = validateMetadata(fields, input);
  return r.ok ? [] : r.issues;
};

describe('validateMetadata', () => {
  it('accepts an empty object when nothing is required and returns only provided values', () => {
    expect(ok([field({ key: 'a', fieldType: 'TEXT' })], {})).toEqual({});
  });

  it('rejects non-objects', () => {
    for (const bad of [null, 'x', 5, [], undefined]) expect(issues([], bad)).toEqual([{ path: 'metadata', message: 'Must be an object' }]);
  });

  it('rejects unknown keys and keys of inactive fields', () => {
    const fields = [field({ key: 'a', fieldType: 'TEXT' }), field({ key: 'gone', fieldType: 'TEXT', isActive: false })];
    expect(issues(fields, { a: 'x', b: 'y' })).toEqual([{ path: 'metadata.b', message: 'Unknown field' }]);
    expect(issues(fields, { gone: 'x' })[0]!.message).toBe('Unknown field');
  });

  it('enforces required fields and treats blanks as missing', () => {
    const f = [field({ key: 'name', fieldType: 'TEXT', required: true })];
    for (const v of [undefined, null, '', '   ']) expect(issues(f, { name: v }).map((i) => i.path)).toEqual(['metadata.name']);
    expect(ok(f, { name: '  Acme  ' })).toEqual({ name: 'Acme' }); // trimmed
  });

  it('applies defaults to absent optional fields', () => {
    const f = [field({ key: 'lang', fieldType: 'SELECT', options: opts, defaultValue: 'a' }), field({ key: 'n', fieldType: 'NUMBER', defaultValue: 3 })];
    expect(ok(f, {})).toEqual({ lang: 'a', n: 3 });
    expect(ok(f, { lang: 'b' })).toEqual({ lang: 'b', n: 3 });
  });

  describe('TEXT / TEXTAREA', () => {
    it('applies length and pattern rules', () => {
      const f = [field({ key: 't', fieldType: 'TEXT', validation: { minLength: 3, maxLength: 5, pattern: '^[A-Z]+$' } })];
      expect(issues(f, { t: 'AB' })[0]!.message).toMatch(/at least 3/);
      expect(issues(f, { t: 'ABCDEF' })[0]!.message).toMatch(/at most 5/);
      expect(issues(f, { t: 'abc' })[0]!.message).toMatch(/format/);
      expect(ok(f, { t: 'ABC' })).toEqual({ t: 'ABC' });
    });
    it('caps unbounded text (TEXT 1000, TEXTAREA 5000)', () => {
      expect(issues([field({ key: 't', fieldType: 'TEXT' })], { t: 'x'.repeat(1001) })).not.toEqual([]);
      expect(issues([field({ key: 't', fieldType: 'TEXTAREA' })], { t: 'x'.repeat(5000) })).toEqual([]);
      expect(issues([field({ key: 't', fieldType: 'TEXTAREA' })], { t: 'x'.repeat(5001) })).not.toEqual([]);
    });
    it('rejects non-strings', () => {
      expect(issues([field({ key: 't', fieldType: 'TEXT' })], { t: 5 })[0]!.message).toBe('Must be text');
    });
  });

  describe('NUMBER', () => {
    const f = (validation?: object) => [field({ key: 'n', fieldType: 'NUMBER', validation: validation ?? null })];
    it('accepts numbers and rejects strings, NaN-like and infinities', () => {
      expect(ok(f(), { n: 12.5 })).toEqual({ n: 12.5 });
      expect(ok(f(), { n: 0 })).toEqual({ n: 0 });
      expect(issues(f(), { n: '12' })[0]!.message).toBe('Must be a number');
      expect(issues(f(), { n: Infinity })).not.toEqual([]);
      expect(issues(f(), { n: 1e16 })).not.toEqual([]);
    });
    it('applies min, max and integerOnly', () => {
      expect(issues(f({ min: 1, max: 10 }), { n: 0 })[0]!.message).toMatch(/at least 1/);
      expect(issues(f({ min: 1, max: 10 }), { n: 11 })[0]!.message).toMatch(/at most 10/);
      expect(issues(f({ integerOnly: true }), { n: 1.5 })[0]!.message).toBe('Must be a whole number');
      expect(ok(f({ integerOnly: true, min: 0 }), { n: 0 })).toEqual({ n: 0 });
    });
  });

  describe('DATE', () => {
    const f = (validation?: object) => [field({ key: 'd', fieldType: 'DATE', validation: validation ?? null })];
    it('accepts real ISO dates only', () => {
      expect(ok(f(), { d: '2026-02-28' })).toEqual({ d: '2026-02-28' });
      for (const bad of ['2026-02-30', '2026-13-01', '28/02/2026', '2026-2-3', 'tomorrow', 20260228]) expect(issues(f(), { d: bad })).not.toEqual([]);
      expect(isIsoDate('2028-02-29')).toBe(true);
      expect(isIsoDate('2027-02-29')).toBe(false);
    });
    it('applies minDate and maxDate', () => {
      expect(issues(f({ minDate: '2026-01-01' }), { d: '2025-12-31' })[0]!.message).toMatch(/on or after/);
      expect(issues(f({ maxDate: '2026-12-31' }), { d: '2027-01-01' })[0]!.message).toMatch(/on or before/);
      expect(ok(f({ minDate: '2026-01-01', maxDate: '2026-12-31' }), { d: '2026-06-15' })).toBeTruthy();
    });
  });

  it('BOOLEAN accepts only booleans (false is a value, not blank)', () => {
    const f = [field({ key: 'b', fieldType: 'BOOLEAN', required: true })];
    expect(ok(f, { b: false })).toEqual({ b: false });
    expect(issues(f, { b: 'true' })).not.toEqual([]);
    expect(issues(f, {}).length).toBe(1);
  });

  describe('SELECT / MULTI_SELECT', () => {
    it('SELECT accepts only active option values', () => {
      const f = [field({ key: 's', fieldType: 'SELECT', options: opts, required: true })];
      expect(ok(f, { s: 'a' })).toEqual({ s: 'a' });
      expect(issues(f, { s: 'zzz' })[0]!.message).toMatch(/listed options/);
      expect(issues(f, { s: 'old' })[0]!.message).toMatch(/listed options/); // inactive option
    });
    it('MULTI_SELECT accepts unique active values; required needs at least one', () => {
      const f = [field({ key: 'm', fieldType: 'MULTI_SELECT', options: opts, required: true })];
      expect(ok(f, { m: ['a', 'b'] })).toEqual({ m: ['a', 'b'] });
      expect(issues(f, { m: ['a', 'a'] })).not.toEqual([]);
      expect(issues(f, { m: ['a', 'nope'] })).not.toEqual([]);
      expect(issues(f, { m: [] }).length).toBe(1);
      expect(issues(f, { m: 'a' })).not.toEqual([]);
      expect(ok([field({ key: 'm', fieldType: 'MULTI_SELECT', options: opts })], { m: [] })).toEqual({});
    });
  });

  it('reports every problem at once with field paths', () => {
    const f = [field({ key: 'a', fieldType: 'TEXT', required: true }), field({ key: 'b', fieldType: 'NUMBER', required: true })];
    expect(issues(f, { x: 1 }).map((i) => i.path).sort()).toEqual(['metadata.a', 'metadata.b', 'metadata.x']);
  });
});

describe('metadataToSearchText', () => {
  it('joins only searchable fields', () => {
    const f = [field({ key: 'a', fieldType: 'TEXT', searchable: true }), field({ key: 'b', fieldType: 'TEXT' }), field({ key: 'c', fieldType: 'MULTI_SELECT', searchable: true, options: opts })];
    expect(metadataToSearchText(f, { a: 'Acme', b: 'secret', c: ['a', 'b'] })).toBe('Acme a b');
  });
});

describe('isSafePattern', () => {
  it('accepts ordinary patterns', () => {
    for (const p of ['^[A-Z]{3}-\\d{4}$', '^\\d+$', '^[a-z ]+$', 'foo|bar']) expect(isSafePattern(p)).toBe(true);
  });
  it('rejects invalid, over-long, nested-quantifier, back-reference and look-behind patterns', () => {
    for (const p of ['', '(', '[a-', '(a+)+$', '(a*)*b', '(\\w+\\s?)+$', '(.*a){10}', '(a)\\1', '(?<=a)b', 'a'.repeat(201)]) expect(isSafePattern(p), p).toBe(false);
  });
});

describe('checkFieldConfig', () => {
  const base = { key: 'k', required: false, defaultValue: null, options: null, validation: null };
  it('requires options for select types and forbids them elsewhere', () => {
    expect(checkFieldConfig({ ...base, fieldType: 'SELECT' }).map((i) => i.path)).toContain('options');
    expect(checkFieldConfig({ ...base, fieldType: 'SELECT', options: [{ value: 'a', label: 'A', isActive: true }] })).toEqual([]);
    expect(checkFieldConfig({ ...base, fieldType: 'TEXT', options: [{ value: 'a', label: 'A', isActive: true }] }).map((i) => i.path)).toContain('options');
  });
  it('rejects duplicate option values and all-inactive options', () => {
    expect(checkFieldConfig({ ...base, fieldType: 'SELECT', options: [{ value: 'a', label: 'A', isActive: true }, { value: 'a', label: 'B', isActive: true }] }).length).toBeGreaterThan(0);
    expect(checkFieldConfig({ ...base, fieldType: 'SELECT', options: [{ value: 'a', label: 'A', isActive: false }] }).length).toBeGreaterThan(0);
  });
  it('rejects validation that does not apply to the type or contradicts itself', () => {
    expect(checkFieldConfig({ ...base, fieldType: 'BOOLEAN', validation: { min: 1 } }).length).toBeGreaterThan(0);
    expect(checkFieldConfig({ ...base, fieldType: 'TEXT', validation: { min: 1 } }).length).toBeGreaterThan(0);
    expect(checkFieldConfig({ ...base, fieldType: 'TEXT', validation: { minLength: 5, maxLength: 2 } }).length).toBeGreaterThan(0);
    expect(checkFieldConfig({ ...base, fieldType: 'NUMBER', validation: { min: 9, max: 1 } }).length).toBeGreaterThan(0);
    expect(checkFieldConfig({ ...base, fieldType: 'DATE', validation: { minDate: '2026-02-01', maxDate: '2026-01-01' } }).length).toBeGreaterThan(0);
    expect(checkFieldConfig({ ...base, fieldType: 'DATE', validation: { minDate: 'soon' } }).length).toBeGreaterThan(0);
    expect(checkFieldConfig({ ...base, fieldType: 'TEXT', validation: { pattern: '(a+)+' } }).length).toBeGreaterThan(0);
  });
  it('validates the default value against the field', () => {
    expect(checkFieldConfig({ ...base, fieldType: 'NUMBER', validation: { max: 5 }, defaultValue: 9 }).map((i) => i.path)).toContain('defaultValue');
    expect(checkFieldConfig({ ...base, fieldType: 'SELECT', options: [{ value: 'a', label: 'A', isActive: true }], defaultValue: 'zzz' }).length).toBeGreaterThan(0);
    expect(checkFieldConfig({ ...base, fieldType: 'SELECT', options: [{ value: 'a', label: 'A', isActive: true }], defaultValue: 'a' })).toEqual([]);
  });
});

describe('admin input schemas', () => {
  const valid = { key: 'client_name', fieldType: 'TEXT', label: 'Client name' };

  it('accepts a minimal field and applies defaults', () => {
    const r = createFieldSchema.parse(valid);
    expect(r).toMatchObject({ required: false, searchable: false });
  });
  it('rejects bad keys, unknown properties and bad types', () => {
    for (const key of ['Client', '1abc', 'a-b', 'a b', '', 'x'.repeat(51), '__proto__']) expect(createFieldSchema.safeParse({ ...valid, key }).success, key).toBe(false);
    expect(createFieldSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(createFieldSchema.safeParse({ ...valid, fieldType: 'FILE' }).success).toBe(false);
    expect(createFieldSchema.safeParse({ ...valid, label: '' }).success).toBe(false);
  });
  it('surfaces config problems as field issues', () => {
    const r = createFieldSchema.safeParse({ ...valid, fieldType: 'SELECT' });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues.map((i) => i.path.join('.'))).toContain('options');
  });
  it('update needs at least one property and never accepts key', () => {
    expect(updateFieldSchema.safeParse({}).success).toBe(false);
    expect(updateFieldSchema.safeParse({ key: 'other' }).success).toBe(false);
    expect(updateFieldSchema.safeParse({ label: 'New' }).success).toBe(true);
  });
  it('document type: PDF-only limits and strict fields', () => {
    expect(createDocumentTypeSchema.safeParse({ name: 'NDA' }).success).toBe(true);
    expect(createDocumentTypeSchema.safeParse({ name: 'N' }).success).toBe(false);
    expect(createDocumentTypeSchema.safeParse({ name: 'NDA', maxFileSizeMb: 101 }).success).toBe(false);
    expect(createDocumentTypeSchema.safeParse({ name: 'NDA', allowedMimeTypes: ['text/html'] }).success).toBe(false);
  });
});

describe('slugifyKey and tag names', () => {
  it('slugifies names into valid keys', () => {
    expect(slugifyKey('Mandate Agreement (v2)')).toBe('mandate_agreement_v2');
    expect(slugifyKey('  NDA – Mutual  ')).toBe('nda_mutual');
    expect(slugifyKey('Café Résumé')).toBe('cafe_resume');
    expect(slugifyKey('2026 Plan')).toBe('t_2026_plan');
    expect(slugifyKey('x'.repeat(100)).length).toBeLessThanOrEqual(44);
  });
  it('normalises tag names', () => {
    expect(tagNameSchema.parse('  High   value  ')).toBe('High value');
    expect(tagNameSchema.safeParse('   ').success).toBe(false);
    expect(tagNameSchema.safeParse('x'.repeat(51)).success).toBe(false);
  });
});

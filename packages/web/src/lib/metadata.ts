import type { FieldDefinition, Issue } from '../types';

// Mirrors the rules of packages/shared/src/metadata.ts validateMetadata so forms can show errors early.
// The API stays authoritative and its `details` are mapped back onto the same fields.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const REQUIRED = 'This field is required';
const blank = (x: unknown) => x === undefined || x === null || x === '' || (Array.isArray(x) && x.length === 0);

function checkOne(f: FieldDefinition, value: unknown): string | null {
  const v = f.validation ?? {};
  switch (f.fieldType) {
    case 'TEXT':
    case 'TEXTAREA': {
      if (typeof value !== 'string') return 'Must be text';
      const s = value.trim();
      const hardMax = f.fieldType === 'TEXT' ? 1000 : 5000;
      if (f.required && s.length === 0) return REQUIRED;
      if (v.minLength !== undefined && s.length < v.minLength) return `Use at least ${v.minLength} characters`;
      const max = Math.min(v.maxLength ?? hardMax, hardMax);
      if (s.length > max) return `Use at most ${max} characters`;
      if (v.pattern && s) {
        try {
          if (!new RegExp(v.pattern, 'u').test(s)) return 'Does not match the required format';
        } catch {
          /* server decides */
        }
      }
      return null;
    }
    case 'NUMBER': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number';
      if (v.integerOnly && !Number.isInteger(value)) return 'Must be a whole number';
      if (v.min !== undefined && value < v.min) return `Must be at least ${v.min}`;
      if (v.max !== undefined && value > v.max) return `Must be at most ${v.max}`;
      return null;
    }
    case 'DATE': {
      if (typeof value !== 'string' || !isIsoDate(value)) return 'Must be a valid date (YYYY-MM-DD)';
      if (v.minDate && value < v.minDate) return `Must be on or after ${v.minDate}`;
      if (v.maxDate && value > v.maxDate) return `Must be on or before ${v.maxDate}`;
      return null;
    }
    case 'BOOLEAN':
      return typeof value === 'boolean' ? null : 'Must be true or false';
    case 'SELECT': {
      const ok = (f.options ?? []).filter((o) => o.isActive).map((o) => o.value);
      return typeof value === 'string' && ok.includes(value) ? null : 'Choose one of the listed options';
    }
    case 'MULTI_SELECT': {
      const ok = (f.options ?? []).filter((o) => o.isActive).map((o) => o.value);
      if (!Array.isArray(value) || !value.every((x) => typeof x === 'string' && ok.includes(x))) return 'Choose from the listed options';
      return new Set(value).size === value.length ? null : 'Duplicate options';
    }
  }
}

/** Returns issues keyed `metadata.<key>`; empty means valid. Only active fields are checked. */
export function validateMetadataLocal(fields: readonly FieldDefinition[], input: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  for (const f of fields.filter((x) => x.isActive)) {
    const v = input[f.key];
    if (blank(v)) {
      if (f.required) issues.push({ path: `metadata.${f.key}`, message: REQUIRED });
      continue;
    }
    const m = checkOne(f, v);
    if (m) issues.push({ path: `metadata.${f.key}`, message: m });
  }
  return issues;
}

/** Drops blank optional values so the API never sees "" for a number or date. */
export function cleanMetadata(fields: readonly FieldDefinition[], input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields.filter((x) => x.isActive)) {
    const v = input[f.key];
    if (!blank(v)) out[f.key] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

/** Initial form values from stored metadata and defaults. */
export function initialMetadata(fields: readonly FieldDefinition[], stored: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields.filter((x) => x.isActive)) {
    if (stored[f.key] !== undefined) out[f.key] = stored[f.key];
    else if (f.defaultValue !== null && f.defaultValue !== undefined) out[f.key] = f.defaultValue;
  }
  return out;
}

export function slugifyKey(label: string): string {
  const base = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 49);
  return /^[a-z]/.test(base) ? base : base ? `f_${base}`.slice(0, 49) : '';
}

export function displayValue(f: FieldDefinition, v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (f.fieldType === 'BOOLEAN') return v ? 'Yes' : 'No';
  if (f.fieldType === 'SELECT') return f.options?.find((o) => o.value === v)?.label ?? String(v);
  if (f.fieldType === 'MULTI_SELECT' && Array.isArray(v)) return v.map((x) => f.options?.find((o) => o.value === x)?.label ?? String(x)).join(', ');
  return String(v);
}

import { z, type ZodType } from 'zod';

/**
 * Dynamic metadata: admins define fields per document type at runtime; a Zod schema is built from the active
 * fields and validates the values. The same code runs in the API (authoritative) and in the browser (convenience).
 */
export const FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const MAX_FIELDS_PER_TYPE = 50;
export const MAX_OPTIONS_PER_FIELD = 100;
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

const DEFAULT_TEXT_MAX = 1000;
const DEFAULT_TEXTAREA_MAX = 5000;
const NUMBER_LIMIT = 1e15;

export interface FieldOption {
  value: string;
  label: string;
  isActive: boolean;
}

export interface FieldValidation {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  integerOnly?: boolean;
  minDate?: string;
  maxDate?: string;
}

export interface FieldDefinition {
  id?: string;
  key: string;
  label: string;
  fieldType: FieldType;
  required: boolean;
  helpText: string | null;
  placeholder: string | null;
  defaultValue: unknown;
  options: FieldOption[] | null;
  validation: FieldValidation | null;
  searchable: boolean;
  displayOrder: number;
  isActive: boolean;
}

export const isSelectType = (t: FieldType) => t === 'SELECT' || t === 'MULTI_SELECT';
export const isTextType = (t: FieldType) => t === 'TEXT' || t === 'TEXTAREA';

/** Rejects patterns that are too long, do not compile, or can backtrack catastrophically in common shapes. */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 200) return false;
  try {
    new RegExp(pattern, 'u');
  } catch {
    return false;
  }
  if (/\\[1-9]|\(\?<[=!]/.test(pattern)) return false; // back-references and look-behind
  if (/\([^()]*[+*{][^()]*\)[+*{]/.test(pattern)) return false; // nested quantifier, e.g. (a+)+
  return true;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const REQUIRED = 'This field is required';

function valueSchema(f: FieldDefinition): ZodType {
  const v = f.validation ?? {};
  switch (f.fieldType) {
    case 'TEXT':
    case 'TEXTAREA': {
      const hardMax = f.fieldType === 'TEXT' ? DEFAULT_TEXT_MAX : DEFAULT_TEXTAREA_MAX;
      let s = z.string({ error: (i) => (i.input === undefined ? REQUIRED : 'Must be text') }).trim();
      if (f.required) s = s.min(1, REQUIRED);
      if (v.minLength !== undefined) s = s.min(v.minLength, `Use at least ${v.minLength} characters`);
      s = s.max(Math.min(v.maxLength ?? hardMax, hardMax), `Use at most ${Math.min(v.maxLength ?? hardMax, hardMax)} characters`);
      if (v.pattern && isSafePattern(v.pattern)) {
        const re = new RegExp(v.pattern, 'u');
        return s.refine((x) => x === '' || re.test(x), 'Does not match the required format');
      }
      return s;
    }
    case 'NUMBER': {
      let s = z.number({ error: (i) => (i.input === undefined ? REQUIRED : 'Must be a number') });
      s = v.integerOnly ? s.int('Must be a whole number') : s;
      s = s.min(Math.max(v.min ?? -NUMBER_LIMIT, -NUMBER_LIMIT), `Must be at least ${v.min ?? -NUMBER_LIMIT}`);
      return s.max(Math.min(v.max ?? NUMBER_LIMIT, NUMBER_LIMIT), `Must be at most ${v.max ?? NUMBER_LIMIT}`);
    }
    case 'DATE': {
      const s = z.string({ error: (i) => (i.input === undefined ? REQUIRED : 'Must be a date (YYYY-MM-DD)') }).refine(isIsoDate, 'Must be a valid date (YYYY-MM-DD)');
      return s
        .refine((x) => !v.minDate || x >= v.minDate, `Must be on or after ${v.minDate}`)
        .refine((x) => !v.maxDate || x <= v.maxDate, `Must be on or before ${v.maxDate}`);
    }
    case 'BOOLEAN':
      return z.boolean({ error: (i) => (i.input === undefined ? REQUIRED : 'Must be true or false') });
    case 'SELECT': {
      const values = (f.options ?? []).filter((o) => o.isActive).map((o) => o.value);
      return z.string({ error: (i) => (i.input === undefined ? REQUIRED : 'Choose one option') }).refine((x) => values.includes(x), 'Choose one of the listed options');
    }
    case 'MULTI_SELECT': {
      const values = (f.options ?? []).filter((o) => o.isActive).map((o) => o.value);
      const arr = z
        .array(z.string(), { error: (i) => (i.input === undefined ? REQUIRED : 'Choose from the listed options') })
        .max(values.length || 1, 'Too many options chosen')
        .refine((a) => new Set(a).size === a.length, 'Duplicate options')
        .refine((a) => a.every((x) => values.includes(x)), 'Choose from the listed options');
      return f.required ? arr.min(1, REQUIRED) : arr;
    }
  }
}

/** Blank strings, nulls and empty arrays count as "not provided". */
function isBlank(x: unknown): boolean {
  return x === undefined || x === null || x === '' || (Array.isArray(x) && x.length === 0);
}

export interface MetadataIssue {
  path: string;
  message: string;
}

export type MetadataResult = { ok: true; value: Record<string, unknown> } | { ok: false; issues: MetadataIssue[] };

/**
 * Validates `input` against the ACTIVE fields of a type. Unknown keys (including inactive fields) are rejected,
 * required fields must be present, defaults fill absent optional fields, and optional blanks are dropped.
 */
export function validateMetadata(fields: readonly FieldDefinition[], input: unknown): MetadataResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ path: 'metadata', message: 'Must be an object' }] };
  }
  const raw = input as Record<string, unknown>;
  const active = fields.filter((f) => f.isActive);
  const known = new Set(active.map((f) => f.key));
  const issues: MetadataIssue[] = [];

  for (const key of Object.keys(raw)) {
    if (!known.has(key)) issues.push({ path: `metadata.${key}`, message: 'Unknown field' });
  }

  const out: Record<string, unknown> = {};
  for (const f of active) {
    let value = raw[f.key];
    if (isBlank(value) && f.defaultValue !== null && f.defaultValue !== undefined) value = f.defaultValue;
    if (isBlank(value)) {
      if (f.required) issues.push({ path: `metadata.${f.key}`, message: REQUIRED });
      continue;
    }
    const r = valueSchema(f).safeParse(value);
    if (r.success) out[f.key] = r.data;
    else for (const i of r.error.issues) issues.push({ path: `metadata.${f.key}`, message: i.message });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
}

/** Value of a stored field rendered as text (for search indexing and list views). */
export function metadataToSearchText(fields: readonly FieldDefinition[], metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (!f.searchable) continue;
    const v = metadata[f.key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) parts.push(v.join(' '));
    else parts.push(String(v));
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Admin input: defining and editing fields and types
// ---------------------------------------------------------------------------------------------------------------

const optionSchema = z.strictObject({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  isActive: z.boolean().default(true),
});

const validationSchema = z.strictObject({
  minLength: z.number().int().min(0).max(DEFAULT_TEXTAREA_MAX).optional(),
  maxLength: z.number().int().min(1).max(DEFAULT_TEXTAREA_MAX).optional(),
  pattern: z.string().max(200).optional(),
  min: z.number().min(-NUMBER_LIMIT).max(NUMBER_LIMIT).optional(),
  max: z.number().min(-NUMBER_LIMIT).max(NUMBER_LIMIT).optional(),
  integerOnly: z.boolean().optional(),
  minDate: z.string().optional(),
  maxDate: z.string().optional(),
});

const ALLOWED_VALIDATION_KEYS: Record<FieldType, (keyof FieldValidation)[]> = {
  TEXT: ['minLength', 'maxLength', 'pattern'],
  TEXTAREA: ['minLength', 'maxLength', 'pattern'],
  NUMBER: ['min', 'max', 'integerOnly'],
  DATE: ['minDate', 'maxDate'],
  BOOLEAN: [],
  SELECT: [],
  MULTI_SELECT: [],
};

/** Consistency rules between the type of a field and the rest of its configuration. Returns problems; empty = fine. */
export function checkFieldConfig(
  f: Pick<FieldDefinition, 'fieldType' | 'options' | 'validation' | 'defaultValue' | 'required'> & { key: string }
): MetadataIssue[] {
  const issues: MetadataIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (isSelectType(f.fieldType)) {
    if (!f.options || f.options.length === 0) add('options', 'Add at least one option');
    else {
      if (f.options.length > MAX_OPTIONS_PER_FIELD) add('options', `At most ${MAX_OPTIONS_PER_FIELD} options`);
      if (new Set(f.options.map((o) => o.value)).size !== f.options.length) add('options', 'Option values must be unique');
      if (!f.options.some((o) => o.isActive)) add('options', 'At least one option must be active');
    }
  } else if (f.options && f.options.length > 0) {
    add('options', 'Options are only allowed for select fields');
  }

  const v = f.validation ?? {};
  const allowed = new Set<string>(ALLOWED_VALIDATION_KEYS[f.fieldType]);
  for (const k of Object.keys(v)) if (!allowed.has(k)) add(`validation.${k}`, `Not applicable to ${f.fieldType} fields`);
  if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) add('validation.minLength', 'Must not exceed the maximum length');
  if (v.min !== undefined && v.max !== undefined && v.min > v.max) add('validation.min', 'Must not exceed the maximum');
  if (v.pattern !== undefined && !isSafePattern(v.pattern)) add('validation.pattern', 'Not a valid or safe pattern');
  for (const k of ['minDate', 'maxDate'] as const) if (v[k] !== undefined && !isIsoDate(v[k]!)) add(`validation.${k}`, 'Must be a valid date (YYYY-MM-DD)');
  if (v.minDate && v.maxDate && v.minDate > v.maxDate) add('validation.minDate', 'Must not be after the maximum date');

  if (f.defaultValue !== null && f.defaultValue !== undefined && issues.length === 0) {
    const probe: FieldDefinition = {
      key: f.key, label: 'x', fieldType: f.fieldType, required: f.required, helpText: null, placeholder: null,
      defaultValue: null, options: f.options, validation: f.validation, searchable: false, displayOrder: 0, isActive: true,
    };
    const r = validateMetadata([probe], { [f.key]: f.defaultValue });
    if (!r.ok) for (const i of r.issues) add('defaultValue', i.message);
  }
  return issues;
}

const fieldShape = {
  label: z.string().trim().min(1).max(100),
  required: z.boolean(),
  helpText: z.string().trim().max(300).nullable(),
  placeholder: z.string().trim().max(100).nullable(),
  defaultValue: z.unknown(),
  options: z.array(optionSchema).max(MAX_OPTIONS_PER_FIELD).nullable(),
  validation: validationSchema.nullable(),
  searchable: z.boolean(),
  displayOrder: z.number().int().min(0).max(10_000),
  isActive: z.boolean(),
};

export const createFieldSchema = z
  .strictObject({
    key: z.string().regex(FIELD_KEY_PATTERN, 'Use lower-case letters, digits and _, starting with a letter (max 50)'),
    fieldType: z.enum(FIELD_TYPES),
    label: fieldShape.label,
    required: fieldShape.required.default(false),
    helpText: fieldShape.helpText.optional(),
    placeholder: fieldShape.placeholder.optional(),
    defaultValue: fieldShape.defaultValue.optional(),
    options: fieldShape.options.optional(),
    validation: fieldShape.validation.optional(),
    searchable: fieldShape.searchable.default(false),
    displayOrder: fieldShape.displayOrder.optional(),
  })
  .superRefine((f, ctx) => {
    for (const i of checkFieldConfig({ ...f, options: f.options ?? null, validation: f.validation ?? null, defaultValue: f.defaultValue ?? null })) {
      ctx.addIssue({ code: 'custom', path: i.path.split('.'), message: i.message });
    }
  });
export type CreateFieldInput = z.output<typeof createFieldSchema>;

/** Every property optional; key is never editable here (immutable). `fieldType` is only accepted while no documents exist. */
export const updateFieldSchema = z
  .strictObject({
    fieldType: z.enum(FIELD_TYPES).optional(),
    label: fieldShape.label.optional(),
    required: fieldShape.required.optional(),
    helpText: fieldShape.helpText.optional(),
    placeholder: fieldShape.placeholder.optional(),
    defaultValue: fieldShape.defaultValue.optional(),
    options: fieldShape.options.optional(),
    validation: fieldShape.validation.optional(),
    searchable: fieldShape.searchable.optional(),
    displayOrder: fieldShape.displayOrder.optional(),
    isActive: fieldShape.isActive.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one property to change');
export type UpdateFieldInput = z.output<typeof updateFieldSchema>;

export const reorderFieldsSchema = z.strictObject({ fieldIds: z.array(z.uuid()).min(1).max(MAX_FIELDS_PER_TYPE) });

// Document types

export const ALLOWED_MIME_TYPES = ['application/pdf'] as const; // MVP: PDF only

const typeShape = {
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable(),
  maxFileSizeMb: z.number().int().min(1).max(100),
  retentionYears: z.number().int().min(0).max(100).nullable(),
  isActive: z.boolean(),
};

export const createDocumentTypeSchema = z.strictObject({
  name: typeShape.name,
  description: typeShape.description.optional(),
  maxFileSizeMb: typeShape.maxFileSizeMb.optional(),
  retentionYears: typeShape.retentionYears.optional(),
  /** Fields may be defined together with the type, or added later one by one. */
  fields: z.array(createFieldSchema).max(MAX_FIELDS_PER_TYPE).optional(),
});
export type CreateDocumentTypeInput = z.output<typeof createDocumentTypeSchema>;

export const updateDocumentTypeSchema = z
  .strictObject({
    name: typeShape.name.optional(),
    description: typeShape.description.optional(),
    maxFileSizeMb: typeShape.maxFileSizeMb.optional(),
    retentionYears: typeShape.retentionYears.optional(),
    isActive: typeShape.isActive.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one property to change');
export type UpdateDocumentTypeInput = z.output<typeof updateDocumentTypeSchema>;

export const listDocumentTypesQuerySchema = z.strictObject({
  active: z.enum(['true', 'false']).optional(),
});

export interface DocumentTypeDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  allowedMimeTypes: string[];
  maxFileSizeMb: number;
  retentionYears: number | null;
  isActive: boolean;
  fieldsVersion: number;
  fields: FieldDefinition[];
  createdAt: string;
  updatedAt: string;
}

/** "Service Agreement (v2)" -> "service_agreement_v2" */
export function slugifyKey(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 44);
  return /^[a-z]/.test(base) ? base : `t_${base}`.slice(0, 44);
}

// Tags

export const tagNameSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(50));

export const createTagSchema = z.strictObject({ name: tagNameSchema });
export const updateTagSchema = z.strictObject({ name: tagNameSchema });
export const listTagsQuerySchema = z.strictObject({ search: z.string().trim().min(1).max(50).optional() });

export interface TagDto {
  id: string;
  name: string;
  createdAt: string;
}

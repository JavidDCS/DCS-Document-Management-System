import { Prisma, type PrismaClient } from '@prisma/client';
import {
  checkFieldConfig,
  MAX_FIELDS_PER_TYPE,
  slugifyKey,
  type CreateDocumentTypeInput,
  type CreateFieldInput,
  type DocumentTypeDto,
  type FieldDefinition,
  type FieldOption,
  type FieldType,
  type FieldValidation,
  type UpdateDocumentTypeInput,
  type UpdateFieldInput,
} from '@dcs-docs/shared';
import type { AuthContext } from '../../types/express.js';
import { assertRecentAuth } from '../../platform/auth/guards.js';
import { HttpError } from '../../utils/httpError.js';
import { recordAudit } from '../audit/index.js';

/** Lets this module ask "does this type already have documents?" without depending on the documents module. */
export interface DocumentUsage {
  countForType(typeId: string): Promise<number>;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface DocumentTypesConfig {
  REAUTH_MAX_AGE_SECONDS: number;
}

type TypeRow = Prisma.DocumentTypeGetPayload<{ include: { fields: true } }>;
type FieldRow = Prisma.DocumentTypeFieldGetPayload<object>;
type Tx = Prisma.TransactionClient;

export function toFieldDefinition(f: FieldRow): FieldDefinition {
  return {
    id: f.id,
    key: f.key,
    label: f.label,
    fieldType: f.fieldType as FieldType,
    required: f.required,
    helpText: f.helpText,
    placeholder: f.placeholder,
    defaultValue: f.defaultValue ?? null,
    options: (f.options as FieldOption[] | null) ?? null,
    validation: (f.validation as FieldValidation | null) ?? null,
    searchable: f.searchable,
    displayOrder: f.displayOrder,
    isActive: f.isActive,
  };
}

export function toTypeDto(t: TypeRow, opts: { onlyActiveFields: boolean }): DocumentTypeDto {
  const fields = t.fields
    .filter((f) => !opts.onlyActiveFields || f.isActive)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.createdAt.getTime() - b.createdAt.getTime())
    .map(toFieldDefinition);
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    description: t.description,
    allowedMimeTypes: t.allowedMimeTypes,
    maxFileSizeMb: t.maxFileSizeMb,
    retentionYears: t.retentionYears,
    isActive: t.isActive,
    fieldsVersion: t.fieldsVersion,
    fields,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

const jsonOrNull = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export class DocumentTypesService {
  constructor(
    private readonly db: PrismaClient,
    private readonly usage: DocumentUsage,
    private readonly cfg: DocumentTypesConfig
  ) {}

  private audit(tx: Tx | PrismaClient, actor: AuthContext, action: string, resourceId: string, meta: RequestMeta, details: Record<string, unknown>) {
    return recordAudit(tx, {
      actorType: 'USER',
      actorUserId: actor.userId,
      action,
      resourceType: 'document_type',
      resourceId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      details,
    });
  }

  private async load(id: string, db: Tx | PrismaClient = this.db): Promise<TypeRow> {
    const t = await db.documentType.findUnique({ where: { id }, include: { fields: true } });
    if (!t) throw new HttpError(404, 'Document type not found');
    return t;
  }

  async list(canManage: boolean, activeOnly: boolean | undefined): Promise<DocumentTypeDto[]> {
    const onlyActive = !canManage || activeOnly === true;
    const rows = await this.db.documentType.findMany({
      where: onlyActive ? { isActive: true } : {},
      include: { fields: true },
      orderBy: [{ name: 'asc' }],
    });
    return rows.map((r) => toTypeDto(r, { onlyActiveFields: !canManage }));
  }

  async get(id: string, canManage: boolean): Promise<DocumentTypeDto> {
    const t = await this.load(id);
    // Non-managers cannot tell an inactive type from a missing one.
    if (!canManage && !t.isActive) throw new HttpError(404, 'Document type not found');
    return toTypeDto(t, { onlyActiveFields: !canManage });
  }

  /** The full definition (including inactive fields) for server-side metadata validation. */
  async getDefinition(typeId: string): Promise<DocumentTypeDto> {
    return toTypeDto(await this.load(typeId), { onlyActiveFields: false });
  }

  private async uniqueKey(tx: Tx, name: string): Promise<string> {
    const base = slugifyKey(name);
    for (let i = 1; i < 1000; i++) {
      const key = i === 1 ? base : `${base.slice(0, 44)}_${i}`;
      if (!(await tx.documentType.findUnique({ where: { key }, select: { id: true } }))) return key;
    }
    throw new HttpError(409, 'Could not derive a unique key for this name', 'CONFLICT');
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const clash = await this.db.documentType.findFirst({
      where: { name: { equals: name.trim(), mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new HttpError(409, 'A document type with this name already exists', 'CONFLICT');
  }

  private fieldCreateData(f: CreateFieldInput, order: number) {
    return {
      key: f.key,
      label: f.label,
      fieldType: f.fieldType,
      required: f.required,
      helpText: f.helpText ?? null,
      placeholder: f.placeholder ?? null,
      defaultValue: jsonOrNull(f.defaultValue),
      options: jsonOrNull(f.options),
      validation: jsonOrNull(f.validation),
      searchable: f.searchable,
      displayOrder: f.displayOrder ?? order,
    };
  }

  async create(actor: AuthContext, input: CreateDocumentTypeInput, meta: RequestMeta): Promise<DocumentTypeDto> {
    const fields = input.fields ?? [];
    const keys = fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) {
      throw new HttpError(400, 'Field keys must be unique', 'VALIDATION_ERROR', [{ path: 'fields', message: 'Field keys must be unique' }]);
    }
    await this.assertNameFree(input.name);
    try {
      const created = await this.db.$transaction(async (tx) => {
        const key = await this.uniqueKey(tx, input.name);
        const t = await tx.documentType.create({
          data: {
            key,
            name: input.name,
            description: input.description ?? null,
            ...(input.maxFileSizeMb !== undefined ? { maxFileSizeMb: input.maxFileSizeMb } : {}),
            retentionYears: input.retentionYears ?? null,
            createdById: actor.userId,
            updatedById: actor.userId,
            fields: { create: fields.map((f, i) => this.fieldCreateData(f, i)) },
          },
          include: { fields: true },
        });
        await this.audit(tx, actor, 'DOCUMENT_TYPE_CREATED', t.id, meta, { key, name: t.name, fieldKeys: keys });
        return t;
      });
      return toTypeDto(created, { onlyActiveFields: false });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A document type with this name already exists', 'CONFLICT');
      throw err;
    }
  }

  async update(actor: AuthContext, id: string, input: UpdateDocumentTypeInput, meta: RequestMeta): Promise<DocumentTypeDto> {
    const current = await this.load(id);
    if (input.name !== undefined && input.name.toLowerCase() !== current.name.toLowerCase()) await this.assertNameFree(input.name, id);

    const togglesActive = input.isActive !== undefined && input.isActive !== current.isActive;
    if (togglesActive && input.isActive === false && (await this.usage.countForType(id)) > 0) {
      assertRecentAuth(actor, this.cfg.REAUTH_MAX_AGE_SECONDS);
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['name', 'description', 'maxFileSizeMb', 'retentionYears', 'isActive'] as const) {
      if (input[k] !== undefined && input[k] !== current[k]) changes[k] = { from: current[k], to: input[k] };
    }
    if (Object.keys(changes).length === 0) return toTypeDto(current, { onlyActiveFields: false });

    try {
      const updated = await this.db.$transaction(async (tx) => {
        const t = await tx.documentType.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.maxFileSizeMb !== undefined ? { maxFileSizeMb: input.maxFileSizeMb } : {}),
            ...(input.retentionYears !== undefined ? { retentionYears: input.retentionYears } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            updatedById: actor.userId,
          },
          include: { fields: true },
        });
        const action = togglesActive ? (input.isActive ? 'DOCUMENT_TYPE_ACTIVATED' : 'DOCUMENT_TYPE_DEACTIVATED') : 'DOCUMENT_TYPE_UPDATED';
        await this.audit(tx, actor, action, id, meta, { changes });
        return t;
      });
      return toTypeDto(updated, { onlyActiveFields: false });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A document type with this name already exists', 'CONFLICT');
      throw err;
    }
  }

  async addField(actor: AuthContext, typeId: string, input: CreateFieldInput, meta: RequestMeta): Promise<DocumentTypeDto> {
    try {
      const updated = await this.db.$transaction(async (tx) => {
        // Serialise concurrent field edits of one type.
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM document_types WHERE id = ${typeId}::uuid FOR UPDATE`;
        if (locked.length === 0) throw new HttpError(404, 'Document type not found');
        const t = await this.load(typeId, tx);
        if (t.fields.length >= MAX_FIELDS_PER_TYPE) {
          throw new HttpError(409, `A type can have at most ${MAX_FIELDS_PER_TYPE} fields`, 'CONFLICT');
        }
        const order = t.fields.reduce((m, f) => Math.max(m, f.displayOrder), -1) + 1;
        const f = await tx.documentTypeField.create({ data: { documentTypeId: typeId, ...this.fieldCreateData(input, order) } });
        await tx.documentType.update({ where: { id: typeId }, data: { fieldsVersion: { increment: 1 }, updatedById: actor.userId } });
        await this.audit(tx, actor, 'DOCUMENT_TYPE_FIELD_ADDED', typeId, meta, { fieldId: f.id, key: f.key, fieldType: f.fieldType, required: f.required });
        return this.load(typeId, tx);
      });
      return toTypeDto(updated, { onlyActiveFields: false });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A field with this key already exists on this type', 'CONFLICT');
      throw err;
    }
  }

  async updateField(actor: AuthContext, typeId: string, fieldId: string, input: UpdateFieldInput, meta: RequestMeta): Promise<DocumentTypeDto> {
    const hasDocuments = (await this.usage.countForType(typeId)) > 0;

    const updated = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM document_types WHERE id = ${typeId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new HttpError(404, 'Document type not found');
      const t = await this.load(typeId, tx);
      const row = t.fields.find((f) => f.id === fieldId);
      if (!row) throw new HttpError(404, 'Field not found');
      const cur = toFieldDefinition(row);
      const typeChanges = input.fieldType !== undefined && input.fieldType !== cur.fieldType;

      if (typeChanges && hasDocuments) {
        throw new HttpError(409, 'The type of a field cannot change once documents exist; add a new field instead', 'CONFLICT');
      }

      // Options are never removed once documents exist (stored values must stay valid); they can be added, relabelled or deactivated.
      if (input.options !== undefined && cur.options && hasDocuments) {
        const next = new Set((input.options ?? []).map((o) => o.value));
        const dropped = cur.options.filter((o) => !next.has(o.value)).map((o) => o.value);
        if (dropped.length > 0) {
          throw new HttpError(409, 'Options cannot be removed once documents exist; deactivate them instead', 'CONFLICT', [
            { path: 'options', message: `Cannot remove: ${dropped.join(', ')}` },
          ]);
        }
      }

      const merged = {
        key: cur.key,
        fieldType: (input.fieldType ?? cur.fieldType) as FieldType,
        required: input.required ?? cur.required,
        options: input.options !== undefined ? input.options : typeChanges ? null : cur.options,
        validation: input.validation !== undefined ? input.validation : typeChanges ? null : cur.validation,
        defaultValue: input.defaultValue !== undefined ? input.defaultValue : typeChanges ? null : cur.defaultValue,
      };
      const problems = checkFieldConfig(merged);
      if (problems.length > 0) throw new HttpError(400, 'Invalid field configuration', 'VALIDATION_ERROR', problems);

      const becomesRequired = input.required === true && !cur.required;
      const deactivates = input.isActive === false && cur.isActive;
      const changesValidation = input.validation !== undefined && !same(input.validation, cur.validation);
      if (hasDocuments && (becomesRequired || deactivates || changesValidation)) assertRecentAuth(actor, this.cfg.REAUTH_MAX_AGE_SECONDS);

      const data: Prisma.DocumentTypeFieldUpdateInput = {};
      const changed: string[] = [];
      if (input.label !== undefined && input.label !== cur.label) (data.label = input.label), changed.push('label');
      if (typeChanges) (data.fieldType = input.fieldType!), changed.push('fieldType');
      if (input.required !== undefined && input.required !== cur.required) (data.required = input.required), changed.push('required');
      if (input.helpText !== undefined && (input.helpText ?? null) !== cur.helpText) (data.helpText = input.helpText), changed.push('helpText');
      if (input.placeholder !== undefined && (input.placeholder ?? null) !== cur.placeholder) (data.placeholder = input.placeholder), changed.push('placeholder');
      if (input.searchable !== undefined && input.searchable !== cur.searchable) (data.searchable = input.searchable), changed.push('searchable');
      if (input.displayOrder !== undefined && input.displayOrder !== cur.displayOrder) (data.displayOrder = input.displayOrder), changed.push('displayOrder');
      if (input.isActive !== undefined && input.isActive !== cur.isActive) (data.isActive = input.isActive), changed.push('isActive');
      if (input.defaultValue !== undefined && !same(input.defaultValue, cur.defaultValue)) changed.push('defaultValue');
      if (input.options !== undefined && !same(input.options, cur.options)) changed.push('options');
      if (input.validation !== undefined && !same(input.validation, cur.validation)) changed.push('validation');
      if (changed.some((c) => ['fieldType', 'defaultValue', 'options', 'validation'].includes(c))) {
        data.defaultValue = jsonOrNull(merged.defaultValue);
        data.options = jsonOrNull(merged.options);
        data.validation = jsonOrNull(merged.validation);
      }

      if (changed.length > 0) {
        await tx.documentTypeField.update({ where: { id: fieldId }, data });
        await tx.documentType.update({ where: { id: typeId }, data: { fieldsVersion: { increment: 1 }, updatedById: actor.userId } });
        const action =
          input.isActive === undefined || input.isActive === cur.isActive
            ? 'DOCUMENT_TYPE_FIELD_UPDATED'
            : input.isActive
              ? 'DOCUMENT_TYPE_FIELD_REACTIVATED'
              : 'DOCUMENT_TYPE_FIELD_DEACTIVATED';
        await this.audit(tx, actor, action, typeId, meta, { fieldId, key: cur.key, changed });
      }
      return this.load(typeId, tx);
    });
    return toTypeDto(updated, { onlyActiveFields: false });
  }

  async reorderFields(actor: AuthContext, typeId: string, fieldIds: string[], meta: RequestMeta): Promise<DocumentTypeDto> {
    const updated = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM document_types WHERE id = ${typeId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new HttpError(404, 'Document type not found');
      const t = await this.load(typeId, tx);
      const existing = t.fields.map((f) => f.id).sort();
      if (new Set(fieldIds).size !== fieldIds.length || !same([...fieldIds].sort(), existing)) {
        throw new HttpError(400, 'Provide every field of the type exactly once', 'VALIDATION_ERROR', [{ path: 'fieldIds', message: 'Must list all fields of the type exactly once' }]);
      }
      for (const [i, id] of fieldIds.entries()) await tx.documentTypeField.update({ where: { id }, data: { displayOrder: i } });
      await tx.documentType.update({ where: { id: typeId }, data: { fieldsVersion: { increment: 1 }, updatedById: actor.userId } });
      await this.audit(tx, actor, 'DOCUMENT_TYPE_FIELDS_REORDERED', typeId, meta, { count: fieldIds.length });
      return this.load(typeId, tx);
    });
    return toTypeDto(updated, { onlyActiveFields: false });
  }
}

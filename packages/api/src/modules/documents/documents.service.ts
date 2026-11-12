import { Prisma, type PrismaClient } from '@prisma/client';
import {
  metadataToSearchText,
  validateMetadata,
  type ArchiveStatus,
  type DocumentDetail,
  type DocumentListItem,
  type FieldDefinition,
  type ScanStatus,
  type VersionDto,
} from '@dcs-docs/shared';
import type { AuthContext } from '../../types/express.js';
import { assertRecentAuth } from '../../platform/auth/guards.js';
import { HttpError } from '../../utils/httpError.js';
import { recordAudit } from '../audit/index.js';
import type { DocumentTypesService } from '../document-types/documentTypes.service.js';
import { likeEscape } from '../../utils/like.js';
import { enqueueJob } from '../jobs/jobs.js';
import { IntegrityError } from '../storage/fileCrypto.js';
import type { FileService, StoredFile } from '../storage/fileService.js';
import { aclAllows, aclWhere, type AccessRuleRow } from './documentAccess.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface DocumentsConfig {
  STORAGE_MAX_FILE_SIZE_MB: number;
  REAUTH_MAX_AGE_SECONDS: number;
}

export interface UploadedFile {
  filename: string;
  stored: StoredFile;
}

type Tx = Prisma.TransactionClient;

const docInclude = {
  documentType: { select: { id: true, name: true } },
  tags: { include: { tag: { select: { id: true, name: true } } } },
  currentVersion: { select: { id: true, versionNumber: true } },
} satisfies Prisma.DocumentInclude;
type DocRow = Prisma.DocumentGetPayload<{ include: typeof docInclude }>;

const versionInclude = { uploadedBy: { select: { id: true, name: true } } } satisfies Prisma.DocumentVersionInclude;
type VersionRow = Prisma.DocumentVersionGetPayload<{ include: typeof versionInclude }>;

const MB = 1024 * 1024;

function scanDetailText(status: string, details: unknown): string | null {
  const d = (details ?? {}) as { reason?: string; signature?: string; problems?: string[]; findings?: string[] };
  if (status === 'QUARANTINED') return `Malware detected${d.signature ? ` (${d.signature})` : ''}`;
  if (status === 'REJECTED') return d.problems?.length ? `Rejected: ${d.problems.join(', ')}` : d.findings?.length ? `Rejected: contains ${d.findings.join(', ')}` : (d.reason ?? 'Rejected');
  if (status === 'CLEAN' && d.findings?.length) return `Flagged: ${d.findings.join(', ')}`;
  return null;
}

export class DocumentsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly files: FileService,
    private readonly types: DocumentTypesService,
    private readonly cfg: DocumentsConfig
  ) {}

  private manages = (a: AuthContext) => a.permissions.includes('documents:manage');

  private audit(tx: Tx | PrismaClient, actor: AuthContext, action: string, resourceType: string, resourceId: string, meta: RequestMeta, details: Record<string, unknown> = {}) {
    return recordAudit(tx, {
      actorType: 'USER', actorUserId: actor.userId, action, resourceType, resourceId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details,
    });
  }

  /** What an ordinary reader may see: active, live documents with a clean current version and no blocking rule. */
  private readerWhere(actor: AuthContext): Prisma.DocumentWhereInput {
    return { AND: [{ isActive: true, archiveStatus: 'LIVE', currentVersionId: { not: null } }, aclWhere(actor, 'VIEW')] };
  }

  private toListItem(d: DocRow): DocumentListItem {
    return {
      id: d.id,
      name: d.name,
      typeId: d.documentType.id,
      typeName: d.documentType.name,
      isActive: d.isActive,
      archiveStatus: d.archiveStatus as ArchiveStatus,
      currentVersionNumber: d.currentVersion?.versionNumber ?? null,
      currentVersionId: d.currentVersionId,
      tags: d.tags.map((t) => t.tag).sort((a, b) => a.name.localeCompare(b.name)),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  private toVersionDto(v: VersionRow, currentId: string | null, manager: boolean): VersionDto {
    return {
      id: v.id,
      versionNumber: v.versionNumber,
      originalFilename: v.originalFilename,
      sizeBytes: Number(v.sizeBytes),
      sha256: v.sha256,
      scanStatus: v.scanStatus as ScanStatus,
      scanDetail: manager ? scanDetailText(v.scanStatus, v.scanDetails) : null,
      isCurrent: v.id === currentId,
      changeNote: v.changeNote,
      restoredFromVersionId: v.restoredFromVersionId,
      uploadedBy: v.uploadedBy,
      createdAt: v.createdAt.toISOString(),
    };
  }

  async list(actor: AuthContext, q: { search?: string | undefined; typeId?: string | undefined; tagId?: string | undefined; active?: 'true' | 'false' | undefined; archive?: ArchiveStatus | undefined; limit: number; offset: number }) {
    const manager = this.manages(actor);
    const filters: Prisma.DocumentWhereInput[] = [];
    if (!manager) filters.push(this.readerWhere(actor));
    if (q.typeId) filters.push({ documentTypeId: q.typeId });
    if (q.tagId) filters.push({ tags: { some: { tagId: q.tagId } } });
    if (q.active) filters.push({ isActive: q.active === 'true' });
    if (q.archive && manager) filters.push({ archiveStatus: q.archive });
    if (q.search) {
      const term = likeEscape(q.search);
      filters.push({
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { searchText: { contains: term, mode: 'insensitive' } },
          { tags: { some: { tag: { name: { contains: term, mode: 'insensitive' } } } } },
          { documentType: { name: { contains: term, mode: 'insensitive' } } },
        ],
      });
    }
    const where: Prisma.DocumentWhereInput = filters.length ? { AND: filters } : {};
    const [rows, total] = await Promise.all([
      this.db.document.findMany({ where, include: docInclude, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: q.limit, skip: q.offset }),
      this.db.document.count({ where }),
    ]);
    return { items: rows.map((r) => this.toListItem(r)), total };
  }

  private async loadVisible(actor: AuthContext, id: string): Promise<DocRow> {
    const where: Prisma.DocumentWhereInput = this.manages(actor) ? { id } : { AND: [{ id }, this.readerWhere(actor)] };
    const d = await this.db.document.findFirst({ where, include: docInclude });
    if (!d) throw new HttpError(404, 'Document not found'); // same answer for "missing" and "not allowed"
    return d;
  }

  async get(actor: AuthContext, id: string): Promise<DocumentDetail> {
    const d = await this.loadVisible(actor, id);
    const manager = this.manages(actor);
    const [full, versions, type] = await Promise.all([
      this.db.document.findUniqueOrThrow({ where: { id }, select: { description: true, metadata: true, fieldsVersion: true } }),
      this.db.documentVersion.findMany({
        where: { documentId: id, ...(manager ? {} : { scanStatus: 'CLEAN' }) },
        include: versionInclude,
        orderBy: { versionNumber: 'desc' },
      }),
      this.types.getDefinition(d.documentType.id),
    ]);
    return {
      ...this.toListItem(d),
      description: full.description,
      metadata: (full.metadata ?? {}) as Record<string, unknown>,
      fieldsVersion: full.fieldsVersion,
      versions: versions.map((v) => this.toVersionDto(v, d.currentVersionId, manager)),
      type: manager ? type : { ...type, fields: type.fields.filter((f) => f.isActive) },
    };
  }

  private async resolveTags(tagIds: string[] | undefined): Promise<string[]> {
    const ids = [...new Set(tagIds ?? [])];
    if (ids.length === 0) return [];
    const found = await this.db.tag.findMany({ where: { id: { in: ids } }, select: { id: true } });
    if (found.length !== ids.length) throw new HttpError(400, 'One or more tags do not exist', 'VALIDATION_ERROR', [{ path: 'tagIds', message: 'Unknown tag' }]);
    return ids;
  }

  private validate(fields: FieldDefinition[], metadata: Record<string, unknown>, existing?: Record<string, unknown>) {
    const r = validateMetadata(fields, metadata);
    if (!r.ok) throw new HttpError(400, 'Invalid metadata', 'VALIDATION_ERROR', r.issues);
    // Values of fields that are now inactive are kept untouched.
    const kept: Record<string, unknown> = {};
    for (const f of fields) if (!f.isActive && existing && f.key in existing) kept[f.key] = existing[f.key];
    const value = { ...kept, ...r.value };
    return { value, searchText: metadataToSearchText(fields, value).slice(0, 4000) };
  }

  private maxBytesFor(typeMaxMb: number) {
    return Math.min(typeMaxMb, this.cfg.STORAGE_MAX_FILE_SIZE_MB) * MB;
  }

  /** The upload cap used while the file streams in (the per-type cap is applied right after the form is known). */
  get globalMaxBytes() {
    return this.cfg.STORAGE_MAX_FILE_SIZE_MB * MB;
  }

  private versionData(documentId: string, n: number, file: UploadedFile, actorId: string, changeNote?: string) {
    return {
      documentId,
      versionNumber: n,
      storageKey: file.stored.storageKey,
      originalFilename: file.filename,
      mimeType: 'application/pdf',
      sizeBytes: BigInt(file.stored.size),
      storedSize: BigInt(file.stored.storedSize),
      sha256: file.stored.sha256,
      encryptionKeyId: file.stored.keyId,
      wrappedDataKey: file.stored.wrappedKey,
      changeNote: changeNote ?? null,
      uploadedById: actorId,
    };
  }

  private async discard(file: UploadedFile | null) {
    if (file) await this.files.delete('quarantine', file.stored.storageKey).catch(() => undefined);
  }

  async create(
    actor: AuthContext,
    input: { typeId: string; name: string; description?: string | undefined; metadata?: Record<string, unknown> | undefined; tagIds?: string[] | undefined; changeNote?: string | undefined },
    file: UploadedFile | null,
    meta: RequestMeta
  ): Promise<DocumentDetail> {
    if (!file) throw new HttpError(400, 'No file was uploaded', 'VALIDATION_ERROR', [{ path: 'file', message: 'Required' }]);
    try {
      const type = await this.types.getDefinition(input.typeId).catch((e) => {
        if (e instanceof HttpError && e.status === 404) throw new HttpError(400, 'Unknown document type', 'VALIDATION_ERROR', [{ path: 'typeId', message: 'Unknown document type' }]);
        throw e;
      });
      if (!type.isActive) throw new HttpError(409, 'This document type is inactive', 'CONFLICT');
      if (file.stored.size > this.maxBytesFor(type.maxFileSizeMb)) throw new HttpError(413, `The file is larger than ${type.maxFileSizeMb} MB`, 'PAYLOAD_TOO_LARGE');
      const meta2 = this.validate(type.fields, input.metadata ?? {});
      const tagIds = await this.resolveTags(input.tagIds);

      const created = await this.db.$transaction(async (tx) => {
        const doc = await tx.document.create({
          data: {
            documentTypeId: type.id,
            name: input.name,
            description: input.description ?? null,
            metadata: meta2.value as Prisma.InputJsonObject,
            fieldsVersion: type.fieldsVersion,
            searchText: meta2.searchText,
            ownerId: actor.userId,
            createdById: actor.userId,
            tags: { create: tagIds.map((tagId) => ({ tagId })) },
          },
        });
        const v = await tx.documentVersion.create({ data: this.versionData(doc.id, 1, file, actor.userId, input.changeNote) });
        await enqueueJob(tx, { type: 'scan_file', payload: { versionId: v.id }, dedupeKey: `scan:${v.id}` });
        await this.audit(tx, actor, 'DOCUMENT_CREATED', 'document', doc.id, meta, { typeId: type.id, name: doc.name });
        await this.audit(tx, actor, 'VERSION_UPLOADED', 'document_version', v.id, meta, { documentId: doc.id, versionNumber: 1, sizeBytes: file.stored.size, sha256: file.stored.sha256 });
        return doc;
      });
      return await this.get(actor, created.id);
    } catch (err) {
      await this.discard(file);
      throw err;
    }
  }

  async addVersion(actor: AuthContext, documentId: string, file: UploadedFile | null, changeNote: string | undefined, meta: RequestMeta): Promise<VersionDto> {
    if (!file) throw new HttpError(400, 'No file was uploaded', 'VALIDATION_ERROR', [{ path: 'file', message: 'Required' }]);
    try {
      const v = await this.db.$transaction(async (tx) => {
        const doc = await this.lockDocument(tx, documentId);
        this.assertEditable(doc.archiveStatus);
        const type = await tx.documentType.findUniqueOrThrow({ where: { id: doc.documentTypeId }, select: { maxFileSizeMb: true } });
        if (file.stored.size > this.maxBytesFor(type.maxFileSizeMb)) throw new HttpError(413, `The file is larger than ${type.maxFileSizeMb} MB`, 'PAYLOAD_TOO_LARGE');
        const n = await this.nextVersionNumber(tx, documentId);
        const created = await tx.documentVersion.create({ data: this.versionData(documentId, n, file, actor.userId, changeNote), include: versionInclude });
        await tx.document.update({ where: { id: documentId }, data: { updatedAt: new Date() } });
        await enqueueJob(tx, { type: 'scan_file', payload: { versionId: created.id }, dedupeKey: `scan:${created.id}` });
        await this.audit(tx, actor, 'VERSION_UPLOADED', 'document_version', created.id, meta, { documentId, versionNumber: n, sizeBytes: file.stored.size, sha256: file.stored.sha256 });
        return created;
      });
      return this.toVersionDto(v, null, true);
    } catch (err) {
      await this.discard(file);
      throw err;
    }
  }

  /** Locks the document row so concurrent uploads, promotions and restores are serialised. */
  private async lockDocument(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<{ id: string; document_type_id: string; archive_status: string; is_active: boolean; current_version_id: string | null }[]>`
      SELECT id, document_type_id, archive_status, is_active, current_version_id FROM documents WHERE id = ${id}::uuid FOR UPDATE`;
    const r = rows[0];
    if (!r) throw new HttpError(404, 'Document not found');
    return { id: r.id, documentTypeId: r.document_type_id, archiveStatus: r.archive_status, isActive: r.is_active, currentVersionId: r.current_version_id };
  }

  /** version_number = max + 1 under the document lock; UNIQUE(document_id, version_number) is the safety net. */
  private async nextVersionNumber(tx: Tx, documentId: string): Promise<number> {
    const max = await tx.documentVersion.aggregate({ where: { documentId }, _max: { versionNumber: true } });
    return (max._max.versionNumber ?? 0) + 1;
  }

  private assertEditable(archiveStatus: string) {
    if (archiveStatus === 'LEGAL_HOLD') throw new HttpError(409, 'This document is under legal hold', 'CONFLICT');
    if (archiveStatus === 'ARCHIVED') throw new HttpError(409, 'This document is archived; unarchive it first', 'CONFLICT');
  }

  async update(actor: AuthContext, id: string, patch: { name?: string | undefined; description?: string | null | undefined; metadata?: Record<string, unknown> | undefined; tagIds?: string[] | undefined }, meta: RequestMeta): Promise<DocumentDetail> {
    const tagIds = patch.tagIds !== undefined ? await this.resolveTags(patch.tagIds) : undefined;
    await this.db.$transaction(async (tx) => {
      const doc = await this.lockDocument(tx, id);
      this.assertEditable(doc.archiveStatus);
      const cur = await tx.document.findUniqueOrThrow({ where: { id }, select: { metadata: true, name: true, description: true } });
      const data: Prisma.DocumentUpdateInput = {};
      const changed: string[] = [];
      if (patch.name !== undefined && patch.name !== cur.name) (data.name = patch.name), changed.push('name');
      if (patch.description !== undefined && patch.description !== cur.description) (data.description = patch.description), changed.push('description');
      if (patch.metadata !== undefined) {
        const type = await this.types.getDefinition(doc.documentTypeId);
        const m = this.validate(type.fields, patch.metadata, (cur.metadata ?? {}) as Record<string, unknown>);
        data.metadata = m.value as Prisma.InputJsonObject;
        data.searchText = m.searchText;
        data.fieldsVersion = type.fieldsVersion;
        changed.push('metadata');
      }
      if (tagIds !== undefined) {
        await tx.documentTag.deleteMany({ where: { documentId: id } });
        if (tagIds.length > 0) await tx.documentTag.createMany({ data: tagIds.map((tagId) => ({ documentId: id, tagId })) });
        changed.push('tags');
      }
      if (changed.length === 0) return;
      await tx.document.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
      await this.audit(tx, actor, 'DOCUMENT_UPDATED', 'document', id, meta, { changed });
    });
    return this.get(actor, id);
  }

  async setActive(actor: AuthContext, id: string, active: boolean, meta: RequestMeta): Promise<DocumentDetail> {
    await this.db.$transaction(async (tx) => {
      const doc = await this.lockDocument(tx, id);
      if (active) {
        if (doc.archiveStatus !== 'LIVE') throw new HttpError(409, 'Only a live (not archived, not on hold) document can be activated', 'CONFLICT');
        if (!doc.currentVersionId) throw new HttpError(409, 'The document has no clean current version yet', 'CONFLICT');
      }
      if (doc.isActive === active) return;
      await tx.document.update({ where: { id }, data: { isActive: active } });
      await this.audit(tx, actor, active ? 'DOCUMENT_ACTIVATED' : 'DOCUMENT_DEACTIVATED', 'document', id, meta);
    });
    return this.get(actor, id);
  }

  async setArchive(actor: AuthContext, id: string, action: 'archive' | 'unarchive' | 'hold' | 'release', meta: RequestMeta): Promise<DocumentDetail> {
    assertRecentAuth(actor, this.cfg.REAUTH_MAX_AGE_SECONDS);
    await this.db.$transaction(async (tx) => {
      const doc = await this.lockDocument(tx, id);
      const from = doc.archiveStatus;
      let to: ArchiveStatus;
      if (action === 'archive') {
        if (from === 'LEGAL_HOLD') throw new HttpError(409, 'This document is under legal hold', 'CONFLICT');
        to = 'ARCHIVED';
      } else if (action === 'unarchive') {
        if (from !== 'ARCHIVED') throw new HttpError(409, 'The document is not archived', 'CONFLICT');
        to = 'LIVE';
      } else if (action === 'hold') {
        to = 'LEGAL_HOLD';
      } else {
        if (from !== 'LEGAL_HOLD') throw new HttpError(409, 'The document is not under legal hold', 'CONFLICT');
        to = 'LIVE';
      }
      if (from === to) return;
      await tx.document.update({ where: { id }, data: { archiveStatus: to, ...(to !== 'LIVE' ? { isActive: false } : {}) } });
      await this.audit(tx, actor, `DOCUMENT_${{ archive: 'ARCHIVED', unarchive: 'UNARCHIVED', hold: 'LEGAL_HOLD_SET', release: 'LEGAL_HOLD_RELEASED' }[action]}`, 'document', id, meta, { from, to });
    });
    return this.get(actor, id);
  }

  private async loadVersion(tx: Tx | PrismaClient, documentId: string, versionId: string) {
    const v = await tx.documentVersion.findFirst({ where: { id: versionId, documentId } });
    if (!v) throw new HttpError(404, 'Version not found');
    return v;
  }

  async promote(actor: AuthContext, documentId: string, versionId: string, meta: RequestMeta): Promise<DocumentDetail> {
    await this.db.$transaction(async (tx) => {
      const doc = await this.lockDocument(tx, documentId);
      this.assertEditable(doc.archiveStatus);
      const v = await this.loadVersion(tx, documentId, versionId);
      if (v.scanStatus !== 'CLEAN') throw new HttpError(409, 'Only a clean version can become the current version', 'CONFLICT');
      if (doc.currentVersionId === v.id) return;
      await tx.document.update({ where: { id: documentId }, data: { currentVersionId: v.id } });
      await this.audit(tx, actor, 'VERSION_PROMOTED', 'document_version', v.id, meta, { documentId, versionNumber: v.versionNumber, previous: doc.currentVersionId });
    });
    return this.get(actor, documentId);
  }

  /** Restoring never edits history: the old content is copied into a NEW version, which becomes current. */
  async restore(actor: AuthContext, documentId: string, versionId: string, meta: RequestMeta): Promise<DocumentDetail> {
    const src = await this.loadVersion(this.db, documentId, versionId);
    if (src.scanStatus !== 'CLEAN') throw new HttpError(409, 'Only a clean version can be restored', 'CONFLICT');

    const plain = await this.files.open('clean', src.storageKey, { keyId: src.encryptionKeyId, wrappedKey: Buffer.from(src.wrappedDataKey) }, { sha256: src.sha256, size: Number(src.sizeBytes) });
    const stored = await this.files.store('clean', plain, { maxBytes: this.globalMaxBytes });
    try {
      await this.db.$transaction(async (tx) => {
        const doc = await this.lockDocument(tx, documentId);
        this.assertEditable(doc.archiveStatus);
        const n = await this.nextVersionNumber(tx, documentId);
        const v = await tx.documentVersion.create({
          data: {
            ...this.versionData(documentId, n, { filename: src.originalFilename, stored }, actor.userId, `Restored from version ${src.versionNumber}`),
            scanStatus: 'CLEAN',
            scannedAt: new Date(),
            scanDetails: { source: 'restore', restoredFromVersion: src.versionNumber },
            restoredFromVersionId: src.id,
          },
        });
        await tx.document.update({ where: { id: documentId }, data: { currentVersionId: v.id } });
        await this.audit(tx, actor, 'VERSION_RESTORED', 'document_version', v.id, meta, { documentId, versionNumber: n, restoredFrom: src.versionNumber });
      });
    } catch (err) {
      await this.files.delete('clean', stored.storageKey).catch(() => undefined);
      throw err;
    }
    return this.get(actor, documentId);
  }

  /**
   * Decrypts and verifies a version for download or preview. Object-level checks: the version must be CLEAN and
   * belong to the document; ordinary users also need a document they may see. The access is audited BEFORE any
   * byte is returned, and the whole file is verified (checksum + authentication tags) before it is released.
   */
  async readContent(actor: AuthContext, documentId: string, versionId: string, inline: boolean, meta: RequestMeta) {
    await this.loadVisible(actor, documentId);
    const v = await this.loadVersion(this.db, documentId, versionId);
    if (v.scanStatus !== 'CLEAN') throw new HttpError(404, 'Version not found');

    await this.audit(this.db, actor, inline ? 'FILE_PREVIEWED' : 'FILE_DOWNLOADED', 'document_version', v.id, meta, { documentId, versionNumber: v.versionNumber, sha256: v.sha256 });
    try {
      const data = await this.files.readVerified(
        'clean', v.storageKey,
        { keyId: v.encryptionKeyId, wrappedKey: Buffer.from(v.wrappedDataKey) },
        { sha256: v.sha256, size: Number(v.sizeBytes) },
        this.globalMaxBytes + MB
      );
      return { data, filename: v.originalFilename, sha256: v.sha256 };
    } catch (err) {
      if (err instanceof IntegrityError) {
        await recordAudit(this.db, {
          actorType: 'SYSTEM', action: 'INTEGRITY_FAILURE', resourceType: 'document_version', resourceId: v.id, outcome: 'FAILURE',
          ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { documentId, reason: err.message },
        });
        throw new HttpError(500, 'The file failed its integrity check and cannot be released', 'INTERNAL_ERROR');
      }
      throw err;
    }
  }

  async getRules(documentId: string) {
    await this.lockFree(documentId);
    const rows = await this.db.documentAccessRule.findMany({ where: { documentId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ id: r.id, subjectType: r.subjectType, userId: r.userId, role: r.role, permission: r.permission, effect: r.effect }));
  }

  private async lockFree(id: string) {
    if (!(await this.db.document.findUnique({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'Document not found');
  }

  async setRules(actor: AuthContext, documentId: string, rules: { subjectType: 'USER' | 'ROLE'; userId?: string; role?: string; permission: string; effect: string }[], meta: RequestMeta) {
    await this.lockFree(documentId);
    const userIds = [...new Set(rules.flatMap((r) => (r.userId ? [r.userId] : [])))];
    if (userIds.length > 0 && (await this.db.user.count({ where: { id: { in: userIds } } })) !== userIds.length) {
      throw new HttpError(400, 'A rule refers to an unknown user', 'VALIDATION_ERROR', [{ path: 'rules', message: 'Unknown user' }]);
    }
    await this.db.$transaction(async (tx) => {
      await tx.documentAccessRule.deleteMany({ where: { documentId } });
      if (rules.length > 0) {
        await tx.documentAccessRule.createMany({
          data: rules.map((r) => ({ documentId, subjectType: r.subjectType, userId: r.userId ?? null, role: r.role ?? null, permission: r.permission, effect: r.effect, createdById: actor.userId })),
        });
      }
      await this.audit(tx, actor, 'ACCESS_RULES_CHANGED', 'document', documentId, meta, { count: rules.length });
    });
    return this.getRules(documentId);
  }

  /** Can this user send this document (used by the email module)? Same visibility rules plus the SEND rules. */
  async canSend(actor: AuthContext, documentId: string): Promise<boolean> {
    const d = await this.db.document.findFirst({
      where: this.manages(actor) ? { id: documentId } : { AND: [{ id: documentId }, this.readerWhere(actor)] },
      select: { id: true, accessRules: { select: { subjectType: true, userId: true, role: true, permission: true, effect: true } } },
    });
    if (!d) return false;
    return aclAllows(d.accessRules as AccessRuleRow[], actor, 'SEND');
  }
}

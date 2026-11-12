import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  unknownPlaceholders,
  type DraftInput,
  type DraftPreview,
  type EmailMessageDetail,
  type EmailMessageListItem,
  type EmailPlaceholder,
  type EmailStatus,
  type EmailTemplateDto,
  type SendInput,
  type TemplateInput,
} from '@dcs-docs/shared';
import type { AuthContext } from '../../types/express.js';
import { HttpError } from '../../utils/httpError.js';
import { likeEscape } from '../../utils/like.js';
import { logger } from '../../utils/logger.js';
import { EmailProviderError, type EmailProvider } from '../../providers/email/types.js';
import { recordAudit } from '../audit/index.js';
import type { DocumentsService } from '../documents/documents.service.js';
import { enqueueJob, type JobContext } from '../jobs/jobs.js';
import { IntegrityError } from '../storage/fileCrypto.js';
import type { FileService } from '../storage/fileService.js';
import type { EmailConnectionsService } from './connections.service.js';
import { buildMime, nameFromAddress, renderText } from './render.js';

export interface EmailConfig {
  ALLOWED_EMAIL_DOMAIN: string;
  EMAIL_MAX_ATTACHMENT_TOTAL_MB: number;
  APP_TIMEZONE: string;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

const CONFIRM_TTL_MS = 15 * 60_000;
const MAX_RECIPIENTS = 50;
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Kind = 'TO' | 'CC' | 'BCC';
interface Resolved {
  documentId: string;
  documentName: string;
  typeName: string;
  versionId: string;
  versionNumber: number;
  filename: string;
  sizeBytes: number;
  sha256: string;
}
interface Draft {
  recipients: { kind: Kind; address: string; external: boolean }[];
  subject: string;
  body: string;
  items: Resolved[];
  hasExternal: boolean;
  hash: string;
}

export class EmailService {
  private readonly confirmKey: Buffer;

  constructor(
    private readonly db: PrismaClient,
    private readonly files: FileService,
    private readonly docs: DocumentsService,
    private readonly connections: EmailConnectionsService,
    private readonly provider: EmailProvider,
    private readonly cfg: EmailConfig,
    emailKey: Buffer
  ) {
    this.confirmKey = createHmac('sha256', emailKey).update('send-confirmation-v1').digest();
  }

  // ------------------------------------------------------------------ templates

  private toTemplate(t: { id: string; name: string; subject: string; body: string; isDefault: boolean; isActive: boolean; version: number; updatedAt: Date }): EmailTemplateDto {
    return { id: t.id, name: t.name, subject: t.subject, body: t.body, isDefault: t.isDefault, isActive: t.isActive, version: t.version, updatedAt: t.updatedAt.toISOString() };
  }

  async listTemplates(manager: boolean) {
    const rows = await this.db.emailTemplate.findMany({ where: manager ? {} : { isActive: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    return rows.map((r) => this.toTemplate(r));
  }

  async createTemplate(actor: AuthContext, input: TemplateInput, meta: RequestMeta) {
    try {
      return this.toTemplate(
        await this.db.$transaction(async (tx) => {
          if (input.isDefault) await tx.emailTemplate.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
          const t = await tx.emailTemplate.create({
            data: { name: input.name, subject: input.subject, body: input.body, isDefault: input.isDefault ?? false, isActive: input.isActive ?? true, createdById: actor.userId, updatedById: actor.userId },
          });
          await this.audit(tx, actor, 'EMAIL_TEMPLATE_CREATED', 'email_template', t.id, meta, { name: t.name });
          return t;
        })
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new HttpError(409, 'A template with this name already exists', 'CONFLICT');
      throw err;
    }
  }

  async updateTemplate(actor: AuthContext, id: string, patch: Partial<TemplateInput>, meta: RequestMeta) {
    try {
      return this.toTemplate(
        await this.db.$transaction(async (tx) => {
          const cur = await tx.emailTemplate.findUnique({ where: { id } });
          if (!cur) throw new HttpError(404, 'Template not found');
          const subject = patch.subject ?? cur.subject;
          const body = patch.body ?? cur.body;
          const bad = unknownPlaceholders(subject, body);
          if (bad.length) throw new HttpError(400, 'Unknown placeholder', 'VALIDATION_ERROR', [{ path: 'body', message: `Unknown placeholder: ${bad.join(', ')}` }]);
          if (patch.isDefault) await tx.emailTemplate.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
          const t = await tx.emailTemplate.update({
            where: { id },
            data: {
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              subject,
              body,
              ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
              ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
              ...(subject !== cur.subject || body !== cur.body ? { version: { increment: 1 } } : {}),
              updatedById: actor.userId,
            },
          });
          await this.audit(tx, actor, 'EMAIL_TEMPLATE_UPDATED', 'email_template', id, meta, { changed: Object.keys(patch) });
          return t;
        })
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new HttpError(409, 'A template with this name or default flag conflicts', 'CONFLICT');
      throw err;
    }
  }

  private audit(tx: Prisma.TransactionClient | PrismaClient, actor: AuthContext, action: string, resourceType: string, resourceId: string, meta: RequestMeta, details: Record<string, unknown> = {}) {
    return recordAudit(tx, { actorType: 'USER', actorUserId: actor.userId, action, resourceType, resourceId, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details });
  }

  // ------------------------------------------------------------------ drafts

  private async resolveItems(actor: AuthContext, items: DraftInput['items']): Promise<Resolved[]> {
    const ids = items.map((i) => i.versionId);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'The same version was selected twice', 'VALIDATION_ERROR', [{ path: 'items', message: 'Duplicate version' }]);
    const out: Resolved[] = [];
    for (const item of items) {
      const v = await this.db.documentVersion.findFirst({ where: { id: item.versionId, documentId: item.documentId }, include: { document: { include: { documentType: { select: { name: true } } } } } });
      // Not found, not clean, not active, or not allowed for this user: the same answer for all (no probing).
      if (!v || v.scanStatus !== 'CLEAN' || !v.document.isActive || v.document.archiveStatus !== 'LIVE' || !(await this.docs.canSend(actor, v.documentId))) {
        throw new HttpError(404, 'A selected document or version is not available for sending', 'NOT_FOUND');
      }
      out.push({ documentId: v.documentId, documentName: v.document.name, typeName: v.document.documentType.name, versionId: v.id, versionNumber: v.versionNumber, filename: v.originalFilename, sizeBytes: Number(v.sizeBytes), sha256: v.sha256 });
    }
    if (out.reduce((n, i) => n + i.sizeBytes, 0) > this.cfg.EMAIL_MAX_ATTACHMENT_TOTAL_MB * 1024 * 1024) {
      throw new HttpError(413, `Attachments are larger than ${this.cfg.EMAIL_MAX_ATTACHMENT_TOTAL_MB} MB in total`, 'PAYLOAD_TOO_LARGE');
    }
    return out;
  }

  private async makeDraft(actor: AuthContext, input: DraftInput): Promise<Draft> {
    // One entry per address; TO wins over CC wins over BCC.
    const seen = new Set<string>();
    const recipients: Draft['recipients'] = [];
    for (const [kind, list] of [['TO', input.to], ['CC', input.cc], ['BCC', input.bcc]] as [Kind, string[]][]) {
      for (const address of list) {
        if (seen.has(address)) continue;
        seen.add(address);
        recipients.push({ kind, address, external: !address.endsWith(`@${this.cfg.ALLOWED_EMAIL_DOMAIN}`) });
      }
    }
    if (recipients.length > MAX_RECIPIENTS) throw new HttpError(400, `At most ${MAX_RECIPIENTS} recipients`, 'VALIDATION_ERROR', [{ path: 'to', message: 'Too many recipients' }]);
    const hasExternal = recipients.some((r) => r.external);
    if (hasExternal && !actor.permissions.includes('email:send_external')) throw new HttpError(403, 'You may only send to internal addresses', 'FORBIDDEN');

    const items = await this.resolveItems(actor, input.items);
    const uniq = (xs: string[]) => [...new Set(xs)].join(', ');
    const values: Record<EmailPlaceholder, string> = {
      recipient_name: nameFromAddress(recipients.find((r) => r.kind === 'TO')?.address ?? ''),
      sender_name: actor.name,
      sender_email: actor.email,
      document_name: uniq(items.map((i) => i.documentName)),
      document_type: uniq(items.map((i) => i.typeName)),
      version_number: uniq(items.map((i) => String(i.versionNumber))),
      date: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: this.cfg.APP_TIMEZONE }).format(new Date()),
    };
    const bad = unknownPlaceholders(input.subject, input.body);
    if (bad.length) throw new HttpError(400, 'Unknown placeholder', 'VALIDATION_ERROR', [{ path: 'body', message: `Unknown placeholder: ${bad.join(', ')}` }]);
    const subject = renderText(input.subject, values, 'subject').slice(0, 200) || 'Documents';
    const body = renderText(input.body, values, 'body');

    const hash = sha256(JSON.stringify({ items: items.map((i) => [i.documentId, i.versionId]).sort(), r: recipients.map((r) => [r.kind, r.address]).sort(), subject, body }));
    return { recipients, subject, body, items, hasExternal, hash };
  }

  private sign(userId: string, hash: string, exp: number): string {
    const payload = b64url(JSON.stringify({ u: userId, h: hash, e: exp }));
    return `${payload}.${createHmac('sha256', this.confirmKey).update(payload).digest('base64url')}`;
  }

  private verifyToken(token: string | undefined, userId: string, hash: string): boolean {
    if (!token) return false;
    const [payload, mac, extra] = token.split('.');
    if (!payload || !mac || extra !== undefined) return false;
    const good = createHmac('sha256', this.confirmKey).update(payload).digest('base64url');
    if (good.length !== mac.length || !timingSafeEqual(Buffer.from(good), Buffer.from(mac))) return false;
    try {
      const p = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u: string; h: string; e: number };
      return p.u === userId && p.h === hash && p.e > Date.now();
    } catch {
      return false;
    }
  }

  async preview(actor: AuthContext, input: DraftInput): Promise<DraftPreview> {
    const d = await this.makeDraft(actor, input);
    const exp = Date.now() + CONFIRM_TTL_MS;
    return {
      subject: d.subject,
      body: d.body,
      from: actor.email,
      replyTo: actor.email,
      recipients: d.recipients,
      attachments: d.items.map((i) => ({ documentId: i.documentId, documentName: i.documentName, versionId: i.versionId, versionNumber: i.versionNumber, filename: i.filename, sizeBytes: i.sizeBytes, sha256: i.sha256 })),
      hasExternal: d.hasExternal,
      confirmationToken: d.hasExternal ? this.sign(actor.userId, d.hash, exp) : null,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  // ------------------------------------------------------------------ send

  /** Validates again at send time (documents may have changed since the preview), stores the record and queues the job. */
  async send(actor: AuthContext, input: SendInput, meta: RequestMeta): Promise<{ id: string; status: EmailStatus }> {
    const d = await this.makeDraft(actor, input);
    if (d.hasExternal && !this.verifyToken(input.confirmationToken, actor.userId, d.hash)) {
      throw new HttpError(409, 'External recipients must be confirmed on the preview screen first', 'CONFLICT');
    }
    const status = await this.connections.status(actor.userId, actor.email);
    if (status.status !== 'ACTIVE') throw new HttpError(409, 'Connect your Gmail account before sending', 'CONFLICT');

    try {
      const created = await this.db.$transaction(async (tx) => {
        const m = await tx.emailMessage.create({
          data: {
            senderUserId: actor.userId,
            idempotencyKey: input.idempotencyKey,
            requestHash: d.hash,
            subject: d.subject,
            bodyText: d.body,
            fromAddress: actor.email,
            replyToAddress: actor.email,
            externalConfirmed: d.hasExternal,
            templateId: input.templateId ?? null,
            recipients: { create: d.recipients.map((r) => ({ kind: r.kind, address: r.address, domain: r.address.split('@')[1]!, isExternal: r.external })) },
            attachments: { create: d.items.map((i) => ({ documentId: i.documentId, versionId: i.versionId, sha256AtSend: i.sha256, filenameSent: i.filename, sizeBytes: BigInt(i.sizeBytes) })) },
          },
        });
        await enqueueJob(tx, { type: 'send_email', payload: { messageId: m.id }, dedupeKey: `email:${m.id}` });
        await this.audit(tx, actor, 'EMAIL_QUEUED', 'email_message', m.id, meta, { recipients: d.recipients.length, attachments: d.items.length, external: d.hasExternal });
        return m;
      });
      return { id: created.id, status: 'QUEUED' };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Same key again: a retry or a double click returns the original; a different payload is an error.
        const existing = await this.db.emailMessage.findUnique({ where: { senderUserId_idempotencyKey: { senderUserId: actor.userId, idempotencyKey: input.idempotencyKey } } });
        if (existing && existing.requestHash === d.hash) return { id: existing.id, status: existing.status as EmailStatus };
        throw new HttpError(409, 'This idempotency key was already used for a different email', 'CONFLICT');
      }
      throw err;
    }
  }

  private async finish(id: string, status: 'SENT' | 'FAILED' | 'UNKNOWN', fields: { providerMessageId?: string; errorCode?: string }, auditAction: string, connectionId?: string) {
    await this.db.$transaction(async (tx) => {
      const r = await tx.emailMessage.updateMany({
        where: { id, status: 'SENDING' },
        data: { status, ...(status === 'SENT' ? { sentAt: new Date() } : {}), ...fields, ...(connectionId ? { connectionId } : {}) },
      });
      if (r.count === 1) await recordAudit(tx, { actorType: 'SYSTEM', action: auditAction, resourceType: 'email_message', resourceId: id, outcome: status === 'SENT' ? 'SUCCESS' : 'FAILURE', details: { status, errorCode: fields.errorCode ?? null } });
    });
  }

  /**
   * The send job. SENDING is claimed atomically; a job that finds a message already SENDING means a worker died
   * mid-send, and since the provider may have accepted it the outcome is UNKNOWN (never retried automatically).
   */
  async handleSend(job: JobContext): Promise<void> {
    const id = String(job.payload.messageId ?? '');
    const claimed = await this.db.emailMessage.updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'SENDING' } });
    if (claimed.count === 0) {
      const m = await this.db.emailMessage.findUnique({ where: { id }, select: { status: true } });
      if (m?.status === 'SENDING') await this.finish(id, 'UNKNOWN', { errorCode: 'WORKER_INTERRUPTED' }, 'EMAIL_UNKNOWN');
      return;
    }

    const m = await this.db.emailMessage.findUniqueOrThrow({ where: { id }, include: { recipients: true, attachments: true, sender: { select: { id: true, name: true } } } });
    let connectionId: string | undefined;
    try {
      const attachments: { filename: string; content: Buffer }[] = [];
      for (const a of m.attachments) {
        const v = await this.db.documentVersion.findUniqueOrThrow({ where: { id: a.versionId } });
        // Fully verified (checksum + authentication tags) before anything is attached.
        const content = await this.files.readVerified('clean', v.storageKey, { keyId: v.encryptionKeyId, wrappedKey: Buffer.from(v.wrappedDataKey) }, { sha256: v.sha256, size: Number(v.sizeBytes) }, 36 * 1024 * 1024);
        if (v.sha256 !== a.sha256AtSend) throw new IntegrityError('Attachment changed since it was selected');
        attachments.push({ filename: a.filenameSent, content });
      }
      const kinds = (k: string) => m.recipients.filter((r) => r.kind === k).map((r) => r.address);
      const raw = await buildMime({ fromName: m.sender.name, fromAddress: m.fromAddress, to: kinds('TO'), cc: kinds('CC'), bcc: kinds('BCC'), subject: m.subject, body: m.bodyText, messageId: m.id, attachments });
      const access = await this.connections.accessToken(m.senderUserId);
      connectionId = access.connectionId;
      const sent = await this.provider.send(access.token, raw);
      await this.finish(id, 'SENT', { providerMessageId: sent.providerMessageId }, 'EMAIL_SENT', connectionId);
    } catch (err) {
      if (err instanceof EmailProviderError) {
        if (err.kind === 'UNKNOWN_OUTCOME') return void (await this.finish(id, 'UNKNOWN', { errorCode: 'NO_CONFIRMATION' }, 'EMAIL_UNKNOWN', connectionId));
        const code = err.kind === 'AUTH_REVOKED' ? 'RECONNECT_REQUIRED' : err.kind === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'REJECTED_BY_PROVIDER';
        return void (await this.finish(id, 'FAILED', { errorCode: code }, 'EMAIL_FAILED', connectionId));
      }
      logger.error('Email send failed before reaching the provider', { messageId: id, error: err instanceof Error ? err.message : 'error' });
      await this.finish(id, 'FAILED', { errorCode: err instanceof IntegrityError ? 'INTEGRITY_FAILURE' : 'INTERNAL_ERROR' }, 'EMAIL_FAILED');
    }
  }

  // ------------------------------------------------------------------ history

  private canSeeAll = (a: AuthContext) => a.permissions.includes('email:read_all');

  async list(actor: AuthContext, q: { scope: 'mine' | 'all'; limit: number; offset: number }) {
    if (q.scope === 'all' && !this.canSeeAll(actor)) throw new HttpError(403, 'You do not have permission to perform this action', 'FORBIDDEN');
    const where: Prisma.EmailMessageWhereInput = q.scope === 'all' ? {} : { senderUserId: actor.userId };
    const [rows, total] = await Promise.all([
      this.db.emailMessage.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: q.limit, skip: q.offset, include: { sender: { select: { name: true } }, _count: { select: { recipients: true, attachments: true } } } }),
      this.db.emailMessage.count({ where }),
    ]);
    const items: EmailMessageListItem[] = rows.map((m) => ({
      id: m.id, status: m.status as EmailStatus, subject: m.subject, from: m.fromAddress, sentAt: m.sentAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString(),
      recipientCount: m._count.recipients, attachmentCount: m._count.attachments, senderName: m.sender.name,
    }));
    return { items, total };
  }

  async get(actor: AuthContext, id: string): Promise<EmailMessageDetail> {
    const m = await this.db.emailMessage.findFirst({
      where: { id, ...(this.canSeeAll(actor) ? {} : { senderUserId: actor.userId }) },
      include: { sender: { select: { name: true } }, recipients: true, attachments: true },
    });
    if (!m) throw new HttpError(404, 'Email not found');
    return {
      id: m.id, status: m.status as EmailStatus, subject: m.subject, from: m.fromAddress, replyTo: m.replyToAddress, body: m.bodyText,
      sentAt: m.sentAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString(), senderName: m.sender.name,
      recipientCount: m.recipients.length, attachmentCount: m.attachments.length,
      recipients: m.recipients.map((r) => ({ kind: r.kind as Kind, address: r.address, external: r.isExternal })),
      attachments: m.attachments.map((a) => ({ documentId: a.documentId, versionId: a.versionId, filename: a.filenameSent, sizeBytes: Number(a.sizeBytes), sha256: a.sha256AtSend })),
      providerMessageId: m.providerMessageId, errorCode: m.errorCode, externalConfirmed: m.externalConfirmed,
    };
  }

  /** A person checks the Sent folder and records what really happened to an UNKNOWN message. */
  async resolveUnknown(actor: AuthContext, id: string, outcome: 'SENT' | 'FAILED', meta: RequestMeta): Promise<EmailMessageDetail> {
    await this.get(actor, id);
    await this.db.$transaction(async (tx) => {
      const r = await tx.emailMessage.updateMany({ where: { id, status: 'UNKNOWN' }, data: { status: outcome, ...(outcome === 'SENT' ? { sentAt: new Date() } : { errorCode: 'MANUALLY_CONFIRMED_NOT_SENT' }) } });
      if (r.count !== 1) throw new HttpError(409, 'Only an email with an unknown outcome can be resolved', 'CONFLICT');
      await this.audit(tx, actor, 'EMAIL_UNKNOWN_RESOLVED', 'email_message', id, meta, { outcome });
    });
    return this.get(actor, id);
  }

  searchTemplates(search: string) {
    return this.db.emailTemplate.findMany({ where: { name: { contains: likeEscape(search), mode: 'insensitive' } }, take: 20 });
  }

  newKey() {
    return randomUUID();
  }
}

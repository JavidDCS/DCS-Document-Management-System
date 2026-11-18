import { Readable } from 'node:stream';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  permissionsForRoles,
  rolesHavePermission,
  ROLES,
  type CreateReviewCommentInput,
  type CreateShareLinkInput,
  type DraftInput,
  type PublicReviewLinkInfo,
  type ReviewCommentDto,
  type ReviewCommentStatus,
  type Role,
  type SendInput,
  type ShareLinkDto,
  type ShareLinkStatus,
} from '@dcs-docs/shared';
import type { AuthContext } from '../../types/express.js';
import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit/index.js';
import { assertEditable, lockDocument, nextVersionNumber, versionData } from '../documents/documentVersioning.js';
import type { DocumentsService } from '../documents/documents.service.js';
import type { EmailConnectionsService } from '../email/connections.service.js';
import type { EmailService } from '../email/email.service.js';
import { toRoles } from '../identity/auth.service.js';
import { generateRefreshToken, hashToken } from '../identity/tokens.js';
import { enqueueJob, type JobContext } from '../jobs/jobs.js';
import type { FileService } from '../storage/fileService.js';
import { pageCount, stamp } from './pdfStamp.service.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface ReviewConfig {
  APP_PUBLIC_URL: string;
  STORAGE_MAX_FILE_SIZE_MB: number;
}

/** Statuses a share link may be viewed, commented on through, or have its content read through. Anything else 404s. */
const USABLE_LINK_STATUSES = new Set(['SENT', 'VIEWED', 'COMMENTED']);

const DEFAULT_SHARE_SUBJECT = 'Please review: {{document_name}}';
const DEFAULT_SHARE_BODY = [
  'Hello {{recipient_name}},',
  '',
  '{{sender_name}} has shared "{{document_name}}" ({{document_type}}, version {{version_number}}) with you for review.',
  '',
  'Open it using the secure link below. No account or sign-in is needed:',
  '{{review_link}}',
  '',
  'This link expires on {{date}}.',
].join('\n');

type ShareLinkRow = {
  id: string;
  documentId: string;
  versionId: string;
  recipientEmail: string;
  status: string;
  previousLinkId: string | null;
  expiresAt: Date;
  viewedAt: Date | null;
  createdAt: Date;
  createdBy: { id: string; name: string };
};

type CommentRow = {
  id: string;
  shareLinkId: string;
  pageNumber: number;
  xPct: number;
  yPct: number;
  body: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: { id: string; name: string } | null;
  resolutionNote: string | null;
};

/**
 * External document review: mints a possession-token share link for a document, lets staff review and act on the
 * client's one open comment, and stamps a pre-approved signature onto a re-versioned PDF when a comment is
 * accepted. Reuses the exact lock/version pattern documents.service.ts already uses for `restore()`.
 */
export class ReviewService {
  private readonly publicUrl: string;
  private readonly maxBytes: number;

  constructor(
    private readonly db: PrismaClient,
    private readonly files: FileService,
    private readonly docs: DocumentsService,
    private readonly email: EmailService,
    private readonly connections: EmailConnectionsService,
    cfg: ReviewConfig
  ) {
    this.publicUrl = cfg.APP_PUBLIC_URL.replace(/\/+$/, '');
    this.maxBytes = cfg.STORAGE_MAX_FILE_SIZE_MB * 1024 * 1024;
  }

  // ------------------------------------------------------------------ mapping

  private toShareLinkDto(r: ShareLinkRow): ShareLinkDto {
    return {
      id: r.id,
      documentId: r.documentId,
      versionId: r.versionId,
      recipientEmail: r.recipientEmail,
      status: r.status as ShareLinkStatus,
      previousLinkId: r.previousLinkId,
      expiresAt: r.expiresAt.toISOString(),
      viewedAt: r.viewedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
    };
  }

  private toCommentDto(c: CommentRow): ReviewCommentDto {
    return {
      id: c.id,
      shareLinkId: c.shareLinkId,
      pageNumber: c.pageNumber,
      xPct: c.xPct,
      yPct: c.yPct,
      body: c.body,
      status: c.status as ReviewCommentStatus,
      createdAt: c.createdAt.toISOString(),
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      resolvedBy: c.resolvedBy,
      resolutionNote: c.resolutionNote,
    };
  }

  private async assertDocumentExists(documentId: string) {
    if (!(await this.db.document.findUnique({ where: { id: documentId }, select: { id: true } }))) throw new HttpError(404, 'Document not found');
  }

  /** Same visibility/sendability rule EmailService.resolveItems applies to a single item. */
  private async loadSendableDocument(actor: AuthContext, documentId: string) {
    const allowed = await this.docs.canSend(actor, documentId);
    if (!allowed) throw new HttpError(404, 'Document not found');
    const doc = await this.db.document.findUnique({ where: { id: documentId }, include: { currentVersion: true } });
    if (!doc || !doc.isActive || doc.archiveStatus !== 'LIVE' || !doc.currentVersion || doc.currentVersion.scanStatus !== 'CLEAN') {
      throw new HttpError(404, 'This document or its current version is not available for sending', 'NOT_FOUND');
    }
    return doc;
  }

  // ------------------------------------------------------------------ internal: create & (re)send a share link

  async createAndSend(actor: AuthContext, documentId: string, input: CreateShareLinkInput, meta: RequestMeta): Promise<ShareLinkDto> {
    const doc = await this.loadSendableDocument(actor, documentId);
    const versionId = doc.currentVersion!.id;

    let previous: { id: string; status: string } | null = null;
    if (input.previousLinkId) {
      previous = await this.db.documentShareLink.findFirst({ where: { id: input.previousLinkId, documentId }, select: { id: true, status: true } });
      if (!previous) throw new HttpError(404, 'Previous share link not found');
      if (previous.status !== 'ACCEPTED' && previous.status !== 'DISMISSED') {
        throw new HttpError(409, 'Only a link that has reached ACCEPTED or DISMISSED may be resent', 'CONFLICT');
      }
    }

    const token = generateRefreshToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

    const link = await this.db.$transaction(async (tx) => {
      const row = await tx.documentShareLink.create({
        data: { documentId, versionId, tokenHash, createdById: actor.userId, recipientEmail: input.recipientEmail, expiresAt, previousLinkId: previous?.id ?? null },
      });
      await recordAudit(tx, {
        actorType: 'USER', actorUserId: actor.userId, action: 'REVIEW_SHARE_LINK_CREATED', resourceType: 'document_share_link', resourceId: row.id,
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { documentId, versionId, resend: Boolean(previous) },
      });
      return row;
    });

    // The raw token exists only here and in the one outbound email below; it is never logged or stored again.
    const linkUrl = `${this.publicUrl}/review/${token}`;

    let subject = DEFAULT_SHARE_SUBJECT;
    let body = DEFAULT_SHARE_BODY;
    if (input.templateId) {
      const tpl = await this.db.emailTemplate.findUnique({ where: { id: input.templateId } });
      if (!tpl || !tpl.isActive) throw new HttpError(400, 'Unknown or inactive email template', 'VALIDATION_ERROR', [{ path: 'templateId', message: 'Unknown or inactive template' }]);
      subject = tpl.subject;
      body = tpl.body;
    }

    const draftInput: DraftInput = {
      items: [{ documentId, versionId }],
      to: [input.recipientEmail],
      cc: [],
      bcc: [],
      subject,
      body,
      templateId: input.templateId,
      attach: input.attach,
      extra: { review_link: linkUrl },
    };

    try {
      // Reuses EmailService's own external-send confirmation dance (preview -> confirmationToken -> send), the
      // same mechanism that protects every other external send, rather than inventing a parallel one.
      const draftPreview = await this.email.preview(actor, draftInput);
      const sendInput: SendInput = { ...draftInput, idempotencyKey: this.email.newKey(), confirmationToken: draftPreview.confirmationToken ?? undefined };
      const sent = await this.email.send(actor, sendInput, meta);
      await this.db.documentShareLink.update({ where: { id: link.id }, data: { initialEmailMessageId: sent.id } });
    } catch (err) {
      await this.db.documentShareLink.update({ where: { id: link.id }, data: { status: 'FAILED' } }).catch(() => undefined);
      throw err;
    }

    const final = await this.db.documentShareLink.findUniqueOrThrow({ where: { id: link.id }, include: { createdBy: { select: { id: true, name: true } } } });
    return this.toShareLinkDto(final);
  }

  async listShareLinks(documentId: string): Promise<ShareLinkDto[]> {
    await this.assertDocumentExists(documentId);
    const rows = await this.db.documentShareLink.findMany({ where: { documentId }, orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { id: true, name: true } } } });
    return rows.map((r) => this.toShareLinkDto(r));
  }

  // ------------------------------------------------------------------ internal: list/accept/dismiss comments

  async listReviewComments(documentId: string): Promise<ReviewCommentDto[]> {
    await this.assertDocumentExists(documentId);
    const rows = await this.db.documentReviewComment.findMany({
      where: { shareLink: { documentId } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: { resolvedBy: { select: { id: true, name: true } } },
    });
    return rows.map((r) => this.toCommentDto(r));
  }

  /** Accept = re-stamp only: the PDF content is unchanged, a signature image is embedded and a new version is created. */
  async acceptComment(actor: AuthContext, commentId: string, input: { signatureAssetId?: string | undefined }, meta: RequestMeta): Promise<ReviewCommentDto> {
    const comment = await this.db.documentReviewComment.findUnique({ where: { id: commentId }, include: { shareLink: { include: { version: true } } } });
    if (!comment || comment.status !== 'OPEN') throw new HttpError(404, 'Comment not found');
    const srcVersion = comment.shareLink.version;
    if (srcVersion.scanStatus !== 'CLEAN') throw new HttpError(409, 'The reviewed version is no longer clean', 'CONFLICT');

    const signature = input.signatureAssetId
      ? await this.db.signatureAsset.findFirst({ where: { id: input.signatureAssetId, isActive: true } })
      : await this.db.signatureAsset.findFirst({ where: { isDefault: true, isActive: true } });
    if (!signature) throw new HttpError(409, 'No signature is configured; choose one or mark one as the default signature asset', 'CONFLICT');

    const pdfBytes = await this.files.readVerified(
      'clean', srcVersion.storageKey,
      { keyId: srcVersion.encryptionKeyId, wrappedKey: Buffer.from(srcVersion.wrappedDataKey) },
      { sha256: srcVersion.sha256, size: Number(srcVersion.sizeBytes) },
      this.maxBytes + 1024 * 1024
    );
    const sigBytes = await this.files.readVerified(
      'clean', signature.storageKey,
      { keyId: signature.encryptionKeyId, wrappedKey: Buffer.from(signature.wrappedDataKey) },
      { sha256: signature.sha256, size: Number(signature.sizeBytes) },
      10 * 1024 * 1024
    );

    const pages = await pageCount(pdfBytes);
    if (signature.pageNumber > pages) {
      throw new HttpError(409, `The signature's page (${signature.pageNumber}) is beyond this document's ${pages} page(s)`, 'CONFLICT');
    }

    const stamped = await stamp({ pdfBytes, signature: { bytes: sigBytes, pageNumber: signature.pageNumber, xPt: signature.xPt, yPt: signature.yPt, widthPt: signature.widthPt, heightPt: signature.heightPt } });
    const stored = await this.files.store('clean', Readable.from(stamped), { maxBytes: this.maxBytes });

    try {
      const updatedComment = await this.db.$transaction(async (tx) => {
        const documentId = comment.shareLink.documentId;
        const doc = await lockDocument(tx, documentId);
        assertEditable(doc.archiveStatus);
        const n = await nextVersionNumber(tx, documentId);
        const v = await tx.documentVersion.create({
          data: {
            ...versionData(documentId, n, { filename: srcVersion.originalFilename, stored }, actor.userId, 'Stamped after accepting a client review comment'),
            scanStatus: 'CLEAN',
            scannedAt: new Date(),
            scanDetails: { source: 'review_accept', commentId, signatureAssetId: signature.id },
          },
        });
        await tx.document.update({ where: { id: documentId }, data: { currentVersionId: v.id } });
        const c = await tx.documentReviewComment.update({
          where: { id: commentId },
          data: { status: 'ACCEPTED', resolvedById: actor.userId, resolvedAt: new Date(), resultingVersionId: v.id },
          include: { resolvedBy: { select: { id: true, name: true } } },
        });
        await tx.documentShareLink.update({ where: { id: comment.shareLinkId }, data: { status: 'ACCEPTED' } });
        await recordAudit(tx, {
          actorType: 'USER', actorUserId: actor.userId, action: 'REVIEW_COMMENT_ACCEPTED', resourceType: 'document_review_comment', resourceId: commentId,
          ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { documentId, versionId: v.id, signatureAssetId: signature.id },
        });
        return c;
      });
      return this.toCommentDto(updatedComment);
    } catch (err) {
      await this.files.delete('clean', stored.storageKey).catch(() => undefined);
      throw err;
    }
  }

  async dismissComment(actor: AuthContext, commentId: string, input: { resolutionNote?: string | undefined }, meta: RequestMeta): Promise<ReviewCommentDto> {
    const comment = await this.db.documentReviewComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.status !== 'OPEN') throw new HttpError(404, 'Comment not found');
    const updated = await this.db.$transaction(async (tx) => {
      const c = await tx.documentReviewComment.update({
        where: { id: commentId },
        data: { status: 'DISMISSED', resolvedById: actor.userId, resolvedAt: new Date(), resolutionNote: input.resolutionNote ?? null },
        include: { resolvedBy: { select: { id: true, name: true } } },
      });
      await tx.documentShareLink.update({ where: { id: comment.shareLinkId }, data: { status: 'DISMISSED' } });
      await recordAudit(tx, {
        actorType: 'USER', actorUserId: actor.userId, action: 'REVIEW_COMMENT_DISMISSED', resourceType: 'document_review_comment', resourceId: commentId,
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { shareLinkId: comment.shareLinkId },
      });
      return c;
    });
    return this.toCommentDto(updated);
  }

  // ------------------------------------------------------------------ public, unauthenticated routes

  /**
   * Looks up a link by its token's hash. Missing, expired, revoked or already-consumed (ACCEPTED/DISMISSED/FAILED)
   * all throw the exact same 404 -- a possession token is the only credential here, like a password-reset link, so
   * nothing about WHY a token doesn't work is ever revealed.
   */
  private async loadActiveLinkByToken(token: string) {
    const tokenHash = hashToken(token);
    const link = await this.db.documentShareLink.findUnique({ where: { tokenHash }, include: { document: { select: { id: true, name: true } }, version: true } });
    if (!link || !USABLE_LINK_STATUSES.has(link.status) || link.expiresAt.getTime() < Date.now()) {
      throw new HttpError(404, 'Review link not found', 'NOT_FOUND');
    }
    return link;
  }

  private externalAudit(action: string, linkId: string, meta: RequestMeta, details: Record<string, unknown> = {}) {
    return recordAudit(this.db, { actorType: 'EXTERNAL', action, resourceType: 'document_share_link', resourceId: linkId, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details });
  }

  async getPublicLink(token: string, meta: RequestMeta): Promise<PublicReviewLinkInfo> {
    const link = await this.loadActiveLinkByToken(token);
    if (link.status === 'SENT') {
      await this.db.documentShareLink.update({ where: { id: link.id }, data: { status: 'VIEWED', viewedAt: link.viewedAt ?? new Date() } });
    }
    await this.externalAudit('REVIEW_LINK_VIEWED', link.id, meta, { documentId: link.documentId });

    const v = link.version;
    const pdfBytes = await this.files.readVerified(
      'clean', v.storageKey,
      { keyId: v.encryptionKeyId, wrappedKey: Buffer.from(v.wrappedDataKey) },
      { sha256: v.sha256, size: Number(v.sizeBytes) },
      this.maxBytes + 1024 * 1024
    );
    const pages = await pageCount(pdfBytes);
    const comments = await this.db.documentReviewComment.findMany({ where: { shareLinkId: link.id }, orderBy: { createdAt: 'asc' }, include: { resolvedBy: { select: { id: true, name: true } } } });
    return {
      documentName: link.document.name,
      versionId: link.versionId,
      pageCount: pages,
      expiresAt: link.expiresAt.toISOString(),
      status: 'ACTIVE',
      comments: comments.map((c) => this.toCommentDto(c)),
    };
  }

  async getPublicContent(token: string, meta: RequestMeta): Promise<{ data: Buffer; filename: string; sha256: string }> {
    const link = await this.loadActiveLinkByToken(token);
    await this.externalAudit('REVIEW_LINK_CONTENT_VIEWED', link.id, meta, { documentId: link.documentId, versionId: link.versionId });
    const v = link.version;
    const data = await this.files.readVerified(
      'clean', v.storageKey,
      { keyId: v.encryptionKeyId, wrappedKey: Buffer.from(v.wrappedDataKey) },
      { sha256: v.sha256, size: Number(v.sizeBytes) },
      this.maxBytes + 1024 * 1024
    );
    return { data, filename: v.originalFilename, sha256: v.sha256 };
  }

  async submitComment(token: string, input: CreateReviewCommentInput, meta: RequestMeta): Promise<ReviewCommentDto> {
    const link = await this.loadActiveLinkByToken(token);
    try {
      const created = await this.db.$transaction(async (tx) => {
        const c = await tx.documentReviewComment.create({
          data: { shareLinkId: link.id, pageNumber: input.pageNumber, xPct: input.xPct, yPct: input.yPct, body: input.body, clientIp: meta.ip, userAgent: meta.userAgent },
          include: { resolvedBy: { select: { id: true, name: true } } },
        });
        if (link.status !== 'COMMENTED') await tx.documentShareLink.update({ where: { id: link.id }, data: { status: 'COMMENTED' } });
        await recordAudit(tx, {
          actorType: 'EXTERNAL', action: 'REVIEW_COMMENT_SUBMITTED', resourceType: 'document_review_comment', resourceId: c.id,
          ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { shareLinkId: link.id, documentId: link.documentId },
        });
        await enqueueJob(tx, { type: 'notify_review_comment', payload: { commentId: c.id }, dedupeKey: `notify-review-comment:${c.id}` });
        return c;
      });
      return this.toCommentDto(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(409, 'This review link already has an open comment awaiting a response from staff', 'CONFLICT');
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ background job: notify the review team

  /**
   * Fires after a comment is submitted. Sent through the share link's creator's own connected Gmail, to every
   * ACTIVE user holding `documents:review` -- never attaching the PDF. Idempotent: a retried job that already
   * recorded an outcome for this comment is a no-op.
   */
  async handleNotify(job: JobContext): Promise<void> {
    const commentId = String(job.payload.commentId ?? '');
    const already = await this.db.auditLog.count({ where: { resourceId: commentId, action: { in: ['REVIEW_COMMENT_NOTIFIED', 'REVIEW_COMMENT_NOTIFICATION_FAILED'] } } });
    if (already > 0) return;

    const comment = await this.db.documentReviewComment.findUniqueOrThrow({
      where: { id: commentId },
      include: { shareLink: { include: { createdBy: { include: { roles: true } } } } },
    });
    const link = comment.shareLink;
    const creator = link.createdBy;

    const reviewRoles = ROLES.filter((r) => rolesHavePermission([r], 'documents:review'));
    const team = await this.db.user.findMany({ where: { status: 'ACTIVE', roles: { some: { role: { in: reviewRoles } } } }, select: { email: true }, distinct: ['email'] });
    const recipients = team.map((u) => u.email);
    if (recipients.length === 0) {
      logger.warn('No team member holds documents:review to notify about a review comment', { commentId });
      return;
    }

    const gmail = await this.connections.status(creator.id, creator.email);
    if (gmail.status !== 'ACTIVE') {
      await recordAudit(this.db, {
        actorType: 'SYSTEM', action: 'REVIEW_COMMENT_NOTIFICATION_FAILED', resourceType: 'document_review_comment', resourceId: commentId, outcome: 'FAILURE',
        details: { reason: 'GMAIL_NOT_CONNECTED', shareLinkId: link.id },
      });
      return;
    }

    const creatorRoles: Role[] = toRoles(creator.roles);
    const actorCtx: AuthContext = {
      userId: creator.id,
      sessionId: `job:${job.id}`,
      email: creator.email,
      name: creator.name,
      status: creator.status === 'ACTIVE' ? 'ACTIVE' : 'INVITED',
      roles: creatorRoles,
      permissions: permissionsForRoles(creatorRoles),
      mustChangePassword: false,
      authTime: new Date(),
    };
    // Points staff at the INTERNAL review page (not the public client link) -- reusing the same {{review_link}}
    // placeholder generically, with a different URL for this internal audience.
    const reviewUrl = `${this.publicUrl}/documents/${link.documentId}#comments`;
    const draftInput: DraftInput = {
      items: [{ documentId: link.documentId, versionId: link.versionId }],
      to: recipients,
      cc: [],
      bcc: [],
      subject: 'New review comment on {{document_name}}',
      body: 'A client left a comment on "{{document_name}}" ({{document_type}}, version {{version_number}}).\n\nReview it here:\n{{review_link}}\n',
      attach: false,
      extra: { review_link: reviewUrl },
    };
    const draftPreview = await this.email.preview(actorCtx, draftInput);
    const sendInput: SendInput = { ...draftInput, idempotencyKey: this.email.newKey(), confirmationToken: draftPreview.confirmationToken ?? undefined };
    await this.email.send(actorCtx, sendInput, { ip: null, userAgent: null, requestId: `job:${job.id}` });
    await recordAudit(this.db, { actorType: 'SYSTEM', action: 'REVIEW_COMMENT_NOTIFIED', resourceType: 'document_review_comment', resourceId: commentId, outcome: 'SUCCESS', details: { recipients: recipients.length } });
  }
}

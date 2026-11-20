import { Readable } from 'node:stream';
import type { DocumentVersion, Prisma, PrismaClient } from '@prisma/client';
import {
  permissionsForRoles,
  rolesHavePermission,
  ROLES,
  type ApplyReviewChangesInput,
  type CreateReviewCommentInput,
  type CreateShareLinkInput,
  type DraftInput,
  type PublicReviewLinkInfo,
  type ReviewCommentDto,
  type ReviewCommentKind,
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
import {
  assertEditable,
  lockDocument,
  nextVersionNumber,
  REVIEW_SOURCE_APPLY,
  REVIEW_SOURCE_INCORPORATE,
  REVIEW_SOURCE_SIGNATURE,
  versionData,
} from '../documents/documentVersioning.js';
import type { DocumentsService } from '../documents/documents.service.js';
import type { EmailConnectionsService } from '../email/connections.service.js';
import type { EmailService } from '../email/email.service.js';
import { toRoles } from '../identity/auth.service.js';
import { generateRefreshToken, hashToken } from '../identity/tokens.js';
import { enqueueJob, type JobContext } from '../jobs/jobs.js';
import type { FileService } from '../storage/fileService.js';
import type { StirlingPdfProvider } from '../../providers/pdf/stirlingPdf.js';
import { applyReplacements, pageCount, stamp, UnsupportedTextError } from './pdfStamp.service.js';

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

/** A client may raise many comments, but a leaked link must not be a way to flood the team's inbox and database. */
const MAX_COMMENTS_PER_LINK = 100;

/** `scanDetails.source` of the versions this module creates; used to tell "derived from the reviewed PDF" apart from a fresh upload. */
const SOURCE_APPLY = REVIEW_SOURCE_APPLY;
const SOURCE_SIGNATURE = REVIEW_SOURCE_SIGNATURE;
const SOURCE_INCORPORATE = REVIEW_SOURCE_INCORPORATE;
const DEFAULT_SIGNING_SUBJECT = 'Please review and sign: {{document_name}}';
const DEFAULT_SIGNING_BODY = [
  'Hello {{recipient_name}},',
  '',
  '{{sender_name}} has sent you the final version of "{{document_name}}" ({{document_type}}, version {{version_number}}) for signing.',
  'The PDF is attached. You can also open it using the secure link below. No account or sign-in is needed:',
  '{{review_link}}',
  '',
  'This link expires on {{date}}.',
].join('\n');

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
  kind: string;
  pageNumber: number;
  xPct: number;
  yPct: number;
  boxWPct: number | null;
  boxHPct: number | null;
  originalText: string | null;
  replacementText: string | null;
  editedReplacementText: string | null;
  resultingVersionId: string | null;
  body: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: { id: string; name: string } | null;
  resolutionNote: string | null;
};

/**
 * External document review, end to end:
 *   1. staff email a possession-token share link (and the client opens it with no account);
 *   2. the client leaves any number of comments and suggested text changes;
 *   3. staff accept or dismiss each one -- the link closes itself once none is left open;
 *   4. staff apply the accepted changes to the PDF (a new version), then stamp the pre-approved signature (another);
 *   5. staff send the final PDF back to the client.
 * Steps 4 reuse the exact lock/version pattern documents.service.ts already uses for `restore()`.
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
    private readonly stirlingPdf: StirlingPdfProvider,
    cfg: ReviewConfig
  ) {
    this.publicUrl = cfg.APP_PUBLIC_URL.replace(/\/+$/, '');
    this.maxBytes = cfg.STORAGE_MAX_FILE_SIZE_MB * 1024 * 1024;
  }

  get maxUploadBytes() {
    return this.maxBytes;
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
      kind: c.kind as ReviewCommentKind,
      pageNumber: c.pageNumber,
      xPct: c.xPct,
      yPct: c.yPct,
      boxWPct: c.boxWPct,
      boxHPct: c.boxHPct,
      originalText: c.originalText,
      replacementText: c.replacementText,
      editedReplacementText: c.editedReplacementText,
      applied: c.kind === 'CHANGE' && c.resultingVersionId !== null,
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

    const signing = input.purpose === 'SIGNING';
    let subject = signing ? DEFAULT_SIGNING_SUBJECT : DEFAULT_SHARE_SUBJECT;
    let body = signing ? DEFAULT_SIGNING_BODY : DEFAULT_SHARE_BODY;
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
      // The final, signed-off PDF always travels with a signing email; a plain review email attaches only on request.
      attach: input.attach || signing,
      extra: { review_link: linkUrl },
    };

    try {
      // Reuses EmailService's own external-send confirmation dance (preview -> confirmationToken -> send), the
      // same mechanism that protects every other external send, rather than inventing a parallel one. Passing
      // `handoffId` through lets EmailService.send do its own hand-off validation/claim exactly as it already
      // does for an attachment send, so a Leads Manager hand-off's ref still reaches sent-lookup through a
      // review link instead of a raw attachment.
      const draftPreview = await this.email.preview(actor, draftInput);
      const sendInput: SendInput = { ...draftInput, idempotencyKey: this.email.newKey(), confirmationToken: draftPreview.confirmationToken ?? undefined, handoffId: input.handoffId };
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

  /** Closes the client's link once staff have answered everything on it: ACCEPTED if anything was accepted, else
   * DISMISSED. Both are terminal for the client (their link stops working) and are what a signing/resend builds on. */
  private async closeLinkIfAnswered(tx: Prisma.TransactionClient, shareLinkId: string): Promise<void> {
    const open = await tx.documentReviewComment.count({ where: { shareLinkId, status: 'OPEN' } });
    if (open > 0) return;
    const accepted = await tx.documentReviewComment.count({ where: { shareLinkId, status: 'ACCEPTED' } });
    await tx.documentShareLink.update({ where: { id: shareLinkId }, data: { status: accepted > 0 ? 'ACCEPTED' : 'DISMISSED' } });
  }

  private readVersionBytes(v: DocumentVersion): Promise<Buffer> {
    return this.files.readVerified(
      'clean', v.storageKey,
      { keyId: v.encryptionKeyId, wrappedKey: Buffer.from(v.wrappedDataKey) },
      { sha256: v.sha256, size: Number(v.sizeBytes) },
      this.maxBytes + 1024 * 1024
    );
  }

  private versionSource(v: DocumentVersion): string | null {
    const s = (v.scanDetails as { source?: unknown } | null)?.source;
    return typeof s === 'string' ? s : null;
  }

  /** A PDF a person has a review open against is only a safe base for new edits while nothing else was uploaded since. */
  private assertDerivedFromReviewed(base: DocumentVersion, reviewedVersionId: string): void {
    const src = this.versionSource(base);
    if (base.id === reviewedVersionId || src === SOURCE_APPLY || src === SOURCE_SIGNATURE || src === SOURCE_INCORPORATE) return;
    throw new HttpError(409, 'A newer version was uploaded after this review link was sent, so the client\'s marks no longer line up. Send a fresh review link for the current version.', 'CONFLICT');
  }

  private async loadCurrentVersion(documentId: string): Promise<DocumentVersion> {
    const doc = await this.db.document.findUnique({ where: { id: documentId }, include: { currentVersion: true } });
    if (!doc) throw new HttpError(404, 'Document not found');
    const v = doc.currentVersion;
    if (!v) throw new HttpError(409, 'This document has no current version', 'CONFLICT');
    if (v.scanStatus !== 'CLEAN') throw new HttpError(409, 'The current version is not clean, so it cannot be edited', 'CONFLICT');
    return v;
  }

  /**
   * Writes `bytes` as the document's next version under the document row lock, then runs `after` in the same
   * transaction. Fails with 409 if the current version moved while the PDF was being prepared, so an edit is never
   * written on top of a version the person did not see. The stored file is removed again if the transaction fails.
   */
  private async commitDerivedVersion(args: {
    actor: AuthContext;
    documentId: string;
    base: DocumentVersion;
    bytes: Buffer;
    changeNote: string;
    scanDetails: Prisma.InputJsonObject;
    meta: RequestMeta;
    auditAction: string;
    auditDetails: Record<string, unknown>;
    after?: (tx: Prisma.TransactionClient, versionId: string) => Promise<void>;
  }): Promise<{ versionId: string; versionNumber: number }> {
    const { actor, documentId, base, meta } = args;
    const stored = await this.files.store('clean', Readable.from(args.bytes), { maxBytes: this.maxBytes });
    try {
      return await this.db.$transaction(async (tx) => {
        const doc = await lockDocument(tx, documentId);
        assertEditable(doc.archiveStatus);
        if (doc.currentVersionId !== base.id) throw new HttpError(409, 'The document changed while this was being prepared. Reload and try again.', 'CONFLICT');
        const n = await nextVersionNumber(tx, documentId);
        const v = await tx.documentVersion.create({
          data: {
            ...versionData(documentId, n, { filename: base.originalFilename, stored }, actor.userId, args.changeNote),
            scanStatus: 'CLEAN',
            scannedAt: new Date(),
            scanDetails: args.scanDetails,
          },
        });
        await tx.document.update({ where: { id: documentId }, data: { currentVersionId: v.id } });
        if (args.after) await args.after(tx, v.id);
        await recordAudit(tx, {
          actorType: 'USER', actorUserId: actor.userId, action: args.auditAction, resourceType: 'document', resourceId: documentId,
          ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { ...args.auditDetails, versionId: v.id, versionNumber: n },
        });
        return { versionId: v.id, versionNumber: n };
      });
    } catch (err) {
      await this.files.delete('clean', stored.storageKey).catch(() => undefined);
      throw err;
    }
  }

  /** Accept = "yes, make this change". It records the decision only; the PDF is written later, in one go, by
   * applyChanges/incorporateChanges, which use `editedReplacementText` over the client's own `replacementText`
   * whenever staff supplied one here -- the client's original submission is never overwritten. */
  async acceptComment(
    actor: AuthContext,
    commentId: string,
    input: { resolutionNote?: string | undefined; editedReplacementText?: string | undefined },
    meta: RequestMeta
  ): Promise<ReviewCommentDto> {
    const comment = await this.db.documentReviewComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.status !== 'OPEN') throw new HttpError(404, 'Comment not found');
    if (input.editedReplacementText !== undefined && comment.kind !== 'CHANGE') {
      throw new HttpError(400, 'Only a suggested change can have its wording edited', 'VALIDATION_ERROR', [{ path: 'editedReplacementText', message: 'Only a CHANGE comment can carry this field' }]);
    }
    const updated = await this.db.$transaction(async (tx) => {
      const c = await tx.documentReviewComment.update({
        where: { id: commentId },
        data: {
          status: 'ACCEPTED',
          resolvedById: actor.userId,
          resolvedAt: new Date(),
          resolutionNote: input.resolutionNote ?? null,
          ...(input.editedReplacementText !== undefined ? { editedReplacementText: input.editedReplacementText } : {}),
        },
        include: { resolvedBy: { select: { id: true, name: true } } },
      });
      await this.closeLinkIfAnswered(tx, comment.shareLinkId);
      await recordAudit(tx, {
        actorType: 'USER', actorUserId: actor.userId, action: 'REVIEW_COMMENT_ACCEPTED', resourceType: 'document_review_comment', resourceId: commentId,
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { shareLinkId: comment.shareLinkId, kind: comment.kind, wordingEdited: input.editedReplacementText !== undefined },
      });
      return c;
    });
    return this.toCommentDto(updated);
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
      await this.closeLinkIfAnswered(tx, comment.shareLinkId);
      await recordAudit(tx, {
        actorType: 'USER', actorUserId: actor.userId, action: 'REVIEW_COMMENT_DISMISSED', resourceType: 'document_review_comment', resourceId: commentId,
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { shareLinkId: comment.shareLinkId, kind: comment.kind },
      });
      return c;
    });
    return this.toCommentDto(updated);
  }

  // ------------------------------------------------------------------ internal: write the result into the PDF

  /**
   * Step 4a. Writes every ACCEPTED, not-yet-applied suggested change of one link into the PDF as a new version
   * (each box whited out and the new text drawn in). All comments on the link must be answered first, so a round is
   * never applied half-way.
   */
  async applyChanges(actor: AuthContext, documentId: string, input: ApplyReviewChangesInput, meta: RequestMeta): Promise<{ versionId: string; versionNumber: number; applied: number }> {
    const link = await this.db.documentShareLink.findFirst({ where: { id: input.shareLinkId, documentId } });
    if (!link) throw new HttpError(404, 'Review link not found');

    const open = await this.db.documentReviewComment.count({ where: { shareLinkId: link.id, status: 'OPEN' } });
    if (open > 0) throw new HttpError(409, `Accept or dismiss the ${open} open comment${open === 1 ? '' : 's'} on this link first`, 'CONFLICT');

    const pending = await this.db.documentReviewComment.findMany({
      where: { shareLinkId: link.id, kind: 'CHANGE', status: 'ACCEPTED', resultingVersionId: null },
      orderBy: { createdAt: 'asc' },
    });
    if (pending.length === 0) throw new HttpError(409, 'There are no accepted changes waiting to be applied', 'CONFLICT');

    const base = await this.loadCurrentVersion(documentId);
    this.assertDerivedFromReviewed(base, link.versionId);

    const pdfBytes = await this.readVersionBytes(base);
    let edited: Buffer;
    try {
      edited = await applyReplacements(
        pdfBytes,
        pending.map((c) => ({ pageNumber: c.pageNumber, xPct: c.xPct, yPct: c.yPct, wPct: c.boxWPct ?? 0, hPct: c.boxHPct ?? 0, text: c.editedReplacementText ?? c.replacementText ?? '' }))
      );
    } catch (err) {
      if (err instanceof UnsupportedTextError) {
        throw new HttpError(400, `${err.message}. Dismiss that change or ask the client for plain letters and numbers.`, 'VALIDATION_ERROR');
      }
      if (err instanceof RangeError) throw new HttpError(409, 'One of the changes points at a page this document does not have', 'CONFLICT');
      throw err;
    }

    const ids = pending.map((c) => c.id);
    const done = await this.commitDerivedVersion({
      actor, documentId, base, bytes: edited, meta,
      changeNote: `Applied ${ids.length} accepted client change${ids.length === 1 ? '' : 's'}`,
      scanDetails: { source: SOURCE_APPLY, shareLinkId: link.id, commentIds: ids },
      auditAction: 'REVIEW_CHANGES_APPLIED',
      auditDetails: { shareLinkId: link.id, commentIds: ids },
      after: async (tx, versionId) => {
        await tx.documentReviewComment.updateMany({ where: { id: { in: ids } }, data: { resultingVersionId: versionId } });
      },
    });
    return { ...done, applied: ids.length };
  }

  /**
   * Step 4b. Stamps the pre-approved signature image at its configured spot on the current version, as a new
   * version. Refused while accepted changes are still waiting to be applied (the signature must go on last), and a
   * version that already carries it is never stamped twice.
   */
  async stampSignature(actor: AuthContext, documentId: string, input: { signatureAssetId?: string | undefined }, meta: RequestMeta): Promise<{ versionId: string; versionNumber: number }> {
    const base = await this.loadCurrentVersion(documentId);
    if (this.versionSource(base) === SOURCE_SIGNATURE) throw new HttpError(409, 'This version already carries the signature', 'CONFLICT');

    const waiting = await this.db.documentReviewComment.count({ where: { kind: 'CHANGE', status: 'ACCEPTED', resultingVersionId: null, shareLink: { documentId } } });
    if (waiting > 0) throw new HttpError(409, `Apply the ${waiting} accepted change${waiting === 1 ? '' : 's'} first: the signature goes on last`, 'CONFLICT');

    const signature = input.signatureAssetId
      ? await this.db.signatureAsset.findFirst({ where: { id: input.signatureAssetId, isActive: true } })
      : await this.db.signatureAsset.findFirst({ where: { isDefault: true, isActive: true } });
    if (!signature) throw new HttpError(409, 'No signature is configured; choose one or mark one as the default signature asset', 'CONFLICT');

    const pdfBytes = await this.readVersionBytes(base);
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

    return this.commitDerivedVersion({
      actor, documentId, base, bytes: stamped, meta,
      changeNote: 'Signature added',
      scanDetails: { source: SOURCE_SIGNATURE, signatureAssetId: signature.id },
      auditAction: 'REVIEW_SIGNATURE_STAMPED',
      auditDetails: { signatureAssetId: signature.id },
    });
  }

  /**
   * The one-button combined step: applies every ACCEPTED, not-yet-applied suggested change as a SINGLE new
   * version, and stamps the configured signature onto it too if one is set up. The signature is optional --
   * staff who add a signature or stamp themselves another way (e.g. in Stirling-PDF) can incorporate the text
   * changes with none configured at all. Everything happens in memory before anything is written, so a failure
   * at any point (an unsupported character in a replacement, a signature page out of range) leaves the document
   * exactly as it was -- never a half-applied version.
   */
  async incorporateChanges(actor: AuthContext, documentId: string, input: { shareLinkId: string; signatureAssetId?: string | undefined }, meta: RequestMeta): Promise<{ versionId: string; versionNumber: number; applied: number }> {
    const link = await this.db.documentShareLink.findFirst({ where: { id: input.shareLinkId, documentId } });
    if (!link) throw new HttpError(404, 'Review link not found');

    const open = await this.db.documentReviewComment.count({ where: { shareLinkId: link.id, status: 'OPEN' } });
    if (open > 0) throw new HttpError(409, `Accept or dismiss the ${open} open comment${open === 1 ? '' : 's'} on this link first`, 'CONFLICT');

    const pending = await this.db.documentReviewComment.findMany({
      where: { shareLinkId: link.id, kind: 'CHANGE', status: 'ACCEPTED', resultingVersionId: null },
      orderBy: { createdAt: 'asc' },
    });
    if (pending.length === 0) throw new HttpError(409, 'There are no accepted changes waiting to be incorporated', 'CONFLICT');

    // No signature configured is fine -- it just means nothing gets stamped here.
    const signature = input.signatureAssetId
      ? await this.db.signatureAsset.findFirst({ where: { id: input.signatureAssetId, isActive: true } })
      : await this.db.signatureAsset.findFirst({ where: { isDefault: true, isActive: true } });
    if (input.signatureAssetId && !signature) throw new HttpError(404, 'Signature not found', 'NOT_FOUND');

    const base = await this.loadCurrentVersion(documentId);
    this.assertDerivedFromReviewed(base, link.versionId);

    const pdfBytes = await this.readVersionBytes(base);
    let edited: Buffer;
    try {
      edited = await applyReplacements(
        pdfBytes,
        pending.map((c) => ({ pageNumber: c.pageNumber, xPct: c.xPct, yPct: c.yPct, wPct: c.boxWPct ?? 0, hPct: c.boxHPct ?? 0, text: c.editedReplacementText ?? c.replacementText ?? '' }))
      );
    } catch (err) {
      if (err instanceof UnsupportedTextError) {
        throw new HttpError(400, `${err.message}. Dismiss that change or ask the client for plain letters and numbers.`, 'VALIDATION_ERROR');
      }
      if (err instanceof RangeError) throw new HttpError(409, 'One of the changes points at a page this document does not have', 'CONFLICT');
      throw err;
    }

    let finalBytes = edited;
    if (signature) {
      const sigBytes = await this.files.readVerified(
        'clean', signature.storageKey,
        { keyId: signature.encryptionKeyId, wrappedKey: Buffer.from(signature.wrappedDataKey) },
        { sha256: signature.sha256, size: Number(signature.sizeBytes) },
        10 * 1024 * 1024
      );
      const pages = await pageCount(edited);
      if (signature.pageNumber > pages) {
        throw new HttpError(409, `The signature's page (${signature.pageNumber}) is beyond this document's ${pages} page(s)`, 'CONFLICT');
      }
      // Stamped last, on the already-edited bytes -- the signature always sits on top of the final text, never under it.
      finalBytes = await stamp({ pdfBytes: edited, signature: { bytes: sigBytes, pageNumber: signature.pageNumber, xPt: signature.xPt, yPt: signature.yPt, widthPt: signature.widthPt, heightPt: signature.heightPt } });
    }

    const ids = pending.map((c) => c.id);
    const done = await this.commitDerivedVersion({
      actor, documentId, base, bytes: finalBytes, meta,
      changeNote: `Incorporated ${ids.length} accepted change${ids.length === 1 ? '' : 's'}${signature ? ' and added the signature' : ''}`,
      scanDetails: { source: SOURCE_INCORPORATE, shareLinkId: link.id, commentIds: ids, ...(signature ? { signatureAssetId: signature.id } : {}) },
      auditAction: 'REVIEW_CHANGES_INCORPORATED',
      auditDetails: { shareLinkId: link.id, commentIds: ids, ...(signature ? { signatureAssetId: signature.id } : {}) },
      after: async (tx, versionId) => {
        await tx.documentReviewComment.updateMany({ where: { id: { in: ids } }, data: { resultingVersionId: versionId } });
      },
    });
    return { ...done, applied: ids.length };
  }

  /**
   * Emails an uploaded file straight to one client address, with no new DocumentVersion and no change to the
   * document's current version -- for sending a small, ad-hoc modified copy (e.g. a couple of filled-in blanks)
   * without that becoming part of the document's own version history.
   */
  async sendModifiedCopy(actor: AuthContext, documentId: string, input: { filename: string; content: Buffer; recipientEmail: string; note?: string | undefined }, meta: RequestMeta): Promise<void> {
    const doc = await this.db.document.findUnique({ where: { id: documentId }, select: { name: true } });
    if (!doc) throw new HttpError(404, 'Document not found');
    const subject = `Modified document: ${doc.name}`;
    const body = [`Hello,`, '', `Please find the modified "${doc.name}" attached.`, ...(input.note ? ['', input.note] : [])].join('\n');
    await this.email.sendModifiedCopy(actor, { documentId, recipientEmail: input.recipientEmail, filename: input.filename, content: input.content, subject, body }, meta);
  }

  /**
   * Pushes the current version into a self-hosted Stirling-PDF instance's own storage, so staff find it waiting
   * there (newest row in the file library) instead of downloading it first and uploading it back by hand.
   * Stirling-PDF's own editor has no webhook or API-visible "save" (confirmed: its Save/Download actions never
   * call back to its own storage endpoints), so there is no way to pull an edit back automatically -- staff still
   * finish by downloading the result there and using "Upload new version" here, same as any other external edit.
   * Entirely optional: 503 if STIRLING_PDF_URL/STIRLING_PDF_API_KEY are not set.
   */
  async createStirlingPdfLink(actor: AuthContext, documentId: string, meta: RequestMeta): Promise<{ url: string }> {
    if (!this.stirlingPdf.available) throw new HttpError(503, 'Stirling-PDF is not configured', 'INTERNAL_ERROR');
    const base = await this.loadCurrentVersion(documentId);
    const pdfBytes = await this.readVersionBytes(base);
    let url: string;
    try {
      url = (await this.stirlingPdf.createEditorLink(pdfBytes, base.originalFilename)).url;
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : 'Stirling-PDF request failed', 'INTERNAL_ERROR');
    }
    await recordAudit(this.db, {
      actorType: 'USER', actorUserId: actor.userId, action: 'STIRLING_PDF_LINK_CREATED', resourceType: 'document', resourceId: documentId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { versionId: base.id },
    });
    return { url };
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

  private commentCreateData(shareLinkId: string, input: CreateReviewCommentInput, meta: RequestMeta) {
    const isChange = input.kind === 'CHANGE';
    // A suggested change needs no separate note: the "from -> to" line IS the comment staff read in the list and the email.
    const body = input.body || `Change ${input.originalText ? `"${input.originalText}" ` : ''}to "${input.replacementText ?? ''}"`;
    return {
      shareLinkId,
      kind: input.kind,
      pageNumber: input.pageNumber,
      xPct: input.xPct,
      yPct: input.yPct,
      boxWPct: isChange ? (input.boxWPct ?? null) : null,
      boxHPct: isChange ? (input.boxHPct ?? null) : null,
      originalText: isChange ? (input.originalText || null) : null,
      replacementText: isChange ? (input.replacementText ?? null) : null,
      body,
      clientIp: meta.ip,
      userAgent: meta.userAgent,
    };
  }

  async submitComment(token: string, input: CreateReviewCommentInput, meta: RequestMeta): Promise<ReviewCommentDto> {
    const link = await this.loadActiveLinkByToken(token);
    const existing = await this.db.documentReviewComment.count({ where: { shareLinkId: link.id } });
    if (existing >= MAX_COMMENTS_PER_LINK) {
      throw new HttpError(409, 'This review link has reached its limit of comments. Please contact the sender.', 'CONFLICT');
    }

    const created = await this.db.$transaction(async (tx) => {
      const c = await tx.documentReviewComment.create({ data: this.commentCreateData(link.id, input, meta), include: { resolvedBy: { select: { id: true, name: true } } } });
      if (link.status !== 'COMMENTED') await tx.documentShareLink.update({ where: { id: link.id }, data: { status: 'COMMENTED' } });
      await recordAudit(tx, {
        actorType: 'EXTERNAL', action: 'REVIEW_COMMENT_SUBMITTED', resourceType: 'document_review_comment', resourceId: c.id,
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { shareLinkId: link.id, documentId: link.documentId, kind: input.kind },
      });
      await enqueueJob(tx, { type: 'notify_review_comment', payload: { commentId: c.id }, dedupeKey: `notify-review-comment:${c.id}` });
      return c;
    });
    return this.toCommentDto(created);
  }

  /**
   * Queues several comments/suggested changes as ONE submission: all rows are created together and exactly one
   * notify job fires for the whole batch, so the team gets a single email covering everything the client just
   * added, instead of one email per item.
   */
  async submitComments(token: string, items: readonly CreateReviewCommentInput[], meta: RequestMeta): Promise<ReviewCommentDto[]> {
    const link = await this.loadActiveLinkByToken(token);
    const existing = await this.db.documentReviewComment.count({ where: { shareLinkId: link.id } });
    if (existing + items.length > MAX_COMMENTS_PER_LINK) {
      throw new HttpError(409, 'This review link has reached its limit of comments. Please contact the sender.', 'CONFLICT');
    }

    const created = await this.db.$transaction(async (tx) => {
      const rows: CommentRow[] = [];
      for (const input of items) {
        const c = await tx.documentReviewComment.create({ data: this.commentCreateData(link.id, input, meta), include: { resolvedBy: { select: { id: true, name: true } } } });
        rows.push(c);
        await recordAudit(tx, {
          actorType: 'EXTERNAL', action: 'REVIEW_COMMENT_SUBMITTED', resourceType: 'document_review_comment', resourceId: c.id,
          ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { shareLinkId: link.id, documentId: link.documentId, kind: input.kind },
        });
      }
      if (link.status !== 'COMMENTED') await tx.documentShareLink.update({ where: { id: link.id }, data: { status: 'COMMENTED' } });
      const ids = rows.map((r) => r.id);
      await enqueueJob(tx, { type: 'notify_review_comment', payload: { commentIds: ids }, dedupeKey: `notify-review-comments:${ids.join(',')}` });
      return rows;
    });
    return created.map((c) => this.toCommentDto(c));
  }

  // ------------------------------------------------------------------ background job: notify the review team

  /**
   * Fires after one or more comments are submitted together. Sent through the share link's creator's own
   * connected Gmail, to every ACTIVE user holding `documents:review` -- never attaching the PDF. One email per
   * submission, whether it carried one comment or several (a batch from `submitComments` queues a single job
   * covering every item, so the team is never emailed once per item). Idempotent: a retried job where any of
   * these comments already has a recorded outcome is a no-op.
   */
  async handleNotify(job: JobContext): Promise<void> {
    const commentIds = Array.isArray(job.payload.commentIds)
      ? (job.payload.commentIds as unknown[]).map(String)
      : [String(job.payload.commentId ?? '')].filter(Boolean);
    if (commentIds.length === 0) return;
    const already = await this.db.auditLog.count({ where: { resourceId: { in: commentIds }, action: { in: ['REVIEW_COMMENT_NOTIFIED', 'REVIEW_COMMENT_NOTIFICATION_FAILED'] } } });
    if (already > 0) return;

    const comments = await this.db.documentReviewComment.findMany({
      where: { id: { in: commentIds } },
      include: { shareLink: { include: { createdBy: { include: { roles: true } } } } },
    });
    const first = comments[0];
    if (!first) return;
    const link = first.shareLink;
    const creator = link.createdBy;

    const recordOutcome = (action: string, outcome: 'SUCCESS' | 'FAILURE', details: Record<string, unknown>) =>
      Promise.all(commentIds.map((id) => recordAudit(this.db, { actorType: 'SYSTEM', action, resourceType: 'document_review_comment', resourceId: id, outcome, details })));

    const reviewRoles = ROLES.filter((r) => rolesHavePermission([r], 'documents:review'));
    const team = await this.db.user.findMany({ where: { status: 'ACTIVE', roles: { some: { role: { in: reviewRoles } } } }, select: { email: true }, distinct: ['email'] });
    const recipients = team.map((u) => u.email);
    if (recipients.length === 0) {
      logger.warn('No team member holds documents:review to notify about a review comment', { commentIds });
      return;
    }

    const gmail = await this.connections.status(creator.id, creator.email);
    if (gmail.status !== 'ACTIVE') {
      await recordOutcome('REVIEW_COMMENT_NOTIFICATION_FAILED', 'FAILURE', { reason: 'GMAIL_NOT_CONNECTED', shareLinkId: link.id });
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
    const count = comments.length;
    const draftInput: DraftInput = {
      items: [{ documentId: link.documentId, versionId: link.versionId }],
      to: recipients,
      cc: [],
      bcc: [],
      subject: count === 1 ? 'New review comment on {{document_name}}' : `${count} new review comments on {{document_name}}`,
      body: `A client left ${count === 1 ? 'a comment' : `${count} comments`} on "{{document_name}}" ({{document_type}}, version {{version_number}}).\n\nReview ${count === 1 ? 'it' : 'them'} here:\n{{review_link}}\n`,
      attach: false,
      extra: { review_link: reviewUrl },
    };
    const draftPreview = await this.email.preview(actorCtx, draftInput);
    const sendInput: SendInput = { ...draftInput, idempotencyKey: this.email.newKey(), confirmationToken: draftPreview.confirmationToken ?? undefined };
    await this.email.send(actorCtx, sendInput, { ip: null, userAgent: null, requestId: `job:${job.id}` });
    await recordOutcome('REVIEW_COMMENT_NOTIFIED', 'SUCCESS', { recipients: recipients.length, commentCount: count });
  }
}

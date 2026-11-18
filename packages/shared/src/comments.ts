import { z } from 'zod';

export const REVIEW_COMMENT_STATUSES = ['OPEN', 'ACCEPTED', 'DISMISSED'] as const;
export type ReviewCommentStatus = (typeof REVIEW_COMMENT_STATUSES)[number];

export const SHARE_LINK_STATUSES = ['SENT', 'VIEWED', 'COMMENTED', 'ACCEPTED', 'DISMISSED', 'REVOKED', 'FAILED'] as const;
export type ShareLinkStatus = (typeof SHARE_LINK_STATUSES)[number];

/** A pin's position on a page, resolution-independent (fraction of the rendered page, 0..1). */
export const pinPositionSchema = z.strictObject({
  pageNumber: z.number().int().min(1),
  xPct: z.number().min(0).max(1),
  yPct: z.number().min(0).max(1),
});
export type PinPosition = z.output<typeof pinPositionSchema>;

/**
 * COMMENT = a free-text note pinned to a point. CHANGE = a suggested replacement: the client draws a box around the
 * text to change (name, price, period...) and types the new value; staff can apply it to the PDF once accepted.
 */
export const REVIEW_COMMENT_KINDS = ['COMMENT', 'CHANGE'] as const;
export type ReviewCommentKind = (typeof REVIEW_COMMENT_KINDS)[number];

/** Upper bound on the replacement/original text of a CHANGE: they are single values, not paragraphs. */
export const MAX_CHANGE_TEXT = 300;

export const createReviewCommentSchema = pinPositionSchema
  .extend({
    kind: z.enum(REVIEW_COMMENT_KINDS).default('COMMENT'),
    /** Required for COMMENT. Optional for CHANGE (a short note); the server writes a summary line if it is empty. */
    body: z.string().trim().max(2000).optional(),
    /** CHANGE only: the box's size as a fraction of the page. (xPct, yPct) is then the box's top-left corner. */
    boxWPct: z.number().gt(0).max(1).optional(),
    boxHPct: z.number().gt(0).max(1).optional(),
    originalText: z.string().trim().max(MAX_CHANGE_TEXT).optional(),
    replacementText: z.string().trim().min(1).max(MAX_CHANGE_TEXT).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'COMMENT') {
      if (!v.body) ctx.addIssue({ code: 'custom', path: ['body'], message: 'A comment cannot be empty' });
      for (const k of ['boxWPct', 'boxHPct', 'originalText', 'replacementText'] as const) {
        if (v[k] !== undefined) ctx.addIssue({ code: 'custom', path: [k], message: 'Only a suggested change can carry this field' });
      }
      return;
    }
    if (v.boxWPct === undefined) ctx.addIssue({ code: 'custom', path: ['boxWPct'], message: 'Draw a box around the text to change' });
    if (v.boxHPct === undefined) ctx.addIssue({ code: 'custom', path: ['boxHPct'], message: 'Draw a box around the text to change' });
    if (v.replacementText === undefined) ctx.addIssue({ code: 'custom', path: ['replacementText'], message: 'Enter the new text' });
    if (v.boxWPct !== undefined && v.xPct + v.boxWPct > 1.000001) ctx.addIssue({ code: 'custom', path: ['boxWPct'], message: 'The box runs off the page' });
    if (v.boxHPct !== undefined && v.yPct + v.boxHPct > 1.000001) ctx.addIssue({ code: 'custom', path: ['boxHPct'], message: 'The box runs off the page' });
  });
export type CreateReviewCommentInput = z.output<typeof createReviewCommentSchema>;

export const reviewCommentDecisionSchema = z.strictObject({
  resolutionNote: z.string().trim().max(500).optional(),
});

/** REVIEW = "please review this"; SIGNING = "here is the final version to sign" (always attaches the PDF). */
export const SHARE_LINK_PURPOSES = ['REVIEW', 'SIGNING'] as const;
export type ShareLinkPurpose = (typeof SHARE_LINK_PURPOSES)[number];

export const createShareLinkSchema = z.strictObject({
  recipientEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  templateId: z.uuid().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
  previousLinkId: z.uuid().optional(),
  attach: z.boolean().default(false),
  purpose: z.enum(SHARE_LINK_PURPOSES).default('REVIEW'),
});
export type CreateShareLinkInput = z.output<typeof createShareLinkSchema>;

/** Writes every accepted, not-yet-applied CHANGE of one review link into the PDF as a new version. */
export const applyReviewChangesSchema = z.strictObject({ shareLinkId: z.uuid() });
export type ApplyReviewChangesInput = z.output<typeof applyReviewChangesSchema>;

/** Stamps the pre-approved signature onto the document's current version as a new version. */
export const stampSignatureSchema = z.strictObject({ signatureAssetId: z.uuid().optional() });
export type StampSignatureInput = z.output<typeof stampSignatureSchema>;

export interface ReviewCommentDto {
  id: string;
  shareLinkId: string;
  kind: ReviewCommentKind;
  pageNumber: number;
  xPct: number;
  yPct: number;
  /** CHANGE only (null for COMMENT). */
  boxWPct: number | null;
  boxHPct: number | null;
  originalText: string | null;
  replacementText: string | null;
  /** CHANGE only: true once the replacement has been written into a new PDF version. */
  applied: boolean;
  body: string;
  status: ReviewCommentStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string } | null;
  resolutionNote: string | null;
}

export interface ShareLinkDto {
  id: string;
  documentId: string;
  versionId: string;
  recipientEmail: string;
  status: ShareLinkStatus;
  previousLinkId: string | null;
  expiresAt: string;
  viewedAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string };
}

/** What the public, no-login page gets — scoped to this token's own document and its own comments only. */
export interface PublicReviewLinkInfo {
  documentName: string;
  versionId: string;
  pageCount: number;
  expiresAt: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CONSUMED' | 'REVOKED';
  comments: ReviewCommentDto[];
}

export interface SignatureAssetDto {
  id: string;
  label: string;
  pageNumber: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  isActive: boolean;
  isDefault: boolean;
  createdAt: string;
}

export const signatureAssetMetaSchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  pageNumber: z.number().int().min(1),
  xPt: z.number().min(0),
  yPt: z.number().min(0),
  widthPt: z.number().positive(),
  heightPt: z.number().positive(),
});
export type SignatureAssetMeta = z.output<typeof signatureAssetMetaSchema>;

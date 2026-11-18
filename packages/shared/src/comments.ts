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

export const createReviewCommentSchema = pinPositionSchema.extend({
  body: z.string().trim().min(1).max(2000),
});
export type CreateReviewCommentInput = z.output<typeof createReviewCommentSchema>;

export const reviewCommentDecisionSchema = z.strictObject({
  resolutionNote: z.string().trim().max(500).optional(),
});

export const createShareLinkSchema = z.strictObject({
  recipientEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  templateId: z.uuid().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
  previousLinkId: z.uuid().optional(),
  attach: z.boolean().default(false),
});
export type CreateShareLinkInput = z.output<typeof createShareLinkSchema>;

export interface ReviewCommentDto {
  id: string;
  shareLinkId: string;
  pageNumber: number;
  xPct: number;
  yPct: number;
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

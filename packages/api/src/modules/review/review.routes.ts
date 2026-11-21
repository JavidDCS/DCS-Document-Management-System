import { z } from 'zod';
import {
  applyReviewChangesSchema,
  createReviewCommentSchema,
  createReviewCommentsBatchSchema,
  createShareLinkSchema,
  incorporateChangesSchema,
  reviewCommentDecisionSchema,
  stampSignatureSchema,
  submitReviewFieldsBatchSchema,
  uuidParamSchema,
} from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, PUBLIC, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { HttpError } from '../../utils/httpError.js';
import { validate } from '../../platform/http/validateRequest.js';
import { auditContext } from '../audit/index.js';
import { contentDisposition } from '../documents/documents.routes.js';
import { parseAdHocPdfUpload } from './adHocPdfUpload.js';
import type { ReviewService } from './review.service.js';

const sendModifiedCopyFieldsSchema = z.strictObject({
  recipientEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  note: z.string().trim().max(500).optional(),
});

const commentParamSchema = z.strictObject({ commentId: z.uuid() });
// Raw tokens are generateRefreshToken() output: base64url, 64 characters. A loose length/charset check rejects
// obviously-malformed input with 400 before it ever reaches the database; a right-shaped-but-wrong token still 404s.
const tokenParamSchema = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/) });

export function registerReviewRoutes(secure: SecureRouter, ctx: AppContext, review: ReviewService) {
  const { limiters } = ctx;
  const idParam = validate({ params: uuidParamSchema });
  const commentIdParam = validate({ params: commentParamSchema });
  const tokenParam = validate({ params: tokenParamSchema });

  // ---------------------------------------------------------------- internal (authenticated) routes

  secure.post(
    '/documents/:id/share-links',
    can('email:send_external'),
    limiters.send,
    validate({ params: uuidParamSchema, body: createShareLinkSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      const created = await review.createAndSend(req.auth!, id, req.body as z.infer<typeof createShareLinkSchema>, auditContext(req));
      res.status(201).json({ data: created });
    })
  );

  secure.get(
    '/documents/:id/share-links',
    can('documents:read'),
    idParam,
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json({ data: await review.listShareLinks(id) });
    })
  );

  secure.get(
    '/documents/:id/review-comments',
    can('documents:review'),
    idParam,
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json({ data: await review.listReviewComments(id) });
    })
  );

  // Accepting only records "yes, make this change"; the PDF is written by apply-changes below, which is the step that re-authenticates.
  secure.post(
    '/review-comments/:commentId/accept',
    can('documents:review'),
    validate({ params: commentParamSchema, body: reviewCommentDecisionSchema }),
    asyncHandler(async (req, res) => {
      const { commentId } = req.params as unknown as z.infer<typeof commentParamSchema>;
      const body = req.body as z.infer<typeof reviewCommentDecisionSchema>;
      res.json({ data: await review.acceptComment(req.auth!, commentId, { resolutionNote: body.resolutionNote, editedReplacementText: body.editedReplacementText }, auditContext(req)) });
    })
  );

  secure.post(
    '/documents/:id/review/apply-changes',
    can('documents:review', { reauth: true }),
    validate({ params: uuidParamSchema, body: applyReviewChangesSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json({ data: await review.applyChanges(req.auth!, id, req.body as z.infer<typeof applyReviewChangesSchema>, auditContext(req)) });
    })
  );

  secure.post(
    '/documents/:id/review/incorporate-changes',
    can('documents:review', { reauth: true }),
    validate({ params: uuidParamSchema, body: incorporateChangesSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json({ data: await review.incorporateChanges(req.auth!, id, req.body as z.infer<typeof incorporateChangesSchema>, auditContext(req)) });
    })
  );

  secure.post(
    '/documents/:id/review/stirling-link',
    can('documents:manage'),
    idParam,
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json({ data: await review.createStirlingPdfLink(req.auth!, id, auditContext(req)) });
    })
  );

  secure.post(
    '/documents/:id/review/send-modified-copy',
    can('email:send_external'),
    limiters.send,
    idParam,
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      const upload = await parseAdHocPdfUpload(req, { maxBytes: review.maxUploadBytes });
      const parsed = sendModifiedCopyFieldsSchema.safeParse(upload.fields);
      if (!parsed.success) throw new HttpError(400, 'Invalid request', 'VALIDATION_ERROR', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      await review.sendModifiedCopy(req.auth!, id, { filename: upload.file!.filename, content: upload.file!.content, recipientEmail: parsed.data.recipientEmail, note: parsed.data.note }, auditContext(req));
      res.status(200).json({ data: { sent: true } });
    })
  );

  secure.post(
    '/documents/:id/review/stamp-signature',
    can('documents:review', { reauth: true }),
    validate({ params: uuidParamSchema, body: stampSignatureSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json({ data: await review.stampSignature(req.auth!, id, req.body as z.infer<typeof stampSignatureSchema>, auditContext(req)) });
    })
  );

  secure.post(
    '/review-comments/:commentId/dismiss',
    can('documents:review'),
    validate({ params: commentParamSchema, body: reviewCommentDecisionSchema }),
    asyncHandler(async (req, res) => {
      const { commentId } = req.params as unknown as z.infer<typeof commentParamSchema>;
      const body = req.body as z.infer<typeof reviewCommentDecisionSchema>;
      res.json({ data: await review.dismissComment(req.auth!, commentId, { resolutionNote: body.resolutionNote }, auditContext(req)) });
    })
  );

  // ---------------------------------------------------------------- public (unauthenticated) routes

  secure.get(
    '/public/review/:token',
    PUBLIC('possession of the random token is the only credential, like a password-reset link'),
    limiters.publicReview,
    tokenParam,
    asyncHandler(async (req, res) => {
      const { token } = req.params as unknown as z.infer<typeof tokenParamSchema>;
      res.json({ data: await review.getPublicLink(token, auditContext(req)) });
    })
  );

  secure.get(
    '/public/review/:token/content',
    PUBLIC('possession of the random token is the only credential, like a password-reset link'),
    limiters.publicReview,
    tokenParam,
    asyncHandler(async (req, res) => {
      const { token } = req.params as unknown as z.infer<typeof tokenParamSchema>;
      const file = await review.getPublicContent(token, auditContext(req));
      res.status(200);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(file.data.length));
      res.setHeader('Content-Disposition', contentDisposition('inline', file.filename));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // A previewed PDF may not run anything or load anything, even if the viewer is tricked.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'self'");
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('ETag', `"${file.sha256}"`);
      res.end(file.data);
    })
  );

  // Freeform suggested changes are gone at the API layer, not just hidden in the UI: this route (and its batch
  // sibling below) now only accepts kind: 'COMMENT' -- the 1% free-text fallback. A fixed named field goes
  // through /public/review/:token/fields instead, which is the only path that can still produce a CHANGE.
  secure.post(
    '/public/review/:token/comments',
    PUBLIC('possession of the random token is the only credential, like a password-reset link'),
    limiters.publicComment,
    validate({ params: tokenParamSchema, body: createReviewCommentSchema }),
    asyncHandler(async (req, res) => {
      const { token } = req.params as unknown as z.infer<typeof tokenParamSchema>;
      const body = req.body as z.infer<typeof createReviewCommentSchema>;
      if (body.kind === 'CHANGE') {
        throw new HttpError(400, 'Suggested changes are now submitted through the fixed field form, not a freeform box', 'VALIDATION_ERROR', [{ path: 'kind', message: 'Only a comment can be submitted here' }]);
      }
      const created = await review.submitComment(token, body, auditContext(req));
      res.status(201).json({ data: created });
    })
  );

  secure.post(
    '/public/review/:token/comments/batch',
    PUBLIC('possession of the random token is the only credential, like a password-reset link'),
    limiters.publicComment,
    validate({ params: tokenParamSchema, body: createReviewCommentsBatchSchema }),
    asyncHandler(async (req, res) => {
      const { token } = req.params as unknown as z.infer<typeof tokenParamSchema>;
      const { items } = req.body as z.infer<typeof createReviewCommentsBatchSchema>;
      if (items.some((i) => i.kind === 'CHANGE')) {
        throw new HttpError(400, 'Suggested changes are now submitted through the fixed field form, not a freeform box', 'VALIDATION_ERROR', [{ path: 'items', message: 'Only comments can be submitted here' }]);
      }
      const created = await review.submitComments(token, items, auditContext(req));
      res.status(201).json({ data: created });
    })
  );

  secure.post(
    '/public/review/:token/fields',
    PUBLIC('possession of the random token is the only credential, like a password-reset link'),
    limiters.publicComment,
    validate({ params: tokenParamSchema, body: submitReviewFieldsBatchSchema }),
    asyncHandler(async (req, res) => {
      const { token } = req.params as unknown as z.infer<typeof tokenParamSchema>;
      const { items } = req.body as z.infer<typeof submitReviewFieldsBatchSchema>;
      const created = await review.submitReviewFields(token, items, auditContext(req));
      res.status(201).json({ data: created });
    })
  );
}

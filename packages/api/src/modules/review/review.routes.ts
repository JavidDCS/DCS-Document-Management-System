import { z } from 'zod';
import {
  applyReviewChangesSchema,
  createReviewCommentSchema,
  createShareLinkSchema,
  editDocumentTextSchema,
  incorporateChangesSchema,
  reviewCommentDecisionSchema,
  stampSignatureSchema,
  uuidParamSchema,
} from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, PUBLIC, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { auditContext } from '../audit/index.js';
import { contentDisposition } from '../documents/documents.routes.js';
import type { ReviewService } from './review.service.js';

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
    '/documents/:id/review/edit-text',
    can('documents:manage', { reauth: true }),
    validate({ params: uuidParamSchema, body: editDocumentTextSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json({ data: await review.editDocumentText(req.auth!, id, req.body as z.infer<typeof editDocumentTextSchema>, auditContext(req)) });
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

  secure.post(
    '/public/review/:token/comments',
    PUBLIC('possession of the random token is the only credential, like a password-reset link'),
    limiters.publicComment,
    validate({ params: tokenParamSchema, body: createReviewCommentSchema }),
    asyncHandler(async (req, res) => {
      const { token } = req.params as unknown as z.infer<typeof tokenParamSchema>;
      const created = await review.submitComment(token, req.body as z.infer<typeof createReviewCommentSchema>, auditContext(req));
      res.status(201).json({ data: created });
    })
  );
}

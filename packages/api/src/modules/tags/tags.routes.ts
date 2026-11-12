import type { z } from 'zod';
import { createTagSchema, listTagsQuerySchema, updateTagSchema, uuidParamSchema } from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { auditContext } from '../audit/index.js';
import type { TagsService } from './tags.service.js';

export function registerTagRoutes(secure: SecureRouter, _ctx: AppContext, svc: TagsService) {
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  secure.get(
    '/tags',
    can('documents:read'),
    validate({ query: listTagsQuerySchema }),
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.list((req.query as z.infer<typeof listTagsQuerySchema>).search) });
    })
  );

  secure.post(
    '/tags',
    can('documents:manage'),
    validate({ body: createTagSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json({ data: await svc.create(req.auth!, (req.body as z.infer<typeof createTagSchema>).name, auditContext(req)) });
    })
  );

  secure.patch(
    '/tags/:id',
    can('documents:manage'),
    validate({ params: uuidParamSchema, body: updateTagSchema }),
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.rename(req.auth!, id(req), (req.body as z.infer<typeof updateTagSchema>).name, auditContext(req)) });
    })
  );

  secure.delete(
    '/tags/:id',
    can('documents:manage'),
    validate({ params: uuidParamSchema }),
    asyncHandler(async (req, res) => {
      await svc.remove(req.auth!, id(req), auditContext(req));
      res.status(204).end();
    })
  );
}

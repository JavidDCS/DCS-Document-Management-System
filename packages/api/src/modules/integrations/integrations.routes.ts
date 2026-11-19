import type { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import {
  handoffCreateSchema,
  integrationDocumentsQuerySchema,
  sentLookupSchema,
  uuidParamSchema,
} from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, PUBLIC, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { auditContext } from '../audit/index.js';
import { requireIntegrationKey } from './integrationKey.js';
import type { IntegrationsService } from './integrations.service.js';

export interface IntegrationRoutesDeps {
  integrations: IntegrationsService;
  apiKey: string | undefined;
  db: PrismaClient;
}

/**
 * Three server-to-server routes for the sister "DCS Leads Manager" app (fixed contract: do not rename these
 * paths or reshape their bodies), plus one signed-in route SendPage uses to read a hand-off before prefilling
 * itself. All three PUBLIC routes sit behind `requireIntegrationKey` + a per-IP rate limit, never a session.
 */
export function registerIntegrationRoutes(secure: SecureRouter, ctx: AppContext, deps: IntegrationRoutesDeps) {
  const { integrations } = deps;
  const checkKey = requireIntegrationKey(deps.apiKey, deps.db);

  secure.post(
    '/integrations/handoffs',
    PUBLIC('server-to-server call from the Leads Manager app, authenticated by X-Integration-Key, not a session'),
    ctx.limiters.integration,
    checkKey,
    validate({ body: handoffCreateSchema }),
    asyncHandler(async (req, res) => {
      const data = await integrations.createHandoff(req.body as z.infer<typeof handoffCreateSchema>, auditContext(req));
      res.status(200).json({ data });
    })
  );

  secure.get(
    '/integrations/documents',
    PUBLIC('server-to-server call from the Leads Manager app, authenticated by X-Integration-Key, not a session'),
    ctx.limiters.integration,
    checkKey,
    validate({ query: integrationDocumentsQuerySchema }),
    asyncHandler(async (req, res) => {
      const { type } = req.query as unknown as z.infer<typeof integrationDocumentsQuerySchema>;
      res.json({ data: await integrations.listDocuments(type) });
    })
  );

  secure.post(
    '/integrations/sent-lookup',
    PUBLIC('server-to-server call from the Leads Manager app, authenticated by X-Integration-Key, not a session'),
    ctx.limiters.integration,
    checkKey,
    validate({ body: sentLookupSchema }),
    asyncHandler(async (req, res) => {
      const { refs } = req.body as z.infer<typeof sentLookupSchema>;
      res.json({ data: await integrations.sentLookup(refs) });
    })
  );

  // Signed-in: SendPage's own read of a hand-off it was opened with (?handoff=<id>). Not part of the fixed
  // Leads-Manager contract above, so its shape is whatever is most convenient for the frontend.
  secure.get(
    '/email/handoffs/:id',
    can('email:send'),
    validate({ params: uuidParamSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json({ data: await integrations.getHandoffForSend(id) });
    })
  );
}

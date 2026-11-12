import { z } from 'zod';
import {
  draftSchema,
  listMessagesQuerySchema,
  resolveUnknownSchema,
  sendSchema,
  templateInputSchema,
  templateUpdateSchema,
  uuidParamSchema,
} from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, PUBLIC, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { auditContext } from '../audit/index.js';
import type { EmailConnectionsService } from './connections.service.js';
import type { EmailService } from './email.service.js';

export interface EmailRoutesDeps {
  email: EmailService;
  connections: EmailConnectionsService;
  publicUrl: string;
}

export function registerEmailRoutes(
  secure: SecureRouter,
  ctx: AppContext,
  deps: EmailRoutesDeps
) {
  const { email, connections } = deps;
  const publicUrl = deps.publicUrl.replace(/\/+$/, '');

  // Connection
  secure.get(
    '/email/connection',
    can('email:connect'),
    asyncHandler(async (req, res) => {
      res.json({ data: await connections.status(req.auth!.userId, req.auth!.email) });
    })
  );

  secure.post(
    '/email/connection/start',
    can('email:connect'),
    asyncHandler(async (req, res) => {
      res.json({ data: await connections.start(req.auth!.userId, req.auth!.email) });
    })
  );

  secure.get(
    '/email/connection/callback',
    PUBLIC('browser redirect from Google; authenticated by the single-use state'),
    ctx.limiters.auth,
    asyncHandler(async (req, res) => {
      const code = typeof req.query.code === 'string' ? req.query.code : null;
      const state = typeof req.query.state === 'string' ? req.query.state : null;
      let ok = false;
      if (code && state) {
        const userId = await connections.complete(code, state);
        if (userId) ok = true;
      }
      const target = ok
        ? `${publicUrl}/settings/gmail?connected=1`
        : `${publicUrl}/settings/gmail?error=gmail_failed`;
      res.redirect(302, target);
    })
  );

  secure.delete(
    '/email/connection',
    can('email:connect'),
    asyncHandler(async (req, res) => {
      await connections.disconnect(req.auth!.userId);
      res.status(204).end();
    })
  );

  // Templates
  secure.get(
    '/email-templates',
    can('templates:read'),
    asyncHandler(async (req, res) => {
      const isManager = req.auth!.permissions.includes('templates:manage');
      res.json({ data: await email.listTemplates(isManager) });
    })
  );

  secure.post(
    '/email-templates',
    can('templates:manage'),
    validate({ body: templateInputSchema }),
    asyncHandler(async (req, res) => {
      const created = await email.createTemplate(req.auth!, req.body, auditContext(req));
      res.status(201).json({ data: created });
    })
  );

  secure.patch(
    '/email-templates/:id',
    can('templates:manage'),
    validate({ params: uuidParamSchema, body: templateUpdateSchema }),
    asyncHandler(async (req, res) => {
      const id = (req.params as { id: string }).id;
      const updated = await email.updateTemplate(req.auth!, id, req.body, auditContext(req));
      res.json({ data: updated });
    })
  );

  // Drafts & Send
  secure.post(
    '/email/drafts',
    can('email:send'),
    validate({ body: draftSchema }),
    asyncHandler(async (req, res) => {
      const preview = await email.preview(req.auth!, req.body);
      res.json({ data: preview });
    })
  );

  secure.post(
    '/email/messages',
    can('email:send'),
    ctx.limiters.send,
    validate({ body: sendSchema }),
    asyncHandler(async (req, res) => {
      const result = await email.send(req.auth!, req.body, auditContext(req));
      res.status(202).json({ data: result });
    })
  );

  secure.get(
    '/email/messages',
    can('email:read_own'),
    validate({ query: listMessagesQuerySchema }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listMessagesQuerySchema>;
      const { items, total } = await email.list(req.auth!, q);
      res.json({ data: items, meta: { total, limit: q.limit, offset: q.offset } });
    })
  );

  secure.get(
    '/email/messages/:id',
    can('email:read_own'),
    validate({ params: uuidParamSchema }),
    asyncHandler(async (req, res) => {
      const id = (req.params as { id: string }).id;
      const detail = await email.get(req.auth!, id);
      res.json({ data: detail });
    })
  );

  secure.post(
    '/email/messages/:id/resolve',
    can('email:read_own'),
    validate({ params: uuidParamSchema, body: resolveUnknownSchema }),
    asyncHandler(async (req, res) => {
      const id = (req.params as { id: string }).id;
      const resolved = await email.resolveUnknown(req.auth!, id, req.body.outcome, auditContext(req));
      res.json({ data: resolved });
    })
  );
}

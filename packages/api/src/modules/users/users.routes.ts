import { z } from 'zod';
import { createUserSchema, ROLES, setUserRolesSchema, setUserStatusSchema, USER_STATUSES, uuidParamSchema } from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { auditContext } from '../audit/index.js';
import type { UsersService } from './users.service.js';

const listQuery = z.strictObject({
  search: z.string().trim().min(1).max(100).optional(),
  status: z.enum(USER_STATUSES).optional(),
  role: z.enum(ROLES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export function registerUserRoutes(secure: SecureRouter, _ctx: AppContext, users: UsersService) {
  const idParam = validate({ params: uuidParamSchema });
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  secure.get(
    '/users',
    can('users:read'),
    validate({ query: listQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listQuery>;
      const { users: rows, total } = await users.list(q);
      res.json({ data: rows, meta: { total, limit: q.limit, offset: q.offset } });
    })
  );

  secure.get(
    '/users/:id',
    can('users:read'),
    idParam,
    asyncHandler(async (req, res) => {
      res.json({ data: await users.get(id(req)) });
    })
  );

  secure.post(
    '/users',
    can('users:manage', { reauth: true }),
    validate({ body: createUserSchema }),
    asyncHandler(async (req, res) => {
      const r = await users.create(req.auth!, req.body as z.infer<typeof createUserSchema>, auditContext(req));
      res.status(201).json({ data: r });
    })
  );

  secure.patch(
    '/users/:id/status',
    can('users:manage', { reauth: true }),
    validate({ params: uuidParamSchema, body: setUserStatusSchema }),
    asyncHandler(async (req, res) => {
      const { status } = req.body as z.infer<typeof setUserStatusSchema>;
      res.json({ data: await users.setStatus(req.auth!, id(req), status, auditContext(req)) });
    })
  );

  secure.put(
    '/users/:id/roles',
    can('users:roles', { reauth: true }),
    validate({ params: uuidParamSchema, body: setUserRolesSchema }),
    asyncHandler(async (req, res) => {
      const { roles } = req.body as z.infer<typeof setUserRolesSchema>;
      res.json({ data: await users.setRoles(req.auth!, id(req), roles, auditContext(req)) });
    })
  );

  secure.post(
    '/users/:id/reset-password',
    can('users:manage', { reauth: true }),
    idParam,
    asyncHandler(async (req, res) => {
      res.json({ data: await users.resetPassword(req.auth!, id(req), auditContext(req)) });
    })
  );

  secure.post(
    '/users/:id/revoke-sessions',
    can('users:manage', { reauth: true }),
    idParam,
    asyncHandler(async (req, res) => {
      res.json({ data: await users.revokeSessions(req.auth!, id(req), auditContext(req)) });
    })
  );
}

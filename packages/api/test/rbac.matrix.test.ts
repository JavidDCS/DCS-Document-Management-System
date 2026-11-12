import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, rolesHavePermission, type Role } from '@dcs-docs/shared';
import type { RouteSpec } from '../src/platform/auth/secureRouter.js';
import { ALLOWED_ORIGIN } from './helpers/app.js';
import { buildFullApp, createTestUser, csrfPair, signIn, type Client } from './helpers/fullApp.js';
import { skipDb, testPrisma } from './helpers/db.js';

const UUID = '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f';
const fill = (path: string) => path.replace(/:[A-Za-z]+/g, UUID);

describe.skipIf(skipDb)('role x route matrix and deny-by-default (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const { app, services } = skipDb ? ({} as never) : buildFullApp(prisma);
  const clients = {} as Record<Role | 'NONE', Client>;
  let mustChange: Client;
  const registry: RouteSpec[] = skipDb ? [] : app.secure.registry;

  beforeAll(async () => {
    for (const role of ROLES) clients[role] = await signIn(app, (await createTestUser(prisma, services, { role })).email);
    // a user with NO role at all
    const none = await prisma.user.create({
      data: { email: `norole.${Date.now()}@decirclesolar.com`, name: 'No Role', status: 'ACTIVE', credential: { create: { passwordHash: await services.hasher.hash('correct-horse-battery-9'), mustChangePassword: false } } },
    });
    clients.NONE = await signIn(app, none.email);
    mustChange = await signIn(app, (await createTestUser(prisma, services, { role: 'SUPER_ADMIN', status: 'INVITED', mustChange: true })).email);
  });
  afterAll(() => prisma.$disconnect());

  const call = (c: Client | null, spec: RouteSpec) => {
    const url = `/api/v1${fill(spec.path)}`;
    const r = request(app)[spec.method](url);
    return c ? r.set(c.auth()).send(spec.method === 'get' || spec.method === 'delete' ? undefined : {}) : r;
  };

  it('every route on the router is declared in the registry (deny-by-default)', () => {
    const stack = (app.secure.router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
    const actual = stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`));
    const declared = registry.map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(actual.sort()).toEqual(declared.sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('every protected route names a known permission; every public route explains itself', () => {
    for (const r of registry) {
      if (r.access.kind === 'permission') expect(PERMISSIONS).toContain(r.access.permission);
      if (r.access.kind === 'public') expect(r.access.reason.length).toBeGreaterThan(10);
    }
  });

  it('has routes in every access class (sanity)', () => {
    expect(new Set(registry.map((r) => r.access.kind))).toEqual(new Set(['public', 'authenticated', 'permission']));
  });

  describe('unauthenticated callers', () => {
    for (const spec of ['authenticated', 'permission'] as const) {
      it(`get 401 on every ${spec} route`, async () => {
        for (const r of registry.filter((x) => x.access.kind === spec)) {
          let res = request(app)[r.method](`/api/v1${fill(r.path)}`);
          if (r.method !== 'get') {
            const k = await csrfPair(app);
            res = res.set('Cookie', k.cookie).set('X-CSRF-Token', k.token).set('Origin', ALLOWED_ORIGIN).send({});
          }
          const out = await res;
          expect(out.status, `${r.method} ${r.path}`).toBe(401);
        }
      });
    }

    it('a forged or tampered bearer token is rejected on every protected route', async () => {
      for (const r of registry.filter((x) => x.access.kind !== 'public')) {
        const res = await request(app)[r.method](`/api/v1${fill(r.path)}`).set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.').send();
        expect(res.status, `${r.method} ${r.path}`).toBe(401);
      }
    });
  });

  describe('role x permission-protected route', () => {
    const protectedRoutes = () => registry.filter((r): r is RouteSpec & { access: { kind: 'permission'; permission: (typeof PERMISSIONS)[number] } } => r.access.kind === 'permission');

    for (const role of [...ROLES, 'NONE'] as const) {
      it(`${role}: allowed exactly where the matrix says so`, async () => {
        for (const r of protectedRoutes()) {
          const allowed = role !== 'NONE' && rolesHavePermission([role], r.access.permission);
          const res = await call(clients[role], r);
          const label = `${role} ${r.method.toUpperCase()} ${r.path} (${r.access.permission})`;
          if (allowed) expect([401, 403], label).not.toContain(res.status);
          else {
            expect(res.status, label).toBe(403);
            expect(res.body.error.code, label).toBe('FORBIDDEN');
          }
        }
      });
    }

    it('a user who must change their password is blocked on every permission route, even a SUPER_ADMIN', async () => {
      for (const r of protectedRoutes()) {
        const res = await call(mustChange, r);
        expect(res.status, `${r.method} ${r.path}`).toBe(403);
        expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      }
    });
  });

  it('authenticated routes work for every role', async () => {
    for (const r of registry.filter((x) => x.access.kind === 'authenticated' && x.method === 'get')) {
      for (const role of ROLES) {
        const res = await call(clients[role], r);
        expect(res.status, `${role} ${r.path}`).toBe(200);
      }
    }
  });
});

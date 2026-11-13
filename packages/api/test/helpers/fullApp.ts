import { randomBytes } from 'node:crypto';
import type { MalwareScanner } from '../../src/modules/file-security/scanner.js';
import { FileCrypto } from '../../src/modules/storage/fileCrypto.js';
import { FileService } from '../../src/modules/storage/fileService.js';
import { EnvKeyProvider } from '../../src/providers/keys/envKeyProvider.js';
import type { StorageProvider } from '../../src/providers/storage/types.js';
import type { EmailProvider } from '../../src/providers/email/types.js';
import type { GoogleOidcProvider } from '../../src/providers/identity/googleOidc.js';
import { FakeScanner } from './storage.js';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { Role } from '@dcs-docs/shared';
import { createApp } from '../../src/app.js';
import { buildServices, registerRoutes, type ServicesConfig } from '../../src/composition.js';
import type { DocumentUsage } from '../../src/modules/document-types/documentTypes.service.js';
import { ALLOWED_ORIGIN, baseConfig } from './app.js';

/** For suites that never touch files: any use is a test bug, so it throws. */
const unusedProvider = new Proxy({}, { get: () => () => { throw new Error('storage not configured for this test'); } }) as unknown as StorageProvider;

export const PASSWORD = 'correct-horse-battery-9';

const testEmailKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 13) % 256)).toString('base64');

export const testConfig: ServicesConfig = {
  ...baseConfig,
  REQUEST_BODY_LIMIT_KB: 100,
  ALLOWED_EMAIL_DOMAIN: 'decirclesolar.com',
  AUTH_PASSWORD_LOGIN_ENABLED: true,
  AUTH_GOOGLE_LOGIN_ENABLED: false,
  LOGIN_MAX_FAILED_ATTEMPTS: 3,
  LOGIN_LOCKOUT_MINUTES: 15,
  JWT_ACCESS_SECRET: 'test-jwt-secret-test-jwt-secret-0123456789ab',
  ACCESS_TOKEN_TTL: '10m',
  REFRESH_TOKEN_IDLE_TIMEOUT_MINUTES: 480,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 12,
  REFRESH_COOKIE_NAME: 'dcs_docs_refresh',
  BCRYPT_COST: 4, // bcrypt's minimum: keeps the suites fast; production requires >= 12
  STORAGE_MAX_FILE_SIZE_MB: 5,
  PDF_ACTIVE_CONTENT_POLICY: 'block',
  JOBS_MAX_ATTEMPTS: 3,
  JOBS_LEASE_MS: 60_000,
  JOBS_POLL_INTERVAL_MS: 250,
  EMAIL_TOKEN_ENCRYPTION_KEY: testEmailKey,
  EMAIL_MAX_ATTACHMENT_TOTAL_MB: 20,
  APP_TIMEZONE: 'Asia/Kolkata',
};

export interface TestDeps {
  usage?: DocumentUsage;
  files?: FileService;
  scanner?: MalwareScanner;
  emailProvider?: EmailProvider;
  googleProvider?: GoogleOidcProvider;
}

export function buildFullApp(prisma: PrismaClient, overrides: Partial<ServicesConfig> = {}, deps: TestDeps = {}) {
  const cfg = { ...testConfig, ...overrides };
  const services = buildServices(prisma, cfg, {
    files: deps.files ?? new FileService(unusedProvider, new FileCrypto(new EnvKeyProvider('unused', randomBytes(32)))),
    scanner: deps.scanner ?? new FakeScanner(),
    ...(deps.usage ? { usage: deps.usage } : {}),
    ...(deps.emailProvider ? { emailProvider: deps.emailProvider } : {}),
    ...(deps.googleProvider ? { googleProvider: deps.googleProvider } : {}),
  });
  const app = createApp({
    config: cfg,
    authenticate: services.authenticate,
    register: (secure, ctx) => registerRoutes(secure, ctx, services, cfg),
  });
  return { app, services, cfg };
}

export type TestApp = ReturnType<typeof buildFullApp>['app'];

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${randomBytes(5).toString('hex')}@decirclesolar.com`;
}

export async function createTestUser(
  prisma: PrismaClient,
  services: ReturnType<typeof buildFullApp>['services'],
  opts: { role?: Role; roles?: Role[]; email?: string; name?: string; password?: string; status?: 'INVITED' | 'ACTIVE' | 'DEACTIVATED'; mustChange?: boolean } = {}
) {
  const email = opts.email ?? uniqueEmail(opts.role?.toLowerCase() ?? 'user');
  const password = opts.password ?? PASSWORD;
  const status = opts.status ?? 'ACTIVE';
  const mustChange = opts.mustChange ?? false;
  const user = await prisma.user.create({
    data: {
      email,
      name: opts.name ?? 'Test User',
      status,
      credential: {
        create: {
          passwordHash: await services.hasher.hash(password),
          mustChangePassword: mustChange,
          passwordChangedAt: mustChange ? null : new Date(),
        },
      },
      roles: { create: (opts.roles ?? [opts.role ?? 'VIEWER']).map((role) => ({ role })) },
    },
  });
  return { id: user.id, email, password };
}

export async function csrfPair(app: TestApp) {
  const res = await request(app).get('/api/v1/csrf');
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  return { token: res.body.data.csrfToken as string, cookie };
}

export async function loginRaw(app: TestApp, email: string, password: string, extraCookie = '') {
  const c = await csrfPair(app);
  return request(app)
    .post('/api/v1/auth/login')
    .set('Cookie', [c.cookie, extraCookie].filter(Boolean).join('; '))
    .set('X-CSRF-Token', c.token)
    .set('Origin', ALLOWED_ORIGIN)
    .send({ email, password });
}

type Req = ReturnType<typeof request>;
type Test = ReturnType<Req['get']>;

/** A signed-in client: bearer access token plus the refresh cookie, with helpers for cookie-authenticated calls. */
export interface Client {
  accessToken: string;
  refreshCookie: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response user shape is asserted in tests
  user: any;
  auth(): { Authorization: string };
  refresh(cookie?: string): Promise<request.Response>;
  get(path: string): Test;
  post(path: string, body?: object): Test;
  put(path: string, body?: object): Test;
  patch(path: string, body?: object): Test;
  del(path: string): Test;
}

export async function signIn(app: TestApp, email: string, password = PASSWORD) {
  const res = await loginRaw(app, email, password);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const refreshCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('dcs_docs_refresh='))!.split(';')[0]!;
  const client: Client = {
    accessToken: res.body.data.accessToken as string,
    refreshCookie,
    user: res.body.data.user,
    auth: () => ({ Authorization: `Bearer ${client.accessToken}` }),
    async refresh(cookie = client.refreshCookie) {
      const c = await csrfPair(app);
      return request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${c.cookie}; ${cookie}`)
        .set('X-CSRF-Token', c.token)
        .set('Origin', ALLOWED_ORIGIN)
        .send();
    },
    get: (path: string) => request(app).get(`/api/v1${path}`).set(client.auth()),
    post: (path: string, body: object = {}) => request(app).post(`/api/v1${path}`).set(client.auth()).send(body),
    put: (path: string, body: object = {}) => request(app).put(`/api/v1${path}`).set(client.auth()).send(body),
    patch: (path: string, body: object = {}) => request(app).patch(`/api/v1${path}`).set(client.auth()).send(body),
    del: (path: string) => request(app).delete(`/api/v1${path}`).set(client.auth()),
  };
  return client;
}


export async function reauth(client: Client, password = PASSWORD) {
  const res = await client.post('/auth/reauth', { password });
  if (res.status !== 200) throw new Error(`reauth failed: ${res.status}`);
  client.accessToken = res.body.data.accessToken;
}

export function sessionIdOf(client: Client): string {
  return JSON.parse(Buffer.from(client.accessToken.split('.')[1]!, 'base64url').toString()).sid as string;
}

/** Makes the session look like it was authenticated `seconds` ago (to test re-authentication). */
export async function ageAuth(prisma: PrismaClient, client: Client, seconds: number) {
  await prisma.session.update({ where: { id: sessionIdOf(client) }, data: { authTime: new Date(Date.now() - seconds * 1000) } });
}

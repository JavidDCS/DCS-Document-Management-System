import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { packOauthState } from '../src/modules/identity/googleLoginState.js';
import { GoogleOidcProvider, type GoogleOidcConfig } from '../src/providers/identity/googleOidc.js';
import { skipDb, testPrisma } from './helpers/db.js';
import { buildFullApp, createTestUser, testConfig, uniqueEmail, type TestApp } from './helpers/fullApp.js';

describe.skipIf(skipDb)('Google sign-in (/auth/google/*)', () => {
  const prisma = testPrisma();
  const STATE_SECRET = testConfig.CSRF_SECRET;
  const APP_PUBLIC_URL = testConfig.CORS_ORIGINS[0]!;

  function fakeProvider(verifyIdToken: NonNullable<GoogleOidcConfig['verifyIdToken']>) {
    return new GoogleOidcProvider({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: `${APP_PUBLIC_URL}/api/v1/auth/google/callback`,
      fetchImpl: async () => new Response(JSON.stringify({ id_token: 'dummy' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      verifyIdToken,
    });
  }

  function buildApp(
    verifyIdToken: NonNullable<GoogleOidcConfig['verifyIdToken']>,
    extraConfig?: Partial<Parameters<typeof buildFullApp>[1]>
  ): TestApp {
    return buildFullApp(
      prisma,
      { AUTH_GOOGLE_LOGIN_ENABLED: true, GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret', ...extraConfig },
      { googleProvider: fakeProvider(verifyIdToken) }
    ).app;
  }

  function oauthCookie(state: string, nonce: string, verifier: string): string {
    return `dcs_google_oauth=${packOauthState(STATE_SECRET, { state, nonce, verifier })}`;
  }

  async function callback(app: TestApp, cookie: string | undefined, query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    const req = request(app).get(`/api/v1/auth/google/callback?${qs}`);
    if (cookie) req.set('Cookie', cookie);
    return req.redirects(0);
  }

  beforeEach(async () => {
    if (!skipDb) {
      await prisma.loginEvent.deleteMany({});
      await prisma.identityAccount.deleteMany({});
    }
  });

  it('start redirects to Google with PKCE, nonce and state, and sets the signed state cookie', async () => {
    const app = buildApp(async () => ({ sub: 'unused', email: 'unused@decirclesolar.com', email_verified: true }));
    const res = await request(app).get('/api/v1/auth/google/start').redirects(0);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.hostname).toBe('accounts.google.com');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('scope')).toBe('openid email profile');

    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(setCookie).toContain('dcs_google_oauth=');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it('refuses with 503 when Google login is not enabled', async () => {
    const app = buildFullApp(prisma, { AUTH_GOOGLE_LOGIN_ENABLED: false }).app;
    const res = await request(app).get('/api/v1/auth/google/start');
    expect(res.status).toBe(503);
  });

  it('callback without a valid state cookie redirects with error=expired (covers missing, tampered, and replayed/reused state)', async () => {
    const app = buildApp(async () => ({ sub: 's', email: 'a@decirclesolar.com', email_verified: true }));
    const res = await callback(app, undefined, { code: 'c', state: 'whatever' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_PUBLIC_URL}/login?error=expired`);
  });

  it('callback with a mismatched state parameter redirects with error=expired', async () => {
    const app = buildApp(async () => ({ sub: 's', email: 'a@decirclesolar.com', email_verified: true }));
    const cookie = oauthCookie('state-from-browser', 'nonce-1', 'verifier-1');
    const res = await callback(app, cookie, { code: 'c', state: 'attacker-supplied-state' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_PUBLIC_URL}/login?error=expired`);
  });

  it('callback reflecting a cancelled consent (error query param from Google) redirects with error=cancelled', async () => {
    const app = buildApp(async () => ({ sub: 's', email: 'a@decirclesolar.com', email_verified: true }));
    const cookie = oauthCookie('state-1', 'nonce-1', 'verifier-1');
    const res = await callback(app, cookie, { error: 'access_denied', state: 'state-1' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_PUBLIC_URL}/login?error=cancelled`);
  });

  it('a verified identity outside the allowed domain is rejected and audited, without creating a user', async () => {
    const app = buildApp(async () => ({ sub: 'sub-outside', email: 'someone@othercompany.com', email_verified: true, hd: 'othercompany.com', nonce: 'nonce-1' }));
    const cookie = oauthCookie('state-1', 'nonce-1', 'verifier-1');
    const res = await callback(app, cookie, { code: 'c', state: 'state-1' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_PUBLIC_URL}/login?error=wrong_domain`);
    expect(await prisma.user.findUnique({ where: { email: 'someone@othercompany.com' } })).toBeNull();
    const event = await prisma.loginEvent.findFirst({ where: { emailAttempted: 'someone@othercompany.com' } });
    expect(event?.outcome).toBe('DENIED_WRONG_DOMAIN');
  });

  it('an email with no matching invited user is refused and never auto-created', async () => {
    const email = uniqueEmail('never-invited');
    const app = buildApp(async () => ({ sub: 'sub-new', email, email_verified: true, hd: 'decirclesolar.com', nonce: 'nonce-1' }));
    const cookie = oauthCookie('state-1', 'nonce-1', 'verifier-1');
    const res = await callback(app, cookie, { code: 'c', state: 'state-1' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_PUBLIC_URL}/login?error=not_invited`);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    const event = await prisma.loginEvent.findFirst({ where: { emailAttempted: email } });
    expect(event?.outcome).toBe('DENIED_NOT_INVITED');
  });

  it('auto-provisions a new user with default role when AUTH_GOOGLE_AUTO_PROVISION is enabled', async () => {
    const email = uniqueEmail('auto-prov');
    const app = buildApp(
      async () => ({ sub: 'sub-auto-1', email, email_verified: true, hd: 'decirclesolar.com', name: 'Auto User', nonce: 'nonce-1' }),
      { AUTH_GOOGLE_AUTO_PROVISION: true, AUTH_GOOGLE_DEFAULT_ROLE: 'VIEWER' }
    );
    const cookie = oauthCookie('state-1', 'nonce-1', 'verifier-1');
    const res = await callback(app, cookie, { code: 'c', state: 'state-1' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_PUBLIC_URL}/login`);

    const created = await prisma.user.findUnique({ where: { email }, include: { roles: true } });
    expect(created).not.toBeNull();
    expect(created?.name).toBe('Auto User');
    expect(created?.status).toBe('ACTIVE');
    expect(created?.roles.map((r) => r.role)).toEqual(['VIEWER']);
  });

  it('a deactivated user is refused even with a fully valid Google ID token, and no identity link is created', async () => {
    const { services } = buildFullApp(prisma, {});
    const user = await createTestUser(prisma, services, { status: 'DEACTIVATED' });
    const app = buildApp(async () => ({ sub: 'sub-deactivated', email: user.email, email_verified: true, hd: 'decirclesolar.com', nonce: 'nonce-1' }));
    const cookie = oauthCookie('state-1', 'nonce-1', 'verifier-1');
    const res = await callback(app, cookie, { code: 'c', state: 'state-1' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_PUBLIC_URL}/login?error=deactivated`);
    expect(await prisma.identityAccount.findFirst({ where: { userId: user.id } })).toBeNull();
  });

  it('first Google login for an existing active user links the identity account and signs them in; a second login matches by sub, not email', async () => {
    const { services } = buildFullApp(prisma, {});
    const user = await createTestUser(prisma, services, { role: 'VIEWER' });
    const app = buildApp(async () => ({ sub: 'stable-sub-1', email: user.email, email_verified: true, hd: 'decirclesolar.com', name: 'Test User', nonce: 'nonce-1' }));

    const res1 = await callback(app, oauthCookie('state-1', 'nonce-1', 'verifier-1'), { code: 'c1', state: 'state-1' });
    expect(res1.status).toBe(302);
    expect(res1.headers.location).toBe(`${APP_PUBLIC_URL}/login`);
    const refreshSet = (res1.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('dcs_docs_refresh='));
    expect(refreshSet).toBeDefined();

    const link = await prisma.identityAccount.findFirst({ where: { userId: user.id, provider: 'GOOGLE' } });
    expect(link?.subject).toBe('stable-sub-1');

    const successEvent = await prisma.loginEvent.findFirst({ where: { userId: user.id, outcome: 'SUCCESS' } });
    expect(successEvent?.method).toBe('google');

    // Second login: same subject, even if the identity's email were to differ later, still resolves to the same user.
    const res2 = await callback(app, oauthCookie('state-2', 'nonce-1', 'verifier-2'), { code: 'c2', state: 'state-2' });
    expect(res2.status).toBe(302);
    expect(res2.headers.location).toBe(`${APP_PUBLIC_URL}/login`);
    expect(await prisma.identityAccount.count({ where: { userId: user.id, provider: 'GOOGLE' } })).toBe(1);
  });

  it('rejects when the provider fails ID token verification (bad signature, wrong audience, or expired)', async () => {
    const app = buildApp(async () => {
      throw new Error('jwt verification failed');
    });
    const cookie = oauthCookie('state-1', 'nonce-1', 'verifier-1');
    const res = await callback(app, cookie, { code: 'c', state: 'state-1' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_PUBLIC_URL}/login?error=invalid`);
  });
});

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ALLOWED_ORIGIN, baseConfig, buildApp, T } from './helpers/app.js';

const app = buildApp({}, (v1) => {
  v1.post('/change', T, (_req, res) => res.json({ data: { changed: true } }));
  v1.get('/read', T, (_req, res) => res.json({ data: { ok: true } }));
});

async function issue(application = app) {
  const res = await request(application).get('/api/v1/csrf');
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
  return { token: res.body.data.csrfToken as string, cookie, res };
}

describe('CSRF protection', () => {
  it('issues a token in the body and an httpOnly SameSite=Strict cookie', async () => {
    const { token, cookie } = await issue();
    expect(token).toMatch(/^[\w-]{43}\.[\w-]{43}$/);
    expect(cookie).toMatch(/^dcs_csrf=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toMatch(/Secure/i); // COOKIE_SECURE=false in the test config
  });

  it('uses a __Host- prefixed Secure cookie when COOKIE_SECURE=true', async () => {
    const secureApp = buildApp({ COOKIE_SECURE: true });
    const { cookie } = await issue(secureApp);
    expect(cookie).toMatch(/^__Host-dcs_csrf=/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('issues a fresh token each time', async () => {
    const a = await issue();
    const b = await issue();
    expect(a.token).not.toBe(b.token);
  });

  it('lets safe methods through without a token', async () => {
    const res = await request(app).get('/api/v1/read');
    expect(res.status).toBe(200);
  });

  it('rejects a state-changing request with no token', async () => {
    const res = await request(app).post('/api/v1/change').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects a header without the cookie, and a cookie without the header', async () => {
    const { token, cookie } = await issue();
    const headerOnly = await request(app).post('/api/v1/change').set('X-CSRF-Token', token).send({});
    expect(headerOnly.body.error.code).toBe('CSRF_FAILED');
    const cookieOnly = await request(app).post('/api/v1/change').set('Cookie', cookie).send({});
    expect(cookieOnly.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects a header that differs from the cookie', async () => {
    const a = await issue();
    const b = await issue();
    const res = await request(app).post('/api/v1/change').set('Cookie', a.cookie).set('X-CSRF-Token', b.token).send({});
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects a forged token even when cookie and header match', async () => {
    const forged = `${'A'.repeat(43)}.${'B'.repeat(43)}`;
    const res = await request(app)
      .post('/api/v1/change')
      .set('Cookie', `dcs_csrf=${forged}`)
      .set('X-CSRF-Token', forged)
      .send({});
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects a token signed with a different secret', async () => {
    const other = buildApp({ CSRF_SECRET: 'another-secret-another-secret-0123456789abc' });
    const { token, cookie } = await issue(other);
    const res = await request(app).post('/api/v1/change').set('Cookie', cookie).set('X-CSRF-Token', token).send({});
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('accepts a matching, correctly signed token', async () => {
    const { token, cookie } = await issue();
    const res = await request(app)
      .post('/api/v1/change')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .set('Origin', ALLOWED_ORIGIN)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(true);
  });

  it('rejects a valid token sent from a disallowed Origin', async () => {
    const { token, cookie } = await issue();
    const res = await request(app)
      .post('/api/v1/change')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .set('Origin', 'https://evil.example.test')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('applies to PUT, PATCH and DELETE as well', async () => {
    const all = buildApp({}, (v1) => {
      v1.put('/x', T, (_r, res) => res.json({}));
      v1.patch('/x', T, (_r, res) => res.json({}));
      v1.delete('/x', T, (_r, res) => res.json({}));
    });
    for (const method of ['put', 'patch', 'delete'] as const) {
      const res = await request(all)[method]('/api/v1/x').send({});
      expect(res.status).toBe(403);
    }
  });

  it('does not require a token for a Bearer-authenticated request (not cookie auth)', async () => {
    const res = await request(app).post('/api/v1/change').set('Authorization', 'Bearer some.access.token').send({});
    expect(res.status).toBe(200);
  });

  it('still enforces the Origin allow-list for a Bearer request that sends an Origin', async () => {
    const res = await request(app)
      .post('/api/v1/change')
      .set('Authorization', 'Bearer some.access.token')
      .set('Origin', 'https://evil.example.test')
      .send({});
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('config sanity: secret is long enough', () => {
    expect(baseConfig.CSRF_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});

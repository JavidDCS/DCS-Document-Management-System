import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ALLOWED_ORIGIN, buildApp } from './helpers/app.js';

const app = buildApp();

describe('security headers', () => {
  it('sets a deny-everything CSP, HSTS, nosniff, no-referrer, frame denial and no-store', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000; includeSubDomains/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets the same headers on error responses', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('adds a CSP report-uri only when configured', async () => {
    const withReport = await request(buildApp({ CSP_REPORT_URI: 'https://csp.example.test/r' })).get('/healthz');
    expect(withReport.headers['content-security-policy']).toContain('report-uri https://csp.example.test/r');
    const without = await request(app).get('/healthz');
    expect(without.headers['content-security-policy']).not.toContain('report-uri');
  });

  it('exposes nothing but liveness on /healthz', async () => {
    const res = await request(app).get('/healthz');
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('CORS allow-list', () => {
  it('allows a listed origin with credentials', async () => {
    const res = await request(app).get('/healthz').set('Origin', ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('gives no CORS headers to an unlisted origin', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'https://evil.example.test');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('never reflects a null origin', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'null');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight only for listed origins and headers', async () => {
    const ok = await request(app)
      .options('/api/v1/anything')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(ok.headers['access-control-allow-headers']).toMatch(/X-CSRF-Token/i);

    const bad = await request(app)
      .options('/api/v1/anything')
      .set('Origin', 'https://evil.example.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('request ids', () => {
  it('generates an id and returns it in the header', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a safe client id', async () => {
    const res = await request(app).get('/healthz').set('X-Request-Id', 'client-req-12345');
    expect(res.headers['x-request-id']).toBe('client-req-12345');
  });

  it('replaces an unsafe or oversized client id (no log injection)', async () => {
    for (const bad of ['short', 'has spaces in it!!', 'a'.repeat(65), 'x\ty\tz\t12345']) {
      const res = await request(app).get('/healthz').set('X-Request-Id', bad);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('puts the same id in error bodies', async () => {
    const res = await request(app).get('/nope').set('X-Request-Id', 'trace-abcdef-01');
    expect(res.body.error.requestId).toBe('trace-abcdef-01');
  });
});

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import express from 'express';
import { createLimiter } from '../src/platform/http/rateLimit.js';
import { errorHandler } from '../src/platform/http/errorHandler.js';
import { requestId } from '../src/platform/http/requestId.js';
import { buildApp, T } from './helpers/app.js';

describe('API rate limit (per IP)', () => {
  it('returns the standard 429 with Retry-After once the limit is exceeded', async () => {
    const app = buildApp({ RATE_LIMIT_API_MAX_PER_IP: 3 }, (v1) => v1.get('/ping', T, (_r, res) => res.json({ data: 1 })));
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/v1/ping')).status).toBe(200);
    }
    const res = await request(app).get('/api/v1/ping');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(typeof res.body.error.requestId).toBe('string');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['ratelimit']).toBeDefined();
  });

  it('does not rate-limit the liveness probe', async () => {
    const app = buildApp({ RATE_LIMIT_API_MAX_PER_IP: 1 });
    for (let i = 0; i < 5; i++) expect((await request(app).get('/healthz')).status).toBe(200);
  });
});

describe('createLimiter', () => {
  function appWith(limiter: ReturnType<typeof createLimiter>) {
    const a = express();
    a.set('trust proxy', 1);
    a.use(requestId);
    a.get('/x', limiter, (_req, res) => res.json({ ok: true }));
    a.use(errorHandler);
    return a;
  }

  it('limits per principal rather than per IP when a principal is given', async () => {
    const a = appWith(createLimiter({ windowMs: 60_000, limit: 2, principal: (req) => req.header('x-test-user') }));
    const call = (user: string) => request(a).get('/x').set('x-test-user', user);
    expect((await call('alice')).status).toBe(200);
    expect((await call('alice')).status).toBe(200);
    expect((await call('alice')).status).toBe(429);
    expect((await call('bob')).status).toBe(200); // same IP, different user: separate budget
  });

  it('falls back to the client IP without a principal', async () => {
    const a = appWith(createLimiter({ windowMs: 60_000, limit: 1 }));
    expect((await request(a).get('/x').set('X-Forwarded-For', '203.0.113.5')).status).toBe(200);
    expect((await request(a).get('/x').set('X-Forwarded-For', '203.0.113.5')).status).toBe(429);
    expect((await request(a).get('/x').set('X-Forwarded-For', '203.0.113.6')).status).toBe(200);
  });
});

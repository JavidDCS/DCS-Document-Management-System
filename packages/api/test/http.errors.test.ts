import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { asyncHandler } from '../src/platform/http/errorHandler.js';
import { validate } from '../src/platform/http/validateRequest.js';
import { HttpError } from '../src/utils/httpError.js';
import { buildApp, T } from './helpers/app.js';

const BEARER = { Authorization: 'Bearer test-token-not-checked-here' }; // bypasses CSRF; these tests are about errors

const app = buildApp({}, (v1) => {
  v1.get('/boom', T, () => {
    throw new Error('relation "users" does not exist; SELECT * FROM users WHERE password=hunter2 at /srv/app/x.ts:12');
  });
  v1.get('/async-boom', T, asyncHandler(async () => {
    throw new Error('connect ECONNREFUSED postgresql://admin:dbpass@10.0.0.5:5432/prod');
  }));
  v1.get('/forbidden', T, () => {
    throw new HttpError(403, 'You do not have permission to perform this action');
  });
  v1.post(
    '/items/:id',
    T,
    validate({
      params: z.strictObject({ id: z.uuid() }),
      body: z.strictObject({ name: z.string().min(1).max(10) }),
    }),
    (req, res) => res.json({ data: req.body })
  );
});

afterEach(() => vi.restoreAllMocks());

function expectStandard(body: any, code: string, status: number, res: { status: number }) {
  expect(res.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(typeof body.error.requestId).toBe('string');
  expect(Object.keys(body)).toEqual(['error']);
}

describe('standard error format', () => {
  it('404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expectStandard(res.body, 'NOT_FOUND', 404, res);
  });

  it('403 passes an HttpError through', async () => {
    const res = await request(app).get('/api/v1/forbidden');
    expectStandard(res.body, 'FORBIDDEN', 403, res);
  });

  it('never leaks stack, SQL, paths or credentials on a 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const path of ['/api/v1/boom', '/api/v1/async-boom']) {
      const res = await request(app).get(path);
      expectStandard(res.body, 'INTERNAL_ERROR', 500, res);
      const raw = JSON.stringify(res.body);
      expect(res.body.error.message).toBe('Internal server error');
      expect(raw).not.toMatch(/SELECT|users|hunter2|dbpass|ECONNREFUSED|\.ts|\/srv|stack/i);
    }
    // ...and the server-side log is redacted too
    const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toMatch(/hunter2|dbpass/);
  });

  it('400 with field paths for invalid input; unknown keys rejected', async () => {
    const id = '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f';
    const bad = await request(app).post(`/api/v1/items/${id}`).set(BEARER).send({ name: '', extra: 1 });
    expectStandard(bad.body, 'VALIDATION_ERROR', 400, bad);
    const paths = bad.body.error.details.map((d: any) => d.path);
    expect(paths).toContain('body.name');
    expect(paths.some((p: string) => p.startsWith('body'))).toBe(true);
    expect(JSON.stringify(bad.body)).not.toContain('extra":1');

    const badId = await request(app).post('/api/v1/items/not-a-uuid').set(BEARER).send({ name: 'ok' });
    expect(badId.body.error.details.map((d: any) => d.path)).toContain('params.id');
  });

  it('accepts valid input and uses the parsed value', async () => {
    const id = '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f';
    const res = await request(app).post(`/api/v1/items/${id}`).set(BEARER).send({ name: 'ok' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: 'ok' });
  });

  it('400 for malformed JSON', async () => {
    const res = await request(app).post('/api/v1/items/x').set(BEARER).set('Content-Type', 'application/json').send('{"name": ');
    expectStandard(res.body, 'BAD_REQUEST', 400, res);
    expect(res.body.error.message).toBe('Malformed JSON body');
  });

  it('413 when the body exceeds the limit', async () => {
    const res = await request(app)
      .post('/api/v1/items/x')
      .set(BEARER)
      .send({ name: 'x'.repeat(5000) });
    expectStandard(res.body, 'PAYLOAD_TOO_LARGE', 413, res);
  });
});

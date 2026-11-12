import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient, toApiError } from './client';

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const err = (status: number, code: string, message = 'x') => json(status, { error: { code, message, requestId: 'req-1' } });
const user = { id: 'u', email: 'a@b.c', name: 'A', status: 'ACTIVE', roles: [], permissions: [], mustChangePassword: false, lastLoginAt: null, createdAt: '' };

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>, reauth = async () => true) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const u = String(input);
    calls.push({ url: u, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string> });
    return handler(u, init);
  }) as unknown as typeof fetch;
  const onSessionExpired = vi.fn();
  const requestReauth = vi.fn(reauth);
  const client = createClient({ fetchFn, baseUrl: '/api/v1', onSessionExpired, requestReauth });
  return { client, calls, fetchFn, onSessionExpired, requestReauth };
}

describe('error mapping', () => {
  it('maps the standard error body', () => {
    const e = toApiError(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid', requestId: 'r', details: [{ path: 'body.name', message: 'Required' }] } });
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', requestId: 'r' });
    expect(e.details).toEqual([{ path: 'body.name', message: 'Required' }]);
  });
  it('falls back for non-standard bodies', () => {
    expect(toApiError(502, null)).toMatchObject({ status: 502, code: 'HTTP_ERROR' });
  });
});

describe('requests', () => {
  it('sends the bearer token and never the CSRF header on normal calls', async () => {
    const { client, calls } = setup((u) => (u.endsWith('/csrf') ? json(200, { data: { csrfToken: 'c' } }) : u.includes('/auth/login') ? json(200, { data: { accessToken: 'tok', expiresIn: 600, user } }) : json(200, { data: [1] })));
    await client.login('a@b.c', 'pw');
    const r = await client.get<number[]>('/things', { q: 'x', skip: undefined });
    expect(r.data).toEqual([1]);
    const last = calls.at(-1)!;
    expect(last.url).toBe('/api/v1/things?q=x');
    expect(last.headers.Authorization).toBe('Bearer tok');
    expect(last.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('login sends the CSRF token and no bearer token', async () => {
    const { client, calls } = setup((u) => (u.endsWith('/csrf') ? json(200, { data: { csrfToken: 'csrf-1' } }) : json(200, { data: { accessToken: 't', expiresIn: 600, user } })));
    await client.login('a@b.c', 'pw');
    const login = calls.find((c) => c.url.endsWith('/auth/login'))!;
    expect(login.headers['X-CSRF-Token']).toBe('csrf-1');
    expect(login.headers.Authorization).toBeUndefined();
  });
});

describe('session refresh', () => {
  it('refreshes once for many concurrent 401s (single flight) and retries each', async () => {
    let refreshes = 0;
    let token = 'old';
    const { client, calls, onSessionExpired } = setup((u, init) => {
      if (u.endsWith('/csrf')) return json(200, { data: { csrfToken: 'c' } });
      if (u.endsWith('/auth/refresh')) {
        refreshes++;
        token = 'new';
        return new Promise<Response>((r) => setTimeout(() => r(json(200, { data: { accessToken: 'new', expiresIn: 600, user } })), 20));
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new' ? json(200, { data: 'ok' }) : err(401, 'UNAUTHENTICATED', 'Invalid or expired access token');
    });
    client.setAccessToken('old');
    const results = await Promise.all([client.get('/a'), client.get('/b'), client.get('/c')]);
    expect(results.map((r) => r.data)).toEqual(['ok', 'ok', 'ok']);
    expect(refreshes).toBe(1);
    expect(token).toBe('new');
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('signs out when the refresh fails', async () => {
    const { client, onSessionExpired } = setup((u) => (u.endsWith('/csrf') ? json(200, { data: { csrfToken: 'c' } }) : u.endsWith('/auth/refresh') ? err(401, 'UNAUTHENTICATED') : err(401, 'UNAUTHENTICATED')));
    client.setAccessToken('old');
    await expect(client.get('/a')).rejects.toMatchObject({ status: 401 });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(client.hasToken()).toBe(false);
  });

  it('does not loop: a second 401 after a successful refresh is surfaced', async () => {
    let attempts = 0;
    const { client } = setup((u) => {
      if (u.endsWith('/csrf')) return json(200, { data: { csrfToken: 'c' } });
      if (u.endsWith('/auth/refresh')) return json(200, { data: { accessToken: 'n', expiresIn: 600, user } });
      attempts++;
      return err(401, 'UNAUTHENTICATED');
    });
    client.setAccessToken('old');
    await expect(client.get('/a')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(attempts).toBe(2);
  });

  it('does not refresh for other errors', async () => {
    const { client, calls } = setup(() => err(403, 'FORBIDDEN'));
    client.setAccessToken('t');
    await expect(client.get('/a')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(calls).toHaveLength(1);
  });
});

describe('re-authentication', () => {
  it('asks for the password on REAUTH_REQUIRED, then retries with the new token', async () => {
    let first = true;
    const { client, requestReauth } = setup((u, init) => {
      if (u.endsWith('/auth/reauth')) return json(200, { data: { accessToken: 'fresh', expiresIn: 600 } });
      if ((init.headers as Record<string, string>).Authorization === 'Bearer fresh') return json(200, { data: 'done' });
      if (first) {
        first = false;
        return err(401, 'REAUTH_REQUIRED', 'Please confirm your password to continue');
      }
      return err(401, 'UNAUTHENTICATED');
    }, async () => true);
    client.setAccessToken('old');
    // the real UI handler calls client.reauth(); emulate it here
    (requestReauth as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await client.reauth('pw');
      return true;
    });
    const r = await client.post('/users', { x: 1 });
    expect(r.data).toBe('done');
    expect(requestReauth).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error when the user cancels the password prompt', async () => {
    const { client } = setup(() => err(401, 'REAUTH_REQUIRED'), async () => false);
    client.setAccessToken('t');
    await expect(client.post('/users', {})).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });
});

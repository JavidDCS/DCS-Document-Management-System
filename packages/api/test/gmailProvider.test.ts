import { describe, expect, it } from 'vitest';
import { GMAIL_SEND_SCOPE, GmailProvider } from '../src/providers/email/gmail.js';
import { EmailProviderError } from '../src/providers/email/types.js';

describe('GmailProvider', () => {
  const cfg = {
    clientId: 'test-client-id.apps.googleusercontent.com',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://app.test/api/v1/email/connection/callback',
  };

  it('buildAuthUrl contains required parameters, PKCE and exact gmail.send scope', () => {
    const provider = new GmailProvider(cfg);
    const url = provider.buildAuthUrl({
      state: 'random-state-123',
      codeChallenge: 'pkce-challenge-456',
      loginHint: 'alice@decirclesolar.com',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe(cfg.clientId);
    expect(parsed.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe(GMAIL_SEND_SCOPE);
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('state')).toBe('random-state-123');
    expect(parsed.searchParams.get('code_challenge')).toBe('pkce-challenge-456');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('login_hint')).toBe('alice@decirclesolar.com');
  });

  it('exchanges code for refresh token, enforcing exact scope', async () => {
    let capturedUrl = '';
    let capturedBody = '';

    const mockFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: 'dummy-access',
          refresh_token: 'dummy-refresh',
          scope: GMAIL_SEND_SCOPE,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const provider = new GmailProvider({ ...cfg, fetchImpl: mockFetch });
    const res = await provider.exchangeCode({ code: 'auth-code-1', codeVerifier: 'verifier-123' });

    expect(capturedUrl).toBe('https://oauth2.googleapis.com/token');
    expect(capturedBody).toContain('grant_type=authorization_code');
    expect(capturedBody).toContain('code=auth-code-1');
    expect(capturedBody).toContain('code_verifier=verifier-123');
    expect(res.refreshToken).toBe('dummy-refresh');
  });

  it('rejects exchangeCode when scopes differ or are broader than gmail.send', async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: 'dummy-access',
          refresh_token: 'dummy-refresh',
          scope: `${GMAIL_SEND_SCOPE} https://mail.google.com/`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const provider = new GmailProvider({ ...cfg, fetchImpl: mockFetch });
    await expect(provider.exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toMatchObject({
      kind: 'REJECTED',
    });
  });

  it('maps refresh token errors to AUTH_REVOKED for invalid_grant or 401', async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });

    const provider = new GmailProvider({ ...cfg, fetchImpl: mockFetch });
    await expect(provider.refreshAccessToken('expired-token')).rejects.toMatchObject({
      kind: 'AUTH_REVOKED',
    });
  });

  it('send maps 401 to AUTH_REVOKED, 429 to RATE_LIMITED, 400 to REJECTED, and 500 to UNKNOWN_OUTCOME', async () => {
    let status = 401;
    let responseBody = { error: { message: 'Invalid credentials', status: 'UNAUTHENTICATED' } };

    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    const provider = new GmailProvider({ ...cfg, fetchImpl: mockFetch });

    // 401
    await expect(provider.send('tok', Buffer.from('hello'))).rejects.toMatchObject({ kind: 'AUTH_REVOKED' });

    // 429
    status = 429;
    responseBody = { error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } };
    await expect(provider.send('tok', Buffer.from('hello'))).rejects.toMatchObject({ kind: 'RATE_LIMITED' });

    // 400
    status = 400;
    responseBody = { error: { message: 'Bad request', status: 'INVALID_ARGUMENT' } };
    await expect(provider.send('tok', Buffer.from('hello'))).rejects.toMatchObject({ kind: 'REJECTED' });

    // 500
    status = 500;
    responseBody = { error: { message: 'Internal server error', status: 'INTERNAL' } };
    await expect(provider.send('tok', Buffer.from('hello'))).rejects.toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it('send maps fetch network error or abort to UNKNOWN_OUTCOME', async () => {
    const mockFetch: typeof fetch = async () => {
      throw new Error('Network timeout');
    };
    const provider = new GmailProvider({ ...cfg, fetchImpl: mockFetch });
    await expect(provider.send('tok', Buffer.from('hello'))).rejects.toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });
});

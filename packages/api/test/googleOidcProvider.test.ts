import { describe, expect, it } from 'vitest';
import { GOOGLE_LOGIN_SCOPE, GoogleOidcProvider } from '../src/providers/identity/googleOidc.js';
import { GoogleOidcError } from '../src/providers/identity/types.js';

describe('GoogleOidcProvider', () => {
  const cfg = {
    clientId: 'test-client-id.apps.googleusercontent.com',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://app.test/api/v1/auth/google/callback',
  };

  it('buildAuthUrl contains PKCE, nonce and the openid email profile scope', () => {
    const provider = new GoogleOidcProvider(cfg);
    const url = provider.buildAuthUrl({ state: 'state-1', nonce: 'nonce-1', codeChallenge: 'challenge-1', loginHint: 'alice@decirclesolar.com' });
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe(cfg.clientId);
    expect(parsed.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe(GOOGLE_LOGIN_SCOPE);
    expect(parsed.searchParams.get('state')).toBe('state-1');
    expect(parsed.searchParams.get('nonce')).toBe('nonce-1');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('login_hint')).toBe('alice@decirclesolar.com');
  });

  it('exchangeAndVerify returns a VerifiedIdentity when the ID token checks out', async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ id_token: 'dummy-id-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const provider = new GoogleOidcProvider({
      ...cfg,
      fetchImpl: mockFetch,
      verifyIdToken: async () => ({ sub: 'google-sub-123', email: 'Alice@DecircleSolar.com', email_verified: true, name: 'Alice', hd: 'decirclesolar.com', nonce: 'nonce-1' }),
    });

    const identity = await provider.exchangeAndVerify({ code: 'auth-code', codeVerifier: 'verifier', expectedNonce: 'nonce-1' });

    expect(identity).toEqual({ provider: 'GOOGLE', subject: 'google-sub-123', email: 'alice@decirclesolar.com', emailVerified: true, name: 'Alice', hostedDomain: 'decirclesolar.com' });
  });

  it('rejects with TOKEN_REJECTED when Google refuses the authorisation code', async () => {
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const provider = new GoogleOidcProvider({ ...cfg, fetchImpl: mockFetch });
    await expect(provider.exchangeAndVerify({ code: 'c', codeVerifier: 'v', expectedNonce: 'n' })).rejects.toMatchObject({ kind: 'TOKEN_REJECTED' });
  });

  it('rejects with TOKEN_INVALID when ID token verification throws (bad signature, wrong aud/iss, or expired)', async () => {
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify({ id_token: 'bad-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const provider = new GoogleOidcProvider({
      ...cfg,
      fetchImpl: mockFetch,
      verifyIdToken: async () => {
        throw new Error('signature verification failed');
      },
    });
    await expect(provider.exchangeAndVerify({ code: 'c', codeVerifier: 'v', expectedNonce: 'n' })).rejects.toMatchObject({ kind: 'TOKEN_INVALID' });
  });

  it('rejects with TOKEN_INVALID when the nonce does not match this sign-in attempt (replay)', async () => {
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify({ id_token: 'dummy' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const provider = new GoogleOidcProvider({
      ...cfg,
      fetchImpl: mockFetch,
      verifyIdToken: async () => ({ sub: 's', email: 'a@decirclesolar.com', email_verified: true, nonce: 'stale-nonce-from-another-attempt' }),
    });
    await expect(provider.exchangeAndVerify({ code: 'c', codeVerifier: 'v', expectedNonce: 'fresh-nonce' })).rejects.toMatchObject({ kind: 'TOKEN_INVALID' });
  });

  it('rejects with TOKEN_INVALID when email_verified is not true', async () => {
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify({ id_token: 'dummy' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const provider = new GoogleOidcProvider({
      ...cfg,
      fetchImpl: mockFetch,
      verifyIdToken: async () => ({ sub: 's', email: 'a@decirclesolar.com', email_verified: false, nonce: 'n' }),
    });
    await expect(provider.exchangeAndVerify({ code: 'c', codeVerifier: 'v', expectedNonce: 'n' })).rejects.toMatchObject({ kind: 'TOKEN_INVALID' });
  });

  it('maps a network failure to UNKNOWN_OUTCOME', async () => {
    const provider = new GoogleOidcProvider({
      ...cfg,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    await expect(provider.exchangeAndVerify({ code: 'c', codeVerifier: 'v', expectedNonce: 'n' })).rejects.toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it('is unavailable without client id, secret and redirect URI, and refuses to build a URL or exchange', () => {
    const provider = new GoogleOidcProvider({ clientId: undefined, clientSecret: undefined, redirectUri: undefined });
    expect(provider.available).toBe(false);
    expect(() => provider.buildAuthUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).toThrow(GoogleOidcError);
  });
});

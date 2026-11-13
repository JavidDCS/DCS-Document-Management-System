import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { GoogleOidcError, type VerifiedIdentity } from './types.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
// Google's ID tokens use either form depending on endpoint; both are accepted (Google's own docs list both).
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_LOGIN_SCOPE = 'openid email profile';

interface GoogleIdTokenPayload extends JWTPayload {
  email?: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
  nonce?: string;
}

export interface GoogleOidcConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUri: string | undefined;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable for tests: verifies an ID token without a real call to Google's JWKS endpoint. */
  verifyIdToken?: (idToken: string, clientId: string) => Promise<GoogleIdTokenPayload>;
}

/**
 * Google OpenID Connect sign-in, Authorization Code + PKCE, server-side. Mirrors the plain-fetch style of
 * GmailProvider (no SDK) for the HTTP calls; ID token signature verification is delegated to `jose` (a maintained,
 * narrowly-scoped JWT/JWKS library) rather than hand-rolled, per RFC 9700 / OpenID Connect Core.
 */
export class GoogleOidcProvider {
  readonly name = 'google';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly jwks = createRemoteJWKSet(new URL(JWKS_URL));
  private readonly verifyIdTokenImpl: NonNullable<GoogleOidcConfig['verifyIdToken']>;

  constructor(private readonly cfg: GoogleOidcConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.verifyIdTokenImpl = cfg.verifyIdToken ?? ((idToken, clientId) => this.verifyWithGoogle(idToken, clientId));
  }

  get available(): boolean {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret && this.cfg.redirectUri);
  }

  private need() {
    if (!this.available) throw new GoogleOidcError('UNAVAILABLE', 'Google sign-in is not configured');
    return { clientId: this.cfg.clientId!, clientSecret: this.cfg.clientSecret!, redirectUri: this.cfg.redirectUri! };
  }

  buildAuthUrl(input: { state: string; nonce: string; codeChallenge: string; loginHint?: string | undefined }): string {
    const { clientId, redirectUri } = this.need();
    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_LOGIN_SCOPE,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      ...(input.loginHint ? { login_hint: input.loginHint } : {}),
    }).toString();
    return u.toString();
  }

  private async post(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new GoogleOidcError('UNKNOWN_OUTCOME', 'Could not reach Google', err instanceof Error ? err.name : 'error');
    }
  }

  private async verifyWithGoogle(idToken: string, clientId: string): Promise<GoogleIdTokenPayload> {
    const { payload } = await jwtVerify(idToken, this.jwks, { issuer: ISSUERS, audience: clientId });
    return payload as GoogleIdTokenPayload;
  }

  /** Exchanges the authorization code for an ID token and fully verifies it before trusting any of its claims. */
  async exchangeAndVerify(input: { code: string; codeVerifier: string; expectedNonce: string }): Promise<VerifiedIdentity> {
    const { clientId, clientSecret, redirectUri } = this.need();
    const res = await this.post(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: input.codeVerifier,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) {
      throw new GoogleOidcError('TOKEN_REJECTED', 'Google refused the authorisation code', body.error);
    }

    let claims: GoogleIdTokenPayload;
    try {
      // jwtVerify checks the signature against Google's JWKS, exp/nbf, iss and aud; nonce and email_verified are ours to check.
      claims = await this.verifyIdTokenImpl(body.id_token, clientId);
    } catch (err) {
      throw new GoogleOidcError('TOKEN_INVALID', 'Google ID token failed verification', err instanceof Error ? err.message : 'error');
    }

    if (claims.nonce !== input.expectedNonce) {
      throw new GoogleOidcError('TOKEN_INVALID', 'ID token nonce does not match this sign-in attempt');
    }
    if (claims.email_verified !== true || !claims.email || typeof claims.sub !== 'string') {
      throw new GoogleOidcError('TOKEN_INVALID', 'Google did not confirm a verified email address');
    }

    return {
      provider: 'GOOGLE',
      subject: claims.sub,
      email: claims.email.toLowerCase(),
      emailVerified: true,
      name: claims.name,
      hostedDomain: claims.hd,
    };
  }
}

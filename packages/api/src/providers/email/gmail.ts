import { EmailProviderError, type EmailProvider } from './types.js';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SEND_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';

export interface GmailConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUri: string | undefined;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Gmail through its REST API with per-user OAuth. Consent asks for exactly one scope, gmail.send, and is separate
 * from sign-in. The message is sent by the user's own mailbox, so it is DKIM-signed by Google and appears in their
 * Sent folder; a forged From header cannot change who sent it. No SDK: five small HTTPS calls.
 */
export class GmailProvider implements EmailProvider {
  readonly name = 'gmail';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: GmailConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
  }

  get available(): boolean {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret && this.cfg.redirectUri);
  }

  private need() {
    if (!this.available) throw new EmailProviderError('REJECTED', 'Gmail is not configured');
    return { clientId: this.cfg.clientId!, clientSecret: this.cfg.clientSecret!, redirectUri: this.cfg.redirectUri! };
  }

  buildAuthUrl(input: { state: string; codeChallenge: string; loginHint: string }): string {
    const { clientId, redirectUri } = this.need();
    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GMAIL_SEND_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      login_hint: input.loginHint,
    }).toString();
    return u.toString();
  }

  private async post(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new EmailProviderError('UNKNOWN_OUTCOME', 'Could not reach Google', err instanceof Error ? err.name : 'error');
    }
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ refreshToken: string }> {
    const { clientId, clientSecret, redirectUri } = this.need();
    const res = await this.post(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: input.code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: input.codeVerifier }),
    });
    const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; scope?: string; error?: string };
    if (!res.ok) throw new EmailProviderError('REJECTED', 'Google refused the authorisation code', body.error);
    // Only the send scope may have been granted: anything broader means the consent was not what we asked for.
    const scopes = (body.scope ?? '').split(/\s+/).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== GMAIL_SEND_SCOPE) throw new EmailProviderError('REJECTED', 'Unexpected scopes were granted', scopes.join(','));
    if (!body.refresh_token) throw new EmailProviderError('REJECTED', 'Google did not return a refresh token');
    return { refreshToken: body.refresh_token };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const { clientId, clientSecret } = this.need();
    const res = await this.post(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (res.ok && body.access_token) return { accessToken: body.access_token, expiresInSeconds: body.expires_in ?? 3000 };
    if (body.error === 'invalid_grant' || res.status === 400 || res.status === 401) throw new EmailProviderError('AUTH_REVOKED', 'The Gmail authorisation is no longer valid', body.error);
    throw new EmailProviderError('UNKNOWN_OUTCOME', 'Could not refresh the Gmail access token', String(res.status));
  }

  async revoke(refreshToken: string): Promise<void> {
    const res = await this.post(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
    // 400 means it was already revoked or expired, which is the state we want.
    if (!res.ok && res.status !== 400) throw new EmailProviderError('UNKNOWN_OUTCOME', 'Could not revoke the token at Google', String(res.status));
  }

  async send(accessToken: string, rawMessage: Buffer): Promise<{ providerMessageId: string }> {
    const res = await this.post(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'message/rfc822' },
      body: new Uint8Array(rawMessage),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string; errors?: { reason?: string }[]; status?: string } };
    if (res.ok && body.id) return { providerMessageId: body.id };
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? '';
    if (res.status === 401) throw new EmailProviderError('AUTH_REVOKED', 'The Gmail authorisation is no longer valid', reason);
    if (res.status === 429 || /rateLimit|dailyLimit|quota/i.test(reason)) throw new EmailProviderError('RATE_LIMITED', 'Gmail sending limit reached', reason);
    if (res.status >= 400 && res.status < 500) throw new EmailProviderError('REJECTED', 'Gmail rejected the message', `${res.status} ${reason}`.trim());
    // 5xx or an unreadable success: the message may or may not have been accepted.
    throw new EmailProviderError('UNKNOWN_OUTCOME', 'Gmail did not confirm the message', String(res.status));
  }
}

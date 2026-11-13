import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 10 * 60_000;

export interface OauthStateData {
  state: string;
  nonce: string;
  verifier: string;
}

/**
 * Packs {state, nonce, verifier} for one Google sign-in attempt into a value for a short-lived, httpOnly cookie,
 * HMAC-signed so a client cannot forge or tamper with it. None of these values are confidential once the browser
 * reaches Google, so signing (integrity) is enough; no encryption is needed, matching the CSRF cookie's own design.
 */
function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`google-oauth-state:${payload}`).digest('base64url');
}

export function packOauthState(secret: string, data: OauthStateData): string {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + TTL_MS })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function unpackOauthState(secret: string, cookieValue: string | undefined): OauthStateData | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts as [string, string];
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<OauthStateData> & { exp?: number };
    if (typeof decoded.exp !== 'number' || decoded.exp < Date.now()) return null;
    if (typeof decoded.state !== 'string' || typeof decoded.nonce !== 'string' || typeof decoded.verifier !== 'string') return null;
    return { state: decoded.state, nonce: decoded.nonce, verifier: decoded.verifier };
  } catch {
    return null;
  }
}

export const generateState = (): string => randomBytes(32).toString('base64url');
export const generateNonce = (): string => randomBytes(32).toString('base64url');
export const generateCodeVerifier = (): string => randomBytes(48).toString('base64url');
export const codeChallengeFor = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

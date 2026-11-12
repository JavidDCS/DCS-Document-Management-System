import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { generateRefreshToken, hashToken, TokenService } from '../src/modules/identity/tokens.js';

const SECRET = 'unit-test-secret-unit-test-secret-0123456789';
const svc = new TokenService({ JWT_ACCESS_SECRET: SECRET, ACCESS_TOKEN_TTL: '10m' });
const claims = { userId: '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f', sessionId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', authTime: 1_780_000_000, method: 'password' };

describe('access tokens', () => {
  it('round-trips the claims', () => {
    expect(svc.verifyAccess(svc.signAccess(claims))).toEqual(claims);
  });

  it('expires after the configured TTL', () => {
    expect(svc.ttlSeconds).toBe(600);
    const decoded = jwt.decode(svc.signAccess(claims)) as { exp: number; iat: number };
    expect(decoded.exp - decoded.iat).toBe(600);
    expect(new TokenService({ JWT_ACCESS_SECRET: SECRET, ACCESS_TOKEN_TTL: '90s' }).ttlSeconds).toBe(90);
  });

  it('carries no role or permission claims (those are loaded from the database)', () => {
    const decoded = jwt.decode(svc.signAccess(claims)) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(['amr', 'aud', 'auth_time', 'exp', 'iat', 'iss', 'sid', 'sub']);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sid: claims.sessionId, auth_time: 1, amr: ['password'] }, SECRET, {
      algorithm: 'HS256', subject: claims.userId, issuer: 'dcs-docs', audience: 'dcs-docs-api', expiresIn: -60,
    });
    expect(svc.verifyAccess(expired)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const other = new TokenService({ JWT_ACCESS_SECRET: 'another-secret-another-secret-0123456789x', ACCESS_TOKEN_TTL: '10m' });
    expect(svc.verifyAccess(other.signAccess(claims))).toBeNull();
  });

  it('rejects alg:none and other algorithms (algorithm confusion)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: claims.userId, sid: claims.sessionId, auth_time: 1, iss: 'dcs-docs', aud: 'dcs-docs-api', exp: 9_999_999_999 })).toString('base64url');
    expect(svc.verifyAccess(`${header}.${payload}.`)).toBeNull();
    const hs512 = jwt.sign({ sid: claims.sessionId, auth_time: 1 }, SECRET, { algorithm: 'HS512', subject: claims.userId, issuer: 'dcs-docs', audience: 'dcs-docs-api', expiresIn: 60 });
    expect(svc.verifyAccess(hs512)).toBeNull();
  });

  it('rejects a wrong issuer or audience', () => {
    for (const [issuer, audience] of [['evil', 'dcs-docs-api'], ['dcs-docs', 'other']] as const) {
      const t = jwt.sign({ sid: claims.sessionId, auth_time: 1 }, SECRET, { algorithm: 'HS256', subject: claims.userId, issuer, audience, expiresIn: 60 });
      expect(svc.verifyAccess(t)).toBeNull();
    }
  });

  it('rejects tokens missing the session id or subject, and garbage', () => {
    const noSid = jwt.sign({ auth_time: 1 }, SECRET, { algorithm: 'HS256', subject: claims.userId, issuer: 'dcs-docs', audience: 'dcs-docs-api', expiresIn: 60 });
    expect(svc.verifyAccess(noSid)).toBeNull();
    expect(svc.verifyAccess('not.a.jwt')).toBeNull();
    expect(svc.verifyAccess('')).toBeNull();
  });

  it('rejects a payload that was edited after signing', () => {
    const [h, , s] = svc.signAccess(claims).split('.');
    const evil = Buffer.from(JSON.stringify({ sub: 'attacker', sid: claims.sessionId, auth_time: 1, iss: 'dcs-docs', aud: 'dcs-docs-api', exp: 9_999_999_999 })).toString('base64url');
    expect(svc.verifyAccess(`${h}.${evil}.${s}`)).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('are long, random and URL-safe; only the hash is meant to be stored', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).toMatch(/^[\w-]{64}$/);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
    expect(hashToken(a)).toBe(hashToken(a));
  });
});

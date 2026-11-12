import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

const ISSUER = 'dcs-docs';
const AUDIENCE = 'dcs-docs-api';
const ALGORITHM = 'HS256' as const;

export interface AccessClaims {
  userId: string;
  sessionId: string;
  authTime: number; // unix seconds
  method: string;
}

export interface TokenConfig {
  JWT_ACCESS_SECRET: string;
  ACCESS_TOKEN_TTL: string; // 600s | 10m
}

export class TokenService {
  readonly ttlSeconds: number;

  constructor(private readonly cfg: TokenConfig) {
    const n = Number.parseInt(cfg.ACCESS_TOKEN_TTL, 10);
    this.ttlSeconds = cfg.ACCESS_TOKEN_TTL.endsWith('m') ? n * 60 : n;
  }

  signAccess(claims: AccessClaims): string {
    return jwt.sign({ sid: claims.sessionId, auth_time: claims.authTime, amr: [claims.method] }, this.cfg.JWT_ACCESS_SECRET, {
      algorithm: ALGORITHM,
      subject: claims.userId,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: this.ttlSeconds,
    });
  }

  /** Returns null for anything that is not a valid, unexpired token we issued (wrong alg, secret, issuer, audience, shape). */
  verifyAccess(token: string): AccessClaims | null {
    try {
      const d = jwt.verify(token, this.cfg.JWT_ACCESS_SECRET, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        clockTolerance: 5,
      });
      if (typeof d === 'string') return null;
      const { sub, sid, auth_time: authTime, amr } = d as Record<string, unknown>;
      if (typeof sub !== 'string' || typeof sid !== 'string' || typeof authTime !== 'number') return null;
      return { userId: sub, sessionId: sid, authTime, method: Array.isArray(amr) && typeof amr[0] === 'string' ? amr[0] : 'password' };
    } catch {
      return null;
    }
  }
}

/** Opaque random refresh token sent to the browser. Only its hash is stored. */
export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { GmailConnectionDto } from '@dcs-docs/shared';
import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../utils/logger.js';
import { EmailProviderError, type EmailProvider } from '../../providers/email/types.js';
import { GMAIL_SEND_SCOPE } from '../../providers/email/gmail.js';
import { recordAudit } from '../audit/index.js';
import type { SecretBox } from './secretBox.js';

const STATE_TTL_MS = 10 * 60_000;
const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class EmailConnectionsService {
  private readonly tokenCache = new Map<string, { token: string; expires: number }>();

  constructor(
    private readonly db: PrismaClient,
    private readonly provider: EmailProvider,
    private readonly box: SecretBox
  ) {}

  get available() {
    return this.provider.available;
  }

  async status(userId: string, email: string): Promise<GmailConnectionDto> {
    const c = await this.db.emailProviderConnection.findUnique({ where: { userId }, select: { status: true } });
    return { status: (c?.status as GmailConnectionDto['status']) ?? 'NONE', googleEmail: c?.status === 'ACTIVE' ? email : null, available: this.provider.available };
  }

  /** Step 1: a single-use state and a PKCE verifier are stored; the user is sent to Google's consent page. */
  async start(userId: string, email: string): Promise<{ url: string }> {
    if (!this.provider.available) throw new HttpError(503, 'Gmail sending is not configured yet', 'INTERNAL_ERROR');
    const state = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    await this.db.$transaction([
      this.db.emailOauthState.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] } }),
      this.db.emailOauthState.create({
        data: { stateHash: sha256(state), userId, codeVerifierCiphertext: this.box.seal(verifier, 'oauth-verifier'), keyId: this.box.keyId, expiresAt: new Date(Date.now() + STATE_TTL_MS) },
      }),
    ]);
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    return { url: this.provider.buildAuthUrl({ state, codeChallenge: challenge, loginHint: email }) };
  }

  /** Step 2 (browser redirect from Google): state must exist, be unexpired and unused. Returns the user id or null. */
  async complete(code: string, state: string): Promise<string | null> {
    const row = await this.db.emailOauthState.findUnique({ where: { stateHash: sha256(state) } });
    if (!row) return null;
    // single use: removed whether or not the rest succeeds
    const gone = await this.db.emailOauthState.deleteMany({ where: { id: row.id } });
    if (gone.count !== 1 || row.expiresAt < new Date()) return null;
    try {
      const { refreshToken } = await this.provider.exchangeCode({ code, codeVerifier: this.box.open(row.codeVerifierCiphertext, 'oauth-verifier') });
      const data = { status: 'ACTIVE', scopes: [GMAIL_SEND_SCOPE], refreshTokenCiphertext: this.box.seal(refreshToken, 'gmail-refresh'), keyId: this.box.keyId, connectedAt: new Date(), revokedAt: null };
      await this.db.$transaction(async (tx) => {
        await tx.emailProviderConnection.upsert({ where: { userId: row.userId }, create: { userId: row.userId, ...data }, update: data });
        await recordAudit(tx, { actorType: 'USER', actorUserId: row.userId, action: 'EMAIL_CONNECTED', resourceType: 'user', resourceId: row.userId, details: { provider: 'gmail' } });
      });
      this.tokenCache.delete(row.userId);
      return row.userId;
    } catch (err) {
      logger.warn('Gmail connection failed', { userId: row.userId, error: err instanceof Error ? err.message : 'error' });
      return null;
    }
  }

  /** Removes our copy of the token at once, and asks Google to revoke it (best effort). */
  async disconnect(userId: string): Promise<void> {
    const c = await this.db.emailProviderConnection.findUnique({ where: { userId } });
    if (!c || c.status !== 'ACTIVE') return;
    const token = c.refreshTokenCiphertext ? this.box.open(c.refreshTokenCiphertext, 'gmail-refresh') : null;
    await this.db.$transaction(async (tx) => {
      await this.wipe(tx, userId, 'REVOKED');
      await recordAudit(tx, { actorType: 'USER', actorUserId: userId, action: 'EMAIL_DISCONNECTED', resourceType: 'user', resourceId: userId });
    });
    this.tokenCache.delete(userId);
    if (token) await this.provider.revoke(token).catch((e) => logger.warn('Gmail token revoke failed', { error: e instanceof Error ? e.message : 'error' }));
  }

  /** Used inside other transactions, e.g. when a user is deactivated. */
  async wipe(tx: Prisma.TransactionClient, userId: string, status: 'REVOKED' | 'ERROR') {
    await tx.emailProviderConnection.updateMany({ where: { userId }, data: { status, refreshTokenCiphertext: null, revokedAt: new Date() } });
  }

  /** A fresh access token for sending (cached briefly). Throws AUTH_REVOKED when the user must reconnect. */
  async accessToken(userId: string): Promise<{ token: string; connectionId: string }> {
    const c = await this.db.emailProviderConnection.findUnique({ where: { userId } });
    if (!c || c.status !== 'ACTIVE' || !c.refreshTokenCiphertext) throw new EmailProviderError('AUTH_REVOKED', 'Gmail is not connected');
    const cached = this.tokenCache.get(userId);
    if (cached && cached.expires > Date.now() + 60_000) return { token: cached.token, connectionId: c.id };
    try {
      const r = await this.provider.refreshAccessToken(this.box.open(c.refreshTokenCiphertext, 'gmail-refresh'));
      this.tokenCache.set(userId, { token: r.accessToken, expires: Date.now() + r.expiresInSeconds * 1000 });
      await this.db.emailProviderConnection.update({ where: { id: c.id }, data: { lastUsedAt: new Date() } });
      return { token: r.accessToken, connectionId: c.id };
    } catch (err) {
      if (err instanceof EmailProviderError && err.kind === 'AUTH_REVOKED') {
        this.tokenCache.delete(userId);
        await this.db.$transaction((tx) => this.wipe(tx, userId, 'REVOKED'));
      }
      throw err;
    }
  }
}

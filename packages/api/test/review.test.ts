import { readdirSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmailProvider } from '../src/providers/email/types.js';
import { ALLOWED_ORIGIN } from './helpers/app.js';
import { buildFullApp, createTestUser, csrfPair, signIn, type Client } from './helpers/fullApp.js';
import { skipDb, testPrisma } from './helpers/db.js';
import { FakeScanner, makePdf, makeTestFiles } from './helpers/storage.js';

/** Mirrors email.test.ts's mock provider: records what was "sent" via Gmail without touching the network. */
class MockEmailProvider implements EmailProvider {
  readonly name = 'mock-gmail';
  readonly available = true;
  sentMessages: { accessToken: string; raw: Buffer }[] = [];
  authUrl = 'https://consent.google.test/auth';
  refreshTokenToReturn = `mock-refresh-${Math.random().toString(36).slice(2)}`;
  accessTokenToReturn = 'mock-access-token';

  buildAuthUrl(input: { state: string; codeChallenge: string; loginHint: string }): string {
    return `${this.authUrl}?state=${input.state}&challenge=${input.codeChallenge}&hint=${encodeURIComponent(input.loginHint)}`;
  }
  async exchangeCode(): Promise<{ refreshToken: string }> {
    return { refreshToken: this.refreshTokenToReturn };
  }
  async refreshAccessToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    return { accessToken: this.accessTokenToReturn, expiresInSeconds: 3600 };
  }
  async revoke(): Promise<void> {}
  async send(accessToken: string, rawMessage: Buffer): Promise<{ providerMessageId: string }> {
    this.sentMessages.push({ accessToken, raw: rawMessage });
    return { providerMessageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}` };
  }
}

// A real, tiny (4x4) JPEG -- fake test fixture, never a real signature.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqD/9k=';
const tinyJpeg = () => Buffer.from(TINY_JPEG_BASE64, 'base64');

describe.skipIf(skipDb)('external document review: share links, comments, accept/dismiss, signatures (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const scanner = new FakeScanner();
  const mockProvider = new MockEmailProvider();
  let stack: Awaited<ReturnType<typeof makeTestFiles>>;
  let app: ReturnType<typeof buildFullApp>['app'];
  let services: ReturnType<typeof buildFullApp>['services'];

  let admin: Client;
  let sender: Client;
  let typeId = '';
  let defaultSignatureId = '';

  const uniq = (b: string) => `${b} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const drain = () => services.jobs.drain();

  /** No route exposes the raw token: it only ever appears in the one outbound email's stored plain-text body. */
  async function extractToken(shareLinkId: string): Promise<string> {
    const link = await prisma.documentShareLink.findUniqueOrThrow({ where: { id: shareLinkId } });
    expect(link.initialEmailMessageId).not.toBeNull();
    const msg = await prisma.emailMessage.findUniqueOrThrow({ where: { id: link.initialEmailMessageId! } });
    const m = /\/review\/([A-Za-z0-9_-]+)/.exec(msg.bodyText);
    expect(m, msg.bodyText).not.toBeNull();
    return m![1]!;
  }

  async function connectGmail(client: Client) {
    const start = await client.post('/email/connection/start');
    const state = new URL(start.body.data.url).searchParams.get('state')!;
    const res = await request(app).get(`/api/v1/email/connection/callback?code=good&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.header.location).toContain('connected=1');
  }

  async function createActiveDocument(name: string): Promise<string> {
    const res = await request(app)
      .post('/api/v1/documents')
      .set(admin.auth())
      .field('typeId', typeId)
      .field('name', name)
      .field('metadata', '{}')
      .attach('file', makePdf(), { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await drain();
    await admin.post(`/documents/${res.body.data.id}/activate`);
    return res.body.data.id as string;
  }

  async function createLink(documentId: string, overrides: Record<string, unknown> = {}) {
    const res = await admin.post(`/documents/${documentId}/share-links`, { recipientEmail: 'client@example.test', ...overrides });
    return res;
  }

  /** Public POST goes through the real global CSRF middleware -- a proper double-submit pair is required. */
  async function publicPost(path: string, body: object) {
    const c = await csrfPair(app);
    return request(app).post(`/api/v1${path}`).set('Cookie', c.cookie).set('X-CSRF-Token', c.token).set('Origin', ALLOWED_ORIGIN).send(body);
  }

  beforeAll(async () => {
    stack = await makeTestFiles();
    ({ app, services } = buildFullApp(prisma, {}, { files: stack.files, scanner, emailProvider: mockProvider }));

    admin = await signIn(app, (await createTestUser(prisma, services, { role: 'ADMIN' })).email);
    sender = await signIn(app, (await createTestUser(prisma, services, { role: 'SENDER' })).email);
    await connectGmail(admin);

    const t = await admin.post('/document-types', { name: uniq('Reviewable'), fields: [] });
    typeId = t.body.data.id;

    const sig = await request(app)
      .post('/api/v1/signature-assets')
      .set(admin.auth())
      .field('label', 'Primary signature')
      .field('pageNumber', '1')
      .field('xPt', '50')
      .field('yPt', '50')
      .field('widthPt', '120')
      .field('heightPt', '48')
      .attach('file', tinyJpeg(), { filename: 'sig.jpg', contentType: 'image/jpeg' });
    expect(sig.status, JSON.stringify(sig.body)).toBe(201);
    defaultSignatureId = sig.body.data.id;
    expect((await admin.post(`/signature-assets/${defaultSignatureId}/set-default`)).body.data.isDefault).toBe(true);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    stack.cleanup();
  });

  describe('signature assets', () => {
    it('uploads straight to clean storage (never quarantined/scanned) and lists newest/default first', async () => {
      const list = await admin.get('/signature-assets');
      expect(list.status).toBe(200);
      expect(list.body.data[0]).toMatchObject({ id: defaultSignatureId, isDefault: true, isActive: true });

      const cleanFiles = readdirSync(path.join(stack.base, 'clean')).length;
      expect(cleanFiles).toBeGreaterThan(0);
    });

    it('rejects a non-JPEG file even if named .jpg', async () => {
      const res = await request(app)
        .post('/api/v1/signature-assets')
        .set(admin.auth())
        .field('label', 'Bad')
        .field('pageNumber', '1').field('xPt', '0').field('yPt', '0').field('widthPt', '10').field('heightPt', '10')
        .attach('file', Buffer.from('not a jpeg'), { filename: 'bad.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(400);
    });

    it('set-default clears the previous default inside one transaction (DB allows only one)', async () => {
      const second = await request(app)
        .post('/api/v1/signature-assets')
        .set(admin.auth())
        .field('label', 'Second signature')
        .field('pageNumber', '1').field('xPt', '10').field('yPt', '10').field('widthPt', '80').field('heightPt', '30')
        .attach('file', tinyJpeg(), { filename: 'sig2.jpg', contentType: 'image/jpeg' });
      expect(second.status).toBe(201);
      const secondId = second.body.data.id;

      await admin.post(`/signature-assets/${secondId}/set-default`);
      const rows = await prisma.signatureAsset.findMany({ where: { isDefault: true } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(secondId);

      // Restore the fixture used by the rest of this suite.
      await admin.post(`/signature-assets/${defaultSignatureId}/set-default`);
      await admin.post(`/signature-assets/${secondId}/deactivate`);
    });

    it('is off-limits to a role without documents:review / signatures:manage', async () => {
      expect((await sender.get('/signature-assets')).status).toBe(403);
      expect((await sender.post(`/signature-assets/${defaultSignatureId}/set-default`)).status).toBe(403);
    });
  });

  describe('create & send a share link, public viewing', () => {
    let documentId = '';
    let shareLinkId = '';
    let token = '';

    beforeAll(async () => {
      documentId = await createActiveDocument(uniq('Reviewable doc'));
      const res = await createLink(documentId);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ documentId, recipientEmail: 'client@example.test', status: 'SENT', previousLinkId: null });
      shareLinkId = res.body.data.id;
      token = await extractToken(shareLinkId);
    });

    it('never exposes the raw token or storage details in any authenticated response', async () => {
      const body = JSON.stringify((await admin.get(`/documents/${documentId}/share-links`)).body);
      expect(body).not.toContain(token);
      expect(body).not.toMatch(/storageKey|wrappedDataKey|tokenHash/i);
    });

    it('the public info route returns document name, page count and an empty comment list, and marks the link VIEWED', async () => {
      const res = await request(app).get(`/api/v1/public/review/${token}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ pageCount: 1, status: 'ACTIVE', comments: [] });

      const links = (await admin.get(`/documents/${documentId}/share-links`)).body.data;
      expect(links.find((l: any) => l.id === shareLinkId).status).toBe('VIEWED');
    });

    it('the public content route serves the exact PDF bytes with the same sandboxed headers as the authenticated content route', async () => {
      const res = await request(app).get(`/api/v1/public/review/${token}/content`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/^inline;/);
      expect(res.headers['content-security-policy']).toMatch(/default-src 'none'; sandbox/);
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['etag']).toBeTruthy();
    });

    it('requires a real CSRF double-submit pair for the comment POST, even though the route itself needs no login', async () => {
      const bare = await request(app).post(`/api/v1/public/review/${token}/comments`).send({ pageNumber: 1, xPct: 0.5, yPct: 0.5, body: 'no csrf' });
      expect(bare.status).toBe(403);
      expect(bare.body.error.code).toBe('CSRF_FAILED');
    });

    it('accepts one open comment, stores client IP/UA, rejects a second while the first is open (409, not a raw DB error), and queues the notify job', async () => {
      const res = await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.25, yPct: 0.6, body: 'Please change the counterparty name.' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ pageNumber: 1, xPct: 0.25, yPct: 0.6, status: 'OPEN' });
      const commentId = res.body.data.id;

      const row = await prisma.documentReviewComment.findUniqueOrThrow({ where: { id: commentId } });
      expect(row.clientIp).not.toBeNull();

      const again = await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.1, yPct: 0.1, body: 'a second change' });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CONFLICT');

      const links = (await admin.get(`/documents/${documentId}/share-links`)).body.data;
      expect(links.find((l: any) => l.id === shareLinkId).status).toBe('COMMENTED');

      mockProvider.sentMessages = [];
      await drain();
      const notified = await prisma.auditLog.findFirstOrThrow({ where: { action: 'REVIEW_COMMENT_NOTIFIED', resourceId: commentId } });
      expect(notified.outcome).toBe('SUCCESS');
      expect(mockProvider.sentMessages.length).toBeGreaterThanOrEqual(1); // the team notification was actually sent
    });

    it('never embeds a raw comment body into HTML or SQL -- it is plain JSON data, round-tripped verbatim', async () => {
      const list = await admin.get(`/documents/${documentId}/review-comments`);
      const risky = list.body.data.find((c: any) => c.body.includes('counterparty'));
      expect(risky.body).toBe('Please change the counterparty name.');
      expect(JSON.stringify(list.body)).not.toMatch(/dangerouslySetInnerHTML|<script/i);
    });

    it('accept re-stamps the pinned version into a new CLEAN version, resolves the comment, and consumes the link', async () => {
      const comments = (await admin.get(`/documents/${documentId}/review-comments`)).body.data;
      const open = comments.find((c: any) => c.status === 'OPEN');

      const res = await admin.post(`/review-comments/${open.id}/accept`, {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.status).toBe('ACCEPTED');

      const doc = await admin.get(`/documents/${documentId}`);
      const versions = doc.body.data.versions;
      const newest = versions[0];
      expect(newest.isCurrent).toBe(true);
      expect(newest.versionNumber).toBe(2);
      expect(newest.scanStatus).toBe('CLEAN');

      const row = await prisma.documentVersion.findUniqueOrThrow({ where: { id: newest.id } });
      expect((row.scanDetails as any).source).toBe('review_accept');
      expect((row.scanDetails as any).commentId).toBe(open.id);

      const links = (await admin.get(`/documents/${documentId}/share-links`)).body.data;
      expect(links.find((l: any) => l.id === shareLinkId).status).toBe('ACCEPTED');

      for (const path of [`/public/review/${token}`, `/public/review/${token}/content`]) {
        expect((await request(app).get(`/api/v1${path}`)).status).toBe(404);
      }
      expect((await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.5, yPct: 0.5, body: 'late' })).status).toBe(404);
    });

    it('resend mints a brand-new token; it is rejected unless the previous link already reached ACCEPTED or DISMISSED', async () => {
      const freshLinkRes = await createLink(documentId);
      expect(freshLinkRes.status).toBe(201);
      const stillOpenId = freshLinkRes.body.data.id;

      const badResend = await createLink(documentId, { previousLinkId: stillOpenId });
      expect(badResend.status).toBe(409);

      const resend = await createLink(documentId, { previousLinkId: shareLinkId });
      expect(resend.status, JSON.stringify(resend.body)).toBe(201);
      expect(resend.body.data.previousLinkId).toBe(shareLinkId);
      const newToken = await extractToken(resend.body.data.id);
      expect(newToken).not.toBe(token);
      expect((await request(app).get(`/api/v1/public/review/${newToken}`)).status).toBe(200);
    });
  });

  describe('dismiss, expiry and revocation', () => {
    it('dismiss resolves the comment and makes the link terminal too', async () => {
      const documentId = await createActiveDocument(uniq('Dismiss doc'));
      const link = await createLink(documentId);
      const token = await extractToken(link.body.data.id);
      const commentRes = await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.5, yPct: 0.5, body: 'please reconsider' });
      expect(commentRes.status).toBe(201);

      const dismissed = await admin.post(`/review-comments/${commentRes.body.data.id}/dismiss`, { resolutionNote: 'Not needed, thanks' });
      expect(dismissed.status).toBe(200);
      expect(dismissed.body.data.status).toBe('DISMISSED');
      expect(dismissed.body.data.resolutionNote).toBe('Not needed, thanks');

      expect((await request(app).get(`/api/v1/public/review/${token}`)).status).toBe(404);
      const links = (await admin.get(`/documents/${documentId}/share-links`)).body.data;
      expect(links.find((l: any) => l.id === link.body.data.id).status).toBe('DISMISSED');
    });

    it('an expired link 404s on every public route, same as a missing one', async () => {
      const documentId = await createActiveDocument(uniq('Expiry doc'));
      const link = await createLink(documentId);
      const token = await extractToken(link.body.data.id);
      await prisma.documentShareLink.update({ where: { id: link.body.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

      expect((await request(app).get(`/api/v1/public/review/${token}`)).status).toBe(404);
      expect((await request(app).get(`/api/v1/public/review/${token}/content`)).status).toBe(404);
      expect((await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.5, yPct: 0.5, body: 'too late' })).status).toBe(404);
    });

    it('a revoked link and an unknown token both 404, indistinguishably', async () => {
      const documentId = await createActiveDocument(uniq('Revoke doc'));
      const link = await createLink(documentId);
      const token = await extractToken(link.body.data.id);
      await prisma.documentShareLink.update({ where: { id: link.body.data.id }, data: { status: 'REVOKED', revokedAt: new Date() } });

      const revokedRes = await request(app).get(`/api/v1/public/review/${token}`);
      const unknownRes = await request(app).get('/api/v1/public/review/not-a-real-token-at-all-00000000000000000000');
      expect(revokedRes.status).toBe(404);
      expect(unknownRes.status).toBe(404);
      expect(revokedRes.body.error.message).toBe(unknownRes.body.error.message);
    });

    it('rejects an obviously malformed token with 400 before touching the database', async () => {
      expect((await request(app).get('/api/v1/public/review/not%20a%20token')).status).toBe(400);
    });
  });

  describe('notify-the-team job', () => {
    it('emails every ACTIVE user holding documents:review, never attaching the PDF', async () => {
      const documentId = await createActiveDocument(uniq('Notify doc'));
      const link = await createLink(documentId);
      const token = await extractToken(link.body.data.id);
      mockProvider.sentMessages = [];
      const commentRes = await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.5, yPct: 0.5, body: 'team should see this' });
      expect(commentRes.status).toBe(201);
      await drain();

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'REVIEW_COMMENT_NOTIFIED', resourceId: commentRes.body.data.id } });
      expect(audit.outcome).toBe('SUCCESS');
      expect(mockProvider.sentMessages.length).toBeGreaterThanOrEqual(1);

      // The notification email never carries an attachment (it only ever points at the internal staff page).
      const sent = await prisma.emailMessage.findFirstOrThrow({ where: { subject: { startsWith: 'New review comment on' } }, orderBy: { createdAt: 'desc' } });
      expect(await prisma.emailAttachment.count({ where: { messageId: sent.id } })).toBe(0);
    });

    it('a disconnected Gmail at notify-time records REVIEW_COMMENT_NOTIFICATION_FAILED and leaves the job DONE (no retry)', async () => {
      const admin2 = await signIn(app, (await createTestUser(prisma, services, { role: 'ADMIN' })).email);
      await connectGmail(admin2);
      const documentId = await createActiveDocument(uniq('Gmail gap doc'));
      const linkRes = await admin2.post(`/documents/${documentId}/share-links`, { recipientEmail: 'client2@example.test' });
      expect(linkRes.status).toBe(201);
      const token = await extractToken(linkRes.body.data.id);

      await admin2.del('/email/connection'); // creator's Gmail goes away AFTER the link was already sent

      const commentRes = await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.5, yPct: 0.5, body: 'gmail gap' });
      expect(commentRes.status).toBe(201);
      const jobBefore = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `notify-review-comment:${commentRes.body.data.id}` } });
      expect(jobBefore.status).toBe('PENDING');

      await drain();

      const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: jobBefore.id } });
      expect(job.status).toBe('DONE'); // not retried and not DEAD: this is a known, final outcome

      const failure = await prisma.auditLog.findFirstOrThrow({ where: { action: 'REVIEW_COMMENT_NOTIFICATION_FAILED', resourceId: commentRes.body.data.id } });
      expect(failure.outcome).toBe('FAILURE');
      expect((failure.details as any).reason).toBe('GMAIL_NOT_CONNECTED');
    });
  });

  describe('public rate limits', () => {
    it('trips on the public review-info route once the generous viewing budget is exhausted', async () => {
      const low = buildFullApp(prisma, { RATE_LIMIT_PUBLIC_REVIEW_MAX_PER_HOUR: 3 }, { files: stack.files, scanner, emailProvider: mockProvider });
      const results: number[] = [];
      for (let i = 0; i < 4; i++) results.push((await request(low.app).get('/api/v1/public/review/does-not-matter-for-this-limiter-test')).status);
      expect(results.slice(0, 3)).toEqual([404, 404, 404]);
      expect(results[3]).toBe(429);
    });

    it('trips tightly on the public comment route', async () => {
      const low = buildFullApp(prisma, { RATE_LIMIT_PUBLIC_COMMENT_MAX_PER_HOUR: 2 }, { files: stack.files, scanner, emailProvider: mockProvider });
      const post = async () => {
        const c = await csrfPair(low.app);
        return request(low.app)
          .post('/api/v1/public/review/does-not-matter-for-this-limiter-test/comments')
          .set('Cookie', c.cookie).set('X-CSRF-Token', c.token).set('Origin', ALLOWED_ORIGIN)
          .send({ pageNumber: 1, xPct: 0.5, yPct: 0.5, body: 'x' });
      };
      const results = [await post(), await post(), await post()];
      expect(results.slice(0, 2).map((r) => r.status)).toEqual([404, 404]);
      expect(results[2]!.status).toBe(429);
    });
  });
});

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
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

/** pdf-lib's content streams are Flate-compressed, so a plain byte search never finds drawn text. Pull every
 * `stream...endstream` block out of the raw PDF, inflate the ones that are real zlib data (skip the rest, e.g.
 * the JPEG XObject), and check the decompressed text -- a real, if blunt, proof the string actually got drawn. */
function pdfContainsText(pdfBytes: Buffer, needle: string): boolean {
  // pdf-lib's drawText writes a PDF hex string (`<...Tj>`), not a parenthesized literal -- check both forms.
  const needleHex = Buffer.from(needle, 'latin1').toString('hex').toUpperCase();
  const matches = (s: string) => s.includes(needle) || s.toUpperCase().includes(needleHex);
  const raw = pdfBytes.toString('latin1');
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (matches(m[1]!)) return true; // an uncompressed stream -- check it as-is
    try {
      if (matches(inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1'))) return true;
    } catch {
      // not a zlib stream (e.g. the embedded JPEG) -- already checked raw above, nothing more to do
    }
  }
  return false;
}

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

    it('accepts several comments on one link -- a plain note and a suggested change -- stores client IP/UA, and queues the notify job', async () => {
      const res = await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.25, yPct: 0.6, body: 'Please change the counterparty name.' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ kind: 'COMMENT', pageNumber: 1, xPct: 0.25, yPct: 0.6, status: 'OPEN', replacementText: null, applied: false });
      const commentId = res.body.data.id;

      const row = await prisma.documentReviewComment.findUniqueOrThrow({ where: { id: commentId } });
      expect(row.clientIp).not.toBeNull();

      // A second one while the first is still open is now fine: a client raises as many points as they need.
      const change = await publicPost(`/public/review/${token}/comments`, {
        kind: 'CHANGE', pageNumber: 1, xPct: 0.1, yPct: 0.2, boxWPct: 0.3, boxHPct: 0.04, originalText: 'Party B', replacementText: 'Acme Solar Pvt Ltd',
      });
      expect(change.status, JSON.stringify(change.body)).toBe(201);
      expect(change.body.data).toMatchObject({ kind: 'CHANGE', boxWPct: 0.3, boxHPct: 0.04, originalText: 'Party B', replacementText: 'Acme Solar Pvt Ltd', status: 'OPEN', applied: false });
      expect(change.body.data.body).toBe('Change "Party B" to "Acme Solar Pvt Ltd"'); // the server writes the summary line

      // A suggested change must carry its box and new text; a plain note must not.
      expect((await publicPost(`/public/review/${token}/comments`, { kind: 'CHANGE', pageNumber: 1, xPct: 0.1, yPct: 0.1, replacementText: 'x' })).status).toBe(400);
      expect((await publicPost(`/public/review/${token}/comments`, { kind: 'CHANGE', pageNumber: 1, xPct: 0.9, yPct: 0.1, boxWPct: 0.3, boxHPct: 0.1, replacementText: 'x' })).status).toBe(400); // runs off the page
      expect((await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.1, yPct: 0.1, body: 'note', replacementText: 'x' })).status).toBe(400);

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

    it('accepting only records the decision (no new version); the link closes itself when the LAST open comment is answered', async () => {
      const comments = (await admin.get(`/documents/${documentId}/review-comments`)).body.data;
      const note = comments.find((c: any) => c.status === 'OPEN' && c.kind === 'COMMENT');
      const change = comments.find((c: any) => c.status === 'OPEN' && c.kind === 'CHANGE');

      const first = await admin.post(`/review-comments/${note.id}/accept`, {});
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.data.status).toBe('ACCEPTED');
      // One comment is still open, so the client's link keeps working.
      expect((await admin.get(`/documents/${documentId}/share-links`)).body.data.find((l: any) => l.id === shareLinkId).status).toBe('COMMENTED');
      expect((await request(app).get(`/api/v1/public/review/${token}`)).status).toBe(200);

      const second = await admin.post(`/review-comments/${change.id}/accept`, {});
      expect(second.status).toBe(200);

      expect((await admin.get(`/documents/${documentId}`)).body.data.versions).toHaveLength(1); // nothing was written to the PDF yet
      expect((await admin.get(`/documents/${documentId}/share-links`)).body.data.find((l: any) => l.id === shareLinkId).status).toBe('ACCEPTED');

      for (const path of [`/public/review/${token}`, `/public/review/${token}/content`]) {
        expect((await request(app).get(`/api/v1${path}`)).status).toBe(404);
      }
      expect((await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.5, yPct: 0.5, body: 'late' })).status).toBe(404);
    });

    it('apply-changes writes the accepted change into a new CLEAN version; stamp-signature then adds the signature as another', async () => {
      const applied = await admin.post(`/documents/${documentId}/review/apply-changes`, { shareLinkId });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      expect(applied.body.data).toMatchObject({ versionNumber: 2, applied: 1 });

      let versions = (await admin.get(`/documents/${documentId}`)).body.data.versions;
      expect(versions[0]).toMatchObject({ isCurrent: true, versionNumber: 2, scanStatus: 'CLEAN' });
      const v2 = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versions[0].id } });
      expect((v2.scanDetails as any).source).toBe('review_apply');
      const v1 = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versions[1].id } });
      expect(v2.sha256).not.toBe(v1.sha256); // the bytes really changed

      const comments = (await admin.get(`/documents/${documentId}/review-comments`)).body.data;
      expect(comments.find((c: any) => c.kind === 'CHANGE')).toMatchObject({ status: 'ACCEPTED', applied: true });
      expect(comments.find((c: any) => c.kind === 'COMMENT').applied).toBe(false); // a plain note has nothing to apply

      // Nothing is left to apply, so a second click is a clean 409 and writes no extra version.
      expect((await admin.post(`/documents/${documentId}/review/apply-changes`, { shareLinkId })).status).toBe(409);

      const signed = await admin.post(`/documents/${documentId}/review/stamp-signature`, {});
      expect(signed.status, JSON.stringify(signed.body)).toBe(200);
      expect(signed.body.data.versionNumber).toBe(3);
      versions = (await admin.get(`/documents/${documentId}`)).body.data.versions;
      const v3 = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versions[0].id } });
      expect((v3.scanDetails as any)).toMatchObject({ source: 'review_signature', signatureAssetId: defaultSignatureId });

      // Stamping the same version twice would draw the signature on top of itself.
      expect((await admin.post(`/documents/${documentId}/review/stamp-signature`, {})).status).toBe(409);
      expect((await admin.get(`/documents/${documentId}`)).body.data.versions).toHaveLength(3);
    });

    it('a signing send mints a fresh link to the same person, attaches the final PDF, and uses the signing wording', async () => {
      mockProvider.sentMessages = [];
      const res = await createLink(documentId, { purpose: 'SIGNING', previousLinkId: shareLinkId });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.previousLinkId).toBe(shareLinkId);
      await drain(); // the email leaves through the job queue

      const link = await prisma.documentShareLink.findUniqueOrThrow({ where: { id: res.body.data.id } });
      const msg = await prisma.emailMessage.findUniqueOrThrow({ where: { id: link.initialEmailMessageId! } });
      expect(msg.subject).toMatch(/review and sign/i);
      const sent = mockProvider.sentMessages.at(-1)!.raw.toString('latin1');
      expect(sent).toMatch(/application\/pdf/i); // the PDF itself travelled with the email
      expect(sent).toMatch(/Content-Disposition: attachment/i);
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

  describe('review round ordering: answer everything, apply changes, then sign', () => {
    const box = { kind: 'CHANGE', pageNumber: 1, xPct: 0.1, yPct: 0.2, boxWPct: 0.3, boxHPct: 0.04 };

    async function startRound(replacementText: string) {
      const documentId = await createActiveDocument(uniq('Round doc'));
      const link = await createLink(documentId);
      const token = await extractToken(link.body.data.id);
      const c = await publicPost(`/public/review/${token}/comments`, { ...box, replacementText });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      return { documentId, shareLinkId: link.body.data.id as string, token, commentId: c.body.data.id as string };
    }

    it('refuses to apply while any comment on the link is still open', async () => {
      const r = await startRound('Acme Solar');
      const res = await admin.post(`/documents/${r.documentId}/review/apply-changes`, { shareLinkId: r.shareLinkId });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/open comment/i);
    });

    it('refuses to stamp the signature while an accepted change is still waiting to be applied -- the signature goes last', async () => {
      const r = await startRound('Acme Solar');
      await admin.post(`/review-comments/${r.commentId}/accept`, {});
      const early = await admin.post(`/documents/${r.documentId}/review/stamp-signature`, {});
      expect(early.status).toBe(409);
      expect(early.body.error.message).toMatch(/apply/i);

      expect((await admin.post(`/documents/${r.documentId}/review/apply-changes`, { shareLinkId: r.shareLinkId })).status).toBe(200);
      expect((await admin.post(`/documents/${r.documentId}/review/stamp-signature`, {})).status).toBe(200);
    });

    it('a dismissed change is never applied: with nothing accepted there is nothing to write', async () => {
      const r = await startRound('Acme Solar');
      await admin.post(`/review-comments/${r.commentId}/dismiss`, {});
      const res = await admin.post(`/documents/${r.documentId}/review/apply-changes`, { shareLinkId: r.shareLinkId });
      expect(res.status).toBe(409);
      expect((await admin.get(`/documents/${r.documentId}`)).body.data.versions).toHaveLength(1);
    });

    it('text the PDF font cannot draw is a clear 400 and leaves the document untouched', async () => {
      const r = await startRound('日本語');
      await admin.post(`/review-comments/${r.commentId}/accept`, {});
      const res = await admin.post(`/documents/${r.documentId}/review/apply-changes`, { shareLinkId: r.shareLinkId });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.message).toMatch(/cannot draw/i);
      expect((await admin.get(`/documents/${r.documentId}`)).body.data.versions).toHaveLength(1);
      // The comment stays accepted-but-unapplied, so staff can still dismiss/handle it; nothing was half-written.
      const row = await prisma.documentReviewComment.findUniqueOrThrow({ where: { id: r.commentId } });
      expect(row.resultingVersionId).toBeNull();
    });

    it('refuses to apply on top of a version uploaded after the link was sent (the client\'s marks would no longer line up)', async () => {
      const r = await startRound('Acme Solar');
      await admin.post(`/review-comments/${r.commentId}/accept`, {});
      const upload = await request(app)
        .post(`/api/v1/documents/${r.documentId}/versions`)
        .set(admin.auth())
        .attach('file', makePdf({ body: 'BT /F1 12 Tf 72 700 Td (A completely different upload) Tj ET' }), { filename: 'doc.pdf', contentType: 'application/pdf' });
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
      await drain();
      // An upload only becomes the current version once someone promotes it.
      const newest = (await admin.get(`/documents/${r.documentId}`)).body.data.versions[0];
      expect(newest.versionNumber).toBe(2);
      expect((await admin.post(`/documents/${r.documentId}/versions/${newest.id}/promote`, {})).status).toBe(200);
      const res = await admin.post(`/documents/${r.documentId}/review/apply-changes`, { shareLinkId: r.shareLinkId });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/newer version/i);
    });

    it('is off-limits to a role without documents:review', async () => {
      const r = await startRound('Acme Solar');
      expect((await sender.post(`/documents/${r.documentId}/review/apply-changes`, { shareLinkId: r.shareLinkId })).status).toBe(403);
      expect((await sender.post(`/documents/${r.documentId}/review/stamp-signature`, {})).status).toBe(403);
    });
  });

  describe('incorporate-changes: the combined apply + stamp step, as ONE new version', () => {
    const box = { kind: 'CHANGE', pageNumber: 1, xPct: 0.1, yPct: 0.2, boxWPct: 0.3, boxHPct: 0.04 };

    async function startRound(replacementText: string) {
      const documentId = await createActiveDocument(uniq('Incorporate doc'));
      const link = await createLink(documentId);
      const token = await extractToken(link.body.data.id);
      const c = await publicPost(`/public/review/${token}/comments`, { ...box, replacementText });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      return { documentId, shareLinkId: link.body.data.id as string, commentId: c.body.data.id as string };
    }

    it('applies the accepted change and stamps the signature as a single new version -- not two', async () => {
      const r = await startRound('Acme Solar');
      await admin.post(`/review-comments/${r.commentId}/accept`, {});

      const res = await admin.post(`/documents/${r.documentId}/review/incorporate-changes`, { shareLinkId: r.shareLinkId });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ versionNumber: 2, applied: 1 });

      const doc = (await admin.get(`/documents/${r.documentId}`)).body.data;
      expect(doc.versions).toHaveLength(2); // the original upload, plus exactly one combined version -- never two
      expect(doc.versions[0]).toMatchObject({ isCurrent: true, versionNumber: 2, hasSignature: true });

      const v2 = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.versions[0].id } });
      expect(v2.scanDetails).toMatchObject({ source: 'review_incorporate', signatureAssetId: defaultSignatureId });

      const comments = (await admin.get(`/documents/${r.documentId}/review-comments`)).body.data;
      expect(comments.find((c: any) => c.id === r.commentId)).toMatchObject({ applied: true });
    });

    it('staff may edit the wording at accept time -- the edited text is what gets written into the PDF, never the client\'s own submission', async () => {
      const r = await startRound('Acme Solor'); // a client typo, on purpose
      const accepted = await admin.post(`/review-comments/${r.commentId}/accept`, { editedReplacementText: 'Acme Solar Pvt Ltd' });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.data).toMatchObject({ replacementText: 'Acme Solor', editedReplacementText: 'Acme Solar Pvt Ltd' });

      // The client's own row is untouched -- only the override field changed.
      const row = await prisma.documentReviewComment.findUniqueOrThrow({ where: { id: r.commentId } });
      expect(row.replacementText).toBe('Acme Solor');
      expect(row.editedReplacementText).toBe('Acme Solar Pvt Ltd');

      const res = await admin.post(`/documents/${r.documentId}/review/incorporate-changes`, { shareLinkId: r.shareLinkId });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // The staff-edited wording is what actually reaches the PDF bytes, not the client's typo.
      const v2 = await admin.get(`/documents/${r.documentId}`);
      const content = await admin
        .get(`/documents/${r.documentId}/versions/${v2.body.data.versions[0].id}/content`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (x: Buffer) => chunks.push(x));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(content.status).toBe(200);
      const bytes = content.body as Buffer;
      expect(pdfContainsText(bytes, 'Acme Solar Pvt Ltd')).toBe(true);
      expect(pdfContainsText(bytes, 'Acme Solor')).toBe(false);
    });

    it('refuses to edit the wording of a plain COMMENT (it has no replacement to edit)', async () => {
      const documentId = await createActiveDocument(uniq('Comment-only doc'));
      const link = await createLink(documentId);
      const token = await extractToken(link.body.data.id);
      const c = await publicPost(`/public/review/${token}/comments`, { pageNumber: 1, xPct: 0.2, yPct: 0.2, body: 'Just a note' });
      expect(c.status, JSON.stringify(c.body)).toBe(201);

      const res = await admin.post(`/review-comments/${c.body.data.id}/accept`, { editedReplacementText: 'Not applicable' });
      expect(res.status).toBe(400);
    });

    it('refuses with a plain reason when nothing is accepted yet, and writes no version', async () => {
      const r = await startRound('Acme Solar'); // left OPEN, never accepted
      const res = await admin.post(`/documents/${r.documentId}/review/incorporate-changes`, { shareLinkId: r.shareLinkId });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/open comment/i);
      expect((await admin.get(`/documents/${r.documentId}`)).body.data.versions).toHaveLength(1);

      await admin.post(`/review-comments/${r.commentId}/dismiss`, {});
      const res2 = await admin.post(`/documents/${r.documentId}/review/incorporate-changes`, { shareLinkId: r.shareLinkId });
      expect(res2.status).toBe(409);
      expect(res2.body.error.message).toMatch(/nothing.*accepted|waiting to be incorporated/i);
      expect((await admin.get(`/documents/${r.documentId}`)).body.data.versions).toHaveLength(1);
    });

    it('refuses with a plain reason when no signature is configured, and writes no version even though the text edit would have succeeded', async () => {
      const r = await startRound('Acme Solar');
      await admin.post(`/review-comments/${r.commentId}/accept`, {});

      // Temporarily take the only signature out of the running, then put it straight back for every other test.
      expect((await admin.post(`/signature-assets/${defaultSignatureId}/deactivate`)).status).toBe(200);
      try {
        const res = await admin.post(`/documents/${r.documentId}/review/incorporate-changes`, { shareLinkId: r.shareLinkId });
        expect(res.status).toBe(409);
        expect(res.body.error.message).toMatch(/no signature is configured/i);
        expect((await admin.get(`/documents/${r.documentId}`)).body.data.versions).toHaveLength(1); // the text edit was never written either
      } finally {
        // Re-activating does not restore isDefault on its own; set it again so the rest of the suite is unaffected.
        const reactivated = await request(app)
          .post('/api/v1/signature-assets')
          .set(admin.auth())
          .field('label', 'Primary signature (restored)')
          .field('pageNumber', '1')
          .field('xPt', '50')
          .field('yPt', '50')
          .field('widthPt', '120')
          .field('heightPt', '48')
          .attach('file', tinyJpeg(), { filename: 'sig.jpg', contentType: 'image/jpeg' });
        expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(201);
        defaultSignatureId = reactivated.body.data.id;
        expect((await admin.post(`/signature-assets/${defaultSignatureId}/set-default`)).body.data.isDefault).toBe(true);
      }
    });

    it('the two older endpoints still work independently, producing two versions as before', async () => {
      const r = await startRound('Still Separate Inc');
      await admin.post(`/review-comments/${r.commentId}/accept`, {});
      expect((await admin.post(`/documents/${r.documentId}/review/apply-changes`, { shareLinkId: r.shareLinkId })).status).toBe(200);
      expect((await admin.post(`/documents/${r.documentId}/review/stamp-signature`, {})).status).toBe(200);
      expect((await admin.get(`/documents/${r.documentId}`)).body.data.versions).toHaveLength(3);
    });

    it('is off-limits to a role without documents:review', async () => {
      const r = await startRound('Acme Solar');
      expect((await sender.post(`/documents/${r.documentId}/review/incorporate-changes`, { shareLinkId: r.shareLinkId })).status).toBe(403);
    });
  });

  describe('edit-text: staff editing the document directly, anywhere, no client or share link involved', () => {
    it('writes every box as one new version, with the exact text staff typed', async () => {
      const documentId = await createActiveDocument(uniq('Manual edit doc'));
      const res = await admin.post(`/documents/${documentId}/review/edit-text`, {
        edits: [
          { pageNumber: 1, xPct: 0.1, yPct: 0.1, wPct: 0.3, hPct: 0.05, text: 'First Edit' },
          { pageNumber: 1, xPct: 0.1, yPct: 0.3, wPct: 0.3, hPct: 0.05, text: 'Second Edit' },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ versionNumber: 2, edited: 2 });

      const doc = (await admin.get(`/documents/${documentId}`)).body.data;
      expect(doc.versions).toHaveLength(2); // the original upload, plus exactly one new version for both edits together
      const v2 = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.versions[0].id } });
      expect(v2.scanDetails).toMatchObject({ source: 'review_manual_edit', count: 2 });

      const content = await admin
        .get(`/documents/${documentId}/versions/${doc.versions[0].id}/content`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (x: Buffer) => chunks.push(x));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(pdfContainsText(content.body as Buffer, 'First Edit')).toBe(true);
      expect(pdfContainsText(content.body as Buffer, 'Second Edit')).toBe(true);
    });

    it('refuses a box that runs off the page, and refuses a page number the document does not have', async () => {
      const documentId = await createActiveDocument(uniq('Manual edit doc'));
      const offPage = await admin.post(`/documents/${documentId}/review/edit-text`, { edits: [{ pageNumber: 1, xPct: 0.9, yPct: 0.1, wPct: 0.3, hPct: 0.05, text: 'x' }] });
      expect(offPage.status).toBe(400);

      const badPage = await admin.post(`/documents/${documentId}/review/edit-text`, { edits: [{ pageNumber: 99, xPct: 0.1, yPct: 0.1, wPct: 0.3, hPct: 0.05, text: 'x' }] });
      expect(badPage.status).toBe(409);
      expect((await admin.get(`/documents/${documentId}`)).body.data.versions).toHaveLength(1); // nothing written
    });

    it('is off-limits to a role without documents:manage', async () => {
      const documentId = await createActiveDocument(uniq('Manual edit doc'));
      expect((await sender.post(`/documents/${documentId}/review/edit-text`, { edits: [{ pageNumber: 1, xPct: 0.1, yPct: 0.1, wPct: 0.3, hPct: 0.05, text: 'x' }] })).status).toBe(403);
    });
  });

  describe('a client only ever sees comments made through their own link', () => {
    it('two different links on the same document never leak each other\'s comments to either client', async () => {
      const documentId = await createActiveDocument(uniq('Shared doc'));

      const linkA = await createLink(documentId, { recipientEmail: 'client-a@example.test' });
      const tokenA = await extractToken(linkA.body.data.id);
      const commentA = await publicPost(`/public/review/${tokenA}/comments`, { pageNumber: 1, xPct: 0.2, yPct: 0.2, body: 'Comment from client A' });
      expect(commentA.status, JSON.stringify(commentA.body)).toBe(201);

      // A's link is now terminal only once answered, so resend to get a second active link on the same document.
      await admin.post(`/review-comments/${commentA.body.data.id}/dismiss`, {});
      const linkB = await createLink(documentId, { recipientEmail: 'client-b@example.test', previousLinkId: linkA.body.data.id });
      const tokenB = await extractToken(linkB.body.data.id);
      const commentB = await publicPost(`/public/review/${tokenB}/comments`, { pageNumber: 1, xPct: 0.3, yPct: 0.3, body: 'Comment from client B' });
      expect(commentB.status, JSON.stringify(commentB.body)).toBe(201);

      const viewA = await request(app).get(`/api/v1/public/review/${tokenA}`);
      expect(viewA.status).toBe(404); // A's own link is already terminal (dismissed) -- nothing more to see, not even its own history
      const viewB = await request(app).get(`/api/v1/public/review/${tokenB}`);
      expect(viewB.status, JSON.stringify(viewB.body)).toBe(200);
      expect(viewB.body.data.comments).toHaveLength(1);
      expect(viewB.body.data.comments[0].body).toBe('Comment from client B'); // never A's comment, even on the same document

      // Staff, by contrast, see both -- comment isolation is a client-facing rule, not a data-deletion.
      const staffView = (await admin.get(`/documents/${documentId}/review-comments`)).body.data;
      expect(staffView.map((c: any) => c.body).sort()).toEqual(['Comment from client A', 'Comment from client B']);
    });
  });

  describe('the test-mode allowlist also constrains the review-link send path', () => {
    it('refuses to create (and email) a share link to an address not on the allowlist', async () => {
      const limited = buildFullApp(
        prisma,
        { EMAIL_TEST_MODE_ALLOWLIST: ['allowed@decirclesolar.com'] },
        { files: stack.files, scanner, emailProvider: mockProvider }
      );
      const limitedAdmin = await signIn(limited.app, admin.user.email);
      {
        const start = await limitedAdmin.post('/email/connection/start');
        const state = new URL(start.body.data.url).searchParams.get('state')!;
        await request(limited.app).get(`/api/v1/email/connection/callback?code=good&state=${state}`);
      }
      const uploadRes = await request(limited.app)
        .post('/api/v1/documents')
        .set(limitedAdmin.auth())
        .field('typeId', typeId)
        .field('name', uniq('Allowlisted doc'))
        .field('metadata', '{}')
        .attach('file', makePdf(), { filename: 'doc.pdf', contentType: 'application/pdf' });
      expect(uploadRes.status, JSON.stringify(uploadRes.body)).toBe(201);
      await limited.services.jobs.drain();
      const documentId = uploadRes.body.data.id as string;
      await limitedAdmin.post(`/documents/${documentId}/activate`);

      const blocked = await limitedAdmin.post(`/documents/${documentId}/share-links`, { recipientEmail: 'not-allowed@example.com' });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.message).toMatch(/test mode is on/i);

      const allowed = await limitedAdmin.post(`/documents/${documentId}/share-links`, { recipientEmail: 'allowed@decirclesolar.com' });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
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

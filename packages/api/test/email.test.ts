import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmailProvider } from '../src/providers/email/types.js';
import { EmailProviderError } from '../src/providers/email/types.js';
import { buildFullApp, createTestUser, signIn, type Client } from './helpers/fullApp.js';
import { skipDb, testPrisma } from './helpers/db.js';
import { FakeScanner, makePdf, makeTestFiles } from './helpers/storage.js';

class MockEmailProvider implements EmailProvider {
  readonly name = 'mock-gmail';
  readonly available = true;
  sentMessages: { accessToken: string; raw: Buffer }[] = [];
  shouldFailSend: EmailProviderError | null = null;
  authUrl = 'https://consent.google.test/auth';
  refreshTokenToReturn = 'mock-refresh-token-12345';
  accessTokenToReturn = 'mock-access-token-67890';
  revokedTokens: string[] = [];

  buildAuthUrl(input: { state: string; codeChallenge: string; loginHint: string }): string {
    return `${this.authUrl}?state=${input.state}&challenge=${input.codeChallenge}&hint=${encodeURIComponent(input.loginHint)}`;
  }
  async exchangeCode(_input: { code: string; codeVerifier: string }): Promise<{ refreshToken: string }> {
    return { refreshToken: this.refreshTokenToReturn };
  }
  async refreshAccessToken(_refreshToken: string): Promise<{ accessToken: string; expiresInSeconds: number }> {
    return { accessToken: this.accessTokenToReturn, expiresInSeconds: 3600 };
  }
  async revoke(refreshToken: string): Promise<void> {
    this.revokedTokens.push(refreshToken);
  }
  async send(accessToken: string, rawMessage: Buffer): Promise<{ providerMessageId: string }> {
    if (this.shouldFailSend) throw this.shouldFailSend;
    this.sentMessages.push({ accessToken, raw: rawMessage });
    return { providerMessageId: `msg_${Date.now()}` };
  }
}

describe.skipIf(skipDb)('email module (database + real storage + mock provider)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const scanner = new FakeScanner();
  const mockProvider = new MockEmailProvider();
  let stack: Awaited<ReturnType<typeof makeTestFiles>>;
  let app: ReturnType<typeof buildFullApp>['app'];
  let services: ReturnType<typeof buildFullApp>['services'];

  let admin: Client, sender: Client, viewer: Client;
  let senderUserId = '';
  let senderEmail = '';
  let typeId = '';
  let cleanDocId = '';
  let cleanVersionId = '';

  const uniq = (b: string) => `${b} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    stack = await makeTestFiles();
    ({ app, services } = buildFullApp(prisma, {}, { files: stack.files, scanner, emailProvider: mockProvider }));

    const adminUser = await createTestUser(prisma, services, { role: 'ADMIN' });
    admin = await signIn(app, adminUser.email);

    const sUser = await createTestUser(prisma, services, { role: 'SENDER' });
    senderUserId = sUser.id;
    senderEmail = sUser.email;
    sender = await signIn(app, sUser.email);

    const vUser = await createTestUser(prisma, services, { role: 'VIEWER' });
    viewer = await signIn(app, vUser.email);

    // Create a document type
    const t = await admin.post('/document-types', {
      name: uniq('Contract Type'),
      maxFileSizeMb: 3,
      fields: [],
    });
    typeId = t.body.data.id;

    // Upload a clean document for attachments
    const uploadRes = await request(app)
      .post('/api/v1/documents')
      .set(admin.auth())
      .field('typeId', typeId)
      .field('name', 'NDA Agreement')
      .attach('file', makePdf({ body: 'Confidential NDA Content' }), { filename: 'nda.pdf', contentType: 'application/pdf' });

    expect(uploadRes.status).toBe(201);
    cleanDocId = uploadRes.body.data.id;

    // Scan file job
    await services.jobs.drain();

    // Activate document so it is available for sending
    await admin.post(`/documents/${cleanDocId}/activate`);

    const docRes = await admin.get(`/documents/${cleanDocId}`);
    cleanVersionId = docRes.body.data.currentVersionId;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    stack.cleanup();
  });

  describe('Gmail connection flow', () => {
    it('returns NONE when no connection exists', async () => {
      const res = await sender.get('/email/connection');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ status: 'NONE', googleEmail: null, available: true });
    });

    it('starts oauth flow, stores encrypted state and completes via redirect callback', async () => {
      const startRes = await sender.post('/email/connection/start');
      expect(startRes.status).toBe(200);
      expect(startRes.body.data.url).toContain('https://consent.google.test/auth');

      const url = new URL(startRes.body.data.url);
      const state = url.searchParams.get('state')!;
      expect(state).toBeTruthy();

      // Check that code verifier in DB is encrypted
      const stateRow = await prisma.emailOauthState.findFirst({ where: { userId: senderUserId } });
      expect(stateRow).toBeTruthy();
      expect(stateRow!.codeVerifierCiphertext.toString('utf8')).not.toContain('code');

      // Complete via callback (public redirect)
      const callbackRes = await request(app)
        .get(`/api/v1/email/connection/callback?code=good-code&state=${state}`)
        .expect(302);

      expect(callbackRes.header.location).toContain('connected=1');

      // State is single-use: calling callback again with same state fails
      const replayRes = await request(app)
        .get(`/api/v1/email/connection/callback?code=good-code&state=${state}`)
        .expect(302);
      expect(replayRes.header.location).toContain('error=gmail_failed');

      // Connection is ACTIVE now
      const statusRes = await sender.get('/email/connection');
      expect(statusRes.body.data.status).toBe('ACTIVE');
      expect(statusRes.body.data.googleEmail).toBe(senderEmail);

      // Refresh token in DB is encrypted (ciphertext != plaintext)
      const connRow = await prisma.emailProviderConnection.findUnique({ where: { userId: senderUserId } });
      expect(connRow?.refreshTokenCiphertext).toBeTruthy();
      expect(connRow!.refreshTokenCiphertext!.toString('utf8')).not.toContain('mock-refresh-token');
    });

    it('disconnects and wipes the stored token', async () => {
      const delRes = await sender.del('/email/connection');
      expect(delRes.status).toBe(204);

      const statusRes = await sender.get('/email/connection');
      expect(statusRes.body.data.status).toBe('REVOKED');
      expect(mockProvider.revokedTokens).toContain('mock-refresh-token-12345');

      const connRow = await prisma.emailProviderConnection.findUnique({ where: { userId: senderUserId } });
      expect(connRow?.refreshTokenCiphertext).toBeNull();
    });

    it('user deactivation wipes the Gmail connection in the same transaction', async () => {
      // Create user and connect Gmail
      const user = await createTestUser(prisma, services, { role: 'SENDER' });
      const userClient = await signIn(app, user.email);
      const start = await userClient.post('/email/connection/start');
      const state = new URL(start.body.data.url).searchParams.get('state')!;
      await request(app).get(`/api/v1/email/connection/callback?code=abc&state=${state}`);

      const connBefore = await prisma.emailProviderConnection.findUnique({ where: { userId: user.id } });
      expect(connBefore?.status).toBe('ACTIVE');
      expect(connBefore?.refreshTokenCiphertext).not.toBeNull();

      // Deactivate user
      const deact = await admin.patch(`/users/${user.id}/status`, { status: 'DEACTIVATED' });
      expect(deact.status).toBe(200);

      // Connection should be wiped
      const connAfter = await prisma.emailProviderConnection.findUnique({ where: { userId: user.id } });
      expect(connAfter?.status).toBe('REVOKED');
      expect(connAfter?.refreshTokenCiphertext).toBeNull();
    });
  });

  describe('Email templates', () => {
    it('creates, lists and updates templates with placeholder validation', async () => {
      // Invalid placeholder rejected
      const bad = await admin.post('/email-templates', {
        name: 'Bad Template',
        subject: 'Hello {{unknown_foo}}',
        body: 'Body text',
      });
      expect(bad.status).toBe(400);

      // Valid template
      const created = await admin.post('/email-templates', {
        name: uniq('NDA Notification'),
        subject: 'Documents for {{recipient_name}} from {{sender_name}}',
        body: 'Please find attached {{document_name}} (v{{version_number}}). Sent on {{date}}.',
        isDefault: true,
        isActive: true,
      });
      expect(created.status).toBe(201);
      const templateId = created.body.data.id;

      // Sender lists templates (only active)
      const listRes = await sender.get('/email-templates');
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.some((t: any) => t.id === templateId)).toBe(true);

      // Patch template
      const patch = await admin.patch(`/email-templates/${templateId}`, {
        name: uniq('NDA Notification v2'),
        isActive: false,
      });
      expect(patch.status).toBe(200);

      // Sender no longer sees inactive template
      const listSenderAfter = await sender.get('/email-templates');
      expect(listSenderAfter.body.data.some((t: any) => t.id === templateId)).toBe(false);

      // Admin (manager) still sees inactive template
      const listAdminAfter = await admin.get('/email-templates');
      expect(listAdminAfter.body.data.some((t: any) => t.id === templateId)).toBe(true);
    });
  });

  describe('Drafts, previews and external recipients', () => {
    it('rejects CR/LF in subject', async () => {
      const res = await sender.post('/email/drafts', {
        items: [{ documentId: cleanDocId, versionId: cleanVersionId }],
        to: ['colleague@decirclesolar.com'],
        subject: 'Subject\r\nBcc: evil@hacker.com',
        body: 'Normal body',
      });
      expect(res.status).toBe(400);
    });

    it('collapses duplicate recipients across to/cc/bcc', async () => {
      const res = await sender.post('/email/drafts', {
        items: [{ documentId: cleanDocId, versionId: cleanVersionId }],
        to: ['colleague@decirclesolar.com', 'colleague@decirclesolar.com'],
        cc: ['colleague@decirclesolar.com'],
        bcc: [],
        subject: 'Valid Subject',
        body: 'Valid Body',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.recipients.length).toBe(1);
    });

    it('requires confirmation token for external recipients', async () => {
      // Connect sender first
      const start = await sender.post('/email/connection/start');
      const state = new URL(start.body.data.url).searchParams.get('state')!;
      await request(app).get(`/api/v1/email/connection/callback?code=abc&state=${state}`);

      const draftRes = await sender.post('/email/drafts', {
        items: [{ documentId: cleanDocId, versionId: cleanVersionId }],
        to: ['partner@external-corp.com'],
        subject: 'External Contract',
        body: 'Please review',
      });
      expect(draftRes.status).toBe(200);
      expect(draftRes.body.data.hasExternal).toBe(true);
      expect(draftRes.body.data.confirmationToken).toBeTruthy();

      const token = draftRes.body.data.confirmationToken;
      const idempotencyKey = randomUUID();

      // Sending without confirmation token fails with 409
      const failRes = await sender.post('/email/messages', {
        items: [{ documentId: cleanDocId, versionId: cleanVersionId }],
        to: ['partner@external-corp.com'],
        subject: 'External Contract',
        body: 'Please review',
        idempotencyKey,
      });
      expect(failRes.status).toBe(409);

      // Sending with valid confirmation token succeeds
      const sendRes = await sender.post('/email/messages', {
        items: [{ documentId: cleanDocId, versionId: cleanVersionId }],
        to: ['partner@external-corp.com'],
        subject: 'External Contract',
        body: 'Please review',
        idempotencyKey,
        confirmationToken: token,
      });
      expect(sendRes.status).toBe(202);
      expect(sendRes.body.data.status).toBe('QUEUED');
      await services.jobs.drain();
    });

    it('re-checks document status at send time (rejects deactivated doc)', async () => {
      // Create a document, get preview, then deactivate doc before sending
      const uploadRes = await request(app)
        .post('/api/v1/documents')
        .set(admin.auth())
        .field('typeId', typeId)
        .field('name', uniq('Temp Document'))
        .attach('file', makePdf({ body: 'Temporary Content' }), { filename: 'temp.pdf', contentType: 'application/pdf' });
      expect(uploadRes.status).toBe(201);
      await services.jobs.drain();

      const docId = uploadRes.body.data.id;
      const docRes = await admin.get(`/documents/${docId}`);
      const verId = docRes.body.data.currentVersionId;

      // Activate document initially
      await admin.post(`/documents/${docId}/activate`);

      // Draft is valid initially
      const draft = await sender.post('/email/drafts', {
        items: [{ documentId: docId, versionId: verId }],
        to: ['alice@decirclesolar.com'],
        subject: 'Review',
        body: 'Please check',
      });
      expect(draft.status).toBe(200);

      // Deactivate document
      await admin.post(`/documents/${docId}/deactivate`);

      // Send should now fail with 404 (IDOR safe)
      const sendRes = await sender.post('/email/messages', {
        items: [{ documentId: docId, versionId: verId }],
        to: ['alice@decirclesolar.com'],
        subject: 'Review',
        body: 'Please check',
        idempotencyKey: randomUUID(),
      });
      expect(sendRes.status).toBe(404);
    });

    it('enforces idempotency: same key returns same message, different content returns 409', async () => {
      const idempotencyKey = randomUUID();
      const payload = {
        items: [{ documentId: cleanDocId, versionId: cleanVersionId }],
        to: ['sam@decirclesolar.com'],
        subject: 'Contract NDA',
        body: 'Body text',
        idempotencyKey,
      };

      const res1 = await sender.post('/email/messages', payload);
      expect(res1.status).toBe(202);
      const messageId = res1.body.data.id;

      // Re-sending exact same payload returns original message
      const res2 = await sender.post('/email/messages', payload);
      expect(res2.status).toBe(202);
      expect(res2.body.data.id).toBe(messageId);

      // Sending same key with different subject returns 409
      const res3 = await sender.post('/email/messages', { ...payload, subject: 'Tampered Subject' });
      expect(res3.status).toBe(409);
      await services.jobs.drain();
    });
  });

  describe('Send execution, MIME structure, and state machine', () => {
    it('executes send job via JobRunner and builds compliant MIME with From/Reply-To and attachment', async () => {
      mockProvider.sentMessages = [];
      const sendRes = await sender.post('/email/messages', {
        items: [{ documentId: cleanDocId, versionId: cleanVersionId }],
        to: ['recipient@decirclesolar.com'],
        cc: ['manager@decirclesolar.com'],
        subject: 'Executed NDA Send',
        body: 'Hello, find attached file.',
        idempotencyKey: randomUUID(),
      });
      const messageId = sendRes.body.data.id;

      // Run pending job
      await services.jobs.drain();

      const detail = await sender.get(`/email/messages/${messageId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.status).toBe('SENT');
      expect(detail.body.data.sentAt).not.toBeNull();
      expect(mockProvider.sentMessages.length).toBe(1);

      const mime = mockProvider.sentMessages[0]!.raw.toString('utf8');
      expect(mime).toContain(`From: Test User <${senderEmail}>`);
      expect(mime).toContain(`Reply-To: ${senderEmail}`);
      expect(mime).toContain('recipient@decirclesolar.com');
      expect(mime).toContain('manager@decirclesolar.com');
      expect(mime).toContain('nda.pdf');
    });

    it('sets status to UNKNOWN on provider timeout or 500, never auto-retried, and resolves manually', async () => {
      mockProvider.shouldFailSend = new EmailProviderError('UNKNOWN_OUTCOME', 'Google timeout');

      const sendRes = await sender.post('/email/messages', {
        items: [{ documentId: cleanDocId, versionId: cleanVersionId }],
        to: ['recipient@decirclesolar.com'],
        subject: 'Unknown Outcome Test',
        body: 'Body',
        idempotencyKey: randomUUID(),
      });
      const messageId = sendRes.body.data.id;

      await services.jobs.drain();

      const detail = await sender.get(`/email/messages/${messageId}`);
      expect(detail.body.data.status).toBe('UNKNOWN');
      expect(detail.body.data.errorCode).toBe('NO_CONFIRMATION');

      // Manual resolution by sender
      const resolveRes = await sender.post(`/email/messages/${messageId}/resolve`, { outcome: 'SENT' });
      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.data.status).toBe('SENT');

      mockProvider.shouldFailSend = null;
    });

    it('history scopes: sender cannot read other users messages or scope=all', async () => {
      // Sender calling scope=all gets 403
      const forbidden = await sender.get('/email/messages?scope=all');
      expect(forbidden.status).toBe(403);

      // Admin calling scope=all gets 200
      const allowed = await admin.get('/email/messages?scope=all');
      expect(allowed.status).toBe(200);
      expect(Array.isArray(allowed.body.data)).toBe(true);
    });

    it('reports summary endpoint returns statistics and recent emails', async () => {
      const summaryRes = await admin.get('/reports/summary');
      expect(summaryRes.status).toBe(200);
      const s = summaryRes.body.data;
      expect(s.documentsActive).toBeGreaterThanOrEqual(1);
      expect(s.usersActive).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(s.recentEmails)).toBe(true);
    });
  });
});

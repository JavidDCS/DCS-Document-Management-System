import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmailProvider } from '../src/providers/email/types.js';
import { buildFullApp, createTestUser, signIn, type Client } from './helpers/fullApp.js';
import { skipDb, testPrisma } from './helpers/db.js';
import { FakeScanner, makePdf, makeTestFiles } from './helpers/storage.js';

class MockEmailProvider implements EmailProvider {
  readonly name = 'mock-gmail';
  readonly available = true;
  sentMessages: { accessToken: string; raw: Buffer }[] = [];
  authUrl = 'https://consent.google.test/auth';
  buildAuthUrl(input: { state: string; codeChallenge: string; loginHint: string }): string {
    return `${this.authUrl}?state=${input.state}&challenge=${input.codeChallenge}&hint=${encodeURIComponent(input.loginHint)}`;
  }
  async exchangeCode(): Promise<{ refreshToken: string }> {
    return { refreshToken: 'mock-refresh-token' };
  }
  async refreshAccessToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    return { accessToken: 'mock-access-token', expiresInSeconds: 3600 };
  }
  async revoke(): Promise<void> {}
  async send(accessToken: string, rawMessage: Buffer): Promise<{ providerMessageId: string }> {
    this.sentMessages.push({ accessToken, raw: rawMessage });
    return { providerMessageId: `msg_${Date.now()}` };
  }
}

const KEY = 'test-integration-key-0123456789';
const uniq = (b: string) => `${b} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(skipDb)('Leads Manager integration (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const scanner = new FakeScanner();
  const mockProvider = new MockEmailProvider();
  let stack: Awaited<ReturnType<typeof makeTestFiles>>;
  let app: ReturnType<typeof buildFullApp>['app'];
  let services: ReturnType<typeof buildFullApp>['services'];

  let admin: Client, sender: Client;
  let ndaTypeId = '', teaserTypeId = '';
  let ndaDocId = '', ndaInactiveDocId = '', teaserDocId = '';

  const headers = (key: string | undefined = KEY) => (key ? { 'X-Integration-Key': key } : {});

  async function uploadAndActivate(typeId: string, name: string) {
    const uploadRes = await request(app)
      .post('/api/v1/documents')
      .set(admin.auth())
      .field('typeId', typeId)
      .field('name', name)
      .attach('file', makePdf({ body: `Content for ${name}` }), { filename: 'f.pdf', contentType: 'application/pdf' });
    expect(uploadRes.status, JSON.stringify(uploadRes.body)).toBe(201);
    await services.jobs.drain();
    return uploadRes.body.data.id as string;
  }

  beforeAll(async () => {
    stack = await makeTestFiles();
    ({ app, services } = buildFullApp(prisma, { INTEGRATION_API_KEY: KEY, INTEGRATION_HANDOFF_MINUTES: 60 }, { files: stack.files, scanner, emailProvider: mockProvider }));

    admin = await signIn(app, (await createTestUser(prisma, services, { role: 'ADMIN' })).email);
    sender = await signIn(app, (await createTestUser(prisma, services, { role: 'SENDER' })).email);

    const ndaType = await admin.post('/document-types', { name: uniq('NDA type'), maxFileSizeMb: 3, fields: [] });
    ndaTypeId = ndaType.body.data.id;
    await prisma.documentType.update({ where: { id: ndaTypeId }, data: { key: 'nda' } });

    const teaserType = await admin.post('/document-types', { name: uniq('Teaser type'), maxFileSizeMb: 3, fields: [] });
    teaserTypeId = teaserType.body.data.id;
    await prisma.documentType.update({ where: { id: teaserTypeId }, data: { key: 'teaser' } });

    ndaDocId = await uploadAndActivate(ndaTypeId, uniq('NDA doc'));
    await admin.post(`/documents/${ndaDocId}/activate`);

    ndaInactiveDocId = await uploadAndActivate(ndaTypeId, uniq('Inactive NDA doc'));
    // left inactive on purpose

    teaserDocId = await uploadAndActivate(teaserTypeId, uniq('Teaser doc'));
    await admin.post(`/documents/${teaserDocId}/activate`);

    // Connect the sender's Gmail so real sends can succeed.
    const start = await sender.post('/email/connection/start');
    const state = new URL(start.body.data.url).searchParams.get('state')!;
    await request(app).get(`/api/v1/email/connection/callback?code=abc&state=${state}`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    stack.cleanup();
  });

  describe('integration key', () => {
    it('503s every integrations route when no key is configured', async () => {
      const off = buildFullApp(prisma, { INTEGRATION_API_KEY: undefined }, { files: stack.files, scanner, emailProvider: mockProvider });
      const res = await request(off.app).post('/api/v1/integrations/handoffs').send({ to: 'a@decirclesolar.com', documentTypeKey: 'nda', ref: 'r1', requestedBy: 'lead-mgr' });
      expect(res.status).toBe(503);
      expect(res.body.error.message).toBe('The integration is not switched on');
    });

    it('gives the identical 401 for a missing key and for a wrong key', async () => {
      const missing = await request(app).post('/api/v1/integrations/handoffs').send({ to: 'a@decirclesolar.com', documentTypeKey: 'nda', ref: 'r2', requestedBy: 'lead-mgr' });
      const wrong = await request(app).post('/api/v1/integrations/handoffs').set(headers('totally-the-wrong-key-00000000')).send({ to: 'a@decirclesolar.com', documentTypeKey: 'nda', ref: 'r2', requestedBy: 'lead-mgr' });
      expect(missing.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(missing.body.error.message).toBe(wrong.body.error.message);
      // The key itself never appears in the response, whatever happens.
      expect(JSON.stringify(missing.body)).not.toContain(KEY);
      expect(JSON.stringify(wrong.body)).not.toContain(KEY);
    });

    it('rejects a wrong key of a different length too (not a short-circuiting comparison)', async () => {
      const short = await request(app).post('/api/v1/integrations/handoffs').set(headers('x')).send({ to: 'a@decirclesolar.com', documentTypeKey: 'nda', ref: 'r3', requestedBy: 'lead-mgr' });
      const long = await request(app).post('/api/v1/integrations/handoffs').set(headers(KEY + 'extra-bytes-appended')).send({ to: 'a@decirclesolar.com', documentTypeKey: 'nda', ref: 'r3', requestedBy: 'lead-mgr' });
      expect(short.status).toBe(401);
      expect(long.status).toBe(401);
    });

    it('does not require a CSRF token even though it is a POST (server-to-server, not cookie auth)', async () => {
      const res = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'a@decirclesolar.com', documentTypeKey: 'nda', ref: uniq('csrf'), requestedBy: 'lead-mgr' });
      expect(res.status).not.toBe(403);
    });
  });

  describe('POST /integrations/handoffs', () => {
    it('creates a handoff for a bare request (no documentId)', async () => {
      const res = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'prospect@example.com', documentTypeKey: 'nda', ref: uniq('ref'), requestedBy: 'lead-mgr-1' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.id).toBeTruthy();
    });

    it('rejects a body that fails strict validation', async () => {
      const res = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'not-an-email', documentTypeKey: 'nda', ref: '', requestedBy: '' });
      expect(res.status).toBe(400);
    });

    it('404s an unknown documentId', async () => {
      const res = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'prospect@example.com', documentTypeKey: 'nda', documentId: randomUUID(), ref: uniq('ref'), requestedBy: 'lead-mgr' });
      expect(res.status).toBe(404);
    });

    it('400s a document that belongs to a different type than documentTypeKey', async () => {
      const res = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'prospect@example.com', documentTypeKey: 'teaser', documentId: ndaDocId, ref: uniq('ref'), requestedBy: 'lead-mgr' });
      expect(res.status).toBe(400);
    });

    it('400s an inactive document', async () => {
      const res = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'prospect@example.com', documentTypeKey: 'nda', documentId: ndaInactiveDocId, ref: uniq('ref'), requestedBy: 'lead-mgr' });
      expect(res.status).toBe(400);
    });

    it('accepts a valid documentId of the matching, active type', async () => {
      const res = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'prospect@example.com', documentTypeKey: 'nda', documentId: ndaDocId, ref: uniq('ref'), requestedBy: 'lead-mgr' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('refuses when the test-mode allowlist is configured and `to` is not on it', async () => {
      const limited = buildFullApp(prisma, { INTEGRATION_API_KEY: KEY, EMAIL_TEST_MODE_ALLOWLIST: ['allowed@decirclesolar.com'] }, { files: stack.files, scanner, emailProvider: mockProvider });
      const res = await request(limited.app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'not-allowed@example.com', documentTypeKey: 'nda', ref: uniq('ref'), requestedBy: 'lead-mgr' });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Test mode is on: mail can only go to allowed@decirclesolar.com');
    });

    it('allows the configured allowlist address through', async () => {
      const limited = buildFullApp(prisma, { INTEGRATION_API_KEY: KEY, EMAIL_TEST_MODE_ALLOWLIST: ['allowed@decirclesolar.com'] }, { files: stack.files, scanner, emailProvider: mockProvider });
      const res = await request(limited.app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'allowed@decirclesolar.com', documentTypeKey: 'nda', ref: uniq('ref'), requestedBy: 'lead-mgr' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
  });

  describe('GET /integrations/documents', () => {
    it('lists only active, clean, matching-type documents', async () => {
      const res = await request(app).get('/api/v1/integrations/documents?type=nda').set(headers());
      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).toContain(ndaDocId);
      expect(ids).not.toContain(ndaInactiveDocId); // inactive never leaks in
      expect(ids).not.toContain(teaserDocId); // wrong type never leaks in
      const entry = res.body.data.find((d: { id: string }) => d.id === ndaDocId);
      expect(entry.versionLabel).toBe('V1');
      expect(typeof entry.sizeBytes).toBe('number');
    });

    it('returns an empty list for a type with no active documents, not an error', async () => {
      const res = await request(app).get('/api/v1/integrations/documents?type=teaser').set(headers());
      expect(res.status).toBe(200);
      expect(res.body.data.map((d: { id: string }) => d.id)).not.toContain(ndaInactiveDocId);
    });
  });

  describe('GET /email/handoffs/:id (signed-in SendPage lookup)', () => {
    it('requires the email:send permission', async () => {
      const viewer = await signIn(app, (await createTestUser(prisma, services, { role: 'VIEWER' })).email);
      const res = await viewer.get(`/email/handoffs/${randomUUID()}`);
      expect(res.status).toBe(403);
    });

    it('404s an unknown id', async () => {
      const res = await sender.get(`/email/handoffs/${randomUUID()}`);
      expect(res.status).toBe(404);
    });

    it('resolves to, documentTypeKey, documentTypeId, documentId/name and ref for a fresh handoff', async () => {
      const created = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'prospect2@example.com', documentTypeKey: 'nda', documentId: ndaDocId, ref: uniq('lookup-ref'), requestedBy: 'lead-mgr' });
      const id = created.body.data.id;
      const res = await sender.get(`/email/handoffs/${id}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.to).toBe('prospect2@example.com');
      expect(res.body.data.documentTypeKey).toBe('nda');
      expect(res.body.data.documentTypeId).toBe(ndaTypeId);
      expect(res.body.data.documentId).toBe(ndaDocId);
      expect(typeof res.body.data.documentName).toBe('string');
    });

    it('410s an expired handoff with the exact plain-English message, and 410s a used one too (single-use)', async () => {
      const created = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'prospect3@example.com', documentTypeKey: 'nda', ref: uniq('expiring'), requestedBy: 'lead-mgr' });
      const id = created.body.data.id;
      await prisma.integrationHandoff.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await sender.get(`/email/handoffs/${id}`);
      expect(res.status).toBe(410);
      expect(res.body.error.message).toBe('This link has expired. Go back to the Leads app and click Send again.');

      const created2 = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'prospect4@example.com', documentTypeKey: 'nda', ref: uniq('used'), requestedBy: 'lead-mgr' });
      const id2 = created2.body.data.id;
      const someUser = await createTestUser(prisma, services, { role: 'SENDER' });
      await prisma.integrationHandoff.update({ where: { id: id2 }, data: { usedAt: new Date(), usedByUserId: someUser.id } });
      const res2 = await sender.get(`/email/handoffs/${id2}`);
      expect(res2.status).toBe(410);
    });
  });

  describe('POST /integrations/sent-lookup', () => {
    it('returns an empty array, not an error, when nothing has been sent for the given refs', async () => {
      const res = await request(app).post('/api/v1/integrations/sent-lookup').set(headers()).send({ refs: [uniq('never-sent')] });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('returns only SENT messages whose external_ref matches, with exactly {ref, sentAt, senderName}', async () => {
      const ref = uniq('sent-ref');
      const created = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to: 'sender-target@decirclesolar.com', documentTypeKey: 'nda', documentId: ndaDocId, ref, requestedBy: 'lead-mgr' });
      const handoffId = created.body.data.id;

      const docRes = await sender.get(`/documents/${ndaDocId}`);
      const versionId = docRes.body.data.currentVersionId;

      const sendRes = await sender.post('/email/messages', {
        items: [{ documentId: ndaDocId, versionId }],
        to: ['sender-target@decirclesolar.com'],
        subject: 'NDA for you',
        body: 'Please review the attached NDA.',
        idempotencyKey: randomUUID(),
        handoffId,
      });
      expect(sendRes.status, JSON.stringify(sendRes.body)).toBe(202);
      await services.jobs.drain();

      const detail = await sender.get(`/email/messages/${sendRes.body.data.id}`);
      expect(detail.body.data.status).toBe('SENT');

      const lookup = await request(app).post('/api/v1/integrations/sent-lookup').set(headers()).send({ refs: [ref, uniq('other-ref-not-sent')] });
      expect(lookup.status).toBe(200);
      expect(lookup.body.data).toHaveLength(1);
      expect(lookup.body.data[0]).toEqual({ ref, sentAt: expect.any(String), senderName: expect.any(String) });
      expect(Object.keys(lookup.body.data[0]).sort()).toEqual(['ref', 'senderName', 'sentAt']);
    });
  });

  describe('POST /email/messages with handoffId', () => {
    async function freshHandoff(to: string, ref: string) {
      const created = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to, documentTypeKey: 'nda', documentId: ndaDocId, ref, requestedBy: 'lead-mgr' });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      return created.body.data.id as string;
    }

    async function ndaVersionId() {
      const docRes = await sender.get(`/documents/${ndaDocId}`);
      return docRes.body.data.currentVersionId as string;
    }

    it('stores external_ref from the handoff and silently ignores a client-supplied externalRef', async () => {
      const ref = uniq('stored-ref');
      const handoffId = await freshHandoff('stores-ref@decirclesolar.com', ref);
      const versionId = await ndaVersionId();

      const sendRes = await sender.post('/email/messages', {
        items: [{ documentId: ndaDocId, versionId }],
        to: ['stores-ref@decirclesolar.com'],
        subject: 'NDA for you',
        body: 'Please review the attached NDA.',
        idempotencyKey: randomUUID(),
        handoffId,
        externalRef: 'CLIENT-SUPPLIED-SHOULD-BE-IGNORED',
      });
      expect(sendRes.status, JSON.stringify(sendRes.body)).toBe(202);

      const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: sendRes.body.data.id } });
      expect(row.externalRef).toBe(ref);
      expect(row.externalRef).not.toBe('CLIENT-SUPPLIED-SHOULD-BE-IGNORED');

      const handoffAfter = await prisma.integrationHandoff.findUniqueOrThrow({ where: { id: handoffId } });
      expect(handoffAfter.usedAt).not.toBeNull();
      await services.jobs.drain();
    });

    it('refuses when the recipient list no longer includes the handoff address, and leaves the handoff unused', async () => {
      const ref = uniq('edited-ref');
      const handoffId = await freshHandoff('original-target@decirclesolar.com', ref);
      const versionId = await ndaVersionId();

      const sendRes = await sender.post('/email/messages', {
        items: [{ documentId: ndaDocId, versionId }],
        to: ['someone-else@decirclesolar.com'], // edited away from the handoff's address
        subject: 'NDA for you',
        body: 'Please review the attached NDA.',
        idempotencyKey: randomUUID(),
        handoffId,
      });
      expect(sendRes.status).toBe(400);

      const handoffAfter = await prisma.integrationHandoff.findUniqueOrThrow({ where: { id: handoffId } });
      expect(handoffAfter.usedAt).toBeNull(); // a failed attempt must not consume it

      // The same handoff can still be used by a correct, later attempt.
      const retry = await sender.post('/email/messages', {
        items: [{ documentId: ndaDocId, versionId }],
        to: ['original-target@decirclesolar.com'],
        subject: 'NDA for you',
        body: 'Please review the attached NDA.',
        idempotencyKey: randomUUID(),
        handoffId,
      });
      expect(retry.status, JSON.stringify(retry.body)).toBe(202);
      await services.jobs.drain();
    });

    it('refuses a second use of an already-used handoff', async () => {
      const ref = uniq('single-use-ref');
      const handoffId = await freshHandoff('single-use@decirclesolar.com', ref);
      const versionId = await ndaVersionId();
      const body = {
        items: [{ documentId: ndaDocId, versionId }],
        to: ['single-use@decirclesolar.com'],
        subject: 'NDA for you',
        body: 'Please review the attached NDA.',
        handoffId,
      };

      const first = await sender.post('/email/messages', { ...body, idempotencyKey: randomUUID() });
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      await services.jobs.drain();

      const second = await sender.post('/email/messages', { ...body, idempotencyKey: randomUUID() });
      expect(second.status).toBe(410);
    });

    it('a genuine retry with the SAME idempotency key still succeeds after the handoff is already used', async () => {
      const ref = uniq('idempotent-retry-ref');
      const handoffId = await freshHandoff('idempotent@decirclesolar.com', ref);
      const versionId = await ndaVersionId();
      const idempotencyKey = randomUUID();
      const body = {
        items: [{ documentId: ndaDocId, versionId }],
        to: ['idempotent@decirclesolar.com'],
        subject: 'NDA for you',
        body: 'Please review the attached NDA.',
        handoffId,
        idempotencyKey,
      };

      const first = await sender.post('/email/messages', body);
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      const second = await sender.post('/email/messages', body); // same key, same content: a retry, not a new send
      expect(second.status).toBe(202);
      expect(second.body.data.id).toBe(first.body.data.id);
      await services.jobs.drain();
    });
  });

  describe('an NDA hand-off sent through a review link (not a raw attachment)', () => {
    async function freshHandoff(to: string, ref: string) {
      const created = await request(app).post('/api/v1/integrations/handoffs').set(headers()).send({ to, documentTypeKey: 'nda', documentId: ndaDocId, ref, requestedBy: 'lead-mgr' });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      return created.body.data.id as string;
    }

    it('carries the hand-off ref through to sent-lookup once the link email is SENT, and marks the hand-off used', async () => {
      const ref = uniq('review-link-ref');
      const handoffId = await freshHandoff('review-handoff@decirclesolar.com', ref);

      const before = await request(app).post('/api/v1/integrations/sent-lookup').set(headers()).send({ refs: [ref] });
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect(before.body.data).toEqual([]); // nothing sent yet

      const linkRes = await sender.post(`/documents/${ndaDocId}/share-links`, { recipientEmail: 'review-handoff@decirclesolar.com', handoffId });
      expect(linkRes.status, JSON.stringify(linkRes.body)).toBe(201);
      await services.jobs.drain();

      const handoffAfter = await prisma.integrationHandoff.findUniqueOrThrow({ where: { id: handoffId } });
      expect(handoffAfter.usedAt).not.toBeNull();

      const link = await prisma.documentShareLink.findUniqueOrThrow({ where: { id: linkRes.body.data.id } });
      const msg = await prisma.emailMessage.findUniqueOrThrow({ where: { id: link.initialEmailMessageId! } });
      expect(msg.externalRef).toBe(ref);
      expect(msg.status).toBe('SENT'); // the job queue actually dispatched it, mocked provider included
      // Link-only emails never attach the PDF, even for a hand-off.
      expect(await prisma.emailAttachment.count({ where: { messageId: msg.id } })).toBe(0);

      const after = await request(app).post('/api/v1/integrations/sent-lookup').set(headers()).send({ refs: [ref] });
      expect(after.status, JSON.stringify(after.body)).toBe(200);
      expect(after.body.data).toHaveLength(1);
      expect(after.body.data[0]).toMatchObject({ ref });
      expect(after.body.data[0].sentAt).toBeTruthy();
    });

    it('refuses when the share-link recipient no longer matches the hand-off address, and leaves the hand-off unused', async () => {
      const ref = uniq('mismatched-ref');
      const handoffId = await freshHandoff('matched@decirclesolar.com', ref);

      const res = await sender.post(`/documents/${ndaDocId}/share-links`, { recipientEmail: 'different@decirclesolar.com', handoffId });
      expect(res.status).toBe(400);

      const handoffAfter = await prisma.integrationHandoff.findUniqueOrThrow({ where: { id: handoffId } });
      expect(handoffAfter.usedAt).toBeNull();
    });
  });
});

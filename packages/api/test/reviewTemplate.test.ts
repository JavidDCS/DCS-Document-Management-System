import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import type { EmailProvider } from '../src/providers/email/types.js';
import { ALLOWED_ORIGIN } from './helpers/app.js';
import { buildFullApp, createTestUser, csrfPair, signIn, type Client } from './helpers/fullApp.js';
import { skipDb, testPrisma } from './helpers/db.js';
import { FakeScanner, makePdf, makeTestFiles } from './helpers/storage.js';
import { FakeDocxConverter, makeDocx, para, run, textOf } from './helpers/docx.js';
import { DocxConversionError } from '../src/providers/pdf/docxToPdf.js';

class MockEmailProvider implements EmailProvider {
  readonly name = 'mock-gmail';
  readonly available = true;
  buildAuthUrl(input: { state: string; codeChallenge: string; loginHint: string }): string {
    return `https://consent.google.test/auth?state=${input.state}&challenge=${input.codeChallenge}&hint=${encodeURIComponent(input.loginHint)}`;
  }
  async exchangeCode(): Promise<{ refreshToken: string }> {
    return { refreshToken: 'mock-refresh' };
  }
  async refreshAccessToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    return { accessToken: 'mock-access', expiresInSeconds: 3600 };
  }
  async revoke(): Promise<void> {}
  async send(): Promise<{ providerMessageId: string }> {
    return { providerMessageId: `msg_${Math.random().toString(36).slice(2)}` };
  }
}

function pdfContainsText(pdfBytes: Buffer, needle: string): boolean {
  // pdf-lib writes standard-font text as hex, so look for the text either way
  const needleHex = Buffer.from(needle, 'latin1').toString('hex').toUpperCase();
  const matches = (x: string) => x.includes(needle) || x.toUpperCase().includes(needleHex);
  const raw = pdfBytes.toString('latin1');
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (matches(m[1]!)) return true;
    try {
      if (matches(inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1'))) return true;
    } catch {
      /* not a compressed stream */
    }
  }
  return false;
}

/** An agreement shaped like the real NDA: the blanks sit inside sentences, one of them twice, with their own font. */
const FONT = '<w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/><w:sz w:val="20"/>';
const agreement = (extraBlank = '') =>
  makeDocx(
    [
      para(run('This agreement is made on this '), run('{{start_date}}', FONT), run(' by and between DeCircle Solar and:')),
      para(run('{{counterparty_legal_name}}', FONT), run(', a company incorporated under the laws of '), run('{{company_details}}', FONT), run(' (Party B).')),
      para(run('For '), run('{{counterparty_legal_name}}', `${FONT}<w:b/>`)),
      para(run('Name: '), run('{{signatory_name}}'), run('   Designation: '), run('{{signatory_designation}}')),
      extraBlank ? para(run(extraBlank)) : '',
    ].join('')
  );

describe.skipIf(skipDb)('Word template: upload, and filling it when changes are accepted (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const converter = new FakeDocxConverter();
  let stack: Awaited<ReturnType<typeof makeTestFiles>>;
  let app: ReturnType<typeof buildFullApp>['app'];
  let services: ReturnType<typeof buildFullApp>['services'];
  let admin: Client;
  let sender: Client;
  let ndaTypeId = '';
  const uniq = (b: string) => `${b} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  async function connectGmail(client: Client) {
    const start = await client.post('/email/connection/start');
    const state = new URL(start.body.data.url).searchParams.get('state')!;
    const res = await request(app).get(`/api/v1/email/connection/callback?code=good&state=${state}`);
    expect(res.status).toBe(302);
  }
  async function extractToken(shareLinkId: string): Promise<string> {
    const link = await prisma.documentShareLink.findUniqueOrThrow({ where: { id: shareLinkId } });
    const msg = await prisma.emailMessage.findUniqueOrThrow({ where: { id: link.initialEmailMessageId! } });
    return /\/review\/([A-Za-z0-9_-]+)/.exec(msg.bodyText)![1]!;
  }
  async function publicPost(path: string, body: object) {
    const c = await csrfPair(app);
    return request(app).post(`/api/v1${path}`).set('Cookie', c.cookie).set('X-CSRF-Token', c.token).set('Origin', ALLOWED_ORIGIN).send(body);
  }
  /** Runs the background jobs until this document's file has been scanned and moved to its final place (earlier test files may have left jobs in the queue). */
  async function settle(documentId: string) {
    for (let i = 0; i < 40; i++) {
      await services.jobs.drain(500);
      const v = await prisma.documentVersion.findFirst({ where: { documentId } });
      if (v?.scanStatus === 'CLEAN') return;
    }
    throw new Error('the uploaded file was never scanned');
  }
  async function newDocument(name = uniq('NDA')): Promise<string> {
    const res = await request(app).post('/api/v1/documents').set(admin.auth()).field('typeId', ndaTypeId).field('name', name).field('metadata', '{}').attach('file', makePdf(), { filename: 'nda.pdf', contentType: 'application/pdf' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await settle(res.body.data.id);
    await admin.post(`/documents/${res.body.data.id}/activate`);
    return res.body.data.id as string;
  }
  const putTemplate = (client: Client | null, documentId: string, file: Buffer | string, filename = 'nda.docx') => {
    const r = request(app).post(`/api/v1/documents/${documentId}/review-template`);
    if (client) r.set(client.auth());
    return r.attach('file', Buffer.isBuffer(file) ? file : Buffer.from(file), { filename, contentType: 'application/octet-stream' });
  };
  /** the client answers some fields on a fresh review link; staff accept them all; returns the ids */
  async function round(documentId: string, answers: Record<string, string>) {
    const link = await admin.post(`/documents/${documentId}/share-links`, { recipientEmail: 'client@example.test' });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const token = await extractToken(link.body.data.id);
    const sent = await publicPost(`/public/review/${token}/fields`, { items: Object.entries(answers).map(([fieldKey, value]) => ({ fieldKey, value })) });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    return { linkId: link.body.data.id as string, commentIds: (sent.body.data as { id: string }[]).map((c) => c.id) };
  }
  async function acceptAll(commentIds: string[]) {
    let last;
    for (const id of commentIds) last = await admin.post(`/review-comments/${id}/accept`, {});
    return last!;
  }
  async function currentPdf(documentId: string): Promise<{ versionNumber: number; bytes: Buffer }> {
    const doc = (await admin.get(`/documents/${documentId}`)).body.data;
    const v = doc.versions[0];
    const content = await admin
      .get(`/documents/${documentId}/versions/${v.id}/content`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (x: Buffer) => chunks.push(x));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    return { versionNumber: v.versionNumber, bytes: content.body as Buffer };
  }
  const lastFilled = () => textOf(converter.received[converter.received.length - 1]!);

  beforeAll(async () => {
    stack = await makeTestFiles();
    ({ app, services } = buildFullApp(prisma, {}, { files: stack.files, scanner: new FakeScanner(), emailProvider: new MockEmailProvider(), docxConverter: converter }));
    admin = await signIn(app, (await createTestUser(prisma, services, { role: 'ADMIN' })).email);
    sender = await signIn(app, (await createTestUser(prisma, services, { role: 'SENDER' })).email);
    await connectGmail(admin);
    const t = await admin.post('/document-types', { name: uniq('NDA'), fields: [] });
    ndaTypeId = t.body.data.id;
    const cfg = await admin.patch(`/document-types/${ndaTypeId}`, {
      // no painting positions: this type is filled through its Word template
      reviewFieldsConfig: [
        { key: 'start_date', label: 'Start date', format: 'date_ordinal' },
        { key: 'counterparty_legal_name', label: 'Counterparty legal name', format: 'title' },
        { key: 'company_details', label: 'Company details' },
        { key: 'signatory_name', label: 'Signatory name', format: 'name', defaultValue: 'Authorised Signatory' },
        { key: 'signatory_designation', label: 'Designation', format: 'title', defaultValue: 'Director' },
      ],
    });
    expect(cfg.status, JSON.stringify(cfg.body)).toBe(200);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    stack.cleanup();
  });

  describe('looking at and uploading the Word template', () => {
    let docId = '';
    it('a document with no template says so, and says whether a converter is ready', async () => {
      docId = await newDocument();
      const r = await admin.get(`/documents/${docId}/review-template`);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ present: false, blanks: [], converter: { available: true, engine: 'fake' } });
    });

    it('only an administrator can upload or remove it; a sender cannot even look', async () => {
      expect((await putTemplate(sender, docId, agreement())).status).toBe(403);
      expect((await sender.get(`/documents/${docId}/review-template`)).status).toBe(403);
      expect((await sender.del(`/documents/${docId}/review-template`)).status).toBe(403);
      // no sign-in: refused, by the cross-site check or the sign-in check, whichever sees it first
      expect([401, 403]).toContain((await putTemplate(null, docId, agreement())).status);
      expect((await request(app).get(`/api/v1/documents/${docId}/review-template`)).status).toBe(401);
    });

    it('refuses what is not a safe Word template, in plain words', async () => {
      const bad = async (file: Buffer | string, name: string, status: number, message: RegExp) => {
        const r = await putTemplate(admin, docId, file, name);
        expect(r.status, `${name} ${JSON.stringify(r.body)}`).toBe(status);
        expect(r.body.error.message).toMatch(message);
      };
      await bad(makePdf(), 'nda.docx', 400, /not a Word/i);
      await bad('plain text, not a document', 'nda.docx', 400, /not a Word/i);
      await bad(agreement(), 'nda.doc', 400, /\.docx/i);
      await bad(agreement(), 'nda.docm', 400, /\.docx/i);
      await bad(makeDocx(para(run('{{a_blank}}')), { 'word/vbaProject.bin': 'macro' }), 'nda.docx', 400, /macros/i);
      await bad(makeDocx(para(run('No blanks here at all.'))), 'nda.docx', 400, /no blanks/i);
      const noFile = await request(app).post(`/api/v1/documents/${docId}/review-template`).set(admin.auth()).field('x', 'y');
      expect(noFile.status).toBe(400);
      expect((await request(app).post(`/api/v1/documents/${docId}/review-template`).set(admin.auth()).send({ a: 1 })).status).toBe(415);
      expect((await admin.get(`/documents/${docId}/review-template`)).body.data.present).toBe(false);
    });

    it('keeps a good template and reports what it found, flagging blanks nobody can fill', async () => {
      const r = await putTemplate(admin, docId, agreement('Also {{mystery_blank}} appears.'));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data.present).toBe(true);
      expect(r.body.data.filename).toBe('nda.docx');
      expect(r.body.data.blanks).toEqual(['start_date', 'counterparty_legal_name', 'company_details', 'signatory_name', 'signatory_designation', 'mystery_blank']);
      expect(r.body.data.blanksWithoutField).toEqual(['mystery_blank']);
      expect(r.body.data.fieldsWithoutBlank).toEqual([]);
      // blanks that would stop the document if the client leaves that field alone: the ones with no default value
      expect(r.body.data.blanksWithoutDefault).toEqual(expect.arrayContaining(['start_date', 'counterparty_legal_name', 'company_details', 'mystery_blank']));
      expect(r.body.data.blanksWithoutDefault).not.toContain('signatory_name');
    });

    it('a new upload replaces the old one (and flags fields the file has no blank for)', async () => {
      const r = await putTemplate(admin, docId, makeDocx(para(run('Only {{start_date}} here.'))), 'short.docx');
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ filename: 'short.docx', blanks: ['start_date'] });
      expect(r.body.data.fieldsWithoutBlank).toEqual(['counterparty_legal_name', 'company_details', 'signatory_name', 'signatory_designation']);
      expect(await prisma.documentTemplate.count({ where: { documentId: docId } })).toBe(1);
      expect((await putTemplate(admin, docId, agreement())).body.data.blanks).toHaveLength(5);
    });

    it('can be removed, and a missing template is a clear 404', async () => {
      const other = await newDocument();
      await putTemplate(admin, other, agreement());
      expect((await admin.del(`/documents/${other}/review-template`)).status).toBe(200);
      expect((await admin.get(`/documents/${other}/review-template`)).body.data.present).toBe(false);
      expect((await admin.del(`/documents/${other}/review-template`)).status).toBe(404);
      expect((await admin.get('/documents/00000000-0000-4000-8000-000000000000/review-template')).status).toBe(404);
    });

    it('the upload, the replace and the removal are all in the audit log', async () => {
      const rows = await prisma.auditLog.findMany({ where: { action: { in: ['DOCUMENT_TEMPLATE_UPLOADED', 'DOCUMENT_TEMPLATE_REMOVED'] }, resourceId: docId } });
      expect(rows.filter((r) => r.action === 'DOCUMENT_TEMPLATE_UPLOADED').length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('accepting the changes makes the PDF from the Word template', () => {
    let docId = '';
    it('fills the blanks with the tidied answers, unanswered ones with their defaults, and keeps the font of each blank', async () => {
      docId = await newDocument();
      expect((await putTemplate(admin, docId, agreement())).status).toBe(200);
      const r = await round(docId, { start_date: '2026-03-19', counterparty_legal_name: 'sample pvt company', company_details: 'Mumbai, India', signatory_name: 'joseph' });
      const before = converter.received.length;
      const accepted = await acceptAll(r.commentIds);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

      expect(converter.received.length).toBe(before + 1);
      const text = lastFilled();
      expect(text).toBe(
        'This agreement is made on this 19th of March, 2026 by and between DeCircle Solar and:' +
          'Sample Pvt Company, a company incorporated under the laws of Mumbai, India (Party B).' +
          'For Sample Pvt Company' +
          'Name: Joseph   Designation: Director' // the designation was not answered: its default
      );
      // the same word in two places is filled in both, and the bold, sized run is still bold and sized
      const xml = new (await import('pizzip')).default(converter.received[converter.received.length - 1]!).file('word/document.xml')!.asText();
      expect(xml).not.toContain('{{');
      const forRun = xml.match(/<w:r>(?:(?!<\/w:r>).)*Sample Pvt Company(?:(?!<\/w:r>).)*<\/w:r>/gs)!;
      expect(forRun.some((x) => x.includes('<w:b/>') && x.includes('w:ascii="Cambria"') && x.includes('<w:sz w:val="20"/>'))).toBe(true);
    });

    it('the new version IS the converted PDF, a normal version with a plain note', async () => {
      const cur = await currentPdf(docId);
      expect(cur.versionNumber).toBe(2);
      expect(pdfContainsText(cur.bytes, 'Sample Pvt Company, a company incorporated')).toBe(true);
      expect(pdfContainsText(cur.bytes, '19th of March, 2026')).toBe(true);
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: docId, versionNumber: 2 } });
      expect(v.changeNote).toMatch(/Incorporated 4 accepted changes/);
    });

    it('a second round keeps the earlier answers and changes only what the client changed', async () => {
      const r = await round(docId, { company_details: 'Singapore, 10 Raffles Place', signatory_designation: 'co-founder & ceo' });
      expect((await acceptAll(r.commentIds)).status).toBe(200);
      expect(lastFilled()).toBe(
        'This agreement is made on this 19th of March, 2026 by and between DeCircle Solar and:' +
          'Sample Pvt Company, a company incorporated under the laws of Singapore, 10 Raffles Place (Party B).' +
          'For Sample Pvt Company' +
          'Name: Joseph   Designation: Co-Founder &amp; CEO'
      );
      expect((await currentPdf(docId)).versionNumber).toBe(3);
    });

    it('staff can correct the wording at accept time, and the corrected wording is what is written', async () => {
      const doc = await newDocument();
      await putTemplate(admin, doc, agreement());
      const r = await round(doc, { start_date: '2026-03-19', counterparty_legal_name: 'acme', company_details: 'Pune' });
      const ids = r.commentIds;
      for (const id of ids.slice(0, -1)) await admin.post(`/review-comments/${id}/accept`, {});
      const lastId = ids[ids.length - 1]!;
      const row = await prisma.documentReviewComment.findUniqueOrThrow({ where: { id: lastId } });
      const res = await admin.post(`/review-comments/${lastId}/accept`, row.fieldKey === 'company_details' ? { editedReplacementText: 'Pune, India' } : {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(lastFilled()).toContain('Pune');
    });

    it('a field of the document type with no default and no answer stops the document with a plain message, and writes no version', async () => {
      const doc = await newDocument();
      await putTemplate(admin, doc, agreement());
      const r = await round(doc, { start_date: '2026-03-19' }); // company_details and the name have no default
      const before = converter.received.length;
      const res = await acceptAll(r.commentIds);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/needs a value for: .*counterparty_legal_name.*company_details/);
      expect(res.body.error.message).toMatch(/default value/);
      expect(converter.received.length).toBe(before); // never got as far as the converter
      expect((await currentPdf(doc)).versionNumber).toBe(1);
      // the comment is accepted, nothing is lost: once the missing answers come in, one click finishes it
      const link = await prisma.documentShareLink.findFirstOrThrow({ where: { documentId: doc } });
      const again = await round(doc, { counterparty_legal_name: 'acme corp', company_details: 'Pune' });
      expect((await acceptAll(again.commentIds)).status).toBe(200);
      expect((await currentPdf(doc)).versionNumber).toBe(2);
      expect(link.id).toBeTruthy();
    });

    it('when the converter fails, the document is left exactly as it was and the reason is plain', async () => {
      const doc = await newDocument();
      await putTemplate(admin, doc, agreement());
      const r = await round(doc, { start_date: '2026-03-19', counterparty_legal_name: 'acme', company_details: 'Pune' });
      converter.failWith = new DocxConversionError('LibreOffice could not make the PDF (it is missing, or it took too long). Ask the administrator to check it.');
      try {
        const res = await acceptAll(r.commentIds);
        expect(res.status).toBe(502);
        expect(res.body.error.message).toMatch(/LibreOffice could not make the PDF/);
        expect((await currentPdf(doc)).versionNumber).toBe(1);
      } finally {
        converter.failWith = null;
      }
      // fixed: the staff "Incorporate changes" button finishes it
      const link = await prisma.documentShareLink.findFirstOrThrow({ where: { documentId: doc } });
      const done = await admin.post(`/documents/${doc}/review/incorporate-changes`, { shareLinkId: link.id });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect((await currentPdf(doc)).versionNumber).toBe(2);
    });

    it('with no converter set up the answer is a clear 503, not a half-made document', async () => {
      const doc = await newDocument();
      await putTemplate(admin, doc, agreement());
      const r = await round(doc, { start_date: '2026-03-19', counterparty_legal_name: 'acme', company_details: 'Pune' });
      converter.available = false;
      try {
        const res = await acceptAll(r.commentIds);
        expect(res.status).toBe(503);
        expect(res.body.error.message).toMatch(/converter/i);
        expect((await currentPdf(doc)).versionNumber).toBe(1);
      } finally {
        converter.available = true;
      }
    });

    it('a document with NO Word template still works the old way (painted over the PDF)', async () => {
      const doc = await newDocument();
      const fieldsBefore = await admin.get(`/document-types`);
      expect(fieldsBefore.status).toBe(200);
      // give this one document type positions the old way: the same type, but this document has no template, so the converter is not used
      const t2 = await admin.post('/document-types', { name: uniq('Old way'), fields: [] });
      await admin.patch(`/document-types/${t2.body.data.id}`, { reviewFieldsConfig: [{ key: 'start_date', label: 'Start date', positions: [{ pageNumber: 1, xPct: 0.1, yPct: 0.2, wPct: 0.6, hPct: 0.02 }] }] });
      const res = await request(app).post('/api/v1/documents').set(admin.auth()).field('typeId', t2.body.data.id).field('name', uniq('Old doc')).field('metadata', '{}').attach('file', makePdf(), { filename: 'old.pdf', contentType: 'application/pdf' });
      await settle(res.body.data.id);
      await admin.post(`/documents/${res.body.data.id}/activate`);
      const r = await round(res.body.data.id, { start_date: '20th day of November' });
      const before = converter.received.length;
      expect((await acceptAll(r.commentIds)).status).toBe(200);
      expect(converter.received.length).toBe(before); // the converter was not used
      expect(pdfContainsText((await currentPdf(res.body.data.id)).bytes, '20th day of November')).toBe(true);
      expect(doc).toBeTruthy();
    });
  });
});

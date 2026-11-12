import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/modules/audit/index.js';
import { ageAuth, buildFullApp, createTestUser, signIn, type Client } from './helpers/fullApp.js';
import { json, skipDb, testPrisma } from './helpers/db.js';
import { FakeScanner, makePdf, makeTestFiles } from './helpers/storage.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe.skipIf(skipDb)('documents, uploads and versions (database + real local storage)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const scanner = new FakeScanner();
  let stack: Awaited<ReturnType<typeof makeTestFiles>>;
  let app: ReturnType<typeof buildFullApp>['app'];
  let services: ReturnType<typeof buildFullApp>['services'];
  let admin: Client, superAdmin: Client, sender: Client, sender2: Client, viewer: Client;
  let sender2Id = '';
  let typeId = '';
  let typeName = '';
  const uniq = (b: string) => `${b} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    stack = await makeTestFiles();
    ({ app, services } = buildFullApp(prisma, {}, { files: stack.files, scanner }));
    admin = await signIn(app, (await createTestUser(prisma, services, { role: 'ADMIN' })).email);
    superAdmin = await signIn(app, (await createTestUser(prisma, services, { role: 'SUPER_ADMIN' })).email);
    sender = await signIn(app, (await createTestUser(prisma, services, { role: 'SENDER' })).email);
    const s2 = await createTestUser(prisma, services, { role: 'SENDER' });
    sender2Id = s2.id;
    sender2 = await signIn(app, s2.email);
    viewer = await signIn(app, (await createTestUser(prisma, services, { role: 'VIEWER' })).email);
    typeName = uniq('Agreement');
    const t = await admin.post('/document-types', {
      name: typeName,
      maxFileSizeMb: 3,
      fields: [
        { key: 'counterparty', fieldType: 'TEXT', label: 'Counterparty', required: true, searchable: true },
        { key: 'region', fieldType: 'SELECT', label: 'Region', options: [{ value: 'north', label: 'North' }, { value: 'south', label: 'South' }] },
        { key: 'signed_on', fieldType: 'DATE', label: 'Signed on' },
      ],
    });
    typeId = t.body.data.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
    stack.cleanup();
  });

  type UploadOpts = { name?: string; pdf?: Buffer; filename?: string; contentType?: string; metadata?: object; tagIds?: string[]; type?: string; as?: Client; fieldsAfterFile?: boolean; noFile?: boolean };
  const upload = (o: UploadOpts = {}) => {
    const c = o.as ?? admin;
    let r = request(app).post('/api/v1/documents').set(c.auth());
    const fields = () => {
      r = r
        .field('typeId', o.type ?? typeId)
        .field('name', o.name ?? uniq('Doc'))
        .field('metadata', JSON.stringify(o.metadata ?? { counterparty: 'Acme Energy' }));
      if (o.tagIds) r = r.field('tagIds', JSON.stringify(o.tagIds));
    };
    if (!o.fieldsAfterFile) fields();
    if (!o.noFile) r = r.attach('file', o.pdf ?? makePdf(), { filename: o.filename ?? 'agreement.pdf', contentType: o.contentType ?? 'application/pdf' });
    if (o.fieldsAfterFile) fields();
    return r;
  };
  const drain = () => services.jobs.drain();
  const detail = (c: Client, id: string) => c.get(`/documents/${id}`);
  const createClean = async (o: UploadOpts = {}) => {
    const res = await upload(o);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await drain();
    return res.body.data.id as string;
  };
  const quarantineFiles = () => walk(path.join(stack.base, 'quarantine'));
  const cleanFiles = () => walk(path.join(stack.base, 'clean'));

  describe('upload -> quarantine -> scan -> clean', () => {
    it('stores the file encrypted in quarantine as PENDING, then scans it and makes it available', async () => {
      const pdf = makePdf({ body: 'BT (Highly confidential NDA text) Tj ET' });
      const res = await upload({ pdf, name: uniq('NDA like') });
      expect(res.status).toBe(201);
      const doc = res.body.data;
      expect(doc.isActive).toBe(false);
      expect(doc.currentVersionId).toBeNull();
      expect(doc.versions).toHaveLength(1);
      expect(doc.versions[0]).toMatchObject({ versionNumber: 1, scanStatus: 'PENDING', sizeBytes: pdf.length, sha256: sha(pdf), isCurrent: false });

      // quarantine only, and the bytes on disk are not the PDF
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
      const onDisk = quarantineFiles();
      expect(onDisk.some((f) => f.endsWith(v.storageKey))).toBe(true);
      const raw = readFileSync(onDisk.find((f) => f.endsWith(v.storageKey))!);
      expect(raw.includes(Buffer.from('Highly confidential'))).toBe(false);
      expect(raw.includes(Buffer.from('%PDF'))).toBe(false);
      expect(cleanFiles().some((f) => f.endsWith(v.storageKey))).toBe(false);
      expect(v.storageKey).toMatch(/^[0-9a-f-]{36}$/);

      await drain();
      const after = (await detail(admin, doc.id)).body.data;
      expect(after.versions[0].scanStatus).toBe('CLEAN');
      expect(after.currentVersionId).toBe(after.versions[0].id);
      expect(after.versions[0].isCurrent).toBe(true);
      expect(cleanFiles().some((f) => f.endsWith(v.storageKey))).toBe(true);
      expect(quarantineFiles().some((f) => f.endsWith(v.storageKey))).toBe(false);
      expect(after.isActive).toBe(false); // activation is a separate, explicit step
    });

    it('accepts the form fields before or after the file part', async () => {
      const a = await upload({ fieldsAfterFile: true });
      expect(a.status).toBe(201);
      const b = await upload({});
      expect(b.status).toBe(201);
    });

    it('is idempotent: scanning an already scanned version changes nothing', async () => {
      const id = await createClean();
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      expect(await services.scan.scanVersion(v.id)).toBe('SKIPPED');
    });

    it('records audit entries for the upload and the scan (system actor) without file content', async () => {
      const id = await createClean();
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      const actions = (await prisma.auditLog.findMany({ where: { OR: [{ resourceId: id }, { resourceId: v.id }] }, orderBy: { id: 'asc' } })).map((a) => `${a.actorType}:${a.action}`);
      expect(actions).toEqual(['USER:DOCUMENT_CREATED', 'USER:VERSION_UPLOADED', 'SYSTEM:VERSION_SCAN_CLEAN']);
      const dump = json(await prisma.auditLog.findMany({ where: { resourceId: v.id } }));
      expect(dump).not.toContain('Confidential test document');
    });

    it('creates a document whose first clean version is automatically current, with all metadata and tags', async () => {
      const tag = (await admin.post('/tags', { name: uniq('t') })).body.data;
      const id = await createClean({ metadata: { counterparty: 'Beta Corp', region: 'south', signed_on: '2026-03-01' }, tagIds: [tag.id] });
      const d = (await detail(admin, id)).body.data;
      expect(d.metadata).toEqual({ counterparty: 'Beta Corp', region: 'south', signed_on: '2026-03-01' });
      expect(d.tags).toEqual([{ id: tag.id, name: tag.name }]);
      expect(d.fieldsVersion).toBe(d.type.fieldsVersion);
      expect(d.typeName).toBe(typeName);
    });
  });

  describe('upload validation (nothing is kept when it fails)', () => {
    const rejected = async (res: request.Response, status: number, label: string) => {
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(status);
      expect(quarantineFiles(), `${label}: leftover quarantine files`).toEqual(before);
    };
    let before: string[] = [];
    beforeAll(async () => {
      await drain();
    });

    it('rejects content that is not a PDF even if the name and declared type say it is', async () => {
      before = quarantineFiles();
      await rejected(await upload({ pdf: Buffer.from('<html><script>alert(1)</script></html>'), filename: 'evil.pdf' }), 400, 'html as pdf');
      await rejected(await upload({ pdf: Buffer.from('MZ\x90\x00executable'), filename: 'x.pdf' }), 400, 'exe as pdf');
      await rejected(await upload({ pdf: Buffer.alloc(0), filename: 'empty.pdf' }), 400, 'empty');
      await rejected(await upload({ pdf: Buffer.from('%PD'), filename: 'short.pdf' }), 400, 'too short');
      await rejected(await upload({ pdf: Buffer.concat([Buffer.from(' \n'), makePdf()]), filename: 'lead.pdf' }), 400, 'leading bytes');
    });

    it('rejects wrong extensions and declared types', async () => {
      before = quarantineFiles();
      for (const [filename, contentType] of [['a.exe', 'application/pdf'], ['a.pdf.exe', 'application/pdf'], ['a.docx', 'application/pdf'], ['a', 'application/pdf'], ['a.pdf', 'text/html'], ['a.pdf', 'application/octet-stream'], ['a.pdf', 'image/png']] as const) {
        await rejected(await upload({ filename, contentType }), 400, `${filename} ${contentType}`);
      }
    });

    it('rejects a missing file and a request that is not multipart', async () => {
      before = quarantineFiles();
      await rejected(await upload({ noFile: true }), 400, 'no file');
      const json = await request(app).post('/api/v1/documents').set(admin.auth()).send({ typeId, name: 'x' });
      await rejected(json, 415, 'json body');
    });

    it('rejects files over the global and the per-type limit with 413', async () => {
      before = quarantineFiles();
      await rejected(await upload({ pdf: makePdf({ body: 'x'.repeat(6 * 1024 * 1024) }) }), 413, 'over global 5 MB');
      await rejected(await upload({ pdf: makePdf({ body: 'x'.repeat(3.5 * 1024 * 1024) }) }), 413, 'over type limit 3 MB');
      const ok = await upload({ pdf: makePdf({ body: 'x'.repeat(2.5 * 1024 * 1024) }) });
      expect(ok.status).toBe(201);
    });

    it('rejects invalid metadata with field paths, unknown fields, inactive or unknown types, bad tags', async () => {
      await drain();
      before = quarantineFiles();
      const noRequired = await upload({ metadata: { region: 'north' } });
      await rejected(noRequired, 400, 'missing required');
      expect(noRequired.body.error.details.map((d: any) => d.path)).toContain('metadata.counterparty');
      await rejected(await upload({ metadata: { counterparty: 'A', region: 'mars' } }), 400, 'bad option');
      await rejected(await upload({ metadata: { counterparty: 'A', hacked: 1 } }), 400, 'unknown field');
      await rejected(await upload({ metadata: { counterparty: 'A', signed_on: '31/12/2026' } }), 400, 'bad date');
      await rejected(await upload({ type: '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f' }), 400, 'unknown type');
      await rejected(await upload({ tagIds: ['3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f'] }), 400, 'unknown tag');
      const inactive = (await admin.post('/document-types', { name: uniq('Inactive') })).body.data;
      await admin.patch(`/document-types/${inactive.id}`, { isActive: false });
      await rejected(await upload({ type: inactive.id, metadata: {} }), 409, 'inactive type');
    });

    it('is for managers only (SENDER and VIEWER get 403 before any bytes are processed)', async () => {
      before = quarantineFiles();
      await rejected(await upload({ as: sender }), 403, 'sender');
      await rejected(await upload({ as: viewer }), 403, 'viewer');
      expect((await request(app).post('/api/v1/documents').attach('file', makePdf(), 'a.pdf')).status).toBe(403); // no bearer: CSRF first
    });

    it('never uses the supplied filename as a path: it is sanitised for display and the storage key is a random uuid', async () => {
      const before2 = new Set([...cleanFiles(), ...quarantineFiles()]);
      const res = await upload({ filename: '../../../etc/passwd.pdf' });
      expect(res.status).toBe(201);
      const name = res.body.data.versions[0].originalFilename as string;
      expect(name).toBe('passwd.pdf');
      for (const f of [...cleanFiles(), ...quarantineFiles()].filter((f) => !before2.has(f))) {
        expect(path.basename(f)).toMatch(/^[0-9a-f-]{36}$/);
        expect(f.startsWith(stack.base)).toBe(true);
      }
      await drain();
    });
  });

  describe('malware scanning and PDF inspection', () => {
    it('quarantines an infected file permanently: it is never downloadable and the document cannot be activated', async () => {
      const id = (await upload({ pdf: makePdf({ body: `BT (${EICAR}) Tj ET` }), name: uniq('Infected') })).body.data.id;
      await drain();
      const d = (await detail(admin, id)).body.data;
      const v = d.versions[0];
      expect(v.scanStatus).toBe('QUARANTINED');
      expect(v.scanDetail).toContain('Eicar-Test-Signature');
      expect(d.currentVersionId).toBeNull();
      expect((await admin.get(`/documents/${id}/versions/${v.id}/content`)).status).toBe(404);
      expect((await superAdmin.get(`/documents/${id}/versions/${v.id}/content`)).status).toBe(404);
      expect((await admin.post(`/documents/${id}/activate`)).status).toBe(409);
      const row = await prisma.documentVersion.findUniqueOrThrow({ where: { id: v.id } });
      expect(cleanFiles().some((f) => f.endsWith(row.storageKey))).toBe(false);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: v.id, action: 'VERSION_QUARANTINED' } });
      expect(audit.outcome).toBe('DENIED');
    });

    it('rejects a PDF with JavaScript under the default "block" policy', async () => {
      const id = await createClean({ pdf: makePdf({ extra: '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' }), name: uniq('JS') });
      const v = (await detail(admin, id)).body.data.versions[0];
      expect(v.scanStatus).toBe('REJECTED');
      expect(v.scanDetail).toMatch(/JAVASCRIPT/);
      expect((await detail(admin, id)).body.data.currentVersionId).toBeNull();
      expect((await admin.get(`/documents/${id}/versions/${v.id}/content`)).status).toBe(404);
    });

    it('rejects encrypted and truncated PDFs', async () => {
      for (const pdf of [makePdf({ extra: '/Encrypt 9 0 R' }), makePdf({ noEof: true })]) {
        const id = await createClean({ pdf });
        expect((await detail(admin, id)).body.data.versions[0].scanStatus).toBe('REJECTED');
      }
    });

    it('under the "flag" policy a PDF with active content becomes CLEAN but is flagged for administrators only', async () => {
      const flagging = buildFullApp(prisma, { PDF_ACTIVE_CONTENT_POLICY: 'flag' }, { files: stack.files, scanner });
      const c = await signIn(flagging.app, (await createTestUser(prisma, flagging.services, { role: 'ADMIN' })).email);
      const res = await request(flagging.app)
        .post('/api/v1/documents').set(c.auth())
        .field('typeId', typeId).field('name', uniq('Flagged')).field('metadata', JSON.stringify({ counterparty: 'X' }))
        .attach('file', makePdf({ extra: '/OpenAction << /S /JavaScript /JS (1) >>' }), { filename: 'f.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(201);
      await flagging.services.jobs.drain();
      const v = (await c.get(`/documents/${res.body.data.id}`)).body.data.versions[0];
      expect(v.scanStatus).toBe('CLEAN');
      expect(v.scanDetail).toContain('Flagged');
    });

    it('fails closed when the scanner is down: the version stays PENDING, then the job is dead-lettered with an audit entry', async () => {
      scanner.mode = 'down';
      try {
        const id = (await upload({ name: uniq('Scanner down') })).body.data.id;
        const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: id } });
        const dedupeKey = `scan:${v.id}`;
        for (let i = 0; i < 3; i++) {
          await prisma.backgroundJob.update({ where: { dedupeKey }, data: { availableAt: new Date() } });
          await services.jobs.runOnce();
        }
        const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey } });
        expect(job.status).toBe('DEAD');
        expect((await prisma.documentVersion.findUniqueOrThrow({ where: { id: v.id } })).scanStatus).toBe('PENDING');
        expect((await detail(admin, id)).body.data.currentVersionId).toBeNull();
        expect(await prisma.auditLog.count({ where: { resourceId: v.id, action: 'SCAN_JOB_FAILED_PERMANENTLY' } })).toBe(1);
      } finally {
        scanner.mode = 'clean';
      }
    });

    it('recovers if the process died between moving the file to clean and recording the result', async () => {
      const id = (await upload({ name: uniq('Crash') })).body.data.id;
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      await stack.files.promote(v.storageKey); // simulated crash point: moved, database not yet updated
      await drain();
      expect((await detail(admin, id)).body.data.versions[0].scanStatus).toBe('CLEAN');
    });

    it('fails (and retries) if the stored ciphertext was damaged before the scan', async () => {
      const id = (await upload({ name: uniq('Damaged') })).body.data.id;
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      const file = quarantineFiles().find((f) => f.endsWith(v.storageKey))!;
      const data = readFileSync(file);
      data[40] = data[40]! ^ 0xff;
      writeFileSync(file, data);
      await services.jobs.runOnce();
      expect((await prisma.documentVersion.findUniqueOrThrow({ where: { id: v.id } })).scanStatus).toBe('PENDING');
      expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `scan:${v.id}` } })).lastError).toMatch(/integrity/i);
      await prisma.backgroundJob.update({ where: { dedupeKey: `scan:${v.id}` }, data: { status: 'DEAD' } }); // keep it out of later drains
    });
  });

  describe('visibility and object-level access (IDOR)', () => {
    let docId = '';
    let versionId = '';
    beforeAll(async () => {
      docId = await createClean({ name: uniq('Visible'), metadata: { counterparty: 'Visible Ltd' } });
      versionId = (await detail(admin, docId)).body.data.versions[0].id;
    });

    it('an inactive document is invisible to senders and viewers (404, not 403) but visible to admins', async () => {
      for (const c of [sender, viewer]) {
        expect((await detail(c, docId)).status).toBe(404);
        const list = await c.get(`/documents?search=Visible`);
        expect(list.body.data.map((d: any) => d.id)).not.toContain(docId);
      }
      expect((await detail(admin, docId)).status).toBe(200);
      expect((await sender.get(`/documents/${docId}/versions/${versionId}/content`)).status).toBe(404);
    });

    it('once activated, senders and viewers can see it, but only senders can download', async () => {
      expect((await admin.post(`/documents/${docId}/activate`)).body.data.isActive).toBe(true);
      for (const c of [sender, viewer]) {
        const d = await detail(c, docId);
        expect(d.status).toBe(200);
        expect(d.body.data.versions.every((v: any) => v.scanStatus === 'CLEAN' && v.scanDetail === null)).toBe(true);
        expect(d.body.data.type.fields.every((f: any) => f.isActive)).toBe(true);
        expect((await c.get('/documents?search=Visible')).body.data.map((x: any) => x.id)).toContain(docId);
      }
      expect((await sender.get(`/documents/${docId}/versions/${versionId}/content`)).status).toBe(200);
      const v = await viewer.get(`/documents/${docId}/versions/${versionId}/content`);
      expect(v.status).toBe(403);
    });

    it('a version of another document cannot be fetched through this document id', async () => {
      const other = await createClean();
      const otherVersion = (await detail(admin, other)).body.data.versions[0].id;
      expect((await admin.get(`/documents/${docId}/versions/${otherVersion}/content`)).status).toBe(404);
      expect((await admin.post(`/documents/${docId}/versions/${otherVersion}/promote`)).status).toBe(404);
      expect((await admin.post(`/documents/${docId}/versions/${otherVersion}/restore`)).status).toBe(404);
    });

    it('unknown ids are 404 and malformed ids are 400', async () => {
      expect((await detail(admin, '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f')).status).toBe(404);
      expect((await detail(admin, 'nope')).status).toBe(400);
      expect((await admin.get(`/documents/${docId}/versions/nope/content`)).status).toBe(400);
    });

    it('access rules: DENY hides a document from one user, ALLOW narrows it to the listed subjects, SUPER_ADMIN always passes', async () => {
      const id = await createClean({ name: uniq('Restricted') });
      await admin.post(`/documents/${id}/activate`);
      expect((await detail(sender2, id)).status).toBe(200);

      const deny = await admin.put(`/documents/${id}/access-rules`, { rules: [{ subjectType: 'USER', userId: sender2Id, permission: 'VIEW', effect: 'DENY' }] });
      expect(deny.status).toBe(200);
      expect((await detail(sender2, id)).status).toBe(404);
      expect((await sender2.get(`/documents?search=Restricted`)).body.data.map((d: any) => d.id)).not.toContain(id);
      expect((await detail(sender, id)).status).toBe(200);

      await admin.put(`/documents/${id}/access-rules`, { rules: [{ subjectType: 'ROLE', role: 'VIEWER', permission: 'VIEW', effect: 'ALLOW' }] });
      expect((await detail(viewer, id)).status).toBe(200);
      expect((await detail(sender, id)).status).toBe(404); // an ALLOW rule makes the document "only these"
      expect((await detail(superAdmin, id)).status).toBe(200);
      expect((await detail(admin, id)).status).toBe(200); // managers see everything they manage

      await admin.put(`/documents/${id}/access-rules`, { rules: [] });
      expect((await detail(sender, id)).status).toBe(200);
      expect((await admin.get(`/documents/${id}/access-rules`)).body.data).toEqual([]);
    });

    it('access-rule editing needs manage permission, a recent password check, and valid input', async () => {
      const id = await createClean();
      expect((await sender.put(`/documents/${id}/access-rules`, { rules: [] })).status).toBe(403);
      expect((await sender.get(`/documents/${id}/access-rules`)).status).toBe(403);
      expect((await admin.put(`/documents/${id}/access-rules`, { rules: [{ subjectType: 'USER', userId: '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f', permission: 'VIEW', effect: 'DENY' }] })).status).toBe(400);
      expect((await admin.put(`/documents/${id}/access-rules`, { rules: [{ subjectType: 'ROLE', role: 'GOD', permission: 'VIEW', effect: 'DENY' }] })).status).toBe(400);
      expect((await admin.put(`/documents/${id}/access-rules`, { rules: [{ subjectType: 'ROLE', role: 'VIEWER', permission: 'VIEW', effect: 'DENY', extra: 1 }] })).status).toBe(400);
      const fresh = await signIn(app, (await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).email);
      await ageAuth(prisma, fresh, 3600);
      expect((await fresh.put(`/documents/${id}/access-rules`, { rules: [] })).body.error.code).toBe('REAUTH_REQUIRED');
    });
  });

  describe('download and preview', () => {
    it('returns exactly the uploaded bytes with attachment headers, and audits the access before sending', async () => {
      const pdf = makePdf({ body: 'BT (download me) Tj ET' });
      const id = await createClean({ pdf, filename: 'My Contract (final).pdf' });
      await admin.post(`/documents/${id}/activate`);
      const v = (await detail(admin, id)).body.data.versions[0];
      const res = await sender.get(`/documents/${id}/versions/${v.id}/content`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body)).toEqual(pdf);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="My Contract \(final\)\.pdf"; filename\*=UTF-8''My%20Contract/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain('sandbox');
      expect(res.headers['content-length']).toBe(String(pdf.length));
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'FILE_DOWNLOADED', resourceId: v.id } });
      expect(audit.actorType).toBe('USER');
      expect(json(audit.details)).toContain(sha(pdf));
    });

    it('inline preview uses a sandboxed inline disposition and is audited separately', async () => {
      const id = await createClean();
      const v = (await detail(admin, id)).body.data.versions[0];
      const res = await admin.get(`/documents/${id}/versions/${v.id}/content?inline=1`);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^inline;/);
      expect(res.headers['content-security-policy']).toMatch(/default-src 'none'; sandbox/);
      expect(await prisma.auditLog.count({ where: { action: 'FILE_PREVIEWED', resourceId: v.id } })).toBe(1);
      expect((await admin.get(`/documents/${id}/versions/${v.id}/content?inline=2`)).status).toBe(400);
    });

    it('never serves a file whose stored bytes were altered; it raises an integrity alert instead', async () => {
      const id = await createClean({ pdf: makePdf({ body: 'BT (tamper target) Tj ET' }) });
      await admin.post(`/documents/${id}/activate`);
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      const file = cleanFiles().find((f) => f.endsWith(v.storageKey))!;
      const data = readFileSync(file);
      data[data.length - 30] = data[data.length - 30]! ^ 0x55;
      writeFileSync(file, data);
      const res = await sender.get(`/documents/${id}/versions/${v.id}/content`);
      expect(res.status).toBe(500);
      expect(res.body.error.message).toMatch(/integrity/i);
      expect(res.headers['content-type']).not.toBe('application/pdf');
      const alert = await prisma.auditLog.findFirstOrThrow({ where: { action: 'INTEGRITY_FAILURE', resourceId: v.id } });
      expect(alert.outcome).toBe('FAILURE');
    });

    it('detects a swapped ciphertext (a different file placed under this key)', async () => {
      const a = await createClean({ pdf: makePdf({ body: 'BT (file A) Tj ET' }) });
      const b = await createClean({ pdf: makePdf({ body: 'BT (file B) Tj ET' }) });
      const va = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: a } });
      const vb = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: b } });
      const fa = cleanFiles().find((f) => f.endsWith(va.storageKey))!;
      const fb = cleanFiles().find((f) => f.endsWith(vb.storageKey))!;
      writeFileSync(fa, readFileSync(fb));
      expect((await admin.get(`/documents/${a}/versions/${va.id}/content`)).status).toBe(500);
    });

    it('requires authentication', async () => {
      const id = await createClean();
      const v = (await detail(admin, id)).body.data.versions[0];
      expect((await request(app).get(`/api/v1/documents/${id}/versions/${v.id}/content`)).status).toBe(401);
    });
  });

  describe('versions', () => {
    it('adds versions, keeps the current pointer until promotion, and numbers them 1, 2, 3...', async () => {
      const id = await createClean({ name: uniq('Versioned'), pdf: makePdf({ body: 'BT (v1) Tj ET' }) });
      const v1 = (await detail(admin, id)).body.data.versions[0];
      const up = await request(app).post(`/api/v1/documents/${id}/versions`).set(admin.auth()).field('changeNote', 'second draft').attach('file', makePdf({ body: 'BT (v2) Tj ET' }), { filename: 'v2.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
      expect(up.body.data).toMatchObject({ versionNumber: 2, scanStatus: 'PENDING', changeNote: 'second draft', isCurrent: false });
      await drain();
      let d = (await detail(admin, id)).body.data;
      expect(d.currentVersionId).toBe(v1.id);
      expect(d.versions.map((v: any) => [v.versionNumber, v.scanStatus, v.isCurrent])).toEqual([[2, 'CLEAN', false], [1, 'CLEAN', true]]);

      d = (await admin.post(`/documents/${id}/versions/${up.body.data.id}/promote`)).body.data;
      expect(d.currentVersionNumber).toBe(2);
      expect(d.versions.find((v: any) => v.isCurrent).id).toBe(up.body.data.id);
    });

    it('cannot promote or restore a version that is not clean', async () => {
      const id = await createClean();
      const bad = (await upload({ pdf: makePdf({ extra: '/Launch' }) })).body.data;
      await drain();
      const badVersion = (await detail(admin, bad.id)).body.data.versions[0];
      expect(badVersion.scanStatus).toBe('REJECTED');
      const pending = await request(app).post(`/api/v1/documents/${id}/versions`).set(admin.auth()).attach('file', makePdf(), { filename: 'p.pdf', contentType: 'application/pdf' });
      expect((await admin.post(`/documents/${id}/versions/${pending.body.data.id}/promote`)).status).toBe(409);
      expect((await admin.post(`/documents/${id}/versions/${pending.body.data.id}/restore`)).status).toBe(409);
      await drain();
    });

    it('restore never edits history: it copies the old content into a NEW clean version that becomes current', async () => {
      const first = makePdf({ body: 'BT (original) Tj ET' });
      const id = await createClean({ pdf: first });
      await request(app).post(`/api/v1/documents/${id}/versions`).set(admin.auth()).attach('file', makePdf({ body: 'BT (changed) Tj ET' }), { filename: 'v2.pdf', contentType: 'application/pdf' });
      await drain();
      const before = (await detail(admin, id)).body.data;
      const v1 = before.versions.find((v: any) => v.versionNumber === 1);
      const res = await admin.post(`/documents/${id}/versions/${v1.id}/restore`);
      expect(res.status).toBe(201);
      const after = res.body.data;
      expect(after.versions).toHaveLength(3);
      const v3 = after.versions[0];
      expect(v3).toMatchObject({ versionNumber: 3, scanStatus: 'CLEAN', isCurrent: true, restoredFromVersionId: v1.id, sha256: v1.sha256, sizeBytes: first.length });
      expect(after.versions.find((v: any) => v.versionNumber === 1)).toMatchObject({ isCurrent: false, sha256: v1.sha256 }); // v1 untouched
      const rows = await prisma.documentVersion.findMany({ where: { documentId: id }, orderBy: { versionNumber: 'asc' } });
      expect(rows[2]!.storageKey).not.toBe(rows[0]!.storageKey);
      expect(rows[2]!.wrappedDataKey.equals(rows[0]!.wrappedDataKey)).toBe(false); // fresh data key
      const dl = await admin.get(`/documents/${id}/versions/${v3.id}/content`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (x) => c.push(x)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(Buffer.from(dl.body)).toEqual(first);
      expect((await sender.post(`/documents/${id}/versions/${v1.id}/restore`)).status).toBe(403);
    });

    it('gives parallel uploads distinct, consecutive version numbers (no duplicates under concurrency)', async () => {
      const id = await createClean();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => request(app).post(`/api/v1/documents/${id}/versions`).set(admin.auth()).attach('file', makePdf({ body: `BT (parallel ${i}) Tj ET` }), { filename: `p${i}.pdf`, contentType: 'application/pdf' }))
      );
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      const numbers = results.map((r) => r.body.data.versionNumber as number).sort((a, b) => a - b);
      expect(numbers).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
      await drain();
    });

    it('is enforced by the database: versions are immutable and the scan result is one-way', async () => {
      const id = await createClean();
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      const attempt = (sql: string) => expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow(/immutable|final|violat/i);
      await attempt(`UPDATE document_versions SET sha256 = '${'0'.repeat(64)}' WHERE id = '${v.id}'`);
      await attempt(`UPDATE document_versions SET version_number = 99 WHERE id = '${v.id}'`);
      await attempt(`UPDATE document_versions SET storage_key = gen_random_uuid() WHERE id = '${v.id}'`);
      await attempt(`UPDATE document_versions SET original_filename = 'x.pdf' WHERE id = '${v.id}'`);
      await attempt(`UPDATE document_versions SET scan_status = 'PENDING', scanned_at = NULL WHERE id = '${v.id}'`); // a final verdict cannot be reopened
      await attempt(`UPDATE document_versions SET scan_status = 'QUARANTINED' WHERE id = '${v.id}'`);
      await attempt(`DELETE FROM document_versions WHERE id = '${v.id}'`);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM documents WHERE id = '${id}'`)).rejects.toThrow(); // RESTRICT
      const { id: _ignored, storageKey: _key, ...rest } = v;
      await expect(prisma.documentVersion.create({ data: { ...rest, storageKey: crypto.randomUUID(), scanDetails: undefined } })).rejects.toMatchObject({ code: 'P2002' }); // (document, version number) is unique
    });

    it('the database refuses a current pointer to a non-clean or foreign version, and an active document without one', async () => {
      const id = (await upload({ name: uniq('Pending') })).body.data.id;
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      await expect(prisma.$executeRawUnsafe(`UPDATE documents SET current_version_id = '${v.id}' WHERE id = '${id}'`)).rejects.toThrow(/CLEAN/);
      await expect(prisma.$executeRawUnsafe(`UPDATE documents SET is_active = true WHERE id = '${id}'`)).rejects.toThrow();
      await drain();
      const other = await createClean();
      const ov = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: other } });
      await expect(prisma.$executeRawUnsafe(`UPDATE documents SET current_version_id = '${ov.id}' WHERE id = '${id}'`)).rejects.toThrow(/CLEAN/);
    });
  });

  describe('status: active, archived, legal hold', () => {
    it('activates and deactivates; an inactive document cannot be found by senders', async () => {
      const id = await createClean({ name: uniq('Toggle') });
      expect((await admin.post(`/documents/${id}/activate`)).body.data.isActive).toBe(true);
      expect((await detail(sender, id)).status).toBe(200);
      expect((await admin.post(`/documents/${id}/deactivate`)).body.data.isActive).toBe(false);
      expect((await detail(sender, id)).status).toBe(404);
      expect((await sender.post(`/documents/${id}/activate`)).status).toBe(403);
    });

    it('archive and legal hold are SUPER_ADMIN only, need a recent password check, and block edits', async () => {
      const id = await createClean({ name: uniq('Archive') });
      await admin.post(`/documents/${id}/activate`);
      expect((await admin.post(`/documents/${id}/archive`)).status).toBe(403);
      expect((await admin.post(`/documents/${id}/legal-hold`)).status).toBe(403);

      const old = await signIn(app, (await prisma.user.findUniqueOrThrow({ where: { id: superAdmin.user.id } })).email);
      await ageAuth(prisma, old, 3600);
      expect((await old.post(`/documents/${id}/archive`)).body.error.code).toBe('REAUTH_REQUIRED');

      const archived = await superAdmin.post(`/documents/${id}/archive`);
      expect(archived.body.data).toMatchObject({ archiveStatus: 'ARCHIVED', isActive: false });
      expect((await detail(sender, id)).status).toBe(404);
      expect((await admin.patch(`/documents/${id}`, { name: 'renamed' })).status).toBe(409);
      expect((await admin.post(`/documents/${id}/activate`)).status).toBe(409);
      expect((await request(app).post(`/api/v1/documents/${id}/versions`).set(admin.auth()).attach('file', makePdf(), { filename: 'x.pdf', contentType: 'application/pdf' })).status).toBe(409);

      expect((await superAdmin.post(`/documents/${id}/unarchive`)).body.data.archiveStatus).toBe('LIVE');
      const hold = await superAdmin.post(`/documents/${id}/legal-hold`);
      expect(hold.body.data.archiveStatus).toBe('LEGAL_HOLD');
      expect((await superAdmin.post(`/documents/${id}/archive`)).status).toBe(409);
      expect((await admin.patch(`/documents/${id}`, { description: 'x' })).status).toBe(409);
      expect((await superAdmin.post(`/documents/${id}/legal-hold/release`)).body.data.archiveStatus).toBe('LIVE');
      expect((await superAdmin.post(`/documents/${id}/legal-hold/release`)).status).toBe(409);
      const actions = (await prisma.auditLog.findMany({ where: { resourceId: id, action: { startsWith: 'DOCUMENT_' } } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['DOCUMENT_ARCHIVED', 'DOCUMENT_UNARCHIVED', 'DOCUMENT_LEGAL_HOLD_SET', 'DOCUMENT_LEGAL_HOLD_RELEASED']));
    });
  });

  describe('editing and searching', () => {
    it('edits name, description, tags and metadata with validation; inactive-field values are kept', async () => {
      const t = (await admin.post('/document-types', { name: uniq('Edit type'), fields: [{ key: 'a', fieldType: 'TEXT', label: 'A', required: true, searchable: true }, { key: 'b', fieldType: 'TEXT', label: 'B' }] })).body.data;
      const id = await createClean({ type: t.id, metadata: { a: 'one', b: 'keep me' } });
      const tag = (await admin.post('/tags', { name: uniq('edit') })).body.data;
      const bField = t.fields.find((f: any) => f.key === 'b');
      await admin.patch(`/document-types/${t.id}/fields/${bField.id}`, { isActive: false });

      const r = await admin.patch(`/documents/${id}`, { name: 'Renamed doc', description: 'about', metadata: { a: 'two' }, tagIds: [tag.id] });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ name: 'Renamed doc', description: 'about', metadata: { a: 'two', b: 'keep me' } });
      expect(r.body.data.tags).toEqual([{ id: tag.id, name: tag.name }]);
      expect(r.body.data.fieldsVersion).toBe(2);
      expect((await admin.patch(`/documents/${id}`, { metadata: { a: '' } })).status).toBe(400);
      expect((await admin.patch(`/documents/${id}`, { metadata: { a: 'x', b: 'inactive now' } })).status).toBe(400);
      expect((await admin.patch(`/documents/${id}`, {})).status).toBe(400);
      expect((await admin.patch(`/documents/${id}`, { typeId: t.id })).status).toBe(400);
      expect((await sender.patch(`/documents/${id}`, { name: 'x' })).status).toBe(403);
    });

    it('searches by name, searchable metadata, tag and type, filters by status, and paginates', async () => {
      const marker = `zq${Date.now().toString(36)}`;
      const tag = (await admin.post('/tags', { name: `tag-${marker}` })).body.data;
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await createClean({ name: `${marker} doc ${i}`, metadata: { counterparty: i === 0 ? `Needle ${marker}` : 'Other' }, tagIds: i < 2 ? [tag.id] : [] }));
      await admin.post(`/documents/${ids[0]}/activate`);
      await admin.post(`/documents/${ids[1]}/activate`);

      const q = async (c: Client, query: string) => (await c.get(`/documents?${query}`)).body;
      expect((await q(admin, `search=${marker}`)).meta.total).toBe(5);
      expect((await q(admin, `search=${marker.toUpperCase()}`)).meta.total).toBe(5); // case-insensitive
      const page = await q(admin, `search=${marker}&limit=2&offset=2`);
      expect(page.data).toHaveLength(2);
      expect(page.meta).toMatchObject({ total: 5, limit: 2, offset: 2 });
      expect((await q(admin, `search=Needle ${marker}`)).data.map((d: any) => d.id)).toEqual([ids[0]]); // searchable metadata
      expect((await q(admin, `tagId=${tag.id}`)).meta.total).toBe(2);
      expect((await q(admin, `search=${marker}&active=true`)).meta.total).toBe(2);
      expect((await q(admin, `search=${marker}&active=false`)).meta.total).toBe(3);
      expect((await q(admin, `search=${marker}&typeId=${typeId}`)).meta.total).toBe(5);
      expect((await q(admin, `search=${marker}&typeId=3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f`)).meta.total).toBe(0);
      expect((await q(sender, `search=${marker}`)).meta.total).toBe(2); // only active ones
      expect((await q(sender, `search=${marker}&active=false`)).meta.total).toBe(0);
      expect((await q(viewer, `search=${marker}`)).data.every((d: any) => d.isActive)).toBe(true);
      expect((await admin.get('/documents?limit=1000')).status).toBe(400);
      expect((await admin.get('/documents?archive=GONE')).status).toBe(400);
      expect((await admin.get('/documents?unknown=1')).status).toBe(400);
      // wildcard characters are searched literally, not as patterns
      expect((await q(admin, `search=${encodeURIComponent('%')}`)).meta.total).toBe(0);
    });

    it('does not expose storage keys, wrapped keys, or file paths in any response', async () => {
      const id = await createClean();
      const body = JSON.stringify((await detail(admin, id)).body) + JSON.stringify((await admin.get('/documents')).body);
      const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      expect(body).not.toContain(v.storageKey);
      expect(body).not.toMatch(/wrapped|storageKey|encryptionKey|dcs-docs-test|quarantine/i);
    });
  });

  it('keeps the audit chain valid after everything above', async () => {
    expect((await verifyAuditChain(prisma)).ok).toBe(true);
  });
});

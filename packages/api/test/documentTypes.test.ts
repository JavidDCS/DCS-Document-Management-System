import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/modules/audit/index.js';
import { ageAuth, buildFullApp, createTestUser, signIn, type Client } from './helpers/fullApp.js';
import { json, skipDb, testPrisma } from './helpers/db.js';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (n === 'node_modules' || n === 'dist' ? [] : statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));

describe('no document type is hardcoded', () => {
  it('the source, migrations and seeds mention no specific document type', () => {
    const roots = [path.resolve(__dirname, '../src'), path.resolve(__dirname, '../prisma'), path.resolve(__dirname, '../../shared/src')];
    for (const f of roots.flatMap(walk).filter((x) => /\.(ts|sql|prisma|json)$/.test(x))) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/\bNDA\b|\bmandate\b/i);
      if (f.endsWith('.sql')) expect(text, f).not.toMatch(/INSERT\s+INTO\s+"?(document_types|document_type_fields|tags)/i);
    }
  });
});

describe.skipIf(skipDb)('dynamic document types (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  let usageCount = 0;
  const { app, services } = skipDb ? ({} as never) : buildFullApp(prisma, {}, { usage: { countForType: async () => usageCount } });
  let admin: Client, superAdmin: Client, sender: Client, viewer: Client;
  let seq = 0;
  const uniq = (base: string) => `${base} ${Date.now().toString(36)}${++seq}`;

  beforeAll(async () => {
    admin = await signIn(app, (await createTestUser(prisma, services, { role: 'ADMIN' })).email);
    superAdmin = await signIn(app, (await createTestUser(prisma, services, { role: 'SUPER_ADMIN' })).email);
    sender = await signIn(app, (await createTestUser(prisma, services, { role: 'SENDER' })).email);
    viewer = await signIn(app, (await createTestUser(prisma, services, { role: 'VIEWER' })).email);
  });
  afterAll(() => prisma.$disconnect());

  const makeType = async (over: object = {}) => {
    const res = await admin.post('/document-types', { name: uniq('Type'), ...over });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as { id: string; key: string; name: string; isActive: boolean; fieldsVersion: number; fields: any[] };
  };

  it('starts empty: a fresh database has no document types, fields or tags', async () => {
    // Migrations seed no types or fields; any existing rows were created dynamically by tests
    expect(await prisma.documentType.count({ where: { createdById: null } })).toBe(0);
    expect(await prisma.documentTypeField.count({ where: { documentType: { createdById: null } } })).toBe(0);
  });

  describe('creating types', () => {
    it('creates a type with every kind of field in one request', async () => {
      const res = await admin.post('/document-types', {
        name: uniq('Mutual Agreement'),
        description: 'Any agreement you can imagine',
        maxFileSizeMb: 10,
        retentionYears: 7,
        fields: [
          { key: 'counterparty', fieldType: 'TEXT', label: 'Counterparty', required: true, searchable: true, validation: { maxLength: 80 } },
          { key: 'notes', fieldType: 'TEXTAREA', label: 'Notes' },
          { key: 'project_mw', fieldType: 'NUMBER', label: 'Project size (MW)', validation: { min: 0, max: 5000 } },
          { key: 'signed_on', fieldType: 'DATE', label: 'Signed on' },
          { key: 'is_mutual', fieldType: 'BOOLEAN', label: 'Mutual', defaultValue: true },
          { key: 'region', fieldType: 'SELECT', label: 'Region', options: [{ value: 'north', label: 'North' }, { value: 'south', label: 'South' }] },
          { key: 'tags', fieldType: 'MULTI_SELECT', label: 'Topics', options: [{ value: 'solar', label: 'Solar' }, { value: 'wind', label: 'Wind' }] },
        ],
      });
      expect(res.status).toBe(201);
      const t = res.body.data;
      expect(t.key).toMatch(/^mutual_agreement_/);
      expect(t.isActive).toBe(true);
      expect(t.allowedMimeTypes).toEqual(['application/pdf']);
      expect(t.fields.map((f: any) => f.key)).toEqual(['counterparty', 'notes', 'project_mw', 'signed_on', 'is_mutual', 'region', 'tags']);
      expect(t.fields.map((f: any) => f.displayOrder)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(t.fields[0]).toMatchObject({ required: true, searchable: true, fieldType: 'TEXT' });
      expect(t.fields[4].defaultValue).toBe(true);
      expect(t.fields[0].options).toBeNull();
      expect(t.fields[5].options).toHaveLength(2);
    });

    it('creates a bare type that gets fields later', async () => {
      const t = await makeType();
      expect(t.fields).toEqual([]);
      expect(t.fieldsVersion).toBe(1);
    });

    it('rejects duplicate names in any case, and duplicate field keys', async () => {
      const t = await makeType();
      expect((await admin.post('/document-types', { name: t.name.toUpperCase() })).status).toBe(409);
      expect((await admin.post('/document-types', { name: uniq('X'), fields: [{ key: 'a', fieldType: 'TEXT', label: 'A' }, { key: 'a', fieldType: 'TEXT', label: 'B' }] })).status).toBe(400);
    });

    it('derives a unique key even when two different names slugify the same', async () => {
      const base = uniq('Same Slug');
      const a = await admin.post('/document-types', { name: base });
      const b = await admin.post('/document-types', { name: base.replace(' ', '-') });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.data.key).not.toBe(b.body.data.key);
    });

    it('rejects invalid input', async () => {
      for (const body of [{}, { name: 'a' }, { name: uniq('X'), maxFileSizeMb: 0 }, { name: uniq('X'), maxFileSizeMb: 500 }, { name: uniq('X'), retentionYears: -1 }, { name: uniq('X'), allowedMimeTypes: ['text/html'] }, { name: uniq('X'), isActive: false }, { name: uniq('X'), fields: [{ key: 'Bad Key', fieldType: 'TEXT', label: 'x' }] }]) {
        expect((await admin.post('/document-types', body)).status, JSON.stringify(body)).toBe(400);
      }
    });

    it('is for ADMIN and SUPER_ADMIN only', async () => {
      expect((await superAdmin.post('/document-types', { name: uniq('SA') })).status).toBe(201);
      expect((await sender.post('/document-types', { name: uniq('S') })).status).toBe(403);
      expect((await viewer.post('/document-types', { name: uniq('V') })).status).toBe(403);
    });
  });

  describe('visibility', () => {
    it('managers see inactive types and fields; everyone else sees only active ones', async () => {
      const t = await makeType({ fields: [{ key: 'a', fieldType: 'TEXT', label: 'A' }, { key: 'b', fieldType: 'TEXT', label: 'B' }] });
      const fieldB = t.fields.find((f: any) => f.key === 'b');
      await admin.patch(`/document-types/${t.id}/fields/${fieldB.id}`, { isActive: false });
      const inactive = await makeType();
      await admin.patch(`/document-types/${inactive.id}`, { isActive: false });

      const asAdmin = (await admin.get('/document-types')).body.data as any[];
      expect(asAdmin.map((x) => x.id)).toEqual(expect.arrayContaining([t.id, inactive.id]));
      expect(asAdmin.find((x) => x.id === t.id).fields).toHaveLength(2);

      for (const c of [sender, viewer]) {
        const list = (await c.get('/document-types')).body.data as any[];
        expect(list.map((x) => x.id)).toContain(t.id);
        expect(list.map((x) => x.id)).not.toContain(inactive.id);
        expect(list.find((x) => x.id === t.id).fields.map((f: any) => f.key)).toEqual(['a']);
        expect((await c.get(`/document-types/${inactive.id}`)).status).toBe(404);
        expect((await c.get(`/document-types/${t.id}`)).body.data.fields).toHaveLength(1);
      }
      expect((await admin.get(`/document-types/${inactive.id}`)).status).toBe(200);
      const onlyActive = (await admin.get('/document-types?active=true')).body.data as any[];
      expect(onlyActive.map((x) => x.id)).not.toContain(inactive.id);
    });

    it('404 for unknown ids, 400 for malformed ones', async () => {
      expect((await admin.get('/document-types/3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f')).status).toBe(404);
      expect((await admin.get('/document-types/nope')).status).toBe(400);
      expect((await admin.get('/document-types?active=maybe')).status).toBe(400);
    });
  });

  describe('editing a type', () => {
    it('renames, edits settings, and deactivates / reactivates', async () => {
      const t = await makeType();
      const name = uniq('Renamed');
      const r = await admin.patch(`/document-types/${t.id}`, { name, description: 'd', maxFileSizeMb: 5, retentionYears: 10 });
      expect(r.body.data).toMatchObject({ name, description: 'd', maxFileSizeMb: 5, retentionYears: 10, key: t.key }); // key never changes
      expect((await admin.patch(`/document-types/${t.id}`, { isActive: false })).body.data.isActive).toBe(false);
      expect((await admin.patch(`/document-types/${t.id}`, { isActive: true })).body.data.isActive).toBe(true);
      const actions = (await prisma.auditLog.findMany({ where: { resourceId: t.id }, orderBy: { id: 'asc' } })).map((a) => a.action);
      expect(actions).toEqual(['DOCUMENT_TYPE_CREATED', 'DOCUMENT_TYPE_UPDATED', 'DOCUMENT_TYPE_DEACTIVATED', 'DOCUMENT_TYPE_ACTIVATED']);
    });

    it('rejects a rename that collides, empty updates and unknown properties', async () => {
      const a = await makeType();
      const b = await makeType();
      expect((await admin.patch(`/document-types/${b.id}`, { name: a.name.toLowerCase() })).status).toBe(409);
      expect((await admin.patch(`/document-types/${b.id}`, {})).status).toBe(400);
      expect((await admin.patch(`/document-types/${b.id}`, { key: 'hacked' })).status).toBe(400);
      expect((await admin.patch(`/document-types/${b.id}`, { fieldsVersion: 99 })).status).toBe(400);
    });

    it('is forbidden for SENDER and VIEWER', async () => {
      const t = await makeType();
      expect((await sender.patch(`/document-types/${t.id}`, { name: uniq('x') })).status).toBe(403);
      expect((await viewer.patch(`/document-types/${t.id}`, { isActive: false })).status).toBe(403);
    });
  });

  describe('fields', () => {
    it('adds, edits, deactivates and reorders fields; fieldsVersion tracks every change', async () => {
      const t = await makeType();
      let v = t.fieldsVersion;
      const a = await admin.post(`/document-types/${t.id}/fields`, { key: 'client', fieldType: 'TEXT', label: 'Client', required: true });
      expect(a.status).toBe(201);
      expect(a.body.data.fieldsVersion).toBe(++v);
      const b = await admin.post(`/document-types/${t.id}/fields`, { key: 'size', fieldType: 'NUMBER', label: 'Size' });
      expect(b.body.data.fields.map((f: any) => f.displayOrder)).toEqual([0, 1]);
      v++;

      const fa = a.body.data.fields[0];
      const edit = await admin.patch(`/document-types/${t.id}/fields/${fa.id}`, { label: 'Client name', helpText: 'Legal name', required: false, searchable: true });
      expect(edit.body.data.fieldsVersion).toBe(++v);
      expect(edit.body.data.fields[0]).toMatchObject({ key: 'client', label: 'Client name', helpText: 'Legal name', required: false, searchable: true });

      const noop = await admin.patch(`/document-types/${t.id}/fields/${fa.id}`, { label: 'Client name' });
      expect(noop.body.data.fieldsVersion).toBe(v); // nothing changed, no version bump

      const [f1, f2] = b.body.data.fields;
      const re = await admin.put(`/document-types/${t.id}/fields/order`, { fieldIds: [f2.id, f1.id] });
      expect(re.body.data.fields.map((f: any) => f.key)).toEqual(['size', 'client']);
      expect(re.body.data.fieldsVersion).toBe(++v);

      const off = await admin.patch(`/document-types/${t.id}/fields/${f1.id}`, { isActive: false });
      expect(off.body.data.fields.find((f: any) => f.id === f1.id).isActive).toBe(false);
      const actions = (await prisma.auditLog.findMany({ where: { resourceId: t.id }, orderBy: { id: 'asc' } })).map((x) => x.action);
      expect(actions).toEqual(expect.arrayContaining(['DOCUMENT_TYPE_FIELD_ADDED', 'DOCUMENT_TYPE_FIELD_UPDATED', 'DOCUMENT_TYPE_FIELDS_REORDERED', 'DOCUMENT_TYPE_FIELD_DEACTIVATED']));
    });

    it('rejects a duplicate key, a 51st field and malformed definitions', async () => {
      const t = await makeType({ fields: [{ key: 'dup', fieldType: 'TEXT', label: 'Dup' }] });
      expect((await admin.post(`/document-types/${t.id}/fields`, { key: 'dup', fieldType: 'TEXT', label: 'Again' })).status).toBe(409);
      for (const body of [{ key: 'x', fieldType: 'SELECT', label: 'X' }, { key: 'x', fieldType: 'TEXT', label: 'X', options: [{ value: 'a', label: 'A' }] }, { key: 'x', fieldType: 'NUMBER', label: 'X', validation: { min: 5, max: 1 } }, { key: 'x', fieldType: 'TEXT', label: 'X', validation: { pattern: '(a+)+' } }, { key: 'x', fieldType: 'NUMBER', label: 'X', defaultValue: 'abc' }]) {
        expect((await admin.post(`/document-types/${t.id}/fields`, body)).status, JSON.stringify(body)).toBe(400);
      }
      const many = await makeType({ fields: Array.from({ length: 50 }, (_, i) => ({ key: `f${i}`, fieldType: 'TEXT', label: `F${i}` })) });
      expect((await admin.post(`/document-types/${many.id}/fields`, { key: 'f50', fieldType: 'TEXT', label: 'one too many' })).status).toBe(409);
    });

    it('lets two concurrent additions both succeed without losing a field or version bump', async () => {
      const t = await makeType();
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => admin.post(`/document-types/${t.id}/fields`, { key: `c${i}`, fieldType: 'TEXT', label: `C${i}` })));
      expect(rs.every((r) => r.status === 201)).toBe(true);
      const final = (await admin.get(`/document-types/${t.id}`)).body.data;
      expect(final.fields).toHaveLength(6);
      expect(final.fieldsVersion).toBe(7);
      expect(new Set(final.fields.map((f: any) => f.displayOrder)).size).toBe(6);
    });

    it('validates edits against the merged configuration and clears config when the type changes', async () => {
      const t = await makeType({ fields: [{ key: 'pick', fieldType: 'SELECT', label: 'Pick', options: [{ value: 'a', label: 'A' }], defaultValue: 'a' }] });
      const f = t.fields[0];
      expect((await admin.patch(`/document-types/${t.id}/fields/${f.id}`, { options: [] })).status).toBe(400);
      expect((await admin.patch(`/document-types/${t.id}/fields/${f.id}`, { validation: { min: 1 } })).status).toBe(400);
      const changed = await admin.patch(`/document-types/${t.id}/fields/${f.id}`, { fieldType: 'TEXT' });
      expect(changed.status).toBe(200);
      expect(changed.body.data.fields[0]).toMatchObject({ fieldType: 'TEXT', options: null, defaultValue: null });
    });

    it('404 for a field that belongs to another type', async () => {
      const t1 = await makeType({ fields: [{ key: 'a', fieldType: 'TEXT', label: 'A' }] });
      const t2 = await makeType();
      expect((await admin.patch(`/document-types/${t2.id}/fields/${t1.fields[0].id}`, { label: 'Stolen' })).status).toBe(404);
    });

    it('reorder needs every field exactly once', async () => {
      const t = await makeType({ fields: [{ key: 'a', fieldType: 'TEXT', label: 'A' }, { key: 'b', fieldType: 'TEXT', label: 'B' }] });
      const [a, b] = t.fields;
      for (const fieldIds of [[a.id], [a.id, a.id], [a.id, b.id, '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f']]) {
        expect((await admin.put(`/document-types/${t.id}/fields/order`, { fieldIds })).status).toBe(400);
      }
    });

    it('is forbidden for SENDER and VIEWER', async () => {
      const t = await makeType({ fields: [{ key: 'a', fieldType: 'TEXT', label: 'A' }] });
      for (const c of [sender, viewer]) {
        expect((await c.post(`/document-types/${t.id}/fields`, { key: 'z', fieldType: 'TEXT', label: 'Z' })).status).toBe(403);
        expect((await c.patch(`/document-types/${t.id}/fields/${t.fields[0].id}`, { label: 'x' })).status).toBe(403);
        expect((await c.put(`/document-types/${t.id}/fields/order`, { fieldIds: [t.fields[0].id] })).status).toBe(403);
      }
    });
  });

  describe('once documents exist', () => {
    const withDocuments = async <T>(fn: () => Promise<T>) => {
      usageCount = 3;
      try {
        return await fn();
      } finally {
        usageCount = 0;
      }
    };

    it('locks the field type and refuses removing options, but still allows additive changes', async () => {
      const t = await makeType({ fields: [{ key: 'pick', fieldType: 'SELECT', label: 'Pick', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }, { key: 'free', fieldType: 'TEXT', label: 'Free' }] });
      const [pick, free] = t.fields;
      await withDocuments(async () => {
        expect((await admin.patch(`/document-types/${t.id}/fields/${free.id}`, { fieldType: 'NUMBER' })).status).toBe(409);
        expect((await admin.patch(`/document-types/${t.id}/fields/${pick.id}`, { options: [{ value: 'a', label: 'A', isActive: true }] })).status).toBe(409);
        const ok = await admin.patch(`/document-types/${t.id}/fields/${pick.id}`, {
          options: [{ value: 'a', label: 'Alpha', isActive: true }, { value: 'b', label: 'B', isActive: false }, { value: 'c', label: 'C', isActive: true }],
          label: 'Pick one',
        });
        expect(ok.status).toBe(200);
        expect(ok.body.data.fields[0].options.map((o: any) => [o.value, o.isActive])).toEqual([['a', true], ['b', false], ['c', true]]);
        expect((await admin.post(`/document-types/${t.id}/fields`, { key: 'extra', fieldType: 'DATE', label: 'Extra', required: true })).status).toBe(201);
      });
    });

    it('needs a recent password check to deactivate a type or a field, or to make a field required', async () => {
      const t = await makeType({ fields: [{ key: 'a', fieldType: 'TEXT', label: 'A' }] });
      await ageAuth(prisma, admin, 3600);
      await withDocuments(async () => {
        const deactType = await admin.patch(`/document-types/${t.id}`, { isActive: false });
        expect(deactType.status).toBe(401);
        expect(deactType.body.error.code).toBe('REAUTH_REQUIRED');
        expect((await admin.patch(`/document-types/${t.id}/fields/${t.fields[0].id}`, { isActive: false })).body.error.code).toBe('REAUTH_REQUIRED');
        expect((await admin.patch(`/document-types/${t.id}/fields/${t.fields[0].id}`, { required: true })).body.error.code).toBe('REAUTH_REQUIRED');
        expect((await admin.patch(`/document-types/${t.id}/fields/${t.fields[0].id}`, { label: 'Fine without reauth' })).status).toBe(200);
      });
      // without documents the same actions need no re-authentication
      expect((await admin.patch(`/document-types/${t.id}`, { isActive: false })).status).toBe(200);
      const reauthed = await signIn(app, (await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).email);
      admin = reauthed;
    });
  });

  it('writes audit entries for every change and keeps the chain valid', async () => {
    const created = await prisma.auditLog.count({ where: { action: 'DOCUMENT_TYPE_CREATED' } });
    expect(created).toBeGreaterThan(5);
    const sample = await prisma.auditLog.findFirstOrThrow({ where: { action: 'DOCUMENT_TYPE_FIELD_ADDED' } });
    expect(sample.actorUserId).toBeTruthy();
    expect(json(sample)).not.toMatch(/password|token|secret/i);
    expect((await verifyAuditChain(prisma)).ok).toBe(true);
  });
});

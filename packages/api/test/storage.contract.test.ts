import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorageProvider } from '../src/providers/storage/local.js';
import { S3CompatibleStorageProvider } from '../src/providers/storage/s3.js';
import { assertValidKey, StorageError, type StorageProvider } from '../src/providers/storage/types.js';

async function collect(r: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}

/** Minimal in-memory S3: just enough of the S3 API for the commands the provider sends. */
class FakeS3 {
  objects = new Map<string, Buffer>();
  async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
    const name = cmd.constructor.name;
    const { Key, Bucket } = cmd.input;
    const notFound = () => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    switch (name) {
      case 'PutObjectCommand':
        this.objects.set(`${Bucket}/${Key}`, Buffer.from(cmd.input.Body));
        return {};
      case 'GetObjectCommand': {
        const o = this.objects.get(`${Bucket}/${Key}`);
        if (!o) throw notFound();
        let body = o;
        const m = /bytes=(\d+)-(\d+)/.exec(cmd.input.Range ?? '');
        if (m) body = o.subarray(Number(m[1]), Number(m[2]) + 1);
        return { Body: Readable.from([body]) };
      }
      case 'HeadObjectCommand': {
        const o = this.objects.get(`${Bucket}/${Key}`);
        if (!o) throw notFound();
        return { ContentLength: o.length };
      }
      case 'DeleteObjectCommand':
        this.objects.delete(`${Bucket}/${Key}`);
        return {};
      case 'CopyObjectCommand': {
        const o = this.objects.get(cmd.input.CopySource);
        if (!o) throw notFound();
        this.objects.set(`${Bucket}/${Key}`, Buffer.from(o));
        return {};
      }
      default:
        throw new Error(`unsupported command ${name}`);
    }
  }
}

interface Harness {
  provider: StorageProvider;
  cleanup(): void;
}

const drivers: { name: string; make: () => Promise<Harness>; skip?: string }[] = [
  {
    name: 'local',
    make: async () => {
      const base = mkdtempSync(path.join(os.tmpdir(), 'dcs-storage-'));
      const provider = new LocalStorageProvider({ clean: path.join(base, 'clean'), quarantine: path.join(base, 'quarantine') });
      await provider.init();
      return { provider, cleanup: () => rmSync(base, { recursive: true, force: true }) };
    },
  },
  {
    name: 's3-compatible (in-memory fake, also used for OCI)',
    make: async () => ({ provider: new S3CompatibleStorageProvider(new FakeS3() as never, 'test-bucket'), cleanup: () => undefined }),
  },
  {
    name: 's3-compatible (real MinIO)',
    skip: process.env.STORAGE_TEST_MINIO === '1' ? undefined : 'set STORAGE_TEST_MINIO=1 plus MinIO env to run against a real server; skipped',
    make: async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        region: 'us-east-1',
        endpoint: process.env.STORAGE_TEST_S3_ENDPOINT!,
        forcePathStyle: true,
        credentials: { accessKeyId: process.env.STORAGE_TEST_S3_KEY!, secretAccessKey: process.env.STORAGE_TEST_S3_SECRET! },
      });
      return { provider: new S3CompatibleStorageProvider(client, process.env.STORAGE_TEST_S3_BUCKET!), cleanup: () => undefined };
    },
  },
];

for (const d of drivers) {
  describe.skipIf(Boolean(d.skip))(`StorageProvider contract: ${d.name}${d.skip ? ` (${d.skip})` : ''}`, () => {
    let h: Harness;
    let p: StorageProvider;
    beforeAll(async () => {
      h = await d.make();
      p = h.provider;
    });
    afterAll(() => h?.cleanup());

    const put = (area: 'clean' | 'quarantine', data: Buffer, key = randomUUID()) => p.put(area, key, Readable.from([data])).then(() => key);

    it('stores and reads back exactly the bytes written', async () => {
      const data = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
      const key = await put('quarantine', data);
      expect(await collect(await p.getStream('quarantine', key))).toEqual(data);
    });

    it('put reports the size and handles empty and multi-chunk input', async () => {
      const key = randomUUID();
      expect(await p.put('clean', key, Readable.from([Buffer.alloc(10), Buffer.alloc(5), Buffer.alloc(1)]))).toEqual({ size: 16 });
      const empty = randomUUID();
      expect(await p.put('clean', empty, Readable.from([]))).toEqual({ size: 0 });
      expect((await collect(await p.getStream('clean', empty))).length).toBe(0);
    });

    it('head and exists reflect presence and size', async () => {
      const key = await put('clean', Buffer.from('hello'));
      expect(await p.head('clean', key)).toEqual({ size: 5 });
      expect(await p.exists('clean', key)).toBe(true);
      const missing = randomUUID();
      expect(await p.head('clean', missing)).toBeNull();
      expect(await p.exists('clean', missing)).toBe(false);
    });

    it('keeps quarantine and clean separate', async () => {
      const key = await put('quarantine', Buffer.from('q'));
      expect(await p.exists('clean', key)).toBe(false);
      expect(await p.exists('quarantine', key)).toBe(true);
    });

    it('move transfers an object from quarantine to clean', async () => {
      const key = await put('quarantine', Buffer.from('scan me'));
      await p.move('quarantine', 'clean', key);
      expect(await p.exists('quarantine', key)).toBe(false);
      expect((await collect(await p.getStream('clean', key))).toString()).toBe('scan me');
    });

    it('move of a missing object fails with NOT_FOUND', async () => {
      await expect(p.move('quarantine', 'clean', randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('getStream of a missing object fails with NOT_FOUND', async () => {
      await expect(p.getStream('clean', randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('supports byte ranges', async () => {
      const key = await put('clean', Buffer.from('0123456789'));
      expect((await collect(await p.getStream('clean', key, { start: 2, end: 5 }))).toString()).toBe('2345');
    });

    it('delete removes the object and is idempotent', async () => {
      const key = await put('clean', Buffer.from('bye'));
      await p.delete('clean', key);
      expect(await p.exists('clean', key)).toBe(false);
      await expect(p.delete('clean', key)).resolves.toBeUndefined();
    });

    it('overwrites an existing key atomically', async () => {
      const key = await put('clean', Buffer.from('first'));
      await p.put('clean', key, Readable.from([Buffer.from('second, longer')]));
      expect((await collect(await p.getStream('clean', key))).toString()).toBe('second, longer');
    });

    it('aborts and leaves nothing behind when the size limit is exceeded', async () => {
      const key = randomUUID();
      await expect(p.put('quarantine', key, Readable.from([Buffer.alloc(1000), Buffer.alloc(1000)]), { maxBytes: 1500 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
      expect(await p.exists('quarantine', key)).toBe(false);
    });

    it('leaves nothing behind when the source stream fails', async () => {
      const key = randomUUID();
      const bad = new Readable({ read() { this.destroy(new Error('connection reset')); } });
      await expect(p.put('quarantine', key, bad)).rejects.toBeInstanceOf(Error);
      expect(await p.exists('quarantine', key)).toBe(false);
    });

    it('rejects every key that is not a lower-case UUID (no paths, no user filenames)', async () => {
      const bad = ['../etc/passwd', '..\\..\\windows', 'a/b', 'file.pdf', 'C:\\x', '', ' ', randomUUID().toUpperCase(), `${randomUUID()}/../x`, `${randomUUID()}\0`, 'x'.repeat(300), '%2e%2e%2f'];
      for (const k of bad) {
        expect(() => assertValidKey(k), k).toThrow(StorageError);
        await expect(p.put('clean', k, Readable.from([Buffer.from('x')]))).rejects.toMatchObject({ code: 'INVALID_KEY' });
        await expect(p.getStream('clean', k)).rejects.toMatchObject({ code: 'INVALID_KEY' });
        await expect(p.head('clean', k)).rejects.toMatchObject({ code: 'INVALID_KEY' });
        await expect(p.delete('clean', k)).rejects.toMatchObject({ code: 'INVALID_KEY' });
      }
    });
  });
}

describe('LocalStorageProvider specifics', () => {
  const make = async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'dcs-local-'));
    const roots = { clean: path.join(base, 'clean'), quarantine: path.join(base, 'quarantine') };
    const provider = new LocalStorageProvider(roots);
    await provider.init();
    return { base, roots, provider, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  };

  it('writes only inside its roots, under a sharded random name, with no leftover temp files', async () => {
    const { base, roots, provider, cleanup } = await make();
    try {
      const key = randomUUID();
      await provider.put('clean', key, Readable.from([Buffer.from('data')]));
      const file = path.join(roots.clean, key.slice(0, 2), key);
      expect(existsSync(file)).toBe(true);
      expect(readdirSync(path.join(roots.clean, key.slice(0, 2)))).toEqual([key]);
      const all = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? all(path.join(dir, n)) : [path.join(dir, n)]));
      for (const f of all(base)) expect(f.startsWith(base)).toBe(true);
      await provider.put('clean', key, Readable.from([Buffer.from('again')]));
      expect(all(roots.clean).every((f) => !f.includes('.tmp-'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('creates directories 0700 and files 0600', async () => {
    const { roots, provider, cleanup } = await make();
    try {
      const key = randomUUID();
      await provider.put('clean', key, Readable.from([Buffer.from('x')]));
      expect(statSync(roots.clean).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(roots.clean, key.slice(0, 2))).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(roots.clean, key.slice(0, 2), key)).mode & 0o777).toBe(0o600);
    } finally {
      cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a root that group or other can read', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'dcs-perm-'));
    try {
      const { chmodSync, mkdirSync } = await import('node:fs');
      mkdirSync(path.join(base, 'clean'));
      chmodSync(path.join(base, 'clean'), 0o755);
      const p = new LocalStorageProvider({ clean: path.join(base, 'clean'), quarantine: path.join(base, 'q') });
      await expect(p.init()).rejects.toMatchObject({ code: 'UNSAFE_ROOT' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses relative, equal, nested and in-repo roots', () => {
    const base = os.tmpdir();
    expect(() => new LocalStorageProvider({ clean: 'rel/clean', quarantine: 'rel/q' })).toThrow(/absolute/);
    expect(() => new LocalStorageProvider({ clean: path.join(base, 'same'), quarantine: path.join(base, 'same') })).toThrow(/separate/);
    expect(() => new LocalStorageProvider({ clean: path.join(base, 'a'), quarantine: path.join(base, 'a', 'q') })).toThrow(/separate/);
    expect(() => new LocalStorageProvider({ clean: path.join(base, 'repo', 'storage'), quarantine: path.join(base, 'q2'), forbiddenParents: [path.join(base, 'repo')] })).toThrow(/outside the repository/);
  });

  it('sweeps stale temp files from interrupted writes', async () => {
    const { roots, provider, cleanup } = await make();
    try {
      const { mkdirSync, writeFileSync, utimesSync } = await import('node:fs');
      const key = randomUUID();
      const dir = path.join(roots.clean, key.slice(0, 2));
      mkdirSync(dir, { recursive: true });
      const stale = path.join(dir, `${key}.tmp-abc123`);
      writeFileSync(stale, 'partial');
      const old = new Date(Date.now() - 2 * 3_600_000);
      utimesSync(stale, old, old);
      expect(await provider.sweepTemp()).toBe(1);
      expect(existsSync(stale)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

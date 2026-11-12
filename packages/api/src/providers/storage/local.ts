import { createReadStream, createWriteStream, promises as fs, type Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import {
  assertValidKey,
  StorageError,
  type PutOptions,
  type StorageArea,
  type StorageObjectInfo,
  type StorageProvider,
} from './types.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const IS_WINDOWS = process.platform === 'win32';

export interface LocalStorageRoots {
  clean: string;
  quarantine: string;
  /** Directories the roots must never be inside (the repository / web root). */
  forbiddenParents?: string[];
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Files on the local disk: absolute roots outside the repo, directories 0700 and files 0600 (POSIX), separate
 * quarantine and clean roots, atomic writes (temp file + fsync + rename), and path resolution that can never leave
 * the root. Never served as static files: only the application reads them, and only decrypted for authorised users.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly driver = 'local' as const;
  private readonly roots: Record<StorageArea, string>;

  constructor(roots: LocalStorageRoots) {
    const clean = path.resolve(roots.clean);
    const quarantine = path.resolve(roots.quarantine);
    if (!path.isAbsolute(roots.clean) || !path.isAbsolute(roots.quarantine)) {
      throw new StorageError('Storage roots must be absolute paths', 'UNSAFE_ROOT');
    }
    if (clean === quarantine || inside(clean, quarantine) || inside(quarantine, clean)) {
      throw new StorageError('Clean and quarantine roots must be separate, non-nested directories', 'UNSAFE_ROOT');
    }
    for (const forbidden of roots.forbiddenParents ?? []) {
      const f = path.resolve(forbidden);
      if (inside(clean, f) || inside(quarantine, f)) {
        throw new StorageError('Storage roots must be outside the repository / web root', 'UNSAFE_ROOT');
      }
    }
    this.roots = { clean, quarantine };
  }

  /** Creates the roots (0700) and refuses to start if they are readable by group/other (POSIX). Call once at startup. */
  async init(): Promise<void> {
    for (const root of Object.values(this.roots)) {
      await fs.mkdir(root, { recursive: true, mode: DIR_MODE });
      if (!IS_WINDOWS) {
        const st = await fs.stat(root);
        if ((st.mode & 0o077) !== 0) {
          throw new StorageError(`Storage root ${root} is accessible by group/other; run chmod 700 on it`, 'UNSAFE_ROOT');
        }
        if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
          throw new StorageError(`Storage root ${root} is not owned by the application user`, 'UNSAFE_ROOT');
        }
      }
    }
  }

  /** Resolved path of a key, guaranteed to be inside the root of its area. */
  private resolve(area: StorageArea, key: string): string {
    assertValidKey(key);
    const root = this.roots[area];
    const target = path.resolve(root, key.slice(0, 2), key);
    if (!inside(target, root) || target === root) throw new StorageError('Path escapes the storage root', 'INVALID_KEY');
    return target;
  }

  async put(area: StorageArea, key: string, data: Readable, opts: PutOptions = {}): Promise<StorageObjectInfo> {
    const target = this.resolve(area, key);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });
    const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;

    let size = 0;
    const limit = opts.maxBytes;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (limit !== undefined && size > limit) return cb(new StorageError('File exceeds the size limit', 'TOO_LARGE'));
        cb(null, chunk);
      },
    });

    const out = createWriteStream(tmp, { flags: 'wx', mode: FILE_MODE });
    try {
      await pipeline(data, counter, out);
      const fh = await fs.open(tmp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, target);
      await this.syncDir(path.dirname(target));
      return { size };
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      // Filesystem errors carry a syscall; anything else came from the source stream and keeps its own type.
      if (!(err as NodeJS.ErrnoException).syscall) throw err;
      throw new StorageError('Could not write the file', 'IO', { cause: err });
    }
  }

  private async syncDir(dir: string) {
    if (IS_WINDOWS) return;
    const fh = await fs.open(dir, 'r').catch(() => null);
    if (!fh) return;
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async getStream(area: StorageArea, key: string, range?: { start: number; end: number }): Promise<Readable> {
    const target = this.resolve(area, key);
    const st = await this.stat(target);
    if (!st) throw new StorageError('Object not found', 'NOT_FOUND');
    return createReadStream(target, range ? { start: range.start, end: range.end } : {});
  }

  private async stat(target: string): Promise<Stats | null> {
    try {
      const st = await fs.stat(target);
      return st.isFile() ? st : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StorageError('Could not read the file', 'IO', { cause: err });
    }
  }

  async head(area: StorageArea, key: string): Promise<StorageObjectInfo | null> {
    const st = await this.stat(this.resolve(area, key));
    return st ? { size: st.size } : null;
  }

  async exists(area: StorageArea, key: string): Promise<boolean> {
    return (await this.head(area, key)) !== null;
  }

  async delete(area: StorageArea, key: string): Promise<void> {
    await fs.rm(this.resolve(area, key), { force: true });
  }

  async move(from: StorageArea, to: StorageArea, key: string): Promise<void> {
    const src = this.resolve(from, key);
    const dst = this.resolve(to, key);
    if (!(await this.stat(src))) throw new StorageError('Object not found', 'NOT_FOUND');
    await fs.mkdir(path.dirname(dst), { recursive: true, mode: DIR_MODE });
    try {
      await fs.rename(src, dst);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw new StorageError('Could not move the file', 'IO', { cause: err });
      // Different filesystems: copy to a temp name, fsync, rename, then remove the source.
      const tmp = `${dst}.tmp-${randomBytes(6).toString('hex')}`;
      await pipeline(createReadStream(src), createWriteStream(tmp, { flags: 'wx', mode: FILE_MODE }));
      await fs.rename(tmp, dst);
      await fs.rm(src, { force: true });
    }
    await this.syncDir(path.dirname(dst));
  }

  /** Test/ops helper: removes leftover temp files from interrupted writes older than `olderThanMs`. */
  async sweepTemp(olderThanMs = 3_600_000): Promise<number> {
    let removed = 0;
    for (const root of Object.values(this.roots)) {
      const shards = await fs.readdir(root).catch(() => [] as string[]);
      for (const shard of shards) {
        const dir = path.join(root, shard);
        for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
          if (!name.includes('.tmp-')) continue;
          const st = await fs.stat(path.join(dir, name)).catch(() => null);
          if (st && Date.now() - st.mtimeMs > olderThanMs) {
            await fs.rm(path.join(dir, name), { force: true });
            removed++;
          }
        }
      }
    }
    return removed;
  }
}

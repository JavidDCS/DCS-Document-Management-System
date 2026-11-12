import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  assertValidKey,
  StorageError,
  type PutOptions,
  type StorageArea,
  type StorageObjectInfo,
  type StorageProvider,
} from './types.js';

/**
 * S3-compatible object storage: AWS S3, MinIO, and Oracle Cloud Object Storage through its S3-compatible endpoint
 * (the same code; only the endpoint, region and credentials differ, all from environment variables).
 * One private bucket holds both areas under the prefixes `quarantine/` and `clean/`. The objects are already
 * encrypted by the application; enable bucket default encryption, versioning and "block public access" as well.
 *
 * Uploads are a single PutObject of the (bounded) ciphertext, so memory use is limited to the size cap.
 */
export class S3CompatibleStorageProvider implements StorageProvider {
  readonly driver = 's3' as const;

  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    private readonly bucket: string
  ) {}

  private objectKey(area: StorageArea, key: string): string {
    assertValidKey(key);
    return `${area}/${key}`;
  }

  async put(area: StorageArea, key: string, data: Readable, opts: PutOptions = {}): Promise<StorageObjectInfo> {
    const Key = this.objectKey(area, key);
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of data) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += b.length;
      if (opts.maxBytes !== undefined && size > opts.maxBytes) throw new StorageError('File exceeds the size limit', 'TOO_LARGE');
      parts.push(b);
    }
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key, Body: Buffer.concat(parts), ContentLength: size, ContentType: 'application/octet-stream' })
      );
    } catch (err) {
      throw new StorageError('Could not store the file', 'IO', { cause: err });
    }
    return { size };
  }

  async getStream(area: StorageArea, key: string, range?: { start: number; end: number }): Promise<Readable> {
    const Key = this.objectKey(area, key);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) })
      );
      if (!out.Body) throw new StorageError('Object not found', 'NOT_FOUND');
      return out.Body instanceof Readable ? out.Body : Readable.from(out.Body as AsyncIterable<Uint8Array>);
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (isNotFound(err)) throw new StorageError('Object not found', 'NOT_FOUND', { cause: err });
      throw new StorageError('Could not read the file', 'IO', { cause: err });
    }
  }

  async head(area: StorageArea, key: string): Promise<StorageObjectInfo | null> {
    const Key = this.objectKey(area, key);
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key }));
      return { size: Number(out.ContentLength ?? 0) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new StorageError('Could not read the file', 'IO', { cause: err });
    }
  }

  async exists(area: StorageArea, key: string): Promise<boolean> {
    return (await this.head(area, key)) !== null;
  }

  async delete(area: StorageArea, key: string): Promise<void> {
    const Key = this.objectKey(area, key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }));
    } catch (err) {
      if (!isNotFound(err)) throw new StorageError('Could not delete the file', 'IO', { cause: err });
    }
  }

  async move(from: StorageArea, to: StorageArea, key: string): Promise<void> {
    const src = this.objectKey(from, key);
    const dst = this.objectKey(to, key);
    try {
      await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: dst, CopySource: `${this.bucket}/${src}` }));
    } catch (err) {
      if (isNotFound(err)) throw new StorageError('Object not found', 'NOT_FOUND', { cause: err });
      throw new StorageError('Could not move the file', 'IO', { cause: err });
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: src }));
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return !!e && (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.Code === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404);
}

import Busboy from 'busboy';
import type { Request } from 'express';
import { Transform, type Readable } from 'node:stream';
import { sanitizeFilename } from '@dcs-docs/shared';
import { HttpError } from '../../utils/httpError.js';
import { FileTooLargeError } from '../storage/fileCrypto.js';
import type { FileService, StoredFile } from '../storage/fileService.js';

export interface ParsedSignatureUpload {
  fields: Record<string, string>;
  file: { filename: string; stored: StoredFile } | null;
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Rejects a stream whose first bytes are not the JPEG magic (checks magic bytes, not just the name or declared type). */
function jpegMagicGuard(): Transform {
  let seen = Buffer.alloc(0);
  let checked = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!checked) {
        seen = Buffer.concat([seen, chunk]);
        if (seen.length >= JPEG_MAGIC.length) {
          checked = true;
          if (!seen.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return cb(new HttpError(400, 'The file is not a JPEG image', 'VALIDATION_ERROR', [{ path: 'file', message: 'Content is not a JPEG image' }]));
        }
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (!checked) return cb(new HttpError(400, 'The file is not a JPEG image', 'VALIDATION_ERROR', [{ path: 'file', message: 'Content is not a JPEG image' }]));
      cb();
    },
  });
}

/**
 * Reads a multipart request for a signature asset: text fields (any order) and exactly one JPEG image. Unlike
 * document uploads, this NEVER goes through quarantine or the malware scanner (a one-time ADMIN/SUPER_ADMIN upload,
 * never client-supplied, by explicit decision) -- it is encrypted and written straight to the 'clean' area while it
 * streams in. On any failure the partial object is removed.
 */
export function parseSignatureUpload(req: Request, files: FileService, opts: { maxBytes: number }): Promise<ParsedSignatureUpload> {
  return new Promise((resolve, reject) => {
    const contentType = req.header('content-type') ?? '';
    if (!/^multipart\/form-data/i.test(contentType)) {
      return reject(new HttpError(415, 'Send the form as multipart/form-data', 'UNSUPPORTED_MEDIA_TYPE'));
    }

    let bb: Busboy.Busboy;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: 1, fields: 12, fieldSize: 256 * 1024, parts: 14, headerPairs: 40, fileSize: opts.maxBytes + 1 },
        defParamCharset: 'utf8',
      });
    } catch {
      return reject(new HttpError(400, 'Malformed multipart request', 'BAD_REQUEST'));
    }

    const fields: Record<string, string> = {};
    let file: ParsedSignatureUpload['file'] = null;
    let storing: Promise<void> | null = null;
    let failure: unknown = null;
    let storedKey: string | null = null;
    let settled = false;

    const openStreams: Readable[] = [];
    const fail = (err: unknown) => {
      if (failure) return;
      failure = err;
      req.unpipe(bb);
      req.resume();
      for (const s of openStreams) s.destroy(err instanceof Error ? err : new Error('Upload failed'));
      void finish();
    };

    const finish = async () => {
      if (settled) return;
      settled = true;
      try {
        if (storing) await storing.catch(() => undefined);
        if (failure) {
          if (storedKey) await files.delete('clean', storedKey).catch(() => undefined);
          const err = failure instanceof FileTooLargeError ? new HttpError(413, 'The file is too large', 'PAYLOAD_TOO_LARGE') : failure;
          return reject(err);
        }
        if (!file) return reject(new HttpError(400, 'No file was uploaded', 'VALIDATION_ERROR', [{ path: 'file', message: 'Required' }]));
        resolve({ fields, file });
      } catch (err) {
        reject(err);
      }
    };

    bb.on('field', (name, value, info) => {
      if (info.valueTruncated || info.nameTruncated) return fail(new HttpError(400, `Field "${name}" is too long`, 'VALIDATION_ERROR'));
      if (Object.prototype.hasOwnProperty.call(fields, name)) return fail(new HttpError(400, `Field "${name}" was sent twice`, 'VALIDATION_ERROR'));
      fields[name] = value;
    });

    bb.on('file', (name, stream: Readable, info) => {
      if (name !== 'file') {
        stream.resume();
        return fail(new HttpError(400, 'Unexpected file field', 'VALIDATION_ERROR'));
      }
      const filename = sanitizeFilename(info.filename || 'signature.jpg');
      if (!/\.(jpe?g)$/i.test(filename)) {
        stream.resume();
        return fail(new HttpError(400, 'Only JPEG images are accepted', 'VALIDATION_ERROR', [{ path: 'file', message: 'The file name must end in .jpg or .jpeg' }]));
      }
      if (info.mimeType.toLowerCase() !== 'image/jpeg') {
        stream.resume();
        return fail(new HttpError(400, 'Only JPEG images are accepted', 'VALIDATION_ERROR', [{ path: 'file', message: 'The declared type must be image/jpeg' }]));
      }
      stream.on('limit', () => fail(new FileTooLargeError()));

      const guard = jpegMagicGuard();
      guard.on('error', (err) => fail(err));
      openStreams.push(stream, guard);
      stream.on('error', (e) => {
        fail(e);
        guard.destroy(e);
      });
      stream.pipe(guard);
      storing = files
        .store('clean', guard, { maxBytes: opts.maxBytes })
        .then((stored) => {
          storedKey = stored.storageKey;
          if (failure) return;
          file = { filename, stored };
        })
        .catch((err) => fail(err));
    });

    bb.on('error', (err) => fail(err instanceof Error && /Unexpected end|Malformed/i.test(err.message) ? new HttpError(400, 'Malformed multipart request', 'BAD_REQUEST') : err));
    bb.on('partsLimit', () => fail(new HttpError(400, 'Too many form parts', 'VALIDATION_ERROR')));
    bb.on('filesLimit', () => fail(new HttpError(400, 'Send exactly one file', 'VALIDATION_ERROR')));
    bb.on('fieldsLimit', () => fail(new HttpError(400, 'Too many form fields', 'VALIDATION_ERROR')));
    bb.on('close', () => void finish());
    req.on('aborted', () => fail(new HttpError(400, 'Upload was interrupted', 'BAD_REQUEST')));
    req.pipe(bb);
  });
}

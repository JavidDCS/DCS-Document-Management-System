import Busboy from 'busboy';
import type { Request } from 'express';
import { Transform, type Readable } from 'node:stream';
import { sanitizeFilename } from '@dcs-docs/shared';
import { HttpError } from '../../utils/httpError.js';

export interface ParsedAdHocPdf {
  fields: Record<string, string>;
  file: { filename: string; content: Buffer } | null;
}

const PDF_MAGIC = Buffer.from('%PDF');

/** Rejects a stream whose first bytes are not the PDF magic (checks magic bytes, not just the name or declared type). */
function pdfMagicGuard(): Transform {
  let seen = Buffer.alloc(0);
  let checked = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!checked) {
        seen = Buffer.concat([seen, chunk]);
        if (seen.length >= PDF_MAGIC.length) {
          checked = true;
          if (!seen.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return cb(new HttpError(400, 'The file is not a PDF', 'VALIDATION_ERROR', [{ path: 'file', message: 'Content is not a PDF' }]));
        }
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (!checked) return cb(new HttpError(400, 'The file is not a PDF', 'VALIDATION_ERROR', [{ path: 'file', message: 'Content is not a PDF' }]));
      cb();
    },
  });
}

/**
 * Reads a multipart request for a one-off "send this modified copy" email: text fields and exactly one PDF.
 * Held entirely in memory and never persisted anywhere -- this file is only ever sent, never stored, never
 * becomes a document version. On any failure nothing is kept.
 */
export function parseAdHocPdfUpload(req: Request, opts: { maxBytes: number }): Promise<ParsedAdHocPdf> {
  return new Promise((resolve, reject) => {
    const contentType = req.header('content-type') ?? '';
    if (!/^multipart\/form-data/i.test(contentType)) {
      return reject(new HttpError(415, 'Send the form as multipart/form-data', 'UNSUPPORTED_MEDIA_TYPE'));
    }

    let bb: Busboy.Busboy;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: 1, fields: 12, fieldSize: 4 * 1024, parts: 14, headerPairs: 40, fileSize: opts.maxBytes + 1 },
        defParamCharset: 'utf8',
      });
    } catch {
      return reject(new HttpError(400, 'Malformed multipart request', 'BAD_REQUEST'));
    }

    const fields: Record<string, string> = {};
    let file: ParsedAdHocPdf['file'] = null;
    let failure: unknown = null;
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

    const finish = () => {
      if (settled) return;
      settled = true;
      if (failure) return reject(failure);
      if (!file) return reject(new HttpError(400, 'No file was uploaded', 'VALIDATION_ERROR', [{ path: 'file', message: 'Required' }]));
      resolve({ fields, file });
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
      const filename = sanitizeFilename(info.filename || 'document.pdf');
      if (!/\.pdf$/i.test(filename)) {
        stream.resume();
        return fail(new HttpError(400, 'Only PDF files are accepted', 'VALIDATION_ERROR', [{ path: 'file', message: 'The file name must end in .pdf' }]));
      }
      if (info.mimeType.toLowerCase() !== 'application/pdf') {
        stream.resume();
        return fail(new HttpError(400, 'Only PDF files are accepted', 'VALIDATION_ERROR', [{ path: 'file', message: 'The declared type must be application/pdf' }]));
      }
      stream.on('limit', () => fail(new HttpError(413, 'The file is too large', 'PAYLOAD_TOO_LARGE')));

      const guard = pdfMagicGuard();
      guard.on('error', (err) => fail(err));
      openStreams.push(stream, guard);
      stream.on('error', (e) => {
        fail(e);
        guard.destroy(e);
      });
      stream.pipe(guard);
      const chunks: Buffer[] = [];
      guard.on('data', (chunk: Buffer) => chunks.push(chunk));
      guard.on('end', () => {
        if (failure) return;
        file = { filename, content: Buffer.concat(chunks) };
      });
    });

    bb.on('error', (err) => fail(err instanceof Error && /Unexpected end|Malformed/i.test(err.message) ? new HttpError(400, 'Malformed multipart request', 'BAD_REQUEST') : err));
    bb.on('partsLimit', () => fail(new HttpError(400, 'Too many form parts', 'VALIDATION_ERROR')));
    bb.on('filesLimit', () => fail(new HttpError(400, 'Send exactly one file', 'VALIDATION_ERROR')));
    bb.on('fieldsLimit', () => fail(new HttpError(400, 'Too many form fields', 'VALIDATION_ERROR')));
    bb.on('close', finish);
    req.on('aborted', () => fail(new HttpError(400, 'Upload was interrupted', 'BAD_REQUEST')));
    req.pipe(bb);
  });
}

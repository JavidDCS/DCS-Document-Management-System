import Busboy from 'busboy';
import type { Request } from 'express';
import { sanitizeFilename, uuidParamSchema } from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { HttpError } from '../../utils/httpError.js';
import { auditContext } from '../audit/index.js';
import type { DocumentTemplateService } from './documentTemplate.service.js';

const MAX_BYTES = 10 * 1024 * 1024;

/** Reads a multipart request holding exactly one Word file, in memory (it is checked and then stored encrypted by the service). */
function parseDocxUpload(req: Request): Promise<{ filename: string; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    if (!/^multipart\/form-data/i.test(req.header('content-type') ?? '')) return reject(new HttpError(415, 'Send the form as multipart/form-data', 'UNSUPPORTED_MEDIA_TYPE'));
    let bb: Busboy.Busboy;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fields: 2, fieldSize: 1024, parts: 4, headerPairs: 40, fileSize: MAX_BYTES + 1 }, defParamCharset: 'utf8' });
    } catch {
      return reject(new HttpError(400, 'Malformed multipart request', 'BAD_REQUEST'));
    }
    let file: { filename: string; bytes: Buffer } | null = null;
    let tooBig = false;
    bb.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => {
        tooBig = true;
      });
      stream.on('end', () => {
        file = { filename: sanitizeFilename(info.filename || 'agreement.docx'), bytes: Buffer.concat(chunks) };
      });
    });
    bb.on('error', () => reject(new HttpError(400, 'Malformed multipart request', 'BAD_REQUEST')));
    bb.on('close', () => {
      if (tooBig) return reject(new HttpError(413, 'The Word file is too large (the limit is 10 MB).', 'PAYLOAD_TOO_LARGE'));
      if (!file || file.bytes.length === 0) return reject(new HttpError(400, 'Choose a Word (.docx) file to upload.', 'VALIDATION_ERROR'));
      if (!/\.docx$/i.test(file.filename)) return reject(new HttpError(400, 'Only Word files saved as .docx are accepted (not .doc or .docm).', 'VALIDATION_ERROR'));
      resolve(file);
    });
    req.pipe(bb);
  });
}

/** The Word version of an agreement: upload, look at, remove. Uploading and removing is for administrators (documents:manage). */
export function registerDocumentTemplateRoutes(secure: SecureRouter, ctx: AppContext, templates: DocumentTemplateService) {
  const { limiters } = ctx;
  const idParam = validate({ params: uuidParamSchema });

  secure.get(
    '/documents/:id/review-template',
    can('documents:review'),
    idParam,
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      res.json({ data: await templates.get(id) });
    })
  );

  // POST both for the first upload and for a replacement (a new file replaces the old one)
  secure.post(
    '/documents/:id/review-template',
    can('documents:manage'),
    limiters.upload,
    idParam,
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const file = await parseDocxUpload(req);
      res.json({ data: await templates.upload(req.auth!, auditContext(req), id, file) });
    })
  );

  secure.delete(
    '/documents/:id/review-template',
    can('documents:manage'),
    idParam,
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      await templates.remove(req.auth!, auditContext(req), id);
      res.json({ data: { removed: true } });
    })
  );
}

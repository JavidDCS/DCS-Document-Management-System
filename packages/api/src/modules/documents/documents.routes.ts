import type { Request } from 'express';
import type { z } from 'zod';
import {
  accessRulesSchema,
  contentQuerySchema,
  createDocumentFieldsSchema,
  listDocumentsQuerySchema,
  newVersionFieldsSchema,
  updateDocumentSchema,
  uuidParamSchema,
  versionParamsSchema,
} from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { HttpError } from '../../utils/httpError.js';
import { auditContext } from '../audit/index.js';
import type { FileService } from '../storage/fileService.js';
import type { DocumentsService } from './documents.service.js';
import { parseUpload } from './upload.js';

function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export function registerDocumentRoutes(secure: SecureRouter, ctx: AppContext, docs: DocumentsService, files: FileService) {
  const { limiters } = ctx;
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;
  const idParam = validate({ params: uuidParamSchema });

  /** Parses the multipart body and validates its text fields with Zod. */
  async function readForm<T extends z.ZodType>(req: Request, fieldsSchema: T, requireFile = true) {
    const upload = await parseUpload(req, files, { maxBytes: docs.globalMaxBytes, requireFile });
    const parsed = fieldsSchema.safeParse(upload.fields);
    if (!parsed.success) {
      if (upload.file) await files.delete('quarantine', upload.file.stored.storageKey).catch(() => undefined);
      throw new HttpError(400, 'Invalid request', 'VALIDATION_ERROR', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    return { fields: parsed.data as z.infer<T>, file: upload.file };
  }

  secure.get(
    '/documents',
    can('documents:read'),
    validate({ query: listDocumentsQuerySchema }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listDocumentsQuerySchema>;
      const { items, total } = await docs.list(req.auth!, q);
      res.json({ data: items, meta: { total, limit: q.limit, offset: q.offset } });
    })
  );

  secure.post(
    '/documents',
    can('documents:manage'),
    limiters.upload,
    asyncHandler(async (req, res) => {
      const { fields, file } = await readForm(req, createDocumentFieldsSchema);
      const created = await docs.create(req.auth!, fields, file, auditContext(req));
      res.status(201).json({ data: created });
    })
  );

  secure.get(
    '/documents/:id',
    can('documents:read'),
    idParam,
    asyncHandler(async (req, res) => {
      res.json({ data: await docs.get(req.auth!, id(req)) });
    })
  );

  secure.patch(
    '/documents/:id',
    can('documents:manage'),
    validate({ params: uuidParamSchema, body: updateDocumentSchema }),
    asyncHandler(async (req, res) => {
      res.json({ data: await docs.update(req.auth!, id(req), req.body as z.infer<typeof updateDocumentSchema>, auditContext(req)) });
    })
  );

  for (const [path, active] of [['activate', true], ['deactivate', false]] as const) {
    secure.post(
      `/documents/:id/${path}`,
      can('documents:manage'),
      idParam,
      asyncHandler(async (req, res) => {
        res.json({ data: await docs.setActive(req.auth!, id(req), active, auditContext(req)) });
      })
    );
  }

  for (const [path, action, permission] of [
    ['archive', 'archive', 'documents:archive'],
    ['unarchive', 'unarchive', 'documents:archive'],
    ['legal-hold', 'hold', 'documents:legal_hold'],
    ['legal-hold/release', 'release', 'documents:legal_hold'],
  ] as const) {
    secure.post(
      `/documents/:id/${path}`,
      can(permission, { reauth: true }),
      idParam,
      asyncHandler(async (req, res) => {
        res.json({ data: await docs.setArchive(req.auth!, id(req), action, auditContext(req)) });
      })
    );
  }

  secure.get(
    '/documents/:id/access-rules',
    can('documents:manage'),
    idParam,
    asyncHandler(async (req, res) => {
      res.json({ data: await docs.getRules(id(req)) });
    })
  );

  secure.put(
    '/documents/:id/access-rules',
    can('documents:manage', { reauth: true }),
    validate({ params: uuidParamSchema, body: accessRulesSchema }),
    asyncHandler(async (req, res) => {
      const { rules } = req.body as z.infer<typeof accessRulesSchema>;
      res.json({ data: await docs.setRules(req.auth!, id(req), rules, auditContext(req)) });
    })
  );

  secure.post(
    '/documents/:id/versions',
    can('versions:create'),
    limiters.upload,
    idParam,
    asyncHandler(async (req, res) => {
      const { fields, file } = await readForm(req, newVersionFieldsSchema);
      res.status(201).json({ data: await docs.addVersion(req.auth!, id(req), file, fields.changeNote, auditContext(req)) });
    })
  );

  secure.post(
    '/documents/:id/versions/:vid/promote',
    can('documents:manage'),
    validate({ params: versionParamsSchema }),
    asyncHandler(async (req, res) => {
      const { vid } = req.params as unknown as z.infer<typeof versionParamsSchema>;
      res.json({ data: await docs.promote(req.auth!, id(req), vid, auditContext(req)) });
    })
  );

  secure.post(
    '/documents/:id/versions/:vid/restore',
    can('versions:restore'),
    validate({ params: versionParamsSchema }),
    asyncHandler(async (req, res) => {
      const { vid } = req.params as unknown as z.infer<typeof versionParamsSchema>;
      res.status(201).json({ data: await docs.restore(req.auth!, id(req), vid, auditContext(req)) });
    })
  );

  secure.get(
    '/documents/:id/versions/:vid/content',
    can('versions:download'),
    limiters.download,
    validate({ params: versionParamsSchema, query: contentQuerySchema }),
    asyncHandler(async (req, res) => {
      const { vid } = req.params as unknown as z.infer<typeof versionParamsSchema>;
      const inline = (req.query as z.infer<typeof contentQuerySchema>).inline === '1';
      const file = await docs.readContent(req.auth!, id(req), vid, inline, auditContext(req));
      res.status(200);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(file.data.length));
      res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', file.filename));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // A previewed PDF may not run anything or load anything, even if the viewer is tricked.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'self'");
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('ETag', `"${file.sha256}"`);
      res.end(file.data);
    })
  );
}

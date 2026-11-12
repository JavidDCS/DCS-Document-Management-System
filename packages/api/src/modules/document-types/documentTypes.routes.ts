import { z } from 'zod';
import {
  createDocumentTypeSchema,
  createFieldSchema,
  listDocumentTypesQuerySchema,
  reorderFieldsSchema,
  updateDocumentTypeSchema,
  updateFieldSchema,
  uuidParamSchema,
} from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { auditContext } from '../audit/index.js';
import type { DocumentTypesService } from './documentTypes.service.js';

const fieldParams = z.strictObject({ id: z.uuid(), fieldId: z.uuid() });

export function registerDocumentTypeRoutes(secure: SecureRouter, _ctx: AppContext, svc: DocumentTypesService) {
  const typeId = (req: { params: unknown }) => (req.params as { id: string }).id;
  const manages = (req: { auth?: { permissions: readonly string[] } }) => req.auth!.permissions.includes('doc_types:manage');

  secure.get(
    '/document-types',
    can('doc_types:read'),
    validate({ query: listDocumentTypesQuerySchema }),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof listDocumentTypesQuerySchema>;
      res.json({ data: await svc.list(manages(req), q.active === undefined ? undefined : q.active === 'true') });
    })
  );

  secure.get(
    '/document-types/:id',
    can('doc_types:read'),
    validate({ params: uuidParamSchema }),
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.get(typeId(req), manages(req)) });
    })
  );

  secure.post(
    '/document-types',
    can('doc_types:manage'),
    validate({ body: createDocumentTypeSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json({ data: await svc.create(req.auth!, req.body as z.infer<typeof createDocumentTypeSchema>, auditContext(req)) });
    })
  );

  secure.patch(
    '/document-types/:id',
    can('doc_types:manage'),
    validate({ params: uuidParamSchema, body: updateDocumentTypeSchema }),
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.update(req.auth!, typeId(req), req.body as z.infer<typeof updateDocumentTypeSchema>, auditContext(req)) });
    })
  );

  secure.post(
    '/document-types/:id/fields',
    can('doc_types:manage'),
    validate({ params: uuidParamSchema, body: createFieldSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json({ data: await svc.addField(req.auth!, typeId(req), req.body as z.infer<typeof createFieldSchema>, auditContext(req)) });
    })
  );

  secure.put(
    '/document-types/:id/fields/order',
    can('doc_types:manage'),
    validate({ params: uuidParamSchema, body: reorderFieldsSchema }),
    asyncHandler(async (req, res) => {
      const { fieldIds } = req.body as z.infer<typeof reorderFieldsSchema>;
      res.json({ data: await svc.reorderFields(req.auth!, typeId(req), fieldIds, auditContext(req)) });
    })
  );

  secure.patch(
    '/document-types/:id/fields/:fieldId',
    can('doc_types:manage'),
    validate({ params: fieldParams, body: updateFieldSchema }),
    asyncHandler(async (req, res) => {
      const { fieldId } = req.params as unknown as z.infer<typeof fieldParams>;
      res.json({ data: await svc.updateField(req.auth!, typeId(req), fieldId, req.body as z.infer<typeof updateFieldSchema>, auditContext(req)) });
    })
  );
}

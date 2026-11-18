import { signatureAssetMetaSchema, uuidParamSchema } from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { can, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { HttpError } from '../../utils/httpError.js';
import { auditContext } from '../audit/index.js';
import type { FileService } from '../storage/fileService.js';
import type { SignatureAssetsService } from './signatureAssets.service.js';
import { parseSignatureUpload } from './signatureUpload.js';

export function registerSignatureAssetRoutes(secure: SecureRouter, ctx: AppContext, signatureAssets: SignatureAssetsService, files: FileService, maxBytes: number) {
  const { limiters } = ctx;
  const idParam = validate({ params: uuidParamSchema });

  secure.post(
    '/signature-assets',
    can('signatures:manage', { reauth: true }),
    limiters.upload,
    asyncHandler(async (req, res) => {
      const upload = await parseSignatureUpload(req, files, { maxBytes });
      // Multipart fields always arrive as strings; coerce the numeric ones before validating against the schema
      // shared with the rest of the app (which expects real numbers, not form-encoded text).
      const numeric = ['pageNumber', 'xPt', 'yPt', 'widthPt', 'heightPt'] as const;
      const candidate: Record<string, unknown> = { ...upload.fields };
      for (const key of numeric) if (key in candidate) candidate[key] = Number(candidate[key]);
      const parsed = signatureAssetMetaSchema.safeParse(candidate);
      if (!parsed.success) {
        if (upload.file) await files.delete('clean', upload.file.stored.storageKey).catch(() => undefined);
        throw new HttpError(400, 'Invalid request', 'VALIDATION_ERROR', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      }
      const created = await signatureAssets.upload(req.auth!, auditContext(req), parsed.data, upload.file!);
      res.status(201).json({ data: created });
    })
  );

  secure.get(
    '/signature-assets',
    can('documents:review'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await signatureAssets.list() });
    })
  );

  secure.post(
    '/signature-assets/:id/set-default',
    can('signatures:manage', { reauth: true }),
    idParam,
    asyncHandler(async (req, res) => {
      const id = (req.params as { id: string }).id;
      res.json({ data: await signatureAssets.setDefault(req.auth!, id, auditContext(req)) });
    })
  );

  secure.post(
    '/signature-assets/:id/deactivate',
    can('signatures:manage'),
    idParam,
    asyncHandler(async (req, res) => {
      const id = (req.params as { id: string }).id;
      res.json({ data: await signatureAssets.deactivate(req.auth!, id, auditContext(req)) });
    })
  );
}

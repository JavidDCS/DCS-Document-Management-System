import { Prisma, type PrismaClient } from '@prisma/client';
import type { SignatureAssetDto, SignatureAssetMeta } from '@dcs-docs/shared';
import type { AuthContext } from '../../types/express.js';
import { HttpError } from '../../utils/httpError.js';
import { recordAudit } from '../audit/index.js';
import type { FileService, StoredFile } from '../storage/fileService.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

type SignatureAssetRow = {
  id: string;
  label: string;
  pageNumber: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  isActive: boolean;
  isDefault: boolean;
  createdAt: Date;
};

function toDto(r: SignatureAssetRow): SignatureAssetDto {
  return {
    id: r.id,
    label: r.label,
    pageNumber: r.pageNumber,
    xPt: r.xPt,
    yPt: r.yPt,
    widthPt: r.widthPt,
    heightPt: r.heightPt,
    isActive: r.isActive,
    isDefault: r.isDefault,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * CRUD for reusable signature images used to stamp an accepted review comment. Uploaded once by an admin, stored
 * encrypted exactly like document content via the same FileService/FileCrypto -- but written straight to 'clean'
 * (see signatureUpload.ts): never scanned, never client-supplied, by explicit decision.
 */
export class SignatureAssetsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly files: FileService
  ) {}

  private audit(tx: Prisma.TransactionClient | PrismaClient, actor: AuthContext, action: string, resourceId: string, meta: RequestMeta, details: Record<string, unknown> = {}) {
    return recordAudit(tx, { actorType: 'USER', actorUserId: actor.userId, action, resourceType: 'signature_asset', resourceId, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details });
  }

  async list(): Promise<SignatureAssetDto[]> {
    const rows = await this.db.signatureAsset.findMany({ orderBy: [{ isDefault: 'desc' }, { isActive: 'desc' }, { createdAt: 'desc' }] });
    return rows.map(toDto);
  }

  private async get(id: string): Promise<SignatureAssetDto> {
    const row = await this.db.signatureAsset.findUnique({ where: { id } });
    if (!row) throw new HttpError(404, 'Signature asset not found');
    return toDto(row);
  }

  async upload(actor: AuthContext, meta: RequestMeta, fields: SignatureAssetMeta, file: { filename: string; stored: StoredFile }): Promise<SignatureAssetDto> {
    try {
      const created = await this.db.$transaction(async (tx) => {
        const row = await tx.signatureAsset.create({
          data: {
            label: fields.label,
            storageKey: file.stored.storageKey,
            sizeBytes: BigInt(file.stored.size),
            storedSize: BigInt(file.stored.storedSize),
            sha256: file.stored.sha256,
            encryptionKeyId: file.stored.keyId,
            wrappedDataKey: file.stored.wrappedKey,
            pageNumber: fields.pageNumber,
            xPt: fields.xPt,
            yPt: fields.yPt,
            widthPt: fields.widthPt,
            heightPt: fields.heightPt,
            createdById: actor.userId,
          },
        });
        await this.audit(tx, actor, 'SIGNATURE_ASSET_UPLOADED', row.id, meta, { label: row.label, pageNumber: row.pageNumber });
        return row;
      });
      return toDto(created);
    } catch (err) {
      await this.files.delete('clean', file.stored.storageKey).catch(() => undefined);
      throw err;
    }
  }

  /** Clears any previous default inside the same transaction, so the DB's one-default partial index never has to fail a race. */
  async setDefault(actor: AuthContext, id: string, meta: RequestMeta): Promise<SignatureAssetDto> {
    await this.db.$transaction(async (tx) => {
      const row = await tx.signatureAsset.findUnique({ where: { id } });
      if (!row || !row.isActive) throw new HttpError(404, 'Signature asset not found');
      if (row.isDefault) return;
      await tx.signatureAsset.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      await tx.signatureAsset.update({ where: { id }, data: { isDefault: true } });
      await this.audit(tx, actor, 'SIGNATURE_ASSET_SET_DEFAULT', id, meta, { label: row.label });
    });
    return this.get(id);
  }

  async deactivate(actor: AuthContext, id: string, meta: RequestMeta): Promise<SignatureAssetDto> {
    await this.db.$transaction(async (tx) => {
      const row = await tx.signatureAsset.findUnique({ where: { id } });
      if (!row) throw new HttpError(404, 'Signature asset not found');
      if (!row.isActive) return;
      await tx.signatureAsset.update({ where: { id }, data: { isActive: false, isDefault: false } });
      await this.audit(tx, actor, 'SIGNATURE_ASSET_DEACTIVATED', id, meta, { label: row.label });
    });
    return this.get(id);
  }
}

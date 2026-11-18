import type { Prisma } from '@prisma/client';
import { HttpError } from '../../utils/httpError.js';
import type { UploadedFile } from './documents.service.js';

type Tx = Prisma.TransactionClient;

/**
 * The lock/version/edit-guard primitives shared by every flow that creates a new document version under the
 * document's row lock (uploads, restore, and the review-accept flow). Extracted out of DocumentsService so the
 * review module can reuse the exact same pattern without reaching into its private members.
 */

/** Locks the document row so concurrent uploads, promotions and restores are serialised. */
export async function lockDocument(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string; document_type_id: string; archive_status: string; is_active: boolean; current_version_id: string | null }[]>`
    SELECT id, document_type_id, archive_status, is_active, current_version_id FROM documents WHERE id = ${id}::uuid FOR UPDATE`;
  const r = rows[0];
  if (!r) throw new HttpError(404, 'Document not found');
  return { id: r.id, documentTypeId: r.document_type_id, archiveStatus: r.archive_status, isActive: r.is_active, currentVersionId: r.current_version_id };
}

/** version_number = max + 1 under the document lock; UNIQUE(document_id, version_number) is the safety net. */
export async function nextVersionNumber(tx: Tx, documentId: string): Promise<number> {
  const max = await tx.documentVersion.aggregate({ where: { documentId }, _max: { versionNumber: true } });
  return (max._max.versionNumber ?? 0) + 1;
}

export function assertEditable(archiveStatus: string) {
  if (archiveStatus === 'LEGAL_HOLD') throw new HttpError(409, 'This document is under legal hold', 'CONFLICT');
  if (archiveStatus === 'ARCHIVED') throw new HttpError(409, 'This document is archived; unarchive it first', 'CONFLICT');
}

export function versionData(documentId: string, n: number, file: UploadedFile, actorId: string, changeNote?: string) {
  return {
    documentId,
    versionNumber: n,
    storageKey: file.stored.storageKey,
    originalFilename: file.filename,
    mimeType: 'application/pdf',
    sizeBytes: BigInt(file.stored.size),
    storedSize: BigInt(file.stored.storedSize),
    sha256: file.stored.sha256,
    encryptionKeyId: file.stored.keyId,
    wrappedDataKey: file.stored.wrappedKey,
    changeNote: changeNote ?? null,
    uploadedById: actorId,
  };
}

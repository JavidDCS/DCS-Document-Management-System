import { z } from 'zod';
import type { DocumentTypeDto } from './metadata.js';

export const ARCHIVE_STATUSES = ['LIVE', 'ARCHIVED', 'LEGAL_HOLD'] as const;
export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number];

export const SCAN_STATUSES = ['PENDING', 'CLEAN', 'QUARANTINED', 'REJECTED'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const ACL_PERMISSIONS = ['VIEW', 'SEND'] as const;
export const ACL_EFFECTS = ['ALLOW', 'DENY'] as const;

export interface TagRef {
  id: string;
  name: string;
}

export interface DocumentListItem {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  isActive: boolean;
  archiveStatus: ArchiveStatus;
  currentVersionNumber: number | null;
  currentVersionId: string | null;
  tags: TagRef[];
  updatedAt: string;
}

export interface VersionDto {
  id: string;
  versionNumber: number;
  originalFilename: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: ScanStatus;
  scanDetail: string | null;
  isCurrent: boolean;
  changeNote: string | null;
  restoredFromVersionId: string | null;
  uploadedBy: { id: string; name: string };
  createdAt: string;
}

export interface DocumentDetail extends DocumentListItem {
  description: string | null;
  metadata: Record<string, unknown>;
  fieldsVersion: number;
  versions: VersionDto[];
  type: DocumentTypeDto;
}

const jsonString = <T extends z.ZodType>(inner: T) =>
  z.string().transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Must be valid JSON' });
      return z.NEVER;
    }
  }).pipe(inner);

const documentName = z.string().trim().min(1).max(200);
const description = z.string().trim().max(2000);
const changeNote = z.string().trim().max(500);

/** Text fields that accompany the uploaded file in multipart/form-data (metadata and tagIds arrive as JSON strings). */
export const createDocumentFieldsSchema = z.strictObject({
  typeId: z.uuid(),
  name: documentName,
  description: description.optional(),
  metadata: jsonString(z.record(z.string(), z.unknown())).optional(),
  tagIds: jsonString(z.array(z.uuid()).max(30)).optional(),
  changeNote: changeNote.optional(),
});

export const newVersionFieldsSchema = z.strictObject({ changeNote: changeNote.optional() });

export const updateDocumentSchema = z
  .strictObject({
    name: documentName.optional(),
    description: description.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    tagIds: z.array(z.uuid()).max(30).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one property to change');

export const listDocumentsQuerySchema = z.strictObject({
  search: z.string().trim().min(1).max(100).optional(),
  typeId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  active: z.enum(['true', 'false']).optional(),
  archive: z.enum(ARCHIVE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const versionParamsSchema = z.strictObject({ id: z.uuid(), vid: z.uuid() });

export const contentQuerySchema = z.strictObject({ inline: z.enum(['1', '0']).optional() });

export const accessRulesSchema = z.strictObject({
  rules: z
    .array(
      z.discriminatedUnion('subjectType', [
        z.strictObject({ subjectType: z.literal('USER'), userId: z.uuid(), permission: z.enum(ACL_PERMISSIONS), effect: z.enum(ACL_EFFECTS) }),
        z.strictObject({ subjectType: z.literal('ROLE'), role: z.enum(['SUPER_ADMIN', 'ADMIN', 'SENDER', 'VIEWER']), permission: z.enum(ACL_PERMISSIONS), effect: z.enum(ACL_EFFECTS) }),
      ])
    )
    .max(100),
});

/** Display filename: no path parts, no control characters, no quotes, never empty. Never used as a storage path. */
export function sanitizeFilename(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  const limited = cleaned.length > 200 ? cleaned.slice(0, 196) + cleaned.slice(-4) : cleaned;
  return limited.length > 0 ? limited : 'document.pdf';
}

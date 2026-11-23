import { Readable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { parseReviewFieldsConfig, type ReviewFieldDef } from '@dcs-docs/shared';
import type { AuthContext } from '../../types/express.js';
import { HttpError } from '../../utils/httpError.js';
import { recordAudit } from '../audit/index.js';
import type { FileService } from '../storage/fileService.js';
import { DocxConversionError, type DocxToPdfConverter } from '../../providers/pdf/docxToPdf.js';
import { DocxTemplateError, fillTemplate, findBlanks, formatValue, isZip } from './docxTemplate.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface TemplateInfo {
  present: boolean;
  filename: string | null;
  uploadedAt: string | null;
  /** the {{blanks}} found in the Word file */
  blanks: string[];
  /** blanks the document type has no field for, so nobody can fill them (they would stop the document from being made) */
  blanksWithoutField: string[];
  /** fields of the document type that the Word file has no blank for (their answers would go nowhere) */
  fieldsWithoutBlank: string[];
  /** blanks with no default value: if the client leaves that field unchanged, the document cannot be made (fine when every field is required) */
  blanksWithoutDefault: string[];
  converter: { available: boolean; engine: string };
}

const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;

/**
 * The Word (.docx) version of an agreement. An administrator uploads it once; from then on "Incorporate changes" fills its
 * blanks with what the client typed and turns the result into a PDF, instead of painting over the old PDF. Stored encrypted
 * exactly like document content.
 */
export class DocumentTemplateService {
  constructor(
    private readonly db: PrismaClient,
    private readonly files: FileService,
    private readonly converter: DocxToPdfConverter
  ) {}

  private async fieldsOf(documentId: string): Promise<ReviewFieldDef[]> {
    const doc = await this.db.document.findUnique({ where: { id: documentId }, select: { documentType: { select: { reviewFieldsConfig: true } } } });
    if (!doc) throw new HttpError(404, 'Document not found');
    return parseReviewFieldsConfig(doc.documentType.reviewFieldsConfig);
  }

  private info(row: { filename: string; updatedAt: Date; blanks: string[] } | null, fields: ReviewFieldDef[]): TemplateInfo {
    const converter = { available: this.converter.available, engine: this.converter.engine };
    if (!row) return { present: false, filename: null, uploadedAt: null, blanks: [], blanksWithoutField: [], fieldsWithoutBlank: [], blanksWithoutDefault: [], converter };
    const keys = new Set(fields.map((f) => f.key));
    return {
      present: true,
      filename: row.filename,
      uploadedAt: row.updatedAt.toISOString(),
      blanks: row.blanks,
      blanksWithoutField: row.blanks.filter((b) => !keys.has(b)),
      fieldsWithoutBlank: fields.filter((f) => !row.blanks.includes(f.key)).map((f) => f.key),
      blanksWithoutDefault: row.blanks.filter((b) => !fields.find((f) => f.key === b)?.defaultValue),
      converter,
    };
  }

  async get(documentId: string): Promise<TemplateInfo> {
    const fields = await this.fieldsOf(documentId);
    return this.info(await this.db.documentTemplate.findUnique({ where: { documentId } }), fields);
  }

  /** Checks the file is a safe Word template and keeps it (replacing an earlier one). Returns what was found in it. */
  async upload(actor: AuthContext, meta: RequestMeta, documentId: string, file: { filename: string; bytes: Buffer }): Promise<TemplateInfo> {
    const fields = await this.fieldsOf(documentId);
    if (!isZip(file.bytes)) throw new HttpError(400, 'This is not a Word (.docx) file. Save the agreement as .docx and upload that.', 'VALIDATION_ERROR');
    let blanks: string[];
    try {
      blanks = findBlanks(file.bytes);
    } catch (e) {
      if (e instanceof DocxTemplateError) throw new HttpError(400, e.message, 'VALIDATION_ERROR');
      throw e;
    }
    if (blanks.length === 0) throw new HttpError(400, 'The Word file has no blanks. Type each changing part as {{name}}, for example {{counterparty_name}}, then upload it again.', 'VALIDATION_ERROR');
    if (file.bytes.length > MAX_TEMPLATE_BYTES) throw new HttpError(413, 'The Word file is too large (the limit is 10 MB).', 'PAYLOAD_TOO_LARGE');

    const stored = await this.files.store('clean', Readable.from([file.bytes]), { maxBytes: MAX_TEMPLATE_BYTES });
    try {
      const previous = await this.db.documentTemplate.findUnique({ where: { documentId } });
      const row = await this.db.$transaction(async (tx) => {
        const data = {
          filename: file.filename,
          storageKey: stored.storageKey,
          sizeBytes: BigInt(stored.size),
          storedSize: BigInt(stored.storedSize),
          sha256: stored.sha256,
          encryptionKeyId: stored.keyId,
          wrappedDataKey: stored.wrappedKey,
          blanks,
          uploadedById: actor.userId,
        };
        const saved = await tx.documentTemplate.upsert({ where: { documentId }, create: { documentId, ...data }, update: data });
        await recordAudit(tx, { actorType: 'USER', actorUserId: actor.userId, action: 'DOCUMENT_TEMPLATE_UPLOADED', resourceType: 'document', resourceId: documentId, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { filename: file.filename, blanks, replaced: Boolean(previous) } });
        return saved;
      });
      if (previous) await this.files.delete('clean', previous.storageKey).catch(() => undefined);
      return this.info(row, fields);
    } catch (e) {
      await this.files.delete('clean', stored.storageKey).catch(() => undefined);
      throw e;
    }
  }

  async remove(actor: AuthContext, meta: RequestMeta, documentId: string): Promise<void> {
    const row = await this.db.documentTemplate.findUnique({ where: { documentId } });
    if (!row) throw new HttpError(404, 'This document has no Word template');
    await this.db.$transaction(async (tx) => {
      await tx.documentTemplate.delete({ where: { documentId } });
      await recordAudit(tx, { actorType: 'USER', actorUserId: actor.userId, action: 'DOCUMENT_TEMPLATE_REMOVED', resourceType: 'document', resourceId: documentId, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, details: { filename: row.filename } });
    });
    await this.files.delete('clean', row.storageKey).catch(() => undefined);
  }

  /** Does this document have a Word template? */
  async has(documentId: string): Promise<boolean> {
    return (await this.db.documentTemplate.count({ where: { documentId } })) > 0;
  }

  /**
   * The finished PDF for a document that has a Word template: every blank filled with the client's value (tidied the way its field
   * says), or the field's own default when the client did not change it; then converted to PDF. Returns null when the document has no
   * template (the caller then uses the older overlay way). Throws an HttpError in plain English if a blank cannot be filled or the
   * PDF cannot be made, and nothing is written.
   */
  async renderPdf(documentId: string, clientValues: Readonly<Record<string, string>>): Promise<Buffer | null> {
    const row = await this.db.documentTemplate.findUnique({ where: { documentId } });
    if (!row) return null;
    if (!this.converter.available) throw new HttpError(503, 'This agreement has a Word template, but no Word-to-PDF converter is set up on the server. Ask the administrator (DOCX_PDF_CONVERTER in .env).', 'INTERNAL_ERROR');
    const fields = await this.fieldsOf(documentId);
    const bytes = await this.files.readVerified('clean', row.storageKey, { keyId: row.encryptionKeyId, wrappedKey: Buffer.from(row.wrappedDataKey) }, { sha256: row.sha256, size: Number(row.sizeBytes) }, MAX_TEMPLATE_BYTES);

    const values: Record<string, string> = {};
    for (const key of row.blanks) {
      const field = fields.find((f) => f.key === key);
      const typed = clientValues[key];
      const raw = typed !== undefined && typed.trim() !== '' ? typed : field?.defaultValue;
      if (raw !== undefined && raw.trim() !== '') values[key] = formatValue(raw, typed !== undefined && typed.trim() !== '' ? field?.format : undefined);
    }
    try {
      const docx = fillTemplate(bytes, values);
      return await this.converter.convert(docx, row.filename);
    } catch (e) {
      if (e instanceof DocxTemplateError) throw new HttpError(409, `${e.message} Fix the Word template or give that field a default value, then try again.`, 'CONFLICT');
      if (e instanceof DocxConversionError) throw new HttpError(502, e.message, 'INTERNAL_ERROR');
      throw e;
    }
  }
}

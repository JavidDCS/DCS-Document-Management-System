import type { PrismaClient } from '@prisma/client';
import type {
  HandoffCreateInput,
  HandoffLookupDto,
  IntegrationDocumentListItem,
  IntegrationDocumentTypeKey,
  SentLookupItem,
} from '@dcs-docs/shared';
import { HttpError } from '../../utils/httpError.js';
import { recordAudit } from '../audit/index.js';
import { HANDOFF_EXPIRED_MESSAGE, isHandoffUsable } from './handoffs.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface IntegrationsConfig {
  handoffMinutes: number;
  /** Testing only: when set, every hand-off's `to` must be one of these (lower-cased). See EmailService.send
   * for the matching rule applied to ordinary sends. */
  allowlist: string[] | undefined;
}

const MAX_SENT_LOOKUP_REFS = 200;
const MAX_DOCUMENTS_RETURNED = 200;

export class IntegrationsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly cfg: IntegrationsConfig
  ) {}

  private assertAllowlisted(to: string) {
    if (this.cfg.allowlist && !this.cfg.allowlist.includes(to)) {
      throw new HttpError(403, `Test mode is on: mail can only go to ${this.cfg.allowlist.join(', ')}`, 'FORBIDDEN');
    }
  }

  private audit(action: string, resourceId: string | null, meta: RequestMeta, details: Record<string, unknown>, outcome: 'SUCCESS' | 'DENIED' = 'SUCCESS') {
    return recordAudit(this.db, {
      actorType: 'API_CLIENT',
      action,
      resourceType: 'integration_handoff',
      resourceId,
      outcome,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      details,
    });
  }

  /** Creates a hand-off. Validates the optional document (exists, active, clean current version, right type) and
   * the test-mode allowlist before writing anything. */
  async createHandoff(input: HandoffCreateInput, meta: RequestMeta): Promise<{ id: string }> {
    try {
      this.assertAllowlisted(input.to);
    } catch (err) {
      await this.audit('INTEGRATION_HANDOFF_REFUSED', null, meta, { reason: 'ALLOWLIST', documentTypeKey: input.documentTypeKey, ref: input.ref }, 'DENIED');
      throw err;
    }

    if (input.documentId) {
      const doc = await this.db.document.findUnique({
        where: { id: input.documentId },
        include: { documentType: { select: { key: true } }, currentVersion: { select: { scanStatus: true } } },
      });
      if (!doc) {
        await this.audit('INTEGRATION_HANDOFF_REFUSED', input.documentId, meta, { reason: 'DOCUMENT_NOT_FOUND' }, 'DENIED');
        throw new HttpError(404, 'Document not found', 'NOT_FOUND');
      }
      if (doc.documentType.key !== input.documentTypeKey) {
        await this.audit('INTEGRATION_HANDOFF_REFUSED', input.documentId, meta, { reason: 'WRONG_TYPE' }, 'DENIED');
        throw new HttpError(400, `This document does not belong to the "${input.documentTypeKey}" document type`, 'VALIDATION_ERROR');
      }
      if (!doc.isActive || !doc.currentVersion || doc.currentVersion.scanStatus !== 'CLEAN') {
        await this.audit('INTEGRATION_HANDOFF_REFUSED', input.documentId, meta, { reason: 'NOT_SENDABLE' }, 'DENIED');
        throw new HttpError(400, 'This document is inactive or has no clean current version', 'VALIDATION_ERROR');
      }
    }

    const expiresAt = new Date(Date.now() + this.cfg.handoffMinutes * 60_000);
    const created = await this.db.$transaction(async (tx) => {
      const h = await tx.integrationHandoff.create({
        data: {
          toAddress: input.to,
          documentTypeKey: input.documentTypeKey,
          documentId: input.documentId ?? null,
          ref: input.ref,
          requestedBy: input.requestedBy,
          expiresAt,
        },
      });
      await recordAudit(tx, {
        actorType: 'API_CLIENT',
        action: 'INTEGRATION_HANDOFF_CREATED',
        resourceType: 'integration_handoff',
        resourceId: h.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        details: { to: input.to, documentTypeKey: input.documentTypeKey, documentId: input.documentId ?? null, ref: input.ref, requestedBy: input.requestedBy },
      });
      return h;
    });
    return { id: created.id };
  }

  /** Active documents of one type whose current version is CLEAN, for the Leads Manager picker. */
  async listDocuments(typeKey: IntegrationDocumentTypeKey): Promise<IntegrationDocumentListItem[]> {
    const type = await this.db.documentType.findUnique({ where: { key: typeKey }, select: { id: true } });
    if (!type) return []; // the type has not been seeded yet on this server: an empty list, not an error

    const rows = await this.db.document.findMany({
      where: { documentTypeId: type.id, isActive: true },
      include: { currentVersion: { select: { versionNumber: true, sizeBytes: true, scanStatus: true } } },
      orderBy: { name: 'asc' },
      take: MAX_DOCUMENTS_RETURNED,
    });
    // isActive can only be true while a CLEAN current version exists (DB trigger), but this check costs nothing
    // and keeps the contract true even if that invariant is ever relaxed.
    return rows
      .filter((d) => d.currentVersion?.scanStatus === 'CLEAN')
      .map((d) => ({ id: d.id, name: d.name, versionLabel: `V${d.currentVersion!.versionNumber}`, sizeBytes: Number(d.currentVersion!.sizeBytes) }));
  }

  /** Only SENT messages with a matching external_ref come back; nothing else, no address/body/attachment data. */
  async sentLookup(refs: string[]): Promise<SentLookupItem[]> {
    const capped = refs.slice(0, MAX_SENT_LOOKUP_REFS);
    if (capped.length === 0) return [];
    const rows = await this.db.emailMessage.findMany({
      where: { status: 'SENT', externalRef: { in: capped } },
      select: { externalRef: true, sentAt: true, sender: { select: { name: true } } },
    });
    const out: SentLookupItem[] = [];
    for (const r of rows) {
      if (r.externalRef && r.sentAt) out.push({ ref: r.externalRef, sentAt: r.sentAt.toISOString(), senderName: r.sender.name });
    }
    return out;
  }

  /** SendPage's own read of a hand-off (not part of the fixed Leads-Manager contract). 404 for an unknown id,
   * 410 for one that is expired or already used -- both plain-English, no probing distinction needed here since
   * the caller is already a signed-in `email:send` user, not an anonymous party. */
  async getHandoffForSend(id: string): Promise<HandoffLookupDto> {
    const h = await this.db.integrationHandoff.findUnique({ where: { id } });
    if (!h) throw new HttpError(404, 'This hand-off link was not found.', 'NOT_FOUND');
    if (!isHandoffUsable(h)) throw new HttpError(410, HANDOFF_EXPIRED_MESSAGE, 'NOT_FOUND');

    const [type, doc] = await Promise.all([
      this.db.documentType.findUnique({ where: { key: h.documentTypeKey }, select: { id: true } }),
      h.documentId ? this.db.document.findUnique({ where: { id: h.documentId }, select: { name: true } }) : Promise.resolve(null),
    ]);
    return {
      to: h.toAddress,
      documentTypeKey: h.documentTypeKey as IntegrationDocumentTypeKey,
      documentTypeId: type?.id ?? null,
      documentId: h.documentId,
      documentName: doc?.name ?? null,
      ref: h.ref,
    };
  }
}

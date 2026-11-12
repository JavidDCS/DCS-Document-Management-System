import type { Prisma, PrismaClient } from '@prisma/client';
import { Readable } from 'node:stream';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit/index.js';
import type { JobContext } from '../jobs/jobs.js';
import type { FileService } from '../storage/fileService.js';
import { inspectPdf } from './pdfInspector.js';
import type { MalwareScanner } from './scanner.js';

export interface ScanConfig {
  PDF_ACTIVE_CONTENT_POLICY: 'block' | 'flag';
  STORAGE_MAX_FILE_SIZE_MB: number;
}

/**
 * The scan job: a new version is read back (decrypted and checksum-verified) from QUARANTINE, scanned by the malware
 * scanner and inspected for active content. Only a file that passes is moved to the clean area and becomes usable.
 * Fail closed: if the scanner cannot be reached the job throws and is retried; the version stays PENDING.
 */
export class ScanService {
  constructor(
    private readonly db: PrismaClient,
    private readonly files: FileService,
    private readonly scanner: MalwareScanner,
    private readonly cfg: ScanConfig
  ) {}

  private systemAudit(tx: Prisma.TransactionClient | PrismaClient, action: string, versionId: string, outcome: 'SUCCESS' | 'DENIED' | 'FAILURE', details: Record<string, unknown>) {
    return recordAudit(tx, { actorType: 'SYSTEM', action, resourceType: 'document_version', resourceId: versionId, outcome, details });
  }

  async handle(job: JobContext): Promise<void> {
    const versionId = String(job.payload.versionId ?? '');
    await this.scanVersion(versionId);
  }

  async scanVersion(versionId: string): Promise<'CLEAN' | 'QUARANTINED' | 'REJECTED' | 'SKIPPED'> {
    const v = await this.db.documentVersion.findUnique({ where: { id: versionId } });
    if (!v || v.scanStatus !== 'PENDING') return 'SKIPPED'; // idempotent: a repeated job changes nothing

    // After a crash between "move to clean" and the database update the object is already in the clean area.
    const area = (await this.files.exists('quarantine', v.storageKey)) ? 'quarantine' : 'clean';
    const meta = { keyId: v.encryptionKeyId, wrappedKey: Buffer.from(v.wrappedDataKey) };
    const expect = { sha256: v.sha256, size: Number(v.sizeBytes) };
    const data = await this.files.readVerified(area, v.storageKey, meta, expect, this.cfg.STORAGE_MAX_FILE_SIZE_MB * 1024 * 1024 + 1024 * 1024);

    const verdict = await this.scanner.scan(Readable.from([data]));
    const inspection = inspectPdf(data);
    const scannedAt = new Date();
    const base = { engine: this.scanner.name, scannedAt: scannedAt.toISOString() };

    let status: 'CLEAN' | 'QUARANTINED' | 'REJECTED';
    let details: Record<string, unknown>;
    if (!verdict.clean) {
      status = 'QUARANTINED';
      details = { ...base, signature: verdict.signature };
    } else if (inspection.problems.length > 0) {
      status = 'REJECTED';
      details = { ...base, problems: inspection.problems, findings: inspection.findings };
    } else if (inspection.findings.length > 0 && this.cfg.PDF_ACTIVE_CONTENT_POLICY === 'block') {
      status = 'REJECTED';
      details = { ...base, findings: inspection.findings, policy: 'block' };
    } else {
      status = 'CLEAN';
      details = { ...base, findings: inspection.findings, policy: this.cfg.PDF_ACTIVE_CONTENT_POLICY };
    }

    if (status === 'CLEAN' && area === 'quarantine') await this.files.promote(v.storageKey);

    await this.db.$transaction(async (tx) => {
      const r = await tx.documentVersion.updateMany({
        where: { id: v.id, scanStatus: 'PENDING' },
        data: { scanStatus: status, scanDetails: details as Prisma.InputJsonObject, scannedAt },
      });
      if (r.count !== 1) return;
      if (status === 'CLEAN') {
        // The first clean version of a document becomes its current version automatically.
        await tx.document.updateMany({ where: { id: v.documentId, currentVersionId: null }, data: { currentVersionId: v.id } });
      }
      await this.systemAudit(
        tx,
        status === 'CLEAN' ? 'VERSION_SCAN_CLEAN' : status === 'QUARANTINED' ? 'VERSION_QUARANTINED' : 'VERSION_REJECTED',
        v.id,
        status === 'CLEAN' ? 'SUCCESS' : 'DENIED',
        { documentId: v.documentId, ...(status === 'QUARANTINED' ? { signature: (verdict as { signature: string }).signature } : { findings: inspection.findings, problems: inspection.problems }) }
      );
    });
    logger.info('Version scanned', { versionId: v.id, status });
    return status;
  }

  /** Called when a scan job exhausts its retries: the version stays PENDING and an administrator is told through the audit log. */
  async onDeadLetter(job: JobContext, error: string): Promise<void> {
    if (job.type !== 'scan_file') return;
    await this.systemAudit(this.db, 'SCAN_JOB_FAILED_PERMANENTLY', String(job.payload.versionId ?? ''), 'FAILURE', { attempts: job.attempt, error: error.slice(0, 300) });
  }
}

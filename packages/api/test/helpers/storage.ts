import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { ScannerUnavailableError, type MalwareScanner, type ScanVerdict } from '../../src/modules/file-security/scanner.js';
import { FileCrypto } from '../../src/modules/storage/fileCrypto.js';
import { FileService } from '../../src/modules/storage/fileService.js';
import { EnvKeyProvider } from '../../src/providers/keys/envKeyProvider.js';
import { LocalStorageProvider } from '../../src/providers/storage/local.js';

/** Temporary local storage with real encryption, in a directory that is removed afterwards. */
export async function makeTestFiles() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'dcs-docs-test-'));
  const provider = new LocalStorageProvider({ clean: path.join(base, 'clean'), quarantine: path.join(base, 'quarantine') });
  await provider.init();
  const keys = new EnvKeyProvider('test-v1', randomBytes(32));
  const files = new FileService(provider, new FileCrypto(keys));
  return { files, provider, keys, base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Scanner whose verdict the test controls. Also records what it was asked to scan. */
export class FakeScanner implements MalwareScanner {
  readonly name = 'fake';
  mode: 'clean' | 'infected' | 'down' = 'clean';
  scans = 0;
  async scan(data: Readable): Promise<ScanVerdict> {
    this.scans++;
    const chunks: Buffer[] = [];
    for await (const c of data) chunks.push(Buffer.from(c as Uint8Array));
    if (this.mode === 'down') throw new ScannerUnavailableError('scanner is down');
    const text = Buffer.concat(chunks).toString('latin1');
    // The standard EICAR test string is the "virus" in tests.
    if (this.mode === 'infected' || text.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) return { clean: false, signature: 'Eicar-Test-Signature' };
    return { clean: true };
  }
}

/** Builds small, valid PDFs (and hostile ones) for tests. */
export function makePdf(opts: { extra?: string; body?: string; noEof?: boolean; header?: string } = {}): Buffer {
  const body = opts.body ?? 'BT /F1 12 Tf 72 720 Td (Confidential test document) Tj ET';
  const parts = [
    `${opts.header ?? '%PDF-1.4'}\n`,
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R ' + (opts.extra ?? '') + ' >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`,
    'trailer\n<< /Root 1 0 R /Size 5 >>\n',
  ];
  if (!opts.noEof) parts.push('%%EOF\n');
  return Buffer.from(parts.join(''), 'latin1');
}

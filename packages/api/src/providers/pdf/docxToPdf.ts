import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Turning the filled Word file into a PDF failed. The message is in plain English and safe to show. */
export class DocxConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxConversionError';
  }
}

export interface DocxToPdfConverter {
  /** false when no converter is set up in .env: documents with a Word template then cannot be produced */
  readonly available: boolean;
  /** which engine is configured, for display ("stirling", "libreoffice", or "none") */
  readonly engine: string;
  convert(docx: Buffer, filename: string): Promise<Buffer>;
}

const PDF_MAGIC = Buffer.from('%PDF');
const MAX_PDF_BYTES = 50 * 1024 * 1024;

function checkPdf(bytes: Buffer): Buffer {
  if (bytes.length < 100 || !bytes.subarray(0, 4).equals(PDF_MAGIC)) throw new DocxConversionError('The converter did not give back a PDF. Nothing was changed.');
  if (bytes.length > MAX_PDF_BYTES) throw new DocxConversionError('The converted PDF is too large. Nothing was changed.');
  return bytes;
}

/** Used when no converter is configured. */
export class NoDocxConverter implements DocxToPdfConverter {
  readonly available = false;
  readonly engine = 'none';
  async convert(): Promise<Buffer> {
    throw new DocxConversionError('No Word-to-PDF converter is set up on the server (DOCX_PDF_CONVERTER in .env). Ask the administrator.');
  }
}

export interface StirlingDocxConfig {
  url: string | undefined;
  apiKey: string | undefined;
  timeoutMs: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Uses the Stirling-PDF server the app already talks to (its LibreOffice converts Word to PDF). */
export class StirlingDocxConverter implements DocxToPdfConverter {
  readonly engine = 'stirling';
  constructor(private readonly cfg: StirlingDocxConfig) {}
  get available(): boolean {
    return Boolean(this.cfg.url && this.cfg.apiKey);
  }
  async convert(docx: Buffer, filename: string): Promise<Buffer> {
    if (!this.available) throw new DocxConversionError('Stirling-PDF is not set up (STIRLING_PDF_URL and STIRLING_PDF_API_KEY in .env).');
    const form = new FormData();
    form.append('fileInput', new Blob([new Uint8Array(docx)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), filename.replace(/[^\w.\- ]/g, '_') || 'agreement.docx');
    let res: Response;
    try {
      res = await (this.cfg.fetchImpl ?? fetch)(`${this.cfg.url!.replace(/\/+$/, '')}/api/v1/convert/file/pdf`, { method: 'POST', headers: { 'X-API-KEY': this.cfg.apiKey! }, body: form, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch {
      throw new DocxConversionError('Could not reach Stirling-PDF to make the PDF. Try again in a minute.');
    }
    if (!res.ok) throw new DocxConversionError(`Stirling-PDF could not make the PDF (it answered ${res.status}).`);
    return checkPdf(Buffer.from(await res.arrayBuffer()));
  }
}

export interface LibreOfficeConfig {
  bin: string;
  timeoutMs: number;
  /** Injectable for tests: runs the program, resolves when it has finished. */
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<void>;
}

const runProgram = (bin: string, args: string[], timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });

/** Uses LibreOffice installed on the same server, with no screen (`soffice --headless --convert-to pdf`). */
export class LibreOfficeDocxConverter implements DocxToPdfConverter {
  readonly engine = 'libreoffice';
  readonly available = true;
  constructor(private readonly cfg: LibreOfficeConfig) {}
  async convert(docx: Buffer): Promise<Buffer> {
    const dir = await mkdtemp(path.join(tmpdir(), 'docx-pdf-'));
    try {
      const input = path.join(dir, 'agreement.docx');
      await writeFile(input, docx);
      // a private profile folder per run, so two conversions at once never fight over LibreOffice's settings
      const profile = `file://${path.join(dir, 'profile').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`;
      try {
        await (this.cfg.run ?? runProgram)(this.cfg.bin, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input], this.cfg.timeoutMs);
      } catch {
        throw new DocxConversionError('LibreOffice could not make the PDF (it is missing, or it took too long). Ask the administrator to check it.');
      }
      let out: Buffer;
      try {
        out = await readFile(path.join(dir, 'agreement.pdf'));
      } catch {
        throw new DocxConversionError('LibreOffice finished but gave no PDF. Nothing was changed.');
      }
      return checkPdf(out);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export interface DocxConverterEnv {
  DOCX_PDF_CONVERTER: 'stirling' | 'libreoffice' | undefined;
  LIBREOFFICE_BIN: string;
  DOCX_CONVERT_TIMEOUT_MS: number;
  STIRLING_PDF_URL: string | undefined;
  STIRLING_PDF_API_KEY: string | undefined;
}

/** Picks the converter named in .env. Nothing is hardcoded: with no setting there is no converter and the old overlay way is used. */
export function createDocxConverter(env: DocxConverterEnv): DocxToPdfConverter {
  if (env.DOCX_PDF_CONVERTER === 'stirling') return new StirlingDocxConverter({ url: env.STIRLING_PDF_URL, apiKey: env.STIRLING_PDF_API_KEY, timeoutMs: env.DOCX_CONVERT_TIMEOUT_MS });
  if (env.DOCX_PDF_CONVERTER === 'libreoffice') return new LibreOfficeDocxConverter({ bin: env.LIBREOFFICE_BIN, timeoutMs: env.DOCX_CONVERT_TIMEOUT_MS });
  return new NoDocxConverter();
}

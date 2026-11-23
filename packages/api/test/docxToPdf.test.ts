import { writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocxConverter, DocxConversionError, LibreOfficeDocxConverter, NoDocxConverter, StirlingDocxConverter } from '../src/providers/pdf/docxToPdf.js';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 0x20), Buffer.from('\n%%EOF')]);
const DOCX = Buffer.from('PK\u0003\u0004 pretend word file');
const env = { DOCX_PDF_CONVERTER: undefined, LIBREOFFICE_BIN: 'soffice', DOCX_CONVERT_TIMEOUT_MS: 60_000, STIRLING_PDF_URL: undefined, STIRLING_PDF_API_KEY: undefined } as const;

describe('which converter is used comes from .env, never from the code', () => {
  it('none set: no converter, and trying one gives a plain message', async () => {
    const c = createDocxConverter(env);
    expect(c).toBeInstanceOf(NoDocxConverter);
    expect(c.available).toBe(false);
    expect(c.engine).toBe('none');
    await expect(c.convert(DOCX, 'a.docx')).rejects.toThrow(/DOCX_PDF_CONVERTER/);
  });
  it('stirling: needs its address and key', () => {
    expect(createDocxConverter({ ...env, DOCX_PDF_CONVERTER: 'stirling' }).available).toBe(false);
    const ok = createDocxConverter({ ...env, DOCX_PDF_CONVERTER: 'stirling', STIRLING_PDF_URL: 'http://pdf.test', STIRLING_PDF_API_KEY: 'k' });
    expect(ok.available).toBe(true);
    expect(ok.engine).toBe('stirling');
  });
  it('libreoffice: always ready (it fails with a plain message when the program is missing)', () => {
    const c = createDocxConverter({ ...env, DOCX_PDF_CONVERTER: 'libreoffice' });
    expect(c.available).toBe(true);
    expect(c.engine).toBe('libreoffice');
  });
});

describe('Stirling-PDF converter', () => {
  const make = (fetchImpl: typeof fetch) => new StirlingDocxConverter({ url: 'http://pdf.test/', apiKey: 'secret-key', timeoutMs: 5000, fetchImpl });

  it('sends the Word file with the key to the convert address and returns the PDF', async () => {
    let seen: { url: string; key: string | null; hasFile: boolean } | null = null;
    const c = make((async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      seen = { url, key: new Headers(init.headers).get('x-api-key'), hasFile: form.get('fileInput') instanceof Blob };
      return new Response(new Uint8Array(PDF), { status: 200, headers: { 'content-type': 'application/pdf' } });
    }) as unknown as typeof fetch);
    const out = await c.convert(DOCX, 'My NDA (final).docx');
    expect(out.equals(PDF)).toBe(true);
    expect(seen).toEqual({ url: 'http://pdf.test/api/v1/convert/file/pdf', key: 'secret-key', hasFile: true });
  });

  it('says so plainly when the server is down, answers with an error, or returns something that is not a PDF', async () => {
    await expect(make((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch).convert(DOCX, 'a.docx')).rejects.toThrow(/Could not reach Stirling-PDF/);
    await expect(make((async () => new Response('nope', { status: 500 })) as unknown as typeof fetch).convert(DOCX, 'a.docx')).rejects.toThrow(/answered 500/);
    await expect(make((async () => new Response('<html>login page</html>', { status: 200 })) as unknown as typeof fetch).convert(DOCX, 'a.docx')).rejects.toThrow(/did not give back a PDF/);
  });

  it('never shows the key in an error', async () => {
    const e = await make((async () => new Response('x', { status: 401 })) as unknown as typeof fetch).convert(DOCX, 'a.docx').catch((x) => x as Error);
    expect(String((e as Error).message)).not.toContain('secret-key');
  });

  it('without a key or address it refuses before sending anything', async () => {
    const c = new StirlingDocxConverter({ url: undefined, apiKey: undefined, timeoutMs: 1000, fetchImpl: (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch });
    await expect(c.convert(DOCX, 'a.docx')).rejects.toThrow(/not set up/);
  });
});

describe('LibreOffice converter', () => {
  it('writes the Word file to a private folder, runs LibreOffice, reads the PDF back, and cleans the folder up', async () => {
    let args: string[] = [];
    let outdir = '';
    const c = new LibreOfficeDocxConverter({
      bin: 'soffice',
      timeoutMs: 5000,
      run: async (bin, a) => {
        expect(bin).toBe('soffice');
        args = a;
        outdir = a[a.indexOf('--outdir') + 1]!;
        await writeFile(path.join(outdir, 'agreement.pdf'), PDF);
      },
    });
    const out = await c.convert(DOCX);
    expect(out.equals(PDF)).toBe(true);
    expect(args).toEqual(expect.arrayContaining(['--headless', '--norestore', '--convert-to', 'pdf']));
    expect(args.find((x) => x.startsWith('-env:UserInstallation='))).toMatch(/^-env:UserInstallation=file:\/\//);
    // the private folder is gone
    expect((await readdir(tmpdir())).includes(path.basename(outdir))).toBe(false);
  });

  it('a program that is missing or too slow gives a plain message, and still cleans up', async () => {
    let outdir = '';
    const c = new LibreOfficeDocxConverter({ bin: 'nope', timeoutMs: 5000, run: async (_b, a) => { outdir = a[a.indexOf('--outdir') + 1]!; throw new Error('ENOENT'); } });
    await expect(c.convert(DOCX)).rejects.toThrow(/LibreOffice could not make the PDF/);
    expect((await readdir(tmpdir())).includes(path.basename(outdir))).toBe(false);
  });

  it('a run that finishes with no PDF, or with a file that is not a PDF, is refused', async () => {
    await expect(new LibreOfficeDocxConverter({ bin: 's', timeoutMs: 5000, run: async () => undefined }).convert(DOCX)).rejects.toThrow(/gave no PDF/);
    const junk = new LibreOfficeDocxConverter({ bin: 's', timeoutMs: 5000, run: async (_b, a) => writeFile(path.join(a[a.indexOf('--outdir') + 1]!, 'agreement.pdf'), Buffer.alloc(400, 65)) });
    await expect(junk.convert(DOCX)).rejects.toThrow(DocxConversionError);
  });

  it('two conversions at once do not share a folder or a LibreOffice profile', async () => {
    const dirs: string[] = [];
    const profiles: string[] = [];
    const c = new LibreOfficeDocxConverter({
      bin: 's',
      timeoutMs: 5000,
      run: async (_b, a) => {
        dirs.push(a[a.indexOf('--outdir') + 1]!);
        profiles.push(a.find((x) => x.startsWith('-env:UserInstallation='))!);
        await new Promise((r) => setTimeout(r, 20));
        await writeFile(path.join(a[a.indexOf('--outdir') + 1]!, 'agreement.pdf'), PDF);
      },
    });
    await Promise.all([c.convert(DOCX), c.convert(DOCX)]);
    expect(new Set(dirs).size).toBe(2);
    expect(new Set(profiles).size).toBe(2);
  });
});

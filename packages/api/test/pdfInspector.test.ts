import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inspectPdf } from '../src/modules/file-security/pdfInspector.js';
import { makePdf } from './helpers/storage.js';

const flateStream = (dict: string, content: string) => {
  const z = deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([Buffer.from(`5 0 obj\n<< ${dict} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
};

/** Puts extra raw objects before the trailer so the PDF stays structurally normal. */
const withObjects = (...objs: Buffer[]) => {
  const base = makePdf();
  const marker = base.indexOf('trailer');
  return Buffer.concat([base.subarray(0, marker), ...objs, base.subarray(marker)]);
};

describe('inspectPdf', () => {
  it('accepts an ordinary PDF with no findings or problems', () => {
    expect(inspectPdf(makePdf())).toEqual({ findings: [], problems: [] });
  });

  it('does not flag ordinary words that merely contain the names', () => {
    // Plain words are fine; only PDF names (introduced by "/") count. A literal "/JS" in text is flagged on purpose (fail closed).
    expect(inspectPdf(makePdf({ body: 'BT (JavaScript Launch EmbeddedFile OpenAction are just words) Tj ET' }))).toEqual({ findings: [], problems: [] });
  });

  it('finds JavaScript, Launch, embedded files, OpenAction, additional actions, rich media, form submit and remote goto', () => {
    const cases: [string, string][] = [
      ['/OpenAction << /S /JavaScript /JS (app.alert(1)) >>', 'JAVASCRIPT'],
      ['/AA << /O << /S /Launch /F (cmd.exe) >> >>', 'LAUNCH_ACTION'],
      ['/Names << /EmbeddedFiles << /Names [] >> >>', 'EMBEDDED_FILE'],
      ['/OpenAction [3 0 R /Fit]', 'OPEN_ACTION'],
      ['/AA << /WC 6 0 R >>', 'ADDITIONAL_ACTIONS'],
      ['/Annots [<< /Subtype /RichMedia >>]', 'RICH_MEDIA'],
      ['/A << /S /SubmitForm /F (http://evil) >>', 'FORM_SUBMIT'],
      ['/A << /S /GoToR /F (other.pdf) >>', 'GOTO_REMOTE'],
    ];
    for (const [extra, finding] of cases) expect(inspectPdf(makePdf({ extra })).findings, extra).toContain(finding);
  });

  it('sees through #xx name obfuscation', () => {
    expect(inspectPdf(makePdf({ extra: '/#4A#61vaScript (x)' })).findings).toContain('JAVASCRIPT');
    expect(inspectPdf(makePdf({ extra: '/#4Aa#76aScript (x)' })).findings).toContain('JAVASCRIPT');
    expect(inspectPdf(makePdf({ extra: '/#4C#61unch' })).findings).toContain('LAUNCH_ACTION');
    expect(inspectPdf(makePdf({ extra: '/Open#41ction' })).findings).toContain('OPEN_ACTION');
  });

  it('finds code hidden inside a compressed object stream', () => {
    const pdf = withObjects(flateStream('/Type /ObjStm /N 1 /First 8', '10 0 << /S /JavaScript /JS (this.exportDataObject) >>'));
    expect(inspectPdf(pdf).findings).toContain('JAVASCRIPT');
  });

  it('finds code in a compressed stream even without a visible ObjStm type', () => {
    const pdf = withObjects(flateStream('', '<< /Type /Action /S /Launch >>'));
    expect(inspectPdf(pdf).findings).toContain('LAUNCH_ACTION');
  });

  it('rejects an object stream it cannot decode (unknown filter)', () => {
    const odd = Buffer.from('5 0 obj\n<< /Type /ObjStm /Filter [/ASCII85Decode /FlateDecode] /N 1 >>\nstream\nabcdef\nendstream\nendobj\n', 'latin1');
    expect(inspectPdf(withObjects(odd)).problems).toContain('UNINSPECTABLE_OBJECT_STREAM');
  });

  it('rejects a decompression bomb instead of inflating it', () => {
    const bomb = flateStream('/Type /ObjStm', 'A'.repeat(30 * 1024 * 1024));
    const r = inspectPdf(withObjects(bomb));
    expect(r.problems).toContain('TOO_COMPLEX');
  });

  it('flags encrypted, truncated and non-PDF data as problems', () => {
    expect(inspectPdf(makePdf({ extra: '/Encrypt 9 0 R' })).problems).toContain('ENCRYPTED');
    expect(inspectPdf(makePdf({ noEof: true })).problems).toContain('TRUNCATED');
    expect(inspectPdf(Buffer.from('<html><script>alert(1)</script></html>')).problems).toEqual(['NOT_A_PDF']);
    expect(inspectPdf(Buffer.from('MZ\x90\x00 executable')).problems).toEqual(['NOT_A_PDF']);
    expect(inspectPdf(Buffer.alloc(0)).problems).toEqual(['NOT_A_PDF']);
    expect(inspectPdf(makePdf({ header: ' %PDF-1.4' })).problems).toEqual(['NOT_A_PDF']);
  });

  it('survives garbage inside streams', () => {
    const junk = Buffer.from('5 0 obj\n<< /Filter /FlateDecode /Length 10 >>\nstream\n\x00\x01\x02garbage\nendstream\nendobj\n', 'latin1');
    expect(inspectPdf(withObjects(junk)).problems).toEqual([]);
  });

  it('reports each finding once and in a stable order', () => {
    const r = inspectPdf(makePdf({ extra: '/OpenAction << /S /JavaScript /JS (a) >> /AA << /O << /S /JavaScript /JS (b) >> >>' }));
    expect(r.findings).toEqual([...new Set(r.findings)].sort());
  });
});

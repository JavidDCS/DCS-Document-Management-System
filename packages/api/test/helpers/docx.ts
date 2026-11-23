import PizZip from 'pizzip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { DocxToPdfConverter } from '../../src/providers/pdf/docxToPdf.js';

/** A tiny but real .docx made in a test (no real agreement). `body` is the inside of <w:body>; `extra` adds more parts (headers, footers, ...). */
export function makeDocx(body: string, extra: Record<string, string | Buffer> = {}): Buffer {
  const zip = new PizZip();
  const W = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  const overrides = [`<Override PartName="/word/document.xml" ContentType="${W}.document.main+xml"/>`]
    .concat(Object.keys(extra).filter((n) => /^word\/header\d*\.xml$/.test(n)).map((n) => `<Override PartName="/${n}" ContentType="${W}.header+xml"/>`))
    .concat(Object.keys(extra).filter((n) => /^word\/footer\d*\.xml$/.test(n)).map((n) => `<Override PartName="/${n}" ContentType="${W}.footer+xml"/>`));
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}
export const run = (text: string, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
export const para = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;
export const xmlOf = (docx: Buffer, part = 'word/document.xml') => new PizZip(docx).file(part)!.asText();
export const textOf = (docx: Buffer, part = 'word/document.xml') => [...xmlOf(docx, part).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');

/** Stands in for Stirling-PDF / LibreOffice: records every Word file it is given, and answers with a real PDF holding that file's text. */
export class FakeDocxConverter implements DocxToPdfConverter {
  readonly engine = 'fake';
  available = true;
  received: Buffer[] = [];
  failWith: Error | null = null;
  async convert(docx: Buffer): Promise<Buffer> {
    this.received.push(docx);
    if (this.failWith) throw this.failWith;
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595, 842]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    // one line per paragraph, so a test can look for the filled sentence in the PDF
    const lines = [...xmlOf(docx).matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map((p) => [...(p[1] ?? '').matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
    lines.forEach((l, i) => page.drawText(l.replace(/&amp;/g, '&').replace(/[^\x20-\x7e]/g, '?'), { x: 40, y: 800 - i * 16, size: 9, font }));
    return Buffer.from(await pdf.save({ useObjectStreams: false }));
  }
}

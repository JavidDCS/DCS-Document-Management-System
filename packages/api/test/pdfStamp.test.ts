import { decodePDFRawStream, PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { applyReplacements, pageCount, stamp, UnsupportedTextError } from '../src/modules/review/pdfStamp.service.js';

// A real, tiny (4x4) JPEG -- fake test fixture, not any real signature or document content.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqD/9k=';
const tinyJpeg = () => Buffer.from(TINY_JPEG_BASE64, 'base64');

/** The decoded content stream(s) of page 1: pdf-lib compresses them, so the operators are not visible in the raw bytes. */
async function pageContent(pdf: Buffer): Promise<string> {
  const doc = await PDFDocument.load(pdf);
  const contents: any = doc.getPage(0).node.Contents();
  const refs: any[] = contents.asArray ? contents.asArray() : [contents];
  return refs.map((r) => Buffer.from(decodePDFRawStream(doc.context.lookup(r) as any).decode()).toString('latin1')).join('\n');
}

async function makeFakePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

describe('pdfStamp.service', () => {
  it('reports the page count of a PDF', async () => {
    expect(await pageCount(await makeFakePdf(1))).toBe(1);
    expect(await pageCount(await makeFakePdf(3))).toBe(3);
  });

  it('stamps a signature image onto one page: still a valid, reloadable PDF with the same page count and different bytes', async () => {
    const original = await makeFakePdf(2);
    const stamped = await stamp({
      pdfBytes: original,
      signature: { bytes: tinyJpeg(), pageNumber: 2, xPt: 50, yPt: 50, widthPt: 100, heightPt: 40 },
    });

    expect(Buffer.isBuffer(stamped)).toBe(true);
    expect(stamped.equals(original)).toBe(false);
    expect(await pageCount(stamped)).toBe(2); // page count is unchanged

    // pdf-lib can reload the output without error: still a structurally valid PDF.
    const reloaded = await PDFDocument.load(stamped);
    expect(reloaded.getPageCount()).toBe(2);
  });

  describe('applyReplacements (suggested text changes)', () => {
    const one = { pageNumber: 1, xPct: 0.1, yPct: 0.2, wPct: 0.3, hPct: 0.03, text: 'Acme Solar Pvt Ltd' };

    it('whites out the box and draws the new text: a valid PDF with the same page count and different bytes', async () => {
      const original = await makeFakePdf(2);
      const edited = await applyReplacements(original, [one, { ...one, pageNumber: 2, text: '12 months' }]);
      expect(edited.equals(original)).toBe(false);
      expect(await pageCount(edited)).toBe(2);
      expect((await PDFDocument.load(edited)).getPageCount()).toBe(2);
    });

    it('measures from the top-left like a browser: a box at the very top lands near the top of the page in PDF space', async () => {
      // yPct 0 is the TOP edge in the browser, but PDF user space puts y=0 at the BOTTOM edge. If the conversion were
      // missing, the white box would be drawn at the bottom of the page instead. Draw a box at the top and read back
      // the content stream for the rectangle's y coordinate.
      const edited = await applyReplacements(await makeFakePdf(1), [{ pageNumber: 1, xPct: 0, yPct: 0, wPct: 0.5, hPct: 0.1, text: 'x' }]);
      const stream = await pageContent(edited);
      // 792 (page height) - 0 - 79.2 (box height) = 712.8: the box's bottom edge sits 79.2pt below the top of the
      // page -- then padded out by a small fixed margin (not scaled by box size) for a stray descender or edge slop.
      expect(stream).toMatch(/1 0 0 1 -1 711\.3/);
      // ...starting from 306 (half of 612) wide and 79.2 (a tenth of 792) tall, plus that same small margin.
      expect(stream).toMatch(/309 82\.2 l/);
    });

    it('rejects a page beyond the document, and text the standard font cannot draw', async () => {
      const pdf = await makeFakePdf(1);
      await expect(applyReplacements(pdf, [{ ...one, pageNumber: 3 }])).rejects.toThrow(/out of range/);
      await expect(applyReplacements(pdf, [{ ...one, text: '日本語' }])).rejects.toBeInstanceOf(UnsupportedTextError);
    });

    it('with no replacements it still returns a valid PDF', async () => {
      expect(await pageCount(await applyReplacements(await makeFakePdf(1), []))).toBe(1);
    });
  });

  it('rejects a page number beyond the document (does not touch any page)', async () => {
    const pdf = await makeFakePdf(1);
    await expect(
      stamp({ pdfBytes: pdf, signature: { bytes: tinyJpeg(), pageNumber: 5, xPt: 0, yPt: 0, widthPt: 10, heightPt: 10 } })
    ).rejects.toThrow(/out of range/);
    await expect(
      stamp({ pdfBytes: pdf, signature: { bytes: tinyJpeg(), pageNumber: 0, xPt: 0, yPt: 0, widthPt: 10, heightPt: 10 } })
    ).rejects.toThrow(/out of range/);
  });
});

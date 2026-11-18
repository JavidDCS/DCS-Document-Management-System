import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { pageCount, stamp } from '../src/modules/review/pdfStamp.service.js';

// A real, tiny (4x4) JPEG -- fake test fixture, not any real signature or document content.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqD/9k=';
const tinyJpeg = () => Buffer.from(TINY_JPEG_BASE64, 'base64');

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

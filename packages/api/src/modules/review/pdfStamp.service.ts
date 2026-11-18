import { PDFDocument } from 'pdf-lib';

/**
 * Pure PDF stamping: no DB, no HTTP. Loads an existing PDF, embeds a JPEG signature image onto one page at the
 * given point coordinates, and returns the new bytes. Content elsewhere on the page is untouched -- accepting a
 * review comment re-stamps the document, it never edits the text inside it (see the plan's scope decision).
 */
export interface StampSignature {
  bytes: Buffer;
  pageNumber: number; // 1-based
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

export interface StampInput {
  pdfBytes: Buffer;
  signature: StampSignature;
}

/**
 * A Node Buffer under the default pool size is often a VIEW into a larger shared ArrayBuffer (a nonzero
 * byteOffset). pdf-lib's JPEG embedder reads `imageData.buffer` directly with a DataView, ignoring byteOffset --
 * so a pooled buffer is silently read from the wrong position. Copying into a fresh, unpooled Uint8Array first
 * sidesteps that regardless of how the caller's Buffer was allocated.
 */
function unpooled(buf: Buffer): Uint8Array {
  return new Uint8Array(buf);
}

export async function stamp(input: StampInput): Promise<Buffer> {
  const doc = await PDFDocument.load(unpooled(input.pdfBytes));
  const pages = doc.getPages();
  const { pageNumber, xPt, yPt, widthPt, heightPt, bytes } = input.signature;
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pages.length) {
    throw new RangeError(`pageNumber ${pageNumber} is out of range (document has ${pages.length} page(s))`);
  }
  const page = pages[pageNumber - 1]!;
  const jpg = await doc.embedJpg(unpooled(bytes));
  page.drawImage(jpg, { x: xPt, y: yPt, width: widthPt, height: heightPt });
  const out = await doc.save();
  return Buffer.from(out);
}

export async function pageCount(pdfBytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(unpooled(pdfBytes));
  return doc.getPageCount();
}

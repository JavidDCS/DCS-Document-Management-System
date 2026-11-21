import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

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

/** One suggested change: a box on a page (fractions of the page, top-left origin like the browser) and the new text. */
export interface TextReplacement {
  pageNumber: number; // 1-based
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  text: string;
}

/** The replacement contains a character the built-in PDF font cannot draw (e.g. an emoji or a non-Latin script). */
export class UnsupportedTextError extends Error {
  constructor(readonly text: string) {
    super(`The text "${text}" contains characters the PDF font cannot draw`);
    this.name = 'UnsupportedTextError';
  }
}

const MIN_FONT_PT = 5;
const MAX_FONT_PT = 16;

/**
 * Applies suggested text changes as an overlay: each box is painted white and the new text is drawn inside it. The
 * original text is NOT removed from the PDF's content stream -- it is covered, which is what a "whiteout" edit is.
 * That is right for a small value edit (a name, a price, a period) on a white background; it is not a way to
 * redact. The font is Helvetica, shrunk to fit the box.
 */
export async function applyReplacements(pdfBytes: Buffer, items: readonly TextReplacement[]): Promise<Buffer> {
  const doc = await PDFDocument.load(unpooled(pdfBytes));
  const pages = doc.getPages();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const it of items) {
    if (!Number.isInteger(it.pageNumber) || it.pageNumber < 1 || it.pageNumber > pages.length) {
      throw new RangeError(`pageNumber ${it.pageNumber} is out of range (document has ${pages.length} page(s))`);
    }
    const page = pages[it.pageNumber - 1]!;
    const { width: pageW, height: pageH } = page.getSize();
    const w = it.wPct * pageW;
    const h = it.hPct * pageH;
    const x = it.xPct * pageW;
    // The browser measures from the top-left corner; PDF user space measures from the bottom-left.
    const y = pageH - it.yPct * pageH - h;

    let size = Math.max(MIN_FONT_PT, Math.min(MAX_FONT_PT, Math.max(9.5, h * 0.85)));
    try {
      while (size > MIN_FONT_PT && font.widthOfTextAtSize(it.text, size) > Math.max(1, w - 2)) size -= 0.25;
      page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1) });
      page.drawText(it.text, { x: x + 1, y: y + (h - size) / 2 + size * 0.15, size, font, color: rgb(0, 0, 0) });
    } catch (e) {
      // pdf-lib throws "WinAnsi cannot encode ..." for a glyph the standard font lacks.
      if (e instanceof Error && /cannot encode/i.test(e.message)) throw new UnsupportedTextError(it.text);
      throw e;
    }
  }
  return Buffer.from(await doc.save());
}

export async function pageCount(pdfBytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(unpooled(pdfBytes));
  return doc.getPageCount();
}

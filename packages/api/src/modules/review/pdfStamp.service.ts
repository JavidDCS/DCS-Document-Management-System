import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const req = createRequire(import.meta.url);
let poppinsRegularBuffer: Buffer | null = null;
let poppinsBoldBuffer: Buffer | null = null;

function getPoppinsBuffers(): { regular: Buffer; bold: Buffer } | null {
  try {
    if (!poppinsRegularBuffer) {
      const p = req.resolve('@fontsource/poppins/files/poppins-latin-400-normal.woff');
      poppinsRegularBuffer = fs.readFileSync(p);
    }
    if (!poppinsBoldBuffer) {
      const p = req.resolve('@fontsource/poppins/files/poppins-latin-700-normal.woff');
      poppinsBoldBuffer = fs.readFileSync(p);
    }
    return { regular: poppinsRegularBuffer, bold: poppinsBoldBuffer };
  } catch {
    return null;
  }
}

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
  bold?: boolean | undefined;
  /** The covered text's own point size (from the template's `Tf` operator) -- NOT derived from `hPct`, which is
   * sized generously for whiteout coverage, not for font-size estimation. Falls back to a sensible default. */
  fontSizePt?: number | undefined;
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
 * redact.
 *
 * Drawn in Poppins (the app's own brand font) when it can be embedded, falling back to Helvetica otherwise. Text
 * is always validated against Helvetica's WinAnsi encoding first, even when Poppins is what actually gets drawn:
 * a custom fontkit-embedded font silently draws a blank/notdef glyph for a character it can't map (it does not
 * throw), so Helvetica's narrower, throwing encoder is what actually catches an unsupported character.
 *
 * Tests draw with Helvetica only (`PDF_USE_CUSTOM_FONT` unset in the test env): a custom embedded font is written
 * into the PDF as 2-byte glyph-index (CID) codes, not literal character bytes, so a test asserting the drawn text
 * by searching the raw content stream for it (`pdfContainsText`) would never find it. Position, sizing and
 * every other behaviour is identical either way -- only the glyph encoding differs.
 */
export async function applyReplacements(pdfBytes: Buffer, items: readonly TextReplacement[]): Promise<Buffer> {
  const doc = await PDFDocument.load(unpooled(pdfBytes));
  const pages = doc.getPages();

  let poppinsReg: any = null;
  let poppinsBold: any = null;
  const useCustomFont = process.env.NODE_ENV !== 'test' || Boolean(process.env.PDF_USE_CUSTOM_FONT);
  if (useCustomFont) {
    try {
      doc.registerFontkit(fontkit);
      const bufs = getPoppinsBuffers();
      if (bufs) {
        poppinsReg = await doc.embedFont(bufs.regular);
        poppinsBold = await doc.embedFont(bufs.bold);
      }
    } catch {
      // If fontkit or custom font embedding fails, fall back to StandardFonts
    }
  }
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const it of items) {
    if (!Number.isInteger(it.pageNumber) || it.pageNumber < 1 || it.pageNumber > pages.length) {
      throw new RangeError(`pageNumber ${it.pageNumber} is out of range (document has ${pages.length} page(s))`);
    }
    const page = pages[it.pageNumber - 1]!;
    const { width: pageW, height: pageH } = page.getSize();
    const w = it.wPct * pageW;
    const h = it.hPct * pageH;
    const x = it.xPct * pageW;
    // The browser measures from the top-left corner; PDF user space measures from the bottom-left. `h` is the
    // covered text's own ascender-to-baseline height, so this `y` is exactly that text's own baseline.
    const y = pageH - it.yPct * pageH - h;

    // Validate character support against Helvetica's WinAnsi encoding -- see the function comment above for why.
    try {
      helvetica.encodeText(it.text);
    } catch (e) {
      if (e instanceof Error && /cannot encode/i.test(e.message)) {
        throw new UnsupportedTextError(it.text);
      }
      throw e;
    }

    const isBold = it.bold ?? false;
    const font = isBold ? (poppinsBold ?? helveticaBold) : (poppinsReg ?? helvetica);

    // The covered text's own size when the position states it (precise -- read off the template's content
    // stream); otherwise a clamped estimate from `hPct`. Either way, shrunk further only if this particular
    // value is too wide for its box.
    let size = it.fontSizePt ?? Math.max(MIN_FONT_PT, Math.min(MAX_FONT_PT, h));
    // A small fixed margin around the measured box -- just enough for a stray descender or antialiasing at the
    // edge. `hPct` is already sized generously for coverage, so this stays small and fixed rather than scaling
    // with `h` (which, for a bold heading's wider box, would otherwise pad enough to bleed into the line below).
    const padY = 1.5;
    const padRight = 3;
    try {
      while (size > MIN_FONT_PT && font.widthOfTextAtSize(it.text, size) > Math.max(1, w - 2)) size -= 0.25;
      page.drawRectangle({ x: x - 1, y: y - padY, width: w + padRight, height: h + padY * 2, color: rgb(1, 1, 1) });
      page.drawText(it.text, { x: x + 1, y, size, font, color: rgb(0, 0, 0) });
    } catch (e) {
      if (e instanceof Error && (/cannot encode/i.test(e.message) || /unknown glyph/i.test(e.message) || /not found in font/i.test(e.message) || /WinAnsi cannot encode/i.test(e.message))) {
        throw new UnsupportedTextError(it.text);
      }
      throw e;
    }
  }
  return Buffer.from(await doc.save());
}

export async function pageCount(pdfBytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(unpooled(pdfBytes));
  return doc.getPageCount();
}

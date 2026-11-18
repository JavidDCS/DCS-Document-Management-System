/** Pure pin-position math, kept separate from PdfCanvasViewer so it can be unit-tested without pdfjs-dist or the DOM. */

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Converts a click's offset within the rendered page (pixels) into a fraction of the page's
 * width/height (0..1), so the pin's position survives zoom and viewport changes.
 */
export function clickToPct(offsetX: number, offsetY: number, width: number, height: number): { xPct: number; yPct: number } {
  const xPct = width > 0 ? clamp01(offsetX / width) : 0;
  const yPct = height > 0 ? clamp01(offsetY / height) : 0;
  return { xPct, yPct };
}

/** Inverse of `clickToPct`: where a pin should render (CSS percentages) given its stored fraction. */
export function pctToStyle(xPct: number, yPct: number): { left: string; top: string } {
  return { left: `${clamp01(xPct) * 100}%`, top: `${clamp01(yPct) * 100}%` };
}

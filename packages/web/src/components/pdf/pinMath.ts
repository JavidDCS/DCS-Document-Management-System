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

/** Pointer travel (px) below which a press-and-release is a click (a pin), not a drag (a box). */
export const MIN_DRAG_PX = 6;
/** A box is never thinner than this, so a quick drag along one line of text still gives a usable target. */
export const MIN_BOX_PX = 10;

export type DragSelection =
  | { kind: 'pin'; xPct: number; yPct: number }
  | { kind: 'box'; xPct: number; yPct: number; wPct: number; hPct: number };

/**
 * Turns a press-drag-release (pixel offsets within the rendered page) into either a pin (a click) or a box
 * (a drag), both as fractions of the page. A box is normalised so any drag direction works, clamped to the page,
 * and widened to at least MIN_BOX_PX. (xPct, yPct) is always the top-left corner.
 */
export function dragToSelection(startX: number, startY: number, endX: number, endY: number, width: number, height: number): DragSelection {
  if (Math.abs(endX - startX) < MIN_DRAG_PX && Math.abs(endY - startY) < MIN_DRAG_PX) {
    return { kind: 'pin', ...clickToPct(endX, endY, width, height) };
  }
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  let right = Math.max(startX, endX);
  let bottom = Math.max(startY, endY);
  if (right - left < MIN_BOX_PX) right = left + MIN_BOX_PX;
  if (bottom - top < MIN_BOX_PX) bottom = top + MIN_BOX_PX;
  const a = clickToPct(left, top, width, height);
  const b = clickToPct(right, bottom, width, height);
  const wPct = b.xPct - a.xPct;
  const hPct = b.yPct - a.yPct;
  // Dragged entirely outside the page: nothing to select, so fall back to a pin at the nearest edge point.
  if (wPct <= 0 || hPct <= 0) return { kind: 'pin', ...a };
  return { kind: 'box', xPct: a.xPct, yPct: a.yPct, wPct, hPct };
}

/** Where a box should render (CSS percentages) given its stored fractions. */
export function boxToStyle(xPct: number, yPct: number, wPct: number, hPct: number): { left: string; top: string; width: string; height: string } {
  return { ...pctToStyle(xPct, yPct), width: `${clamp01(wPct) * 100}%`, height: `${clamp01(hPct) * 100}%` };
}

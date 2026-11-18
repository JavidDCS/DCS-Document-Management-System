import { describe, expect, it } from 'vitest';
import { boxToStyle, clickToPct, dragToSelection, MIN_BOX_PX, pctToStyle } from './pinMath';

describe('clickToPct', () => {
  it('converts a click at the top-left corner to (0, 0)', () => {
    expect(clickToPct(0, 0, 800, 1000)).toEqual({ xPct: 0, yPct: 0 });
  });

  it('converts a click at the bottom-right corner to (1, 1)', () => {
    expect(clickToPct(800, 1000, 800, 1000)).toEqual({ xPct: 1, yPct: 1 });
  });

  it('converts a click at the exact centre to (0.5, 0.5)', () => {
    expect(clickToPct(400, 500, 800, 1000)).toEqual({ xPct: 0.5, yPct: 0.5 });
  });

  it('is independent of absolute canvas size — same relative position gives the same fraction', () => {
    expect(clickToPct(100, 50, 400, 200)).toEqual(clickToPct(200, 100, 800, 400));
  });

  it('clamps out-of-bounds offsets (e.g. from a mouseup outside the canvas) into [0, 1]', () => {
    expect(clickToPct(-20, -5, 800, 1000)).toEqual({ xPct: 0, yPct: 0 });
    expect(clickToPct(900, 1100, 800, 1000)).toEqual({ xPct: 1, yPct: 1 });
  });

  it('returns 0 for a zero-sized dimension instead of NaN or Infinity', () => {
    expect(clickToPct(10, 10, 0, 0)).toEqual({ xPct: 0, yPct: 0 });
  });
});

describe('dragToSelection', () => {
  it('treats a press-and-release without real movement as a click: a pin at the release point', () => {
    expect(dragToSelection(400, 500, 402, 503, 800, 1000)).toEqual({ kind: 'pin', xPct: 0.5025, yPct: 0.503 });
  });

  it('turns a real drag into a box whose top-left corner is the origin', () => {
    const r = dragToSelection(80, 100, 400, 140, 800, 1000);
    expect(r.kind).toBe('box');
    if (r.kind !== 'box') return;
    // Sizes are differences of fractions, so compare with a tolerance rather than exact floating-point equality.
    expect(r.xPct).toBeCloseTo(0.1, 9);
    expect(r.yPct).toBeCloseTo(0.1, 9);
    expect(r.wPct).toBeCloseTo(0.4, 9);
    expect(r.hPct).toBeCloseTo(0.04, 9);
  });

  it('gives the same box whichever direction the drag goes', () => {
    const forward = dragToSelection(80, 100, 400, 140, 800, 1000);
    expect(dragToSelection(400, 140, 80, 100, 800, 1000)).toEqual(forward);
    expect(dragToSelection(80, 140, 400, 100, 800, 1000)).toEqual(forward);
  });

  it('widens a very thin drag (along one line of text) to a usable minimum height', () => {
    const r = dragToSelection(80, 100, 400, 102, 800, 1000);
    expect(r.kind).toBe('box');
    if (r.kind === 'box') expect(r.hPct).toBeCloseTo(MIN_BOX_PX / 1000, 6);
  });

  it('clamps a drag that runs off the page so the box never leaves it', () => {
    const r = dragToSelection(700, 900, 950, 1100, 800, 1000);
    expect(r.kind).toBe('box');
    if (r.kind !== 'box') return;
    expect(r.xPct).toBeCloseTo(0.875, 9);
    expect(r.yPct).toBeCloseTo(0.9, 9);
    expect(r.wPct).toBeCloseTo(0.125, 9);
    expect(r.hPct).toBeCloseTo(0.1, 9);
    // The point of clamping: the box ends exactly at the page edge, never beyond it.
    expect(r.xPct + r.wPct).toBeCloseTo(1, 9);
    expect(r.yPct + r.hPct).toBeCloseTo(1, 9);
  });

  it('falls back to a pin when the whole drag is off the page, rather than an empty box', () => {
    expect(dragToSelection(900, 1100, 950, 1150, 800, 1000).kind).toBe('pin');
  });
});

describe('boxToStyle', () => {
  it('maps a box to CSS percentages', () => {
    expect(boxToStyle(0.1, 0.2, 0.3, 0.04)).toEqual({ left: '10%', top: '20%', width: '30%', height: '4%' });
  });
});

describe('pctToStyle', () => {
  it('maps fractions to CSS percentage strings', () => {
    expect(pctToStyle(0.25, 0.75)).toEqual({ left: '25%', top: '75%' });
  });

  it('clamps an out-of-range fraction before formatting', () => {
    expect(pctToStyle(-0.5, 1.5)).toEqual({ left: '0%', top: '100%' });
  });
});

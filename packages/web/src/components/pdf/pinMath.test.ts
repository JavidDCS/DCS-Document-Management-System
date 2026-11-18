import { describe, expect, it } from 'vitest';
import { clickToPct, pctToStyle } from './pinMath';

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

describe('pctToStyle', () => {
  it('maps fractions to CSS percentage strings', () => {
    expect(pctToStyle(0.25, 0.75)).toEqual({ left: '25%', top: '75%' });
  });

  it('clamps an out-of-range fraction before formatting', () => {
    expect(pctToStyle(-0.5, 1.5)).toEqual({ left: '0%', top: '100%' });
  });
});

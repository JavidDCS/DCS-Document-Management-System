import { useEffect, useState } from 'react';

export const DURATION = {
  instant: 90,
  quick: 160,
  base: 240,
  slow: 420,
} as const;

export const EASING = {
  standard: 'cubic-bezier(0.16, 1, 0.3, 1)',
  standardOut: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

/** Hook to detect system preferences for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

/** Smooth count-up animation for numbers on initial dashboard load. */
export function useCountUp(target: number, durationMs = 600): number {
  const [current, setCurrent] = useState(0);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    if (prefersReduced || target <= 0) {
      setCurrent(target);
      return;
    }

    let start = 0;
    const startTime = performance.now();

    const frame = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      // Ease out cubic curve
      const eased = 1 - Math.pow(1 - progress, 3);
      const val = Math.round(start + (target - start) * eased);
      setCurrent(val);

      if (progress < 1) {
        requestAnimationFrame(frame);
      }
    };

    const handle = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(handle);
  }, [target, durationMs, prefersReduced]);

  return current;
}


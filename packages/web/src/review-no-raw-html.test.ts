import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Comment text submitted through a public review link is attacker-controlled input. None of the
// review-feature files should ever render it as raw HTML. Paths are relative to this package's root
// (vitest runs with cwd = packages/web), not to this test file, to sidestep import.meta.url quirks.
const FILES = [
  'src/components/pdf/PdfCanvasViewer.tsx',
  'src/components/CommentsReviewPanel.tsx',
  'src/pages/public/ReviewLinkPage.tsx',
  'src/api/publicClient.ts',
];

describe('review feature never renders comment text as HTML', () => {
  for (const rel of FILES) {
    it(`${rel} has no dangerouslySetInnerHTML or .innerHTML`, () => {
      const path = join(process.cwd(), rel);
      const src = readFileSync(path, 'utf8');
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src).not.toMatch(/\.innerHTML\s*=/);
    });
  }
});

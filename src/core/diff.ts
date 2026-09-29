import { createTwoFilesPatch } from 'diff';

// Unified-diff computation over two text buffers. Kept out of `fmt.ts`, which
// formats terminal output and has no business pulling in the `diff` package.

/**
 * Wall-clock bound for one Myers diff. The algorithm is synchronous and
 * quadratic in differing lines (8k changed lines ≈ 11 s), and neither the tool
 * timeout nor the abort signal can interrupt it. Past the deadline the `diff`
 * package returns `undefined`; callers degrade (no preview / no counts) instead
 * of freezing the process.
 */
export const DIFF_TIMEOUT_MS = 1000;

export function unifiedPatch(
  label: string,
  original: string,
  modified: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): string | undefined {
  return createTwoFilesPatch(label, label, original, modified, 'Original', 'Modified', {
    timeout: timeoutMs,
  });
}

/** Added/removed line counts read off a unified patch — no second diff pass. */
export function diffStatsFromPatch(patch: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  // The file header (---/+++) precedes the first hunk; only hunk bodies count,
  // so a content line that itself starts with -- or ++ is never mistaken for it.
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}

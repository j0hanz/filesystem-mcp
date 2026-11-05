import { FILE_HEADERS_ONLY, formatPatch, OMIT_HEADERS, structuredPatch } from 'diff';

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

/**
 * What could break a header line, misorder it on screen, or be lost when it is
 * parsed back (parsePatch trims the line); the `diff` package quotes these.
 */
const NEEDS_QUOTING = /^\s|["\\\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

/** The name as a header shows it: `diff` quotes all non-ASCII, which only a risky name needs. */
function headerName(name: string): string {
  if (!NEEDS_QUOTING.test(name)) return name;
  const patch = { oldFileName: name, newFileName: name, oldHeader: '', newHeader: '', hunks: [] };
  return formatPatch(patch, FILE_HEADERS_ONLY).split('\n', 1)[0]?.slice('--- '.length) ?? name;
}

/** `createTwoFilesPatch` with readable names; `undefined` past `options.timeout`. */
export function twoFilesPatch(
  oldName: string,
  newName: string,
  before: string,
  after: string,
  oldHeader: string,
  newHeader: string,
  options: { context?: number; timeout: number },
): string | undefined {
  const patch = structuredPatch(oldName, newName, before, after, oldHeader, newHeader, options);
  if (patch === undefined) return undefined;
  const shownOld = headerName(oldName);
  const header =
    (oldName === newName ? `Index: ${shownOld}\n` : '') +
    `${'='.repeat(67)}\n--- ${shownOld}\t${oldHeader}\n+++ ${headerName(newName)}\t${newHeader}\n`;
  return patch.hunks.length > 0 ? header + formatPatch(patch, OMIT_HEADERS) : header;
}

export function unifiedPatch(
  label: string,
  original: string,
  modified: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): string | undefined {
  return twoFilesPatch(label, label, original, modified, 'Original', 'Modified', {
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

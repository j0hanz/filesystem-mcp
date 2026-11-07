import { Worker } from 'node:worker_threads';

import {
  FILE_HEADERS_ONLY,
  formatPatch,
  OMIT_HEADERS,
  type StructuredPatch,
  structuredPatch,
} from 'diff';

import { runExclusive } from './concurrency.ts';
import type { DiffWorkerRequest } from './diff-worker.ts';

// Unified-diff computation over two text buffers. Kept out of `fmt.ts`, which
// formats terminal output and has no business pulling in the `diff` package.

/**
 * Wall-clock bound for one Myers diff. The algorithm is synchronous and
 * quadratic in differing lines (8k changed lines ≈ 11 s), and neither the tool
 * timeout nor the abort signal can interrupt it. Past the deadline the `diff`
 * package returns `undefined`; callers degrade (no preview / no counts) instead
 * of freezing the process. A diff over INLINE_DIFF_MAX_LINES runs in a worker,
 * so the deadline holds the worker, not the event loop (GHSA-9p5w-jvxw-wrcg).
 */
export const DIFF_TIMEOUT_MS = 1000;

/** Lines in both sides at or under which a diff runs inline: worst case ~33 ms. */
const INLINE_DIFF_MAX_LINES = 1000;

// Slack past DIFF_TIMEOUT_MS before a worker that never answered is killed.
const WORKER_KILL_GRACE_MS = 500;

// One diff worker at a time: a burst queues instead of taking every core.
const DIFF_WORKER_KEY = Symbol('diff-worker');

// tsc leaves this string alone, so pick the extension the running module has.
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './diff-worker.ts' : './diff-worker.js',
  import.meta.url,
);

/** Characters in both sides at or under which a diff runs inline: long lines cost too. */
const INLINE_DIFF_MAX_CHARS = 64 * 1024;

// Worker diffs pending at once, running or queued; each holds both texts.
const MAX_PENDING_WORKER_DIFFS = 4;
let pendingWorkerDiffs = 0;

function overInlineLimit(before: string, after: string): boolean {
  if (before.length + after.length > INLINE_DIFF_MAX_CHARS) return true;
  let count = 2;
  for (const text of [before, after]) {
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      if (++count > INLINE_DIFF_MAX_LINES) return true;
    }
  }
  return false;
}

/** Runs one structuredPatch in a worker; `undefined` on its deadline, a crash, or the kill timer. */
function patchInWorker(request: DiffWorkerRequest): Promise<StructuredPatch | undefined> {
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (patch: StructuredPatch | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      resolve(patch);
      void worker?.terminate();
    };
    const kill = setTimeout(() => {
      finish(undefined);
    }, request.options.timeout + WORKER_KILL_GRACE_MS);
    try {
      worker = new Worker(WORKER_URL);
      worker.once('message', (patch: StructuredPatch | null) => {
        finish(patch ?? undefined);
      });
      worker.once('error', () => {
        finish(undefined);
      });
      worker.once('exit', () => {
        finish(undefined);
      });
      worker.postMessage(request);
    } catch {
      // A worker that cannot start degrades like one past its deadline.
      finish(undefined);
    }
  });
}

/** One worker diff through the queue; `undefined` at once when the queue is full. */
async function queuedWorkerPatch(request: DiffWorkerRequest): Promise<StructuredPatch | undefined> {
  if (pendingWorkerDiffs >= MAX_PENDING_WORKER_DIFFS) return undefined;
  pendingWorkerDiffs++;
  try {
    return await runExclusive(DIFF_WORKER_KEY, () => patchInWorker(request));
  } finally {
    pendingWorkerDiffs--;
  }
}

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
export async function twoFilesPatch(
  oldName: string,
  newName: string,
  before: string,
  after: string,
  oldHeader: string,
  newHeader: string,
  options: { context?: number; timeout: number },
): Promise<string | undefined> {
  const patch = overInlineLimit(before, after)
    ? await queuedWorkerPatch({ oldName, newName, before, after, oldHeader, newHeader, options })
    : structuredPatch(oldName, newName, before, after, oldHeader, newHeader, options);
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
): Promise<string | undefined> {
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

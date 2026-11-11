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
import { PARALLEL_CONCURRENCY } from './util.ts';

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
const MAX_PENDING_WORKER_DIFFS = PARALLEL_CONCURRENCY;
let pendingWorkerDiffs = 0;
let warmWorker: Worker | undefined;

function getDiffWorker(): Worker {
  if (warmWorker !== undefined) return warmWorker;
  const worker = new Worker(WORKER_URL);
  worker.unref();
  const clear = (): void => {
    if (warmWorker === worker) warmWorker = undefined;
  };
  worker.once('error', clear);
  worker.once('exit', clear);
  warmWorker = worker;
  return worker;
}

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

/**
 * Runs one structuredPatch in a worker; `undefined` on its deadline, a crash, or the kill timer.
 * `spawn` exists for tests, which pass a worker that never answers.
 */
export function patchInWorker(
  request: DiffWorkerRequest,
  spawn: () => Worker = getDiffWorker,
): Promise<StructuredPatch | undefined> {
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let settled = false;
    const onMessage = (patch: StructuredPatch | null): void => {
      finish(patch ?? undefined, false);
    };
    const onAbortOrCrash = (): void => {
      finish(undefined, true);
    };
    const finish = (patch: StructuredPatch | undefined, destroy: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      if (worker !== undefined) {
        worker.off('message', onMessage);
        worker.off('error', onAbortOrCrash);
        worker.off('exit', onAbortOrCrash);
        worker.unref();
        if (destroy) {
          if (warmWorker === worker) warmWorker = undefined;
          void worker.terminate();
        }
      }
      resolve(patch);
    };
    const kill = setTimeout(() => {
      finish(undefined, true);
    }, request.options.timeout + WORKER_KILL_GRACE_MS);
    try {
      worker = spawn();
      worker.ref();
      worker.on('message', onMessage);
      worker.on('error', onAbortOrCrash);
      worker.on('exit', onAbortOrCrash);
      worker.postMessage(request);
    } catch {
      // A worker that cannot start degrades like one past its deadline.
      finish(undefined, true);
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

export interface GeneratedPatch {
  readonly text: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
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
): Promise<GeneratedPatch | undefined> {
  const patch = overInlineLimit(before, after)
    ? await queuedWorkerPatch({ oldName, newName, before, after, oldHeader, newHeader, options })
    : structuredPatch(oldName, newName, before, after, oldHeader, newHeader, options);
  if (patch === undefined) return undefined;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) linesAdded++;
      else if (line.startsWith('-')) linesRemoved++;
    }
  }
  const shownOld = headerName(oldName);
  const header =
    (oldName === newName ? `Index: ${shownOld}\n` : '') +
    `${'='.repeat(67)}\n--- ${shownOld}\t${oldHeader}\n+++ ${headerName(newName)}\t${newHeader}\n`;
  const text = patch.hunks.length > 0 ? header + formatPatch(patch, OMIT_HEADERS) : header;
  return { text, linesAdded, linesRemoved };
}

export function unifiedPatch(
  label: string,
  original: string,
  modified: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): Promise<GeneratedPatch | undefined> {
  return twoFilesPatch(label, label, original, modified, 'Original', 'Modified', {
    timeout: timeoutMs,
  });
}

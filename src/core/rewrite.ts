import type { Stats } from 'node:fs';

import { withAbort } from './concurrency.ts';
import { buildWrittenFileMeta, type WrittenFileMeta } from './file-uri.ts';
import type { GuardedFileSystem } from './fs.ts';
import { readNamedText, readText, type ScanSkip, skipOf } from './scan.ts';
import { type TextView, viewText } from './text-view.ts';

/**
 * The Rewrite: a call that replaces a text file's content with a transform of
 * its current content (edit, patch, replace_text). A real run reads,
 * transforms and writes under the file's write lock; a dry run reads and
 * reports but takes no lock and writes nothing. A tool supplies only the
 * transform.
 */
export interface RewriteRequest {
  readonly fs: GuardedFileSystem;
  /** Locked and written as given, as each caller does today. */
  readonly path: string;
  readonly dryRun: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly transport?: 'stdio' | 'http' | undefined;
}

/** `write: false` reports without writing (an edit that applied nothing). */
export interface Change<T> {
  /** The new content as view text; `apply` restores the file's BOM and endings. */
  readonly content: string;
  readonly result: T;
  readonly write: boolean;
  /** The decoded current content, when the transform already decoded the bytes. */
  readonly before?: string;
}

type WrittenFileReport = WrittenFileMeta & {
  readonly validPath: string;
  readonly modified: string;
};

export interface Rewritten<T> {
  readonly kind: 'text';
  readonly validPath: string;
  readonly before: string;
  readonly after: string;
  readonly result: T;
  readonly written: boolean;
  readonly modified: string;
  /** Built on demand: replace_text links only its walk-first file. */
  readonly report: () => WrittenFileReport;
}

/** A file the client named (edit, patch): readNamedText's refusals fail the call. */
export function rewriteFile<T>(
  request: RewriteRequest & { readonly tool: string },
  transform: (content: string, view: TextView) => Change<T> | Promise<Change<T>>,
): Promise<Rewritten<T>> {
  return locked(request, async () => {
    const { validPath, content, stats } = await readNamedText(request.fs, request.path, {
      signal: request.signal,
      tool: request.tool,
    });
    const view = viewText(content);
    return apply(request, validPath, view, stats, await transform(view.text, view));
  });
}

/**
 * A walked file (replace_text): a non-text verdict comes back untransformed;
 * a transform that returns undefined writes nothing. The transform gets the
 * bytes and the read's stat, so it can rule a file out before anything is decoded.
 */
export function rewriteEntry<T>(
  request: RewriteRequest,
  transform: (bytes: Buffer, stats: Stats) => Promise<Change<T> | undefined>,
): Promise<Rewritten<T> | ScanSkip | undefined> {
  return locked(request, async () => {
    const verdict = await readText(request.fs, request.path, request.signal);
    if (verdict.kind !== 'text') return skipOf(verdict);
    const change = await transform(verdict.bytes, verdict.stats);
    if (change === undefined) return undefined;
    // A changed file up to the text cap: decode it once, not once per side.
    const before = change.before ?? verdict.bytes.toString('utf8');
    // Task 3 gives this a real view; until then it is the identity.
    const view: TextView = {
      disk: before,
      text: before,
      bom: false,
      crlf: false,
      accept: (t) => t,
      restore: (t) => t,
    };
    return apply(request, request.path, view, verdict.stats, change);
  });
}

/** A dry run never writes, so it takes no lock, but it answers the same refusals as a write. */
async function locked<R>(request: RewriteRequest, body: () => Promise<R>): Promise<R> {
  if (!request.dryRun) return lockedWrite(request, body);
  await withAbort(request.fs.pathGuard.validatePathForWrite(request.path), request.signal);
  return body();
}

/**
 * A cancel or deadline ends the wait for the lock, and the queued body never
 * runs. Once the body holds the lock only it decides: it watches the signal
 * itself, and answering early could report a failure for a write that lands.
 */
function lockedWrite<R>(request: RewriteRequest, body: () => Promise<R>): Promise<R> {
  const { signal } = request;
  let started = false;
  const run = request.fs.lockForWrite(request.path, () => {
    signal?.throwIfAborted();
    started = true;
    return body();
  });
  if (signal === undefined) return run;
  return new Promise<R>((resolve, reject) => {
    const onAbort = (): void => {
      if (!started) reject(signal.reason as Error);
    };
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    void run.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * The modified rule: a run that wrote nothing reports the mtime read with the
 * content; a write reports the post-write stat's mtime, or the write time when
 * that stat fails. The post-write mtime is advisory: under a concurrent writer
 * it may be that writer's, while size and content come from this atomic write.
 */
async function apply<T>(
  request: RewriteRequest,
  validPath: string,
  view: TextView,
  stats: Stats,
  change: Change<T>,
): Promise<Rewritten<T>> {
  const { fs, dryRun, signal, transport } = request;
  const after = view.restore(change.content);
  const written = !dryRun && change.write;
  if (dryRun && change.write) fs.assertNoReadOnlyHardLink(validPath, stats);
  let modified = stats.mtime.toISOString();
  if (written) {
    await fs.writeFile(request.path, after, { signal });
    const writtenAt = new Date();
    modified = modifiedAfterWrite(await statAfterWrite(fs, validPath, signal), writtenAt);
  }
  return {
    kind: 'text',
    validPath,
    before: view.disk,
    after,
    result: change.result,
    written,
    modified,
    report: () => ({
      validPath,
      modified,
      ...buildWrittenFileMeta({
        validPath,
        content: after,
        dryRun,
        lastModified: modified,
        transport,
      }),
    }),
  };
}

/** The modified rule after a real write. */
export function modifiedAfterWrite(stats: Stats | undefined, writtenAt: Date): string {
  return (stats?.mtime ?? writtenAt).toISOString();
}

/** Post-write stat for advisory metadata: undefined when the stat fails
 * (concurrent delete, etc.), so callers fall back to the write time. */
export async function statAfterWrite(
  fs: GuardedFileSystem,
  validPath: string,
  signal?: AbortSignal,
): Promise<Stats | undefined> {
  try {
    // An aborted stat falls back to the write time; the write has landed.
    return (await fs.stat(validPath, { signal })).stats;
  } catch {
    return undefined;
  }
}

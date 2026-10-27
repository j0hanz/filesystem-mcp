import type { Stats } from 'node:fs';

import { buildWrittenFileMeta, type WrittenFileMeta } from './file-uri.ts';
import type { GuardedFileSystem } from './fs.ts';
import { readNamedText, readText } from './scan.ts';

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
  readonly content: string;
  readonly result: T;
  readonly write: boolean;
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

export type Skipped =
  | { readonly kind: 'binary' | 'undecodable' }
  | { readonly kind: 'tooLarge'; readonly size: number };

/** A file the client named (edit, patch): readNamedText's refusals fail the call. */
export function rewriteFile<T>(
  request: RewriteRequest & { readonly tool: string },
  transform: (content: string) => Change<T> | Promise<Change<T>>,
): Promise<Rewritten<T>> {
  return locked(request, async () => {
    const { validPath, content, stats } = await readNamedText(request.fs, request.path, {
      signal: request.signal,
      tool: request.tool,
    });
    return apply(request, validPath, content, stats, await transform(content));
  });
}

/**
 * A walked file (replace_text): a non-text verdict comes back untransformed;
 * a transform that returns undefined writes nothing. The transform gets the
 * bytes, so it can rule a file out before anything is decoded.
 */
export function rewriteEntry<T>(
  request: RewriteRequest,
  transform: (bytes: Buffer) => Promise<Change<T> | undefined>,
): Promise<Rewritten<T> | Skipped | undefined> {
  return locked(request, async () => {
    const verdict = await readText(request.fs, request.path, request.signal);
    if (verdict.kind === 'tooLarge') return verdict;
    if (verdict.kind !== 'text') return { kind: verdict.kind };
    const change = await transform(verdict.bytes);
    if (change === undefined) return undefined;
    const before = verdict.bytes.toString('utf8');
    return apply(request, request.path, before, verdict.stats, change);
  });
}

/** A dry run never writes, so it needs no lock. */
function locked<R>(request: RewriteRequest, body: () => Promise<R>): Promise<R> {
  return request.dryRun ? body() : request.fs.lockForWrite(request.path, body);
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
  before: string,
  stats: Stats,
  change: Change<T>,
): Promise<Rewritten<T>> {
  const { fs, dryRun, signal, transport } = request;
  const written = !dryRun && change.write;
  let modified = stats.mtime.toISOString();
  if (written) {
    await fs.writeFile(request.path, change.content, { signal });
    const writtenAt = new Date();
    modified = modifiedAfterWrite(await statAfterWrite(fs, validPath, signal), writtenAt);
  }
  const after = change.content;
  return {
    kind: 'text',
    validPath,
    before,
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

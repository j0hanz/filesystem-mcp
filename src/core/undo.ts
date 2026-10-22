import { createHash, randomBytes } from 'node:crypto';
import {
  lstat as fsLstat,
  readdir as fsReaddir,
  readFile as fsReadFile,
  readlink as fsReadlink,
  stat as fsStat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ErrorCode, isMissing, isNodeError, type PerPathResult, Problem } from './errors.ts';
import type { GuardedFileSystem } from './fs.ts';
import type { PathGuard } from './path.ts';
import { getMaxUndoBytes, sha256Hex } from './util.ts';

interface FileIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

export type UndoRecord =
  /** Put `bytes` back at `path`. expect = sha256 of the bytes that must be there now, or null = path must be absent. */
  | { op: 'write'; path: string; bytes: Buffer; mode: number; expect: string | null }
  /** Remove a file this call created, if its sha256 still equals `expect`. */
  | { op: 'remove'; path: string; expect: string }
  /** Remove a directory this call created, only if empty. */
  | { op: 'rmdir'; path: string }
  /** Recreate a directory this call deleted, only if `path` is absent. */
  | { op: 'mkdir'; path: string }
  /** Recreate a symlink this call deleted, only if `path` is absent. */
  | { op: 'symlink'; path: string; target: string; type: 'file' | 'junction' }
  /** Move `to` back to `from`, if `to` is still the same object and `from` is absent or is that same object. */
  | { op: 'rename'; from: string; to: string; identity: FileIdentity };

/** One restored path, in the batch tools' per-path result shape. */
export type UndoFileResult = PerPathResult<{ restored: true }>;

export interface UndoEntry {
  id: string;
  tool: string;
  createdAt: number;
  records: UndoRecord[];
}

const MAX_ENTRIES = 64;
const TTL_MS = 30 * 60 * 1000;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Byte weight of an entry: the saved bytes it pins. */
const weigh = (records: readonly UndoRecord[]): number =>
  records.reduce((n, r) => n + (r.op === 'write' ? r.bytes.length : 0), 0);

export class UndoJournal {
  // Insertion order is call order; nothing ever re-inserts, so the last key is the newest call.
  readonly #byId = new Map<string, UndoEntry>();
  readonly maxBytes: number;

  constructor(maxBytes = getMaxUndoBytes()) {
    this.maxBytes = maxBytes;
  }

  get enabled(): boolean {
    return this.maxBytes > 0;
  }

  #pruneExpired(now: number): void {
    for (const [id, entry] of this.#byId) {
      if (now - entry.createdAt >= TTL_MS) this.#byId.delete(id);
    }
  }

  #newId(): string {
    // 4 chars from the 36-char alphabet via randomBytes; regenerate on a live collision.
    const make = () => [...randomBytes(4)].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
    let id = make();
    while (this.#byId.has(id)) id = make();
    return id;
  }

  add(tool: string, records: UndoRecord[]): string {
    const now = Date.now();
    this.#pruneExpired(now);
    const id = this.#newId();
    this.#byId.set(id, { id, tool, createdAt: now, records });
    while (
      this.#byId.size > MAX_ENTRIES ||
      [...this.#byId.values()].reduce((n, e) => n + weigh(e.records), 0) > this.maxBytes
    ) {
      const oldest = this.#byId.keys().next().value;
      if (oldest === undefined) break;
      this.#byId.delete(oldest);
    }
    return id;
  }

  get(id: string): UndoEntry | undefined {
    this.#pruneExpired(Date.now());
    return this.#byId.get(id);
  }

  newest(n: number): UndoEntry[] {
    this.#pruneExpired(Date.now());
    return [...this.#byId.values()].reverse().slice(0, n);
  }

  replaceRecords(id: string, records: UndoRecord[]): void {
    if (records.length === 0) {
      this.#byId.delete(id);
      return;
    }
    const entry = this.#byId.get(id);
    if (entry) entry.records = records;
  }

  list(): UndoEntry[] {
    this.#pruneExpired(Date.now());
    return [...this.#byId.values()].reverse();
  }

  clear(): void {
    this.#byId.clear();
  }
}

export class UndoCapture {
  readonly records: UndoRecord[] = [];
  unavailable: string | undefined;
  #bytes = 0;
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** Reserve n saved bytes; past the budget the capture is abandoned and false comes back. */
  reserve(n: number): boolean {
    if (this.unavailable !== undefined) return false;
    if (this.#bytes + n > this.maxBytes) {
      this.abandon('too large to keep for undo');
      return false;
    }
    this.#bytes += n;
    return true;
  }

  /** The call stays runnable but not undoable; first reason wins, records are dropped. */
  abandon(reason: string): void {
    if (this.unavailable !== undefined) return;
    this.unavailable = reason;
    this.records.length = 0;
    this.#bytes = 0;
  }

  push(...records: UndoRecord[]): void {
    if (this.unavailable !== undefined) return;
    this.records.push(...records);
  }
}

/**
 * The chain of absent directories `validPath` sits on, outermost first —
 * what an undo of this mkdir would have to remove. Abandons `capture` when
 * the chain cannot be determined.
 */
export async function plannedMkdirChain(
  capture: UndoCapture,
  validPath: string,
): Promise<string[]> {
  try {
    const created: string[] = [];
    let probe: string | undefined = validPath;
    for (;;) {
      const parent = dirname(probe);
      if (parent === probe) break;
      const stats = await fsLstat(probe).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
        return undefined;
      });
      if (stats !== undefined) break;
      created.push(probe);
      probe = parent;
    }
    return created.reverse();
  } catch {
    capture.abandon('could not inspect the parent folders');
    return [];
  }
}

/**
 * Post-order snapshot of the tree at `validPath` for undo: children first,
 * so a parent is recreated before its children on restore. Any read failure
 * abandons the whole capture; a sensitive path anywhere in the tree refuses
 * to be captured.
 */
export async function snapshotTree(
  capture: UndoCapture,
  pathGuard: PathGuard,
  validPath: string,
): Promise<UndoRecord[]> {
  if (capture.unavailable !== undefined) return [];
  try {
    const stats = await fsLstat(validPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      return undefined;
    });
    // ENOENT on the root (the `force` case): nothing will be deleted.
    if (stats === undefined) return [];
    if (pathGuard.isSensitive(validPath)) {
      capture.abandon('contains protected files');
      return [];
    }
    if (stats.isFile()) {
      if (!capture.reserve(stats.size)) return [];
      const bytes = await fsReadFile(validPath);
      return [{ op: 'write', path: validPath, bytes, mode: stats.mode & 0o777, expect: null }];
    }
    if (stats.isSymbolicLink()) {
      const target = await fsReadlink(validPath);
      // The follow-stat types the link (junction vs file). A win32 link
      // whose target is gone cannot be typed, so it refuses capture rather
      // than restoring with the wrong reparse flavor.
      const isDir =
        process.platform === 'win32'
          ? await fsStat(validPath)
              .then((s) => s.isDirectory())
              .catch(() => undefined)
          : false;
      if (isDir === undefined) {
        capture.abandon('could not type a link whose target is gone');
        return [];
      }
      return [{ op: 'symlink', path: validPath, target, type: isDir ? 'junction' : 'file' }];
    }
    if (stats.isDirectory()) {
      const children = await fsReaddir(validPath);
      const records: UndoRecord[] = [];
      for (const name of children) {
        records.push(...(await snapshotTree(capture, pathGuard, join(validPath, name))));
      }
      records.push({ op: 'mkdir', path: validPath });
      return records;
    }
    return [];
  } catch {
    capture.abandon('could not read the deleted files');
    return [];
  }
}

export interface RestoreOutcome {
  results: UndoFileResult[];
  remaining: UndoRecord[];
}

/** sha256 of a file's current bytes, streamed so a huge file still hashes. */
async function hashFile(fs: GuardedFileSystem, path: string): Promise<string> {
  await using handle = await fs.open(path);
  const hash = createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Revert one journal entry: its records, in reverse capture order, put back
 * what the call changed. A record whose target no longer matches what the
 * call wrote is skipped, not restored — a skip never fails the call.
 */
export async function restoreEntry(
  entry: UndoEntry,
  fs: GuardedFileSystem,
  opts: { dryRun: boolean; simulated?: Map<string, string | null> | undefined },
): Promise<RestoreOutcome> {
  const { dryRun } = opts;
  // Shared across entries by the caller when the whole run is simulated.
  // Values are null (absent), a 64-char sha256 hex (regular file), or 'dir'/'link'/'moved'.
  const simulated = opts.simulated ?? new Map<string, string | null>();
  const results: UndoFileResult[] = [];
  const remaining: UndoRecord[] = [];
  const SKIP_MSG = 'Not restored: modified since this undo step was recorded';
  const skip = (record: UndoRecord, path: string): void => {
    remaining.push(record);
    results.push({ path, error: Problem.cancelled(SKIP_MSG, { path }) });
  };
  const done = (path: string): void => {
    results.push({ path, value: { restored: true } });
  };
  const fail = (record: UndoRecord, path: string, error: unknown): void => {
    remaining.push(record);
    results.push({ path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path) });
  };
  const absent = async (path: string): Promise<boolean> => {
    const known = simulated.get(path);
    if (known !== undefined) return known === null;
    try {
      await fs.lstat(path);
      return false;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return true;
    }
  };
  const matchesHash = async (path: string, expect: string): Promise<boolean> => {
    const known = simulated.get(path);
    if (known !== undefined) return known === expect;
    const existing = await fs.lstat(path).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      return undefined;
    });
    return (
      existing !== undefined && existing.stats.isFile() && (await hashFile(fs, path)) === expect
    );
  };
  const simulate = (path: string, state: string | null): void => {
    if (dryRun) simulated.set(path, state);
  };

  // Run non-rmdir records in reverse first, then deduplicated rmdirs deepest-first
  // so parallel batch creates/moves empty shared parent folders before removing them.
  const reversed = [...entry.records].reverse();
  const seenRmdir = new Set<string>();
  const rmdirs = reversed
    .filter((r): r is Extract<UndoRecord, { op: 'rmdir' }> => {
      if (r.op !== 'rmdir' || seenRmdir.has(r.path)) return false;
      seenRmdir.add(r.path);
      return true;
    })
    .sort((a, b) => b.path.length - a.path.length);

  for (const record of [...reversed.filter((r) => r.op !== 'rmdir'), ...rmdirs]) {
    try {
      switch (record.op) {
        case 'write': {
          await fs.lockForWrite(record.path, async () => {
            const ok =
              record.expect === null
                ? await absent(record.path)
                : await matchesHash(record.path, record.expect);
            if (ok) {
              if (!dryRun) await fs.writeFile(record.path, record.bytes, { mode: record.mode });
              simulate(record.path, sha256Hex(record.bytes));
              done(record.path);
            } else {
              skip(record, record.path);
            }
          });
          break;
        }
        case 'remove': {
          await fs.lockForWrite(record.path, async () => {
            if (await absent(record.path)) {
              done(record.path);
            } else if (await matchesHash(record.path, record.expect)) {
              if (!dryRun) await fs.rm(record.path);
              simulate(record.path, null);
              done(record.path);
            } else {
              skip(record, record.path);
            }
          });
          break;
        }
        case 'rmdir': {
          if (dryRun) break; // emptiness depends on writes the dry run did not make
          try {
            await fs.rmdir(record.path);
          } catch (error) {
            if (!isMissing(error)) {
              if (!isNodeError(error) || error.code !== 'ENOTEMPTY') throw error;
              skip(record, record.path);
              break;
            }
          }
          done(record.path);
          break;
        }
        case 'mkdir': {
          const known = simulated.get(record.path);
          if (await absent(record.path)) {
            // ponytail: a recreated directory gets the default mode; GuardedFileSystem
            // has no chmod and mkdir's mode is masked by the umask. Files get their
            // exact mode back; directories do not. Upgrade: add a chmod record.
            if (!dryRun) await fs.mkdir(record.path);
            simulate(record.path, 'dir');
            done(record.path);
          } else if (
            known !== undefined
              ? known === 'dir'
              : (await fs.lstat(record.path)).stats.isDirectory()
          ) {
            done(record.path);
          } else {
            skip(record, record.path);
          }
          break;
        }
        case 'symlink': {
          if (await absent(record.path)) {
            if (!dryRun) await fs.symlink(record.target, record.path, record.type);
            simulate(record.path, 'link');
            done(record.path);
          } else {
            skip(record, record.path);
          }
          break;
        }
        case 'rename': {
          const same = (s: { dev: number; ino: number; birthtimeMs: number }): boolean =>
            s.dev === record.identity.dev &&
            s.ino === record.identity.ino &&
            s.birthtimeMs === record.identity.birthtimeMs;
          const toKnown = simulated.get(record.to);
          const toHere =
            toKnown === null
              ? false
              : await fs.lstat(record.to).then(
                  (r) => same(r.stats),
                  (error: unknown) => {
                    if (!isMissing(error)) throw error;
                    return false;
                  },
                );
          const fromKnown = simulated.get(record.from);
          const fromFree =
            fromKnown !== undefined
              ? fromKnown === null
              : await fs.lstat(record.from).then(
                  (r) => same(r.stats),
                  (error: unknown) => {
                    if (!isMissing(error)) throw error;
                    return true;
                  },
                );
          if (toHere && fromFree) {
            if (!dryRun) {
              await fs.mkdir(dirname(record.from), { recursive: true });
              await fs.rename(record.to, record.from);
            }
            simulate(record.to, null);
            simulate(record.from, toKnown ?? 'moved');
            done(record.from);
          } else {
            skip(record, record.from);
          }
          break;
        }
      }
    } catch (error) {
      fail(record, record.op === 'rename' ? record.from : record.path, error);
    }
  }
  return { results, remaining };
}

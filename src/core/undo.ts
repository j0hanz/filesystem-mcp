import { createHash, randomInt } from 'node:crypto';
import {
  lstat as fsLstat,
  readdir as fsReaddir,
  readlink as fsReadlink,
  stat as fsStat,
} from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import {
  ErrorCode,
  FsError,
  isMissing,
  isNodeError,
  type PerPathResult,
  Problem,
} from './errors.ts';
import type { GuardedFileSystem } from './fs.ts';
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
/** In-flight captures allowed at once; past it a mutating call runs, just not undoable. */
const MAX_LIVE_CAPTURES = 8;
/**
 * Flat memory weight charged per record, whatever its op: the record object
 * plus its path strings (a rename carries two). An estimate, not a measure —
 * it exists so a tree of empty entries cannot bypass the byte budget.
 */
const RECORD_OVERHEAD_BYTES = 512;

/** Memory weight of one record: its saved bytes plus object/path overhead. */
const recordWeight = (record: UndoRecord): number =>
  record.op === 'write' ? RECORD_OVERHEAD_BYTES + record.bytes.length : RECORD_OVERHEAD_BYTES;

/** Byte weight of an entry: what its records pin. */
const weigh = (records: readonly UndoRecord[]): number =>
  records.reduce((n, r) => n + recordWeight(r), 0);

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
    // 4 chars from the 36-char alphabet via randomInt; regenerate on a live collision.
    const make = () =>
      Array.from({ length: 4 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');
    let id = make();
    while (this.#byId.has(id)) id = make();
    return id;
  }

  #live = 0;
  /** Bytes held by all in-flight captures together, so concurrent calls share one budget. */
  readonly #pool: LivePool = { bytes: 0 };

  /**
   * Start a capture for a mutating call. Past the live cap the call still
   * runs, its capture is pre-abandoned with the reason, and it takes no slot;
   * pair every `beginCapture` with `endCapture` when the call finishes.
   */
  beginCapture(): UndoCapture {
    const capture = new UndoCapture(this.maxBytes, this.#pool);
    if (this.#live < MAX_LIVE_CAPTURES) {
      this.#live += 1;
      capture.holdsSlot = true;
    } else {
      capture.abandon('too many concurrent calls to keep for undo');
    }
    return capture;
  }

  endCapture(capture: UndoCapture | undefined): void {
    // Its records now live in the journal (or were dropped); either way the
    // live pool no longer owes them.
    capture?.release();
    if (capture?.holdsSlot) {
      capture.holdsSlot = false;
      this.#live -= 1;
    }
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

  /** Re-key every move record that ends at `path`: a restore replaced the file there. */
  reidentify(path: string, identity: FileIdentity): void {
    for (const entry of this.#byId.values()) {
      for (const record of entry.records) {
        if (record.op === 'rename' && record.to === path) record.identity = identity;
      }
    }
  }

  list(): UndoEntry[] {
    this.#pruneExpired(Date.now());
    return [...this.#byId.values()].reverse();
  }

  clear(): void {
    this.#byId.clear();
  }
}

interface LivePool {
  bytes: number;
}

export class UndoCapture {
  readonly records: UndoRecord[] = [];
  unavailable: string | undefined;
  /** True while this capture holds one of the journal's live-capture slots. */
  holdsSlot = false;
  #bytes = 0;
  readonly maxBytes: number;
  readonly #pool: LivePool | undefined;

  constructor(maxBytes: number, pool?: LivePool) {
    this.maxBytes = maxBytes;
    this.#pool = pool;
  }

  /** Bytes charged against the budget: the shared live total when pooled. */
  #used(): number {
    return this.#pool?.bytes ?? this.#bytes;
  }

  #charge(n: number): void {
    this.#bytes += n;
    if (this.#pool) this.#pool.bytes += n;
  }

  /** True once abandoned; a method so callers re-read it after an await. */
  isAbandoned(): boolean {
    return this.unavailable !== undefined;
  }

  /** Return this capture's charge to the shared pool; call when the call ends. */
  release(): void {
    if (this.#pool) this.#pool.bytes -= this.#bytes;
    this.#bytes = 0;
  }

  /**
   * Gate before reading n more saved bytes (plus the record that will hold
   * them); the bytes are charged at `push`.
   */
  reserve(n: number): boolean {
    if (this.unavailable !== undefined) return false;
    if (this.#used() + n + RECORD_OVERHEAD_BYTES > this.maxBytes) {
      this.abandon('too large to keep for undo');
      return false;
    }
    return true;
  }

  /** The call stays runnable but not undoable; first reason wins, records are dropped. */
  abandon(reason: string): void {
    if (this.unavailable !== undefined) return;
    this.unavailable = reason;
    this.records.length = 0;
    this.release();
  }

  push(...records: UndoRecord[]): void {
    if (this.unavailable !== undefined) return;
    for (const record of records) {
      const cost = recordWeight(record);
      if (this.#used() + cost > this.maxBytes) {
        this.abandon('too many changes to keep for undo');
        return;
      }
      this.#charge(cost);
      this.records.push(record);
    }
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
 * Post-order snapshot of the tree at `validPath` for undo, pushed onto
 * `capture` as the walk goes: children first, so a parent is recreated before
 * its children on restore. Charging per entry stops an oversized tree before
 * it is all in memory. Any read failure abandons the whole capture; a
 * sensitive path anywhere in the tree refuses to be captured.
 */
export async function snapshotTree(
  capture: UndoCapture,
  fs: GuardedFileSystem,
  validPath: string,
): Promise<void> {
  if (capture.unavailable !== undefined) return;
  try {
    const stats = await fsLstat(validPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      return undefined;
    });
    // ENOENT on the root (the `force` case): nothing will be deleted.
    if (stats === undefined) return;
    if (fs.pathGuard.isSensitive(validPath)) {
      capture.abandon('contains protected files');
      return;
    }
    if (stats.isFile()) {
      if (!capture.reserve(stats.size)) return;
      const bytes = await fs.readSaved(validPath);
      capture.push({ op: 'write', path: validPath, bytes, mode: stats.mode & 0o777, expect: null });
      return;
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
        return;
      }
      capture.push({ op: 'symlink', path: validPath, target, type: isDir ? 'junction' : 'file' });
      return;
    }
    if (stats.isDirectory()) {
      const children = await fsReaddir(validPath);
      for (const name of children) {
        await snapshotTree(capture, fs, join(validPath, name));
        if (capture.isAbandoned()) return;
      }
      capture.push({ op: 'mkdir', path: validPath });
      return;
    }
    // Anything else (FIFO, socket, device) has no restore record. Journaling
    // the parent without it would report a restore that silently misses the
    // entry, so the whole capture is refused instead.
    capture.abandon('cannot capture a non-regular entry');
  } catch {
    capture.abandon('could not read the deleted files');
  }
}

/**
 * A directory may go back only if every entry keeps its sensitive-file status,
 * as the move tool requires: path rules (`secrets/**`) follow the path, so
 * something created under the moved directory since would leave protection.
 * Fails closed when the tree cannot be fully listed.
 */
async function assertTreeKeepsPolicy(
  fs: GuardedFileSystem,
  from: string,
  to: string,
): Promise<void> {
  const refuse = (cause?: unknown): never => {
    throw new FsError(
      ErrorCode.ACCESS_DENIED,
      'Undo refused: the directory contains entries whose protection would change when moved back',
      to,
      cause,
    );
  };
  try {
    const guard = fs.pathGuard;
    const names = ['', ...(await fsReaddir(from, { recursive: true }))];
    for (const name of names) {
      if (guard.isSensitive(join(from, name)) !== guard.isSensitive(join(to, name))) refuse();
    }
  } catch (error) {
    if (error instanceof FsError) throw error;
    refuse(error);
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
  opts: {
    dryRun: boolean;
    simulated?: Map<string, string | null> | undefined;
    /**
     * A restore wrote a new file at `path`, so it has a new inode; the owner
     * of the journal re-keys any move record that ends there, in this entry
     * or an older one, so that move still finds its file.
     */
    onRewrite?: ((path: string, identity: FileIdentity) => void) | undefined;
  },
): Promise<RestoreOutcome> {
  const { dryRun } = opts;
  // Shared across entries by the caller when the whole run is simulated.
  // Values are null (absent), a 64-char sha256 hex (regular file), or 'dir'/'link'/'moved'.
  const simulated = opts.simulated ?? new Map<string, string | null>();
  // Records that did not run because a directory they sit under was not restored.
  const blocked: string[] = [];
  const isBlocked = (path: string): boolean =>
    blocked.some((dir) => path === dir || path.startsWith(dir + sep));
  const results: UndoFileResult[] = [];
  // Skipped/failed records, each with its capture order, so the retry runs the
  // same reverse pass instead of re-reversing an already-reversed list.
  const remaining: { record: UndoRecord; order: number }[] = [];
  const SKIP_MSG = 'Not restored: modified since this undo step was recorded';
  const skip = (record: UndoRecord, order: number, path: string): void => {
    remaining.push({ record, order });
    results.push({ path, error: Problem.cancelled(SKIP_MSG, { path }) });
  };
  const done = (path: string): void => {
    results.push({ path, value: { restored: true } });
  };
  const fail = (record: UndoRecord, order: number, path: string, error: unknown): void => {
    remaining.push({ record, order });
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
  const indexed = entry.records.map((record, order) => ({ record, order }));
  const reversed = [...indexed].reverse();
  const seenRmdir = new Set<string>();
  const rmdirs = reversed
    .filter((x): x is { record: Extract<UndoRecord, { op: 'rmdir' }>; order: number } => {
      if (x.record.op !== 'rmdir' || seenRmdir.has(x.record.path)) return false;
      seenRmdir.add(x.record.path);
      return true;
    })
    .sort((a, b) => b.record.path.length - a.record.path.length);

  for (const { record, order } of [...reversed.filter((x) => x.record.op !== 'rmdir'), ...rmdirs]) {
    const anchor = record.op === 'rename' ? record.from : record.path;
    if (isBlocked(anchor)) {
      skip(record, order, anchor);
      continue;
    }
    try {
      switch (record.op) {
        case 'write': {
          await fs.lockForWrite(record.path, async () => {
            const ok =
              record.expect === null
                ? await absent(record.path)
                : await matchesHash(record.path, record.expect);
            if (ok) {
              if (!dryRun) {
                await fs.writeFile(record.path, record.bytes, { mode: record.mode });
                const at = await fs.lstat(record.path);
                opts.onRewrite?.(record.path, {
                  dev: at.stats.dev,
                  ino: at.stats.ino,
                  birthtimeMs: at.stats.birthtimeMs,
                });
              }
              simulate(record.path, sha256Hex(record.bytes));
              done(record.path);
            } else {
              skip(record, order, record.path);
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
              skip(record, order, record.path);
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
              skip(record, order, record.path);
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
            blocked.push(record.path);
            skip(record, order, record.path);
          }
          break;
        }
        case 'symlink': {
          if (await absent(record.path)) {
            if (!dryRun) await fs.symlink(record.target, record.path, record.type);
            simulate(record.path, 'link');
            done(record.path);
          } else {
            skip(record, order, record.path);
          }
          break;
        }
        case 'rename': {
          // Both paths locked: without the pair, a concurrent create can land
          // on `from` between the absence check and the rename, and the rename
          // would overwrite it. The pair is taken in a fixed key order (and
          // deduped) so two concurrent pairs cannot deadlock.
          await fs.lockPairForWrite(record.from, record.to, async () => {
            const same = (s: FileIdentity): boolean =>
              s.dev === record.identity.dev &&
              s.ino === record.identity.ino &&
              s.birthtimeMs === record.identity.birthtimeMs;
            const toKnown = simulated.get(record.to);
            let toHere: boolean;
            let toIsRealDir = false;
            // What undoing leaves at `from`, so an older record's check can
            // match it in a later simulated step: a hash, or 'dir'/'link'.
            let toState: string | undefined;
            if (toKnown !== undefined) {
              toHere = toKnown !== null;
              toState = toKnown ?? undefined;
            } else {
              const at = await fs.lstat(record.to).then(
                (r) => r,
                (error: unknown) => {
                  if (!isMissing(error)) throw error;
                  return undefined;
                },
              );
              if (at !== undefined && same(at.stats)) {
                toHere = true;
                toIsRealDir = at.stats.isDirectory();
                if (dryRun) {
                  toState = at.stats.isDirectory()
                    ? 'dir'
                    : at.stats.isSymbolicLink()
                      ? 'link'
                      : await hashFile(fs, record.to);
                }
              } else {
                toHere = false;
              }
            }
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
              if (toIsRealDir) await assertTreeKeepsPolicy(fs, record.to, record.from);
              if (!dryRun) {
                await fs.mkdir(dirname(record.from), { recursive: true });
                await fs.rename(record.to, record.from);
              }
              simulate(record.to, null);
              simulate(record.from, toState ?? 'moved');
              done(record.from);
            } else {
              skip(record, order, record.from);
            }
          });
          break;
        }
      }
    } catch (error) {
      fail(record, order, record.op === 'rename' ? record.from : record.path, error);
    }
  }
  return {
    results,
    remaining: remaining.sort((a, b) => a.order - b.order).map((x) => x.record),
  };
}

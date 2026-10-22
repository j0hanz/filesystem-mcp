import { createHash, randomInt } from 'node:crypto';
import {
  lstat as fsLstat,
  readdir as fsReaddir,
  readlink as fsReadlink,
  stat as fsStat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ErrorCode,
  FsError,
  isMissing,
  isNodeError,
  type PerPathResult,
  Problem,
} from './errors.ts';
import type { GuardedFileSystem } from './fs.ts';
import { IS_WINDOWS, isPathInsideDirectory } from './path-utils.ts';
import { getMaxUndoBytes, sha256Hex } from './util.ts';

export interface FileIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

export type UndoRecord =
  /** Put `bytes` back at `path`. expect = sha256 of the bytes that must be there now, or null = path must be absent. */
  | {
      op: 'write';
      path: string;
      bytes: Buffer;
      mode: number;
      expect: string | null;
      /** The file these bytes came from; a restore gives its replacement to the moves that tracked it. */
      was?: FileIdentity | undefined;
    }
  /** Remove a file this call created, if its sha256 still equals `expect`. */
  | { op: 'remove'; path: string; expect: string }
  /** Remove a directory this call created, only if empty. */
  | { op: 'rmdir'; path: string }
  /** Recreate a directory this call deleted, only if `path` is absent; `mode` is reapplied, narrowed by the umask. */
  | { op: 'mkdir'; path: string; mode?: number | undefined; was?: FileIdentity | undefined }
  /** Recreate a symlink this call deleted, only if `path` is absent. */
  | {
      op: 'symlink';
      path: string;
      target: string;
      type: 'file' | 'junction';
      was?: FileIdentity | undefined;
    }
  /** Move `to` back to `from`, if `to` is still the same object and `from` is absent or is that same object. */
  | { op: 'rename'; from: string; to: string; identity: FileIdentity };

/** The identity a move record is matched on. */
export const identityOf = (s: { dev: number; ino: number; birthtimeMs: number }): FileIdentity => ({
  dev: s.dev,
  ino: s.ino,
  birthtimeMs: s.birthtimeMs,
});

type RenameRecord = Extract<UndoRecord, { op: 'rename' }>;

const identityKey = (i: FileIdentity): string =>
  `${String(i.dev)}:${String(i.ino)}:${String(i.birthtimeMs)}`;

export const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

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
  /** Move records by the identity they track; rebuilt lazily after the journal changes. */
  #renameIndex: Map<string, RenameRecord[]> | undefined;
  readonly maxBytes: number;

  constructor(maxBytes = getMaxUndoBytes()) {
    this.maxBytes = maxBytes;
  }

  get enabled(): boolean {
    return this.maxBytes > 0;
  }

  #pruneExpired(now: number): void {
    for (const [id, entry] of this.#byId) {
      if (now - entry.createdAt >= TTL_MS) {
        this.#byId.delete(id);
        this.#renameIndex = undefined;
      }
    }
  }

  #newId(): string {
    // 4 base-36 chars via randomInt; regenerate on a live collision.
    const make = () =>
      randomInt(36 ** 4)
        .toString(36)
        .padStart(4, '0');
    let id = make();
    while (this.#byId.has(id)) id = make();
    return id;
  }

  /** Bytes held by all in-flight captures together, so concurrent calls share one budget. */
  readonly #pool: LivePool = { bytes: 0 };

  /** Start a capture for a mutating call; `release()` it when the call finishes. */
  beginCapture(): UndoCapture {
    return new UndoCapture(this.maxBytes, this.#pool);
  }

  add(tool: string, records: UndoRecord[]): string {
    const now = Date.now();
    this.#pruneExpired(now);
    const id = this.#newId();
    this.#renameIndex = undefined;
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
    this.#renameIndex = undefined;
    if (records.length === 0) {
      this.#byId.delete(id);
      return;
    }
    const entry = this.#byId.get(id);
    if (entry) entry.records = records;
  }

  /**
   * A restore replaced the file `was` with a new one: every move record that
   * tracked `was` now tracks `identity`. Matched on the object, not its path,
   * so an unrelated file that took the same name is never adopted.
   */
  reidentify(was: FileIdentity, identity: FileIdentity): void {
    if (this.#renameIndex === undefined) {
      this.#renameIndex = new Map();
      for (const entry of this.#byId.values()) {
        for (const record of entry.records) {
          if (record.op === 'rename') this.#track(record);
        }
      }
    }
    const key = identityKey(was);
    const hit = this.#renameIndex.get(key);
    if (hit === undefined) return;
    this.#renameIndex.delete(key);
    for (const record of hit) {
      record.identity = identity;
      this.#track(record);
    }
  }

  #track(record: RenameRecord): void {
    const key = identityKey(record.identity);
    const bucket = this.#renameIndex?.get(key);
    if (bucket) bucket.push(record);
    else this.#renameIndex?.set(key, [record]);
  }

  clear(): void {
    this.#renameIndex = undefined;
    this.#byId.clear();
  }
}

interface LivePool {
  bytes: number;
}

export class UndoCapture {
  readonly records: UndoRecord[] = [];
  unavailable: string | undefined;
  #bytes = 0;
  /** Part of #bytes reserved for reads still in flight; a write record's push draws it down. */
  #reserved = 0;
  readonly maxBytes: number;
  readonly #pool: LivePool;

  constructor(maxBytes: number, pool: LivePool) {
    this.maxBytes = maxBytes;
    this.#pool = pool;
  }

  /** Bytes charged against the budget: the shared live total of every capture. */
  #used(): number {
    return this.#pool.bytes;
  }

  #charge(n: number): void {
    this.#bytes += n;
    this.#pool.bytes += n;
  }

  /** True once abandoned; a method so callers re-read it after an await. */
  isAbandoned(): boolean {
    return this.unavailable !== undefined;
  }

  /** Return this capture's charge to the shared pool; call when the call ends. */
  release(): void {
    this.#pool.bytes -= this.#bytes;
    this.#bytes = 0;
    this.#reserved = 0;
  }

  /**
   * Charge n more saved bytes (plus the record that will hold them) before
   * reading them, so concurrent reads cannot all pass the same gate. The
   * write record's `push` draws the reservation down instead of charging twice.
   */
  reserve(n: number): boolean {
    if (this.unavailable !== undefined) return false;
    const cost = n + RECORD_OVERHEAD_BYTES;
    if (this.#used() + cost > this.maxBytes) {
      this.abandon('too large to keep for undo');
      return false;
    }
    this.#charge(cost);
    this.#reserved += cost;
    return true;
  }

  /** The call stays runnable but not undoable; first reason wins, records are dropped. */
  abandon(reason: string): void {
    if (this.unavailable !== undefined) return;
    this.unavailable = reason;
    this.records.length = 0;
    // Dropped records free their bytes now. Reservations stay charged until
    // release(): a read reserved before the abandon may still be in flight.
    this.#pool.bytes -= this.#bytes - this.#reserved;
    this.#bytes = this.#reserved;
  }

  push(...records: UndoRecord[]): void {
    if (this.unavailable !== undefined) return;
    for (const record of records) {
      const cost = recordWeight(record);
      const drawn = record.op === 'write' ? Math.min(this.#reserved, cost) : 0;
      if (this.#used() + (cost - drawn) > this.maxBytes) {
        this.abandon('too many changes to keep for undo');
        return;
      }
      this.#reserved -= drawn;
      this.#charge(cost - drawn);
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
      capture.push({
        op: 'write',
        path: validPath,
        bytes,
        mode: stats.mode & 0o777,
        expect: null,
        was: identityOf(stats),
      });
      return;
    }
    if (stats.isSymbolicLink()) {
      const target = await fsReadlink(validPath);
      // The follow-stat types the link (junction vs file). A win32 link
      // whose target is gone cannot be typed, so it refuses capture rather
      // than restoring with the wrong reparse flavor.
      const isDir = IS_WINDOWS
        ? await fsStat(validPath)
            .then((s) => s.isDirectory())
            .catch(() => undefined)
        : false;
      if (isDir === undefined) {
        capture.abandon('could not type a link whose target is gone');
        return;
      }
      capture.push({
        op: 'symlink',
        path: validPath,
        target,
        type: isDir ? 'junction' : 'file',
        was: identityOf(stats),
      });
      return;
    }
    if (stats.isDirectory()) {
      const children = await fsReaddir(validPath);
      for (const name of children) {
        await snapshotTree(capture, fs, join(validPath, name));
        if (capture.isAbandoned()) return;
      }
      capture.push({
        op: 'mkdir',
        path: validPath,
        mode: stats.mode & 0o777,
        was: identityOf(stats),
      });
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
  listedAt: string,
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
    const names = ['', ...(await fsReaddir(listedAt, { recursive: true }))];
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
async function hashFile(
  fs: GuardedFileSystem,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  await using handle = await fs.open(path);
  const hash = createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    signal?.throwIfAborted();
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
     * A restore replaced the file `was` with a new inode; the owner of the
     * journal re-keys the move records that tracked `was`, in this entry or an
     * older one, so those moves still find their file.
     */
    onRewrite?: ((was: FileIdentity, identity: FileIdentity) => void) | undefined;
    /** Stops the run between records; the unprocessed ones come back in `remaining`. */
    signal?: AbortSignal | undefined;
    /**
     * Dry run only, shared across entries like `simulated`: directories the
     * simulation moved back, so a later probe of a path inside one reads the
     * folder where it still sits on disk.
     */
    relocations?: [string, string][] | undefined;
    /** Dry-run directories map to their on-disk tree, or null when rebuilt from saved records. */
    directoryBackings?: Map<string, string | null> | undefined;
  },
): Promise<RestoreOutcome> {
  const { dryRun, signal } = opts;
  const relocations = opts.relocations ?? [];
  const directoryBackings = opts.directoryBackings ?? new Map<string, string | null>();
  const disk = (path: string): string => {
    let out = path;
    for (const [from, to] of relocations.toReversed()) {
      // startsWith keeps the slice exact; the helper adds the segment boundary.
      if (out.startsWith(from) && isPathInsideDirectory(from, out)) {
        out = to + out.slice(from.length);
      }
    }
    return out;
  };
  // Shared across entries by the caller when the whole run is simulated.
  // Values are null (absent), a 64-char sha256 hex (regular file), or 'dir'/'link'/'moved'.
  const simulated = opts.simulated ?? new Map<string, string | null>();
  // Records that did not run because a directory they sit under was not restored.
  const blocked: string[] = [];
  const isBlocked = (path: string): boolean =>
    blocked.some((dir) => isPathInsideDirectory(dir, path));
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
      await fs.lstat(disk(path));
      return false;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return true;
    }
  };
  const matchesHash = async (path: string, expect: string): Promise<boolean> => {
    const known = simulated.get(path);
    if (known !== undefined) return known === expect;
    const existing = await fs.lstat(disk(path)).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      return undefined;
    });
    return (
      existing !== undefined &&
      existing.stats.isFile() &&
      (await hashFile(fs, disk(path), signal)) === expect
    );
  };
  const simulate = (
    path: string,
    state: string | null,
    directoryBacking: string | null = null,
  ): void => {
    if (!dryRun) return;
    simulated.set(path, state);
    if (state === 'dir') directoryBackings.set(path, directoryBacking);
    else directoryBackings.delete(path);
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
    if (signal?.aborted) {
      remaining.push({ record, order });
      continue;
    }
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
                if (record.was) opts.onRewrite?.(record.was, identityOf(at.stats));
              }
              simulate(record.path, sha256Hex(record.bytes));
              done(record.path);
            } else if (await matchesHash(record.path, sha256Hex(record.bytes))) {
              done(record.path); // already holds what undo would write
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
            // Owner rwx is forced: the server owns the recreated folder and must
            // write its children back into it.
            // ponytail: mkdir's mode is masked by the umask, so group/other bits can
            // come back narrower (0775 as 0755), never wider; a parent an older
            // move's undo recreated first keeps the default mode. Upgrade: a guarded
            // chmod on GuardedFileSystem for exact bits.
            if (!dryRun) {
              await fs.mkdir(record.path, { mode: (record.mode ?? 0o777) | 0o700 });
              if (record.was) {
                opts.onRewrite?.(record.was, identityOf((await fs.lstat(record.path)).stats));
              }
            }
            simulate(record.path, 'dir');
            done(record.path);
          } else if (
            known !== undefined
              ? known === 'dir'
              : (await fs.lstat(disk(record.path))).stats.isDirectory()
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
            if (!dryRun) {
              await fs.symlink(record.target, record.path, record.type);
              if (record.was) {
                opts.onRewrite?.(record.was, identityOf((await fs.lstat(record.path)).stats));
              }
            }
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
            const toKnown = simulated.get(record.to);
            let toHere: boolean;
            let toIsRealDir = false;
            let toBacking: string | undefined;
            // What undoing leaves at `from`, so an older record's check can
            // match it in a later simulated step: a hash, or 'dir'/'link'.
            let toState: string | undefined;
            if (toKnown !== undefined) {
              toHere = toKnown !== null;
              toState = toKnown ?? undefined;
              if (dryRun && toKnown === 'dir') {
                toBacking = directoryBackings.get(record.to) ?? undefined;
                toIsRealDir = toBacking !== undefined;
              }
            } else {
              const at = await fs.lstat(disk(record.to)).then(
                (r) => r,
                (error: unknown) => {
                  if (!isMissing(error)) throw error;
                  return undefined;
                },
              );
              if (at !== undefined && sameIdentity(at.stats, record.identity)) {
                toHere = true;
                toIsRealDir = at.stats.isDirectory();
                if (toIsRealDir) toBacking = disk(record.to);
                if (dryRun) {
                  toState = at.stats.isDirectory()
                    ? 'dir'
                    : at.stats.isSymbolicLink()
                      ? 'link'
                      : await hashFile(fs, disk(record.to), signal);
                }
              } else {
                toHere = false;
              }
            }
            const fromKnown = simulated.get(record.from);
            const fromFree =
              fromKnown !== undefined
                ? fromKnown === null
                : await fs.lstat(disk(record.from)).then(
                    (r) => sameIdentity(r.stats, record.identity),
                    (error: unknown) => {
                      if (!isMissing(error)) throw error;
                      return true;
                    },
                  );
            if (toHere && fromFree) {
              if (toIsRealDir && toBacking !== undefined) {
                await assertTreeKeepsPolicy(fs, toBacking, record.to, record.from);
              }
              if (!dryRun) {
                await fs.mkdir(dirname(record.from), { recursive: true });
                await fs.rename(record.to, record.from);
                // A move can change a file's creation time (NTFS restores the
                // one an older file had at that name), so carry the identity
                // it now has to the other moves that tracked it.
                const landed = identityOf((await fs.lstat(record.from)).stats);
                if (!sameIdentity(landed, record.identity)) {
                  opts.onRewrite?.(record.identity, landed);
                }
              }
              if (dryRun && toBacking !== undefined) relocations.push([record.from, toBacking]);
              simulate(record.to, null);
              simulate(record.from, toState ?? 'moved', toBacking ?? null);
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

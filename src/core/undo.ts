import { createHash, randomInt } from 'node:crypto';
import type { BigIntStats, Stats } from 'node:fs';
import {
  lstat as fsLstat,
  readdir as fsReaddir,
  readlink as fsReadlink,
  stat as fsStat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runExclusive } from './concurrency.ts';
import {
  ErrorCode,
  FsError,
  isMissing,
  isNodeError,
  type PerPathResult,
  Problem,
  unlessMissing,
} from './errors.ts';
import { joinRoster, pathLabel } from './fmt.ts';
import type { GuardedFileSystem } from './fs.ts';
import {
  IS_CASE_INSENSITIVE_FS,
  IS_WINDOWS,
  isPathInsideDirectory,
  normalizeCaseForComparison,
} from './path-utils.ts';
import { getMaxUndoBytes, sha256Hex } from './util.ts';

/**
 * Exact, from bigint stats: as a number an NTFS file ID loses its low bits,
 * and files created in one clock tick share a birth time, so siblings a batch
 * call made could read as one file.
 */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
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
export const identityOf = (s: BigIntStats): FileIdentity => ({
  dev: s.dev,
  ino: s.ino,
  birthtimeNs: s.birthtimeNs,
});

type RenameRecord = Extract<UndoRecord, { op: 'rename' }>;

const identityKey = (i: FileIdentity): string =>
  `${String(i.dev)}:${String(i.ino)}:${String(i.birthtimeNs)}`;

const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

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
// Copied files are hashed after the copy, a second full read. Past this many
// budgets' worth, undo is not worth that read: 256 MiB at the default 32 MiB.
const COPY_HASH_BUDGETS = 8;

/** Memory weight of one record: its saved bytes plus object/path overhead. */
const recordWeight = (record: UndoRecord): number =>
  record.op === 'write' ? RECORD_OVERHEAD_BYTES + record.bytes.length : RECORD_OVERHEAD_BYTES;

/** Byte weight of an entry: what its records pin. */
const weigh = (records: readonly UndoRecord[]): number =>
  records.reduce((n, r) => n + recordWeight(r), 0);

export class UndoJournal {
  // Insertion order is call order; nothing ever re-inserts, so the last key is the newest call.
  readonly #byId = new Map<string, UndoEntry & { weight: number }>();
  /** Move records by the identity they track; rebuilt lazily after the journal changes. */
  #renameIndex: Map<string, RenameRecord[]> | undefined;
  readonly maxBytes: number;
  #bytes = 0;

  constructor(maxBytes = getMaxUndoBytes()) {
    this.maxBytes = maxBytes;
  }

  get enabled(): boolean {
    return this.maxBytes > 0;
  }

  #deleteEntry(id: string): void {
    const existing = this.#byId.get(id);
    if (!existing) return;
    this.#byId.delete(id);
    this.#bytes -= existing.weight;
    this.#renameIndex = undefined;
  }

  #pruneExpired(now: number): void {
    for (const [id, entry] of this.#byId) {
      if (now - entry.createdAt >= TTL_MS) {
        this.#deleteEntry(id);
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
    const weight = weigh(records);
    this.#renameIndex = undefined;
    this.#byId.set(id, { id, tool, createdAt: now, records, weight });
    this.#bytes += weight;
    while (this.#byId.size > MAX_ENTRIES || this.#bytes > this.maxBytes) {
      const oldest = this.#byId.keys().next().value;
      if (oldest === undefined) break;
      this.#deleteEntry(oldest);
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
      this.#deleteEntry(id);
      return;
    }
    const entry = this.#byId.get(id);
    if (entry) {
      const nextWeight = weigh(records);
      this.#bytes += nextWeight - entry.weight;
      entry.records = records;
      entry.weight = nextWeight;
    }
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
    this.#bytes = 0;
    this.#byId.clear();
  }
}

interface LivePool {
  bytes: number;
}

/** What a mutation holds for its path while `UndoCapture.forMutation` runs it. */
export interface PathCapture {
  /** False only for NOT_RECORDING; stays true after abandon. */
  readonly recording: boolean;
  /** The undo byte budget this capture charges against. */
  readonly maxBytes: number;
  reserve(n: number): boolean;
  abandon(reason: string): void;
  push(...records: UndoRecord[]): void;
  unavailableReason(): string | undefined;
  /** This path has, or may have, changed: hand records and charge to the call, or report why it has none. */
  changed(): void;
}

/** The PathCapture of a call with no Capture: it records nothing. */
export const NOT_RECORDING: PathCapture = {
  recording: false,
  maxBytes: 0,
  reserve: () => false,
  abandon: () => undefined,
  push: () => undefined,
  unavailableReason: () => undefined,
  changed: () => undefined,
};

export class UndoCapture implements PathCapture {
  readonly records: UndoRecord[] = [];
  #unavailable: string | undefined;
  /** Each path that lost its own undo, with why; the rest of the call keeps theirs. */
  readonly #refused = new Map<string, string>();
  /** Set on a `#forPath` capture: where `changed` hands its records. */
  #owner: { parent: UndoCapture; path: string } | undefined;
  #bytes = 0;
  /** Part of #bytes reserved for reads still in flight; a write record's push draws it down. */
  #reserved = 0;
  readonly maxBytes: number;
  readonly #pool: LivePool;
  readonly recording = true;

  constructor(maxBytes: number, pool: LivePool) {
    this.maxBytes = maxBytes;
    this.#pool = pool;
  }

  #charge(n: number): void {
    this.#bytes += n;
    this.#pool.bytes += n;
  }

  /**
   * The abandon reason once this capture is unavailable, or the paths that lost
   * their own undo, else undefined; the undo suffix reports it.
   */
  unavailableReason(): string | undefined {
    if (this.#unavailable !== undefined) return this.#unavailable;
    if (this.#refused.size === 0) return undefined;
    // A bare name that another path in the call shares would not say which file stayed as written.
    const uses = new Map<string, number>();
    const others = this.journalRecords().map((r) => (r.op === 'rename' ? r.to : r.path));
    for (const path of [...this.#refused.keys(), ...others]) {
      uses.set(pathLabel(path), (uses.get(pathLabel(path)) ?? 0) + 1);
    }
    const lines = [...this.#refused].map(([path, reason]) => {
      const label = pathLabel(path);
      return `${uses.get(label) === 1 ? label : path}: ${reason}`;
    });
    return joinRoster(lines, '; ');
  }

  /**
   * What an undo id restores. A refused path stays as it is: no record may change
   * it, as when a call reaches one file through a link, or remove a folder it sits in.
   */
  journalRecords(): UndoRecord[] {
    if (this.#refused.size === 0) return this.records;
    const paths = [...this.#refused.keys()];
    const refused = new Set(paths.map(normalizeCaseForComparison));
    return this.records.filter((record) => {
      if (record.op === 'rmdir') {
        return !paths.some((path) => isPathInsideDirectory(record.path, path));
      }
      return !refused.has(
        normalizeCaseForComparison(record.op === 'rename' ? record.to : record.path),
      );
    });
  }

  /**
   * A capture for one path of a parallel batch, so abandoning it costs only that
   * path's undo. `forMutation` settles it.
   */
  #forPath(path: string): UndoCapture {
    const own = new UndoCapture(this.maxBytes, this.#pool);
    own.#unavailable = this.#unavailable;
    own.#owner = { parent: this, path };
    return own;
  }

  /**
   * Run one path's mutation under its own capture, so abandoning it costs only
   * that path's undo. The mutation calls `changed()` at its point of no return.
   */
  async forMutation<T>(path: string, run: (own: PathCapture) => Promise<T>): Promise<T> {
    const own = this.#forPath(path);
    try {
      return await run(own);
    } finally {
      // After changed() this does nothing. Any other exit changed nothing, so nothing is reported.
      own.release();
    }
  }

  changed(): void {
    if (this.#owner === undefined) return;
    const { parent, path } = this.#owner;
    // Once only: a second hand-over would run the records twice on restore.
    this.#owner = undefined;
    if (this.#unavailable !== undefined || parent.#unavailable !== undefined) {
      if (parent.#unavailable === undefined) {
        parent.#refused.set(path, String(this.#unavailable));
      }
      this.release();
      return;
    }
    // One at a time: a large tree overflows the call stack if spread into `push`.
    for (const record of this.records) parent.records.push(record);
    parent.#bytes += this.#bytes;
    parent.#reserved += this.#reserved;
    this.#bytes = 0;
    this.#reserved = 0;
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
   * record's `push` draws the reservation down instead of charging twice.
   */
  reserve(n: number): boolean {
    if (this.#unavailable !== undefined) return false;
    const cost = n + RECORD_OVERHEAD_BYTES;
    // The budget is shared: every live capture's charge counts.
    if (this.#pool.bytes + cost > this.maxBytes) {
      this.abandon('too large to keep for undo');
      return false;
    }
    this.#charge(cost);
    this.#reserved += cost;
    return true;
  }

  /** The call stays runnable but not undoable; first reason wins, records are dropped. */
  abandon(reason: string): void {
    if (this.#unavailable !== undefined) return;
    this.#unavailable = reason;
    this.records.length = 0;
    // Dropped records free their bytes now. Reservations stay charged until
    // release(): a read reserved before the abandon may still be in flight.
    this.#pool.bytes -= this.#bytes - this.#reserved;
    this.#bytes = this.#reserved;
  }

  push(...records: UndoRecord[]): void {
    if (this.#unavailable !== undefined) return;
    for (const record of records) {
      const cost = recordWeight(record);
      const drawn = Math.min(this.#reserved, cost);
      if (this.#pool.bytes + (cost - drawn) > this.maxBytes) {
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
  capture: PathCapture,
  validPath: string,
): Promise<string[]> {
  try {
    const created: string[] = [];
    let probe: string | undefined = validPath;
    for (;;) {
      const parent = dirname(probe);
      if (parent === probe) break;
      if ((await unlessMissing(fsLstat(probe))) !== undefined) break;
      created.push(probe);
      probe = parent;
    }
    return created.reverse();
  } catch {
    capture.abandon('could not inspect the parent folders');
    return [];
  }
}

/** A regular file's bytes, mode and identity before a call replaces it: a write record's fields. */
export interface SavedFile {
  bytes: Buffer;
  mode: number;
  was: FileIdentity;
}

/** Read `path`'s current bytes for undo; `undefined` once they would go over the budget. */
export async function saveOld(
  capture: PathCapture,
  fs: GuardedFileSystem,
  path: string,
  stats: Stats | BigIntStats,
): Promise<SavedFile | undefined> {
  if (!capture.reserve(Number(stats.size))) return undefined;
  const exact =
    typeof stats.ino === 'bigint' ? (stats as BigIntStats) : await fsLstat(path, { bigint: true });
  return {
    bytes: await fs.readSaved(path),
    mode: Number(stats.mode) & 0o777,
    was: identityOf(exact),
  };
}

/**
 * Post-order snapshot of the tree at `validPath` for undo, pushed onto
 * `capture` as the walk goes: children first, so a parent is recreated before
 * its children on restore. Charging per entry stops an oversized tree before
 * it is all in memory. Any read failure abandons the whole capture; a
 * sensitive path anywhere in the tree refuses to be captured.
 */
export async function snapshotTree(
  capture: PathCapture,
  fs: GuardedFileSystem,
  validPath: string,
  /** A cancel ends the walk, so it cannot overflow the budget; the caller drops what it pushed. */
  signal?: AbortSignal,
): Promise<void> {
  if (capture.unavailableReason() !== undefined || signal?.aborted) return;
  try {
    const stats = await unlessMissing(fsLstat(validPath, { bigint: true }));
    // ENOENT on the root (the `force` case): nothing will be deleted.
    if (stats === undefined) return;
    if (fs.pathGuard.isSensitive(validPath)) {
      capture.abandon('contains protected files');
      return;
    }
    if (stats.isFile()) {
      const saved = await saveOld(capture, fs, validPath, stats);
      if (saved) capture.push({ op: 'write', path: validPath, ...saved, expect: null });
      return;
    }
    if (stats.isSymbolicLink()) {
      if (await fs.pathGuard.reachesRemoteLink(validPath)) {
        capture.abandon('a link to a network path');
        return;
      }
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
        capture.abandon('could not tell the type of a link whose target is gone');
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
        await snapshotTree(capture, fs, join(validPath, name), signal);
        if (capture.unavailableReason() !== undefined || signal?.aborted) return;
      }
      capture.push({
        op: 'mkdir',
        path: validPath,
        mode: Number(stats.mode) & 0o777,
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

/** One destination entry a copy creates or replaces, as it stood before the copy. */
export type CopyTarget =
  | { kind: 'new-file'; path: string }
  | { kind: 'new-dir'; path: string }
  | { kind: 'replaced-file'; path: string; saved: SavedFile };

/**
 * Pre-order walk of the copy source against the destination, before the copy:
 * what each destination entry was, with the bytes of every file the copy will
 * replace. Abandons `capture` (and returns []) on anything it cannot restore.
 */
export async function planCopyUndo(
  capture: PathCapture,
  fs: GuardedFileSystem,
  validSource: string,
  validDest: string,
): Promise<CopyTarget[]> {
  const targets: CopyTarget[] = [];
  let hashBytes = 0;
  const walk = async (source: string, dest: string, destAbsent: boolean): Promise<void> => {
    if (fs.pathGuard.isSensitive(dest)) {
      capture.abandon('contains protected files');
      return;
    }
    const src = await fsLstat(source, { bigint: true });
    const existing = destAbsent ? undefined : await unlessMissing(fsLstat(dest, { bigint: true }));
    if (src.isSymbolicLink()) {
      // shortcut: no record removes a link a call created; add one if clients copy trees with links
      capture.abandon('copied links are not undoable');
    } else if (src.isFile()) {
      // Every copied file is re-read to hash it; stop before the copy, not after.
      hashBytes += Number(src.size);
      if (hashBytes > capture.maxBytes * COPY_HASH_BUDGETS) {
        capture.abandon('too large to keep for undo');
        return;
      }
      if (existing === undefined) {
        // Charged now, so a huge new tree stops here instead of after the copy.
        if (!capture.reserve(0)) return;
        targets.push({ kind: 'new-file', path: dest });
      } else if (existing.isFile() && existing.nlink > 1n) {
        // The copy renames over one name; its twins keep the old inode, which
        // the restore would hand to the moves that tracked it.
        capture.abandon('cannot capture a copy over a hard-linked file');
      } else if (existing.isFile()) {
        const saved = await saveOld(capture, fs, dest, existing);
        if (saved) targets.push({ kind: 'replaced-file', path: dest, saved });
      } else {
        capture.abandon('a copy would replace a different kind of entry');
      }
    } else if (src.isDirectory()) {
      if (existing !== undefined && !existing.isDirectory()) {
        capture.abandon('a copy would replace a different kind of entry');
        return;
      }
      if (existing === undefined) {
        // The copy keeps the source's mode; without owner write, undo could not empty it.
        if ((Number(src.mode) & 0o200) === 0) {
          capture.abandon('cannot capture a copy of a read-only folder');
          return;
        }
        if (!capture.reserve(0)) return;
        targets.push({ kind: 'new-dir', path: dest });
      }
      for (const name of await fsReaddir(source)) {
        await walk(join(source, name), join(dest, name), existing === undefined);
        if (capture.unavailableReason() !== undefined) return;
      }
    } else {
      capture.abandon('cannot capture a non-regular entry');
    }
  };
  try {
    await walk(validSource, validDest, false);
  } catch {
    capture.abandon('could not read the copy destination');
  }
  return capture.unavailableReason() === undefined ? targets : [];
}

/** After the copy: push the records that undo `targets`, each file hashed as it landed. */
export async function recordCopyUndo(
  capture: PathCapture,
  fs: GuardedFileSystem,
  targets: readonly CopyTarget[],
): Promise<void> {
  try {
    for (const target of targets) {
      // Once undo gave up, hashing the rest would only re-read files for nothing.
      if (capture.unavailableReason() !== undefined) return;
      if (target.kind === 'new-dir') {
        capture.push({ op: 'rmdir', path: target.path });
      } else {
        const expect = await hashFile(fs, target.path);
        capture.push(
          target.kind === 'new-file'
            ? { op: 'remove', path: target.path, expect }
            : { op: 'write', path: target.path, ...target.saved, expect },
        );
      }
    }
  } catch {
    capture.abandon('could not read the copied files');
  }
}

/**
 * A directory may go back only if every entry keeps its sensitive-file status,
 * as the move tool requires (`PathGuard.relocationKeepsProtection`): something
 * created under the moved directory since could leave or enter protection.
 * Fails closed when the tree cannot be fully listed.
 */
async function assertTreeKeepsPolicy(
  fs: GuardedFileSystem,
  listNames: () => Promise<string[]>,
  from: string,
  to: string,
): Promise<void> {
  let keeps = false;
  let cause: unknown;
  try {
    keeps = await fs.pathGuard.relocationKeepsProtection(await listNames(), { from }, to);
  } catch (error) {
    if (error instanceof FsError) throw error;
    cause = error;
  }
  if (!keeps) {
    throw new FsError(
      ErrorCode.ACCESS_DENIED,
      'Undo refused: moving the directory back would change the protection of entries in it',
      to,
      cause,
    );
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
 * The records a restore runs, each with its capture order: non-rmdir records
 * in reverse first, then deduplicated rmdirs deepest-first, so parallel batch
 * creates/moves empty shared parent folders before removing them.
 */
export function restoreOrder(
  records: readonly UndoRecord[],
): { record: UndoRecord; order: number }[] {
  const reversed = records.map((record, order) => ({ record, order })).reverse();
  const seenRmdir = new Set<string>();
  const rmdirs = reversed
    .filter((x): x is { record: Extract<UndoRecord, { op: 'rmdir' }>; order: number } => {
      if (x.record.op !== 'rmdir' || seenRmdir.has(x.record.path)) return false;
      seenRmdir.add(x.record.path);
      return true;
    })
    .sort((a, b) => b.record.path.length - a.record.path.length);
  return [...reversed.filter((x) => x.record.op !== 'rmdir'), ...rmdirs];
}

/** What sits at a path, as a restore sees it: never following a final link. */
interface Entry {
  kind: 'file' | 'dir' | 'link' | 'other';
  identity: FileIdentity;
}

/**
 * Where a restore reads and changes the tree. The real run uses the disk; a
 * dry run uses an `UndoPreview`, so both run the same checks in the same order.
 * The preview differs where the disk changes under it, or where the OS refuses
 * what the preview allows (a symlink without the privilege to make one).
 */
interface RestoreWorld {
  probe(path: string): Promise<Entry | undefined>;
  /** The identity of the entry at `path`; fails when there is none. */
  identity(path: string): Promise<FileIdentity>;
  hash(path: string): Promise<string>;
  writeFile(path: string, bytes: Buffer, mode: number): Promise<void>;
  rm(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
  mkdirp(path: string): Promise<void>;
  symlink(target: string, path: string, type: 'file' | 'junction'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Names under the directory at `path`, relative to it, with '' for the directory itself. */
  treeNames(path: string): Promise<string[]>;
  lock<T>(path: string, fn: () => Promise<T>): Promise<T>;
  lockPair<T>(a: string, b: string, fn: () => Promise<T>): Promise<T>;
  /** The identity a move record's `identity` names now, after earlier re-keys. */
  tracked(identity: FileIdentity): FileIdentity;
  /** A restore replaced the entry `was` with `now`; see `onRewrite`. */
  rewrite(was: FileIdentity, now: FileIdentity): void;
}

const kindOf = (stats: Stats | BigIntStats): Entry['kind'] =>
  stats.isFile() ? 'file' : stats.isDirectory() ? 'dir' : stats.isSymbolicLink() ? 'link' : 'other';

function diskWorld(
  fs: GuardedFileSystem,
  signal: AbortSignal | undefined,
  onRewrite: ((was: FileIdentity, identity: FileIdentity) => void) | undefined,
): RestoreWorld {
  return {
    probe: async (path) => {
      const at = await unlessMissing(fs.lstatExact(path));
      return at && { kind: kindOf(at.stats), identity: identityOf(at.stats) };
    },
    identity: async (path) => identityOf((await fs.lstatExact(path)).stats),
    hash: (path) => hashFile(fs, path, signal),
    writeFile: async (path, bytes, mode) => {
      await fs.writeFile(path, bytes, { mode });
    },
    rm: (path) => fs.rm(path),
    rmdir: (path) => fs.rmdir(path),
    mkdir: (path, mode) => fs.mkdir(path, { mode }),
    mkdirp: (path) => fs.mkdir(path, { recursive: true }),
    symlink: (target, path, type) => fs.symlink(target, path, type),
    // No cross-device copy: it would give every descendant a new identity,
    // and the records that track them would read as modified since.
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath, { crossDevice: false }),
    treeNames: async (path) => ['', ...(await fsReaddir(path, { recursive: true }))],
    lock: (path, fn) => fs.lockForWrite(path, fn),
    lockPair: (a, b, fn) => fs.lockPairForWrite(a, b, fn),
    tracked: (identity) => identity,
    rewrite: (was, now) => {
      onRewrite?.(was, now);
    },
  };
}

type PreviewNode =
  | { kind: 'absent' }
  /** `disk` holds the bytes for an entry the preview has not rewritten; `hash` the bytes it wrote. */
  | { kind: 'file'; identity: FileIdentity; disk?: string; hash?: string }
  /** `backing` is the folder on disk whose children show through, or null for a rebuilt one. */
  | { kind: 'dir'; identity: FileIdentity; backing: string | null }
  /** `disk` is the link on disk, which the OS follows to reach entries under it. */
  | { kind: 'link'; identity: FileIdentity; disk?: string }
  | { kind: 'other'; identity: FileIdentity };

const ABSENT: PreviewNode = { kind: 'absent' };

/**
 * A path's key in the preview, folded where the filesystem folds case. ASCII
 * folds both ways; another character folds only when its lowercase maps back
 * to it, since NTFS keeps pairs such as the Kelvin sign and `k`, or `İ` and
 * `i̇`, apart.
 */
function previewKey(path: string): string {
  if (!IS_CASE_INSENSITIVE_FS) return path;
  // eslint-disable-next-line no-control-regex -- the ASCII range, control characters included
  if (/^[\u0000-\u007f]*$/u.test(path)) return path.toLowerCase();
  return Array.from(path, (ch) => {
    const lower = ch.toLowerCase();
    return lower.toUpperCase() === ch ? lower : ch;
  }).join('');
}

const UV_MESSAGES: Record<string, string> = {
  EEXIST: 'file already exists',
  EISDIR: 'illegal operation on a directory',
  ENOENT: 'no such file or directory',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
};

/** The error the OS would raise, in the shape Node gives it. */
const errnoError = (code: string, syscall: string, path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${UV_MESSAGES[code] ?? code}, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });

/**
 * A dry run's view of the tree: what the restored entries would leave,
 * layered over the disk, which it never changes. Shared across the entries of
 * one undo call, so an older step's preview sees what reverting the newer ones
 * would do. Identities the preview mints follow the journal's re-keying, so a
 * move is previewed against the same identity check the real run makes.
 */
export class UndoPreview {
  readonly #fs: GuardedFileSystem;
  readonly #signal: AbortSignal | undefined;
  readonly #nodes = new Map<string, PreviewNode>();
  /**
   * Keys by their parent's key, so a subtree is found without a scan. Every
   * ancestor of an override is linked, whether or not it has a node itself.
   */
  readonly #children = new Map<string, Set<string>>();
  /** Emulates `UndoJournal.reidentify`: an identity's key to its replacement. */
  readonly #alias = new Map<string, FileIdentity>();
  /**
   * An inode's link count as the preview's own unlinks leave it: seeded once
   * from disk, never re-seeded (a dry run never unlinks for real, so a later
   * lstat would undo counts the preview already spent). Never delete entries.
   */
  readonly #links = new Map<string, bigint>();
  /**
   * sha256 an in-place preview write left on that inode: live writes through
   * one name of a multiply-linked file change what every name sees.
   */
  readonly #inPlace = new Map<string, string>();
  #minted = 0;

  constructor(fs: GuardedFileSystem, signal?: AbortSignal) {
    this.#fs = fs;
    this.#signal = signal;
  }

  /** The world `restoreEntry` runs against in a dry run. */
  world(): RestoreWorld {
    return {
      probe: async (path) => {
        const node = await this.#node(path);
        return node.kind === 'absent' ? undefined : { kind: node.kind, identity: node.identity };
      },
      identity: async (path) => {
        const node = await this.#node(path);
        if (node.kind === 'absent') throw errnoError('ENOENT', 'lstat', path);
        return node.identity;
      },
      hash: async (path) => {
        const node = await this.#node(path);
        if (node.kind !== 'file') throw errnoError('EISDIR', 'open', path);
        return (
          node.hash ??
          this.#inPlace.get(identityKey(node.identity)) ??
          (await hashFile(this.#fs, node.disk ?? path, this.#signal))
        );
      },
      writeFile: async (path, bytes) => {
        await this.#parentDir(path, 'open');
        const node = await this.#node(path);
        const hash = sha256Hex(bytes);
        if (node.kind === 'file' && this.#linkCount(node.identity) > 1n) {
          // Live writeFile keeps a multiply-linked inode in place, so every
          // name sees the new bytes and the identity survives to later records.
          // The refusal live writeFile makes must fire before any preview state
          // changes, so a failed dry run leaves the preview untouched.
          this.#fs.assertNoReadOnlyHardLink(path, {
            nlink: Number(this.#linkCount(node.identity)),
          });
          this.#inPlace.set(identityKey(node.identity), hash);
          this.#put(previewKey(path), { kind: 'file', identity: node.identity });
          return;
        }
        this.#put(previewKey(path), { kind: 'file', identity: this.#mint(), hash });
      },
      rm: async (path) => {
        const node = await this.#node(path);
        if (node.kind === 'file') this.#unlink(node.identity);
        this.#put(previewKey(path), ABSENT);
      },
      rmdir: async (path) => {
        const node = await this.#node(path);
        if (node.kind === 'absent') throw errnoError('ENOENT', 'rmdir', path);
        if (node.kind !== 'dir') throw errnoError('ENOTDIR', 'rmdir', path);
        if (!(await this.#isEmpty(path, node))) throw errnoError('ENOTEMPTY', 'rmdir', path);
        this.#replace(previewKey(path), ABSENT);
      },
      mkdir: async (path) => {
        await this.#parentDir(path, 'mkdir');
        this.#put(previewKey(path), { kind: 'dir', identity: this.#mint(), backing: null });
      },
      mkdirp: async (path) => {
        const missing: string[] = [];
        for (let at = path; dirname(at) !== at; at = dirname(at)) {
          const node = await this.#node(at, true);
          if (node.kind === 'absent') {
            missing.push(at);
            continue;
          }
          // Node's recursive mkdir: EEXIST on the target itself, ENOTDIR above it.
          if (!(await this.#isDirLike(node))) {
            throw errnoError(at === path ? 'EEXIST' : 'ENOTDIR', 'mkdir', path);
          }
          break;
        }
        for (const at of missing.reverse()) {
          this.#put(previewKey(at), { kind: 'dir', identity: this.#mint(), backing: null });
        }
      },
      symlink: async (_target, path) => {
        await this.#parentDir(path, 'symlink');
        this.#put(previewKey(path), { kind: 'link', identity: this.#mint() });
      },
      rename: async (oldPath, newPath) => {
        const node = await this.#node(oldPath);
        if (node.kind === 'absent') throw errnoError('ENOENT', 'rename', oldPath);
        const oldKey = previewKey(oldPath);
        const newKey = previewKey(newPath);
        if (oldKey === newKey) {
          this.#put(newKey, node); // a case-only rename keeps the entry
          return;
        }
        const moved = this.#descendants(oldKey).map((key) => [key, this.#nodes.get(key)] as const);
        this.#replace(newKey, node);
        for (const [key, child] of moved) {
          this.#drop(key);
          if (child !== undefined) this.#put(newKey + key.slice(oldKey.length), child);
        }
        this.#put(oldKey, ABSENT);
      },
      treeNames: async (path) => {
        const node = await this.#node(path);
        const names = [''];
        if (node.kind === 'dir') await this.#listTree(path, node.backing, '', names);
        return names;
      },
      lock: (path, fn) => this.#locked([path], fn),
      lockPair: (a, b, fn) => this.#locked([a, b], fn),
      tracked: (identity) => {
        let current = identity;
        for (;;) {
          const next = this.#alias.get(identityKey(current));
          if (next === undefined) return current;
          current = next;
        }
      },
      rewrite: (was, now) => {
        // Only records that track `was` now are re-keyed: once `was` was
        // replaced, nothing tracks it.
        const key = identityKey(was);
        if (!this.#alias.has(key) && key !== identityKey(now)) this.#alias.set(key, now);
      },
    };
  }

  #mint(): FileIdentity {
    this.#minted += 1;
    return { dev: -1n, ino: BigInt(this.#minted), birthtimeNs: 0n };
  }

  /** A minted file is its inode's only name; every disk-resolved file is seeded. */
  #linkCount(identity: FileIdentity): bigint {
    return this.#links.get(identityKey(identity)) ?? 1n;
  }

  /** A name left its inode: live unlink drops its link count. */
  #unlink(identity: FileIdentity): void {
    this.#links.set(identityKey(identity), (this.#links.get(identityKey(identity)) ?? 1n) - 1n);
  }

  /**
   * The writers' locks, so a preview never reads a write half done, keyed and
   * validated as `lockForWrite`/`lockPairForWrite` do (the pair's second path
   * as the entry itself). Validation reads the disk, so it decides only for a
   * path the preview has not changed; one it has changed gets the checks that
   * read no disk, and is locked under its own spelling.
   */
  async #locked<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
    const guard = this.#fs.pathGuard;
    const keys = await Promise.all(
      paths.map((path, i) =>
        (i === 0 ? guard.validatePathForWrite(path) : guard.entryLockKey(path)).catch(
          (error: unknown) => {
            if (!this.#touched(path)) throw error;
            this.#assertAllowed(path);
            return path;
          },
        ),
      ),
    );
    // Sorted and deduped, as lockPairForWrite takes them: no deadlock, no re-entry.
    const ordered = [...new Set(keys)].sort();
    const run = (i: number): Promise<T> => {
      const key = ordered[i];
      return key === undefined ? fn() : runExclusive(key, () => run(i + 1));
    };
    return run(0);
  }

  /** True when the preview overrides `path` or a folder above it. */
  #touched(path: string): boolean {
    for (let at = path; ; at = dirname(at)) {
      if (this.#nodes.has(previewKey(at))) return true;
      if (dirname(at) === at) return false;
    }
  }

  #assertAllowed(path: string): void {
    const guard = this.#fs.pathGuard;
    if (guard.allowedRootContaining(path) === undefined || guard.isSensitive(path)) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Outside allowed directories.', path);
    }
  }

  #put(key: string, node: PreviewNode): void {
    this.#nodes.set(key, node);
    for (let child = key, parent = dirname(key); parent !== child;) {
      const siblings = this.#children.get(parent);
      if (siblings?.has(child)) break; // the rest of the chain is linked already
      if (siblings) siblings.add(child);
      else this.#children.set(parent, new Set([child]));
      child = parent;
      parent = dirname(parent);
    }
  }

  /** Remove `key`'s node, and its link once nothing under it needs one. */
  #drop(key: string): void {
    this.#nodes.delete(key);
    for (let child = key, parent = dirname(key); parent !== child;) {
      if (this.#nodes.has(child) || this.#children.has(child)) break;
      const siblings = this.#children.get(parent);
      siblings?.delete(child);
      if (siblings?.size !== 0) break;
      this.#children.delete(parent);
      child = parent;
      parent = dirname(parent);
    }
  }

  /** Keys under `key`, with or without a node, parents before children. */
  #descendants(key: string): string[] {
    const out: string[] = [];
    const queue = [key];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      for (const child of this.#children.get(next) ?? []) {
        out.push(child);
        queue.push(child);
      }
    }
    return out;
  }

  /** Set `key`, dropping overrides left under an entry that no longer has those children. */
  #replace(key: string, node: PreviewNode): void {
    for (const other of this.#descendants(key)) this.#drop(other);
    this.#put(key, node);
  }

  async #isDirLike(node: PreviewNode): Promise<boolean> {
    if (node.kind === 'dir') return true;
    if (node.kind !== 'link' || node.disk === undefined) return false;
    return fsStat(node.disk).then(
      (s) => s.isDirectory(),
      () => false,
    );
  }

  async #parentDir(path: string, syscall: string): Promise<void> {
    const parent = await this.#node(dirname(path), true);
    if (await this.#isDirLike(parent)) return;
    // Windows reports a file in the way as a missing path.
    const code = parent.kind === 'absent' || IS_WINDOWS ? 'ENOENT' : 'ENOTDIR';
    throw errnoError(code, syscall, path);
  }

  /**
   * The node at `path`: its own override, else what the nearest overridden
   * folder (or link) shows, else the disk. `structural` probes skip path
   * validation, as the real run's folder creation does: a parent may be a
   * workspace root.
   */
  async #node(path: string, structural = false): Promise<PreviewNode> {
    const own = this.#nodes.get(previewKey(path));
    if (own !== undefined) return own;
    for (let child = path, parent = dirname(path); parent !== child;) {
      const above = this.#nodes.get(previewKey(parent));
      if (above !== undefined) {
        const through =
          above.kind === 'dir' ? above.backing : above.kind === 'link' ? above.disk : undefined;
        if (through === undefined || through === null) return ABSENT;
        return (await this.#fromDisk(through + path.slice(parent.length), structural)).node;
      }
      child = parent;
      parent = dirname(parent);
    }
    const { node, validPath } = await this.#fromDisk(path, structural);
    // Validation found the entry under another Unicode spelling; an override
    // the preview made at that spelling stands for it.
    return (validPath === path ? undefined : this.#nodes.get(previewKey(validPath))) ?? node;
  }

  async #fromDisk(
    path: string,
    structural: boolean,
  ): Promise<{ node: PreviewNode; validPath: string }> {
    const at = structural
      ? await unlessMissing(fsLstat(path, { bigint: true })).then(
          (stats) => stats && { stats, validPath: path },
        )
      : await unlessMissing(this.#fs.lstatExact(path));
    if (at === undefined) return { node: ABSENT, validPath: path };
    const { stats, validPath } = at;
    const identity = identityOf(stats);
    const kind = kindOf(stats);
    // First sight wins: the dry run's disk is frozen, so a later read of the
    // same inode would re-report the pre-run count the preview already spent.
    if (kind === 'file' && !this.#links.has(identityKey(identity))) {
      this.#links.set(identityKey(identity), stats.nlink);
    }
    const node: PreviewNode =
      kind === 'file'
        ? { kind, identity, disk: validPath }
        : kind === 'dir'
          ? { kind, identity, backing: validPath }
          : kind === 'link'
            ? { kind, identity, disk: validPath }
            : { kind, identity };
    return { node, validPath };
  }

  /** The tree under `path` as the preview shows it: the backing folder's entries, minus or plus overrides. */
  async #listTree(path: string, backing: string | null, rel: string, out: string[]): Promise<void> {
    const key = previewKey(path);
    const listed = new Set<string>();
    const visit = async (
      name: string,
      child: PreviewNode | undefined,
      diskDir: string | undefined,
    ) => {
      const childRel = rel === '' ? name : join(rel, name);
      out.push(childRel);
      if (child?.kind === 'dir')
        await this.#listTree(join(path, name), child.backing, childRel, out);
      else if (child === undefined && diskDir !== undefined) {
        await this.#listTree(join(path, name), diskDir, childRel, out);
      }
    };
    if (backing !== null) {
      for (const entry of await fsReaddir(backing, { withFileTypes: true })) {
        const childKey = previewKey(join(path, entry.name));
        listed.add(childKey);
        const child = this.#nodes.get(childKey);
        if (child?.kind === 'absent') continue;
        await visit(entry.name, child, entry.isDirectory() ? join(backing, entry.name) : undefined);
      }
    }
    for (const childKey of this.#children.get(key) ?? []) {
      const child = this.#nodes.get(childKey);
      if (listed.has(childKey) || child === undefined || child.kind === 'absent') continue;
      await visit(childKey.slice(key.length + 1), child, undefined);
    }
  }

  async #isEmpty(path: string, node: Extract<PreviewNode, { kind: 'dir' }>): Promise<boolean> {
    const key = previewKey(path);
    // A child linked without a node of its own is on disk, if anywhere: the listing below sees it.
    for (const child of this.#children.get(key) ?? []) {
      const over = this.#nodes.get(child);
      if (over !== undefined && over.kind !== 'absent') return false;
    }
    if (node.backing === null) return true;
    for (const name of await fsReaddir(node.backing)) {
      if (this.#nodes.get(previewKey(join(path, name)))?.kind !== 'absent') return false;
    }
    return true;
  }
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
    /** The dry run's view, shared across the entries of one undo; one is made when absent. */
    preview?: UndoPreview | undefined;
    /**
     * A restore replaced the file `was` with a new inode; the owner of the
     * journal re-keys the move records that tracked `was`, in this entry or an
     * older one, so those moves still find their file.
     */
    onRewrite?: ((was: FileIdentity, identity: FileIdentity) => void) | undefined;
    /** Stops the run between records; the unprocessed ones come back in `remaining`. */
    signal?: AbortSignal | undefined;
    /** Called as each record starts, so a long restore can report progress. */
    onRecord?: (() => void) | undefined;
  },
): Promise<RestoreOutcome> {
  const { signal } = opts;
  const world = opts.dryRun
    ? (opts.preview ?? new UndoPreview(fs, signal)).world()
    : diskWorld(fs, signal, opts.onRewrite);
  // Records that did not run because a directory they sit under was not restored.
  const blocked: string[] = [];
  const isBlocked = (path: string): boolean =>
    blocked.some((dir) => isPathInsideDirectory(dir, path));
  const results: UndoFileResult[] = [];
  // Skipped/failed records, each with its capture order, so the retry runs the
  // same reverse pass instead of re-reversing an already-reversed list.
  const remaining: { record: UndoRecord; order: number }[] = [];
  const SKIP = {
    blocked: 'Not restored: its parent folder could not be restored',
    created: 'Not restored: something was created at this path since this undo step was recorded',
    content: 'Not restored: its content was modified since this undo step was recorded',
    deleted: 'Not restored: it was deleted since this undo step was recorded',
    replaced: 'Not restored: a folder or link replaced it since this undo step was recorded',
    linkInFolder: 'Not restored: a link now sits where the folder was',
    notEmpty: 'Not restored: the folder is no longer empty',
    folderTaken: "Not restored: a file or link now occupies the folder's path",
    linkTaken: "Not restored: something now occupies the link's path",
  } as const;
  const skip = (record: UndoRecord, order: number, path: string, message: string): void => {
    remaining.push({ record, order });
    results.push({ path, error: Problem.cancelled(message, { path }) });
  };
  const done = (path: string): void => {
    results.push({ path, value: { restored: true } });
  };
  const fail = (record: UndoRecord, order: number, path: string, error: unknown): void => {
    remaining.push({ record, order });
    results.push({ path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path) });
  };
  const matchesHash = async (path: string, expect: string): Promise<boolean> =>
    (await world.probe(path))?.kind === 'file' && (await world.hash(path)) === expect;
  /** Why a file whose hash no longer matches was left alone. */
  const changedReason = async (path: string): Promise<string> => {
    const at = await world.probe(path);
    if (at === undefined) return SKIP.deleted;
    return at.kind === 'file' ? SKIP.content : SKIP.replaced;
  };

  for (const { record, order } of restoreOrder(entry.records)) {
    const anchor = record.op === 'rename' ? record.from : record.path;
    if (signal?.aborted) {
      remaining.push({ record, order });
      continue;
    }
    opts.onRecord?.();
    if (isBlocked(anchor)) {
      skip(record, order, anchor, SKIP.blocked);
      continue;
    }
    try {
      switch (record.op) {
        case 'write': {
          await world.lock(record.path, async () => {
            const ok =
              record.expect === null
                ? (await world.probe(record.path)) === undefined
                : await matchesHash(record.path, record.expect);
            if (ok) {
              // An append keeps its inode, so its `was` may already be re-keyed by a
              // newer restore; the moves now track the file this write replaces.
              const replaced =
                record.expect === null ? undefined : await world.identity(record.path);
              await world.writeFile(record.path, record.bytes, record.mode);
              const at = await world.identity(record.path);
              if (record.was) world.rewrite(record.was, at);
              if (replaced) world.rewrite(replaced, at);
              done(record.path);
            } else if (await matchesHash(record.path, sha256Hex(record.bytes))) {
              done(record.path); // already holds what undo would write
            } else {
              skip(
                record,
                order,
                record.path,
                record.expect === null ? SKIP.created : await changedReason(record.path),
              );
            }
          });
          break;
        }
        case 'remove': {
          await world.lock(record.path, async () => {
            if ((await world.probe(record.path)) === undefined) {
              done(record.path);
            } else if (await matchesHash(record.path, record.expect)) {
              await world.rm(record.path);
              done(record.path);
            } else {
              skip(record, order, record.path, await changedReason(record.path));
            }
          });
          break;
        }
        case 'rmdir': {
          // A link that took the folder's place is not the folder this call made.
          if ((await world.probe(record.path))?.kind === 'link') {
            skip(record, order, record.path, SKIP.linkInFolder);
            break;
          }
          try {
            await world.rmdir(record.path);
          } catch (error) {
            if (!isMissing(error)) {
              if (!isNodeError(error) || error.code !== 'ENOTEMPTY') throw error;
              skip(record, order, record.path, SKIP.notEmpty);
              break;
            }
          }
          done(record.path);
          break;
        }
        case 'mkdir': {
          const at = await world.probe(record.path);
          if (at === undefined) {
            // Owner rwx is forced: the server owns the recreated folder and must
            // write its children back into it.
            // ponytail: mkdir's mode is masked by the umask, so group/other bits can
            // come back narrower (0775 as 0755), never wider; a parent an older
            // move's undo recreated first keeps the default mode. Upgrade: a guarded
            // chmod on GuardedFileSystem for exact bits.
            await world.mkdir(record.path, (record.mode ?? 0o777) | 0o700);
            if (record.was) world.rewrite(record.was, await world.identity(record.path));
            done(record.path);
          } else if (at.kind === 'dir') {
            done(record.path);
          } else {
            blocked.push(record.path);
            skip(record, order, record.path, SKIP.folderTaken);
          }
          break;
        }
        case 'symlink': {
          if ((await world.probe(record.path)) === undefined) {
            await world.symlink(record.target, record.path, record.type);
            if (record.was) world.rewrite(record.was, await world.identity(record.path));
            done(record.path);
          } else {
            skip(record, order, record.path, SKIP.linkTaken);
          }
          break;
        }
        case 'rename': {
          // Both paths locked: without the pair, a concurrent create can land
          // on `from` between the absence check and the rename, and the rename
          // would overwrite it. The pair is taken in a fixed key order (and
          // deduped) so two concurrent pairs cannot deadlock.
          await world.lockPair(record.from, record.to, async () => {
            const tracked = world.tracked(record.identity);
            const to = await world.probe(record.to);
            const from = await world.probe(record.from);
            const toHere = to !== undefined && sameIdentity(to.identity, tracked);
            const fromFree = from === undefined || sameIdentity(from.identity, tracked);
            if (toHere && fromFree) {
              if (to.kind === 'dir') {
                await assertTreeKeepsPolicy(
                  fs,
                  () => world.treeNames(record.to),
                  record.to,
                  record.from,
                );
              }
              await world.mkdirp(dirname(record.from));
              await world.rename(record.to, record.from);
              // A move can change a file's creation time (NTFS restores the
              // one an older file had at that name), so carry the identity
              // it now has to the other moves that tracked it.
              const landed = await world.identity(record.from);
              if (!sameIdentity(landed, tracked)) world.rewrite(tracked, landed);
              done(record.from);
            } else {
              // Either end can be what changed, and this names only the old path.
              skip(
                record,
                order,
                record.from,
                'Not restored: the moved entry, its old path or a parent folder changed since this undo step was recorded',
              );
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

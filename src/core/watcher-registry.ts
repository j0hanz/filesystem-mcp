import type { FSWatcher } from 'node:fs';
import { watch as fsWatch, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { parseEnvInt } from './config.ts';
import { formatUnknownErrorMessage } from './errors.ts';
import { extractPath } from './file-uri.ts';
import { Logger, sanitizeLogField } from './observability.ts';
import { isSamePath } from './path-utils.ts';
import type { PathGuard } from './path.ts';

// Cap concurrent file watchers to avoid exhausting OS-level watch handles
// (e.g. Linux inotify, default ~8192/user). One real path == one watcher.
export const MAX_WATCHERS = parseEnvInt('FS_MAX_WATCHERS', 256, 1, 4096);

/** A client-supplied URI, safe for one log line. */
const shownUri = (uri: string): string => sanitizeLogField(uri, 256);

function warnWatcherCap(uri: string): void {
  Logger.warn(
    `Cannot subscribe to ${shownUri(uri)}: MAX_WATCHERS limit (${MAX_WATCHERS}) reached.`,
  );
}

/**
 * `ok` means a watcher is live for this uri and `notify` is registered. Every
 * other outcome names why, and only `invalid-path` carries what
 * `validateExistingPath` threw — so `error` is unreachable on a branch that has
 * none. `cancelled` means the lease was disposed (or the registry destroyed)
 * before acquisition settled.
 */
export type WatcherAttachResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'capped' | 'bad-uri' | 'attach-failed' }
  | { ok: false; reason: 'invalid-path'; error: unknown };

/**
 * One caller's hold on a watcher, returned by `acquire` before acquisition
 * settles. `ready` reports the outcome; `dispose` cancels a pending lease
 * (`ready` resolves `cancelled` at once) or releases a settled one. Disposal is
 * exactly-once: repeated calls change nothing.
 */
export interface WatcherLease {
  readonly ready: Promise<WatcherAttachResult>;
  dispose(): void;
}

/** The `fs.watch` surface the registry uses; injectable so tests can fire events and errors. */
export type WatchFn = (
  path: string,
  options: { recursive?: boolean },
  listener: (event: string, filename: string | null) => void,
) => FSWatcher;

// The default reads the `fsWatch` binding per call, not once at creation, so a
// test that mocks `fs.watch` and re-syncs the ESM exports still takes effect.
const defaultWatch: WatchFn = (path, options, listener) => fsWatch(path, options, listener);

/** One OS watcher, shared by every URI that resolves to `path` (`%61.txt` and `a.txt`, drive-letter case). */
interface WatchEntry {
  path: string;
  watcher: FSWatcher;
  uris: Set<string>;
}

/** The registry's record of one lease. Only a `settled` lease hears notifications. */
interface LeaseRecord {
  readonly uri: string;
  readonly notify: (uri: string) => void;
  state: 'pending' | 'settled' | 'disposed';
  readonly resolve: (result: WatcherAttachResult) => void;
}

const OK: WatcherAttachResult = { ok: true };
const CANCELLED: WatcherAttachResult = { ok: false, reason: 'cancelled' };

/**
 * Owns the uri → FSWatcher map and every Watcher lease on it (ADR-022):
 * acquisition, cancellation, callback fan-out, and the watcher cap. Callers
 * hold a `WatcherLease` and dispose it; they never release by URI. The
 * individual primitives stay closure-private.
 */
export function createWatcherRegistry({ watch = defaultWatch }: { watch?: WatchFn } = {}) {
  // Keyed by URI; aliases of one real path point at the same entry. `byPath`
  // owns the OS watcher, and its size is the cap count.
  const watchers = new Map<string, WatchEntry>();
  const byPath = new Map<string, WatchEntry>();
  // Every pending or settled lease, per URI. A URI's watcher lives while one of
  // its settled leases does. Callback identity and lease lifetime are separate:
  // the HTTP leg uses one stable bus-publishing callback for every listen
  // stream, while each stream still owns its own lease. A lease whose watcher
  // errored stays settled until disposed — no watcher slot, just bookkeeping.
  const leases = new Map<string, Set<LeaseRecord>>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  // The guard each live watcher was acquired with, to re-check its root at fan-out.
  const guards = new Map<string, PathGuard>();
  let destroyed = false;

  /** The callbacks of a URI's settled leases, de-duplicated by function identity. */
  const liveCallbacks = (uri: string): Set<(uri: string) => void> => {
    const callbacks = new Set<(uri: string) => void>();
    for (const record of leases.get(uri) ?? []) {
      if (record.state === 'settled') callbacks.add(record.notify);
    }
    return callbacks;
  };

  const forget = (record: LeaseRecord): void => {
    const set = leases.get(record.uri);
    set?.delete(record);
    if (set?.size === 0) leases.delete(record.uri);
  };

  // Tears down the watcher itself, NOT the leases. The 'error' event calls this
  // with leases still outstanding; they end only when their holders dispose
  // them. The OS watcher closes only when the last URI aliasing its path leaves.
  const dropWatcher = (uri: string, entry: WatchEntry): void => {
    const current = watchers.get(uri);
    if (current !== entry) return;
    const timer = debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(uri);
    }
    entry.uris.delete(uri);
    watchers.delete(uri);
    guards.delete(uri);
    if (entry.uris.size === 0) {
      if (byPath.get(entry.path) === entry) byPath.delete(entry.path);
      try {
        entry.watcher.close();
      } catch (err) {
        Logger.error(
          `Failed to close watcher for ${shownUri(uri)}: ${sanitizeLogField(formatUnknownErrorMessage(err), 256)}`,
        );
      }
    }
  };

  /** Ends one lease. A pending lease resolves `cancelled`; the URI's last settled lease drops its watcher. */
  const disposeRecord = (record: LeaseRecord): void => {
    if (record.state === 'disposed') return;
    const wasSettled = record.state === 'settled';
    record.state = 'disposed';
    forget(record);
    if (!wasSettled) {
      record.resolve(CANCELLED);
      return;
    }
    const { uri } = record;
    if (liveCallbacks(uri).size > 0) return;
    const entry = watchers.get(uri);
    if (entry) dropWatcher(uri, entry);
  };

  const settle = (record: LeaseRecord, result: WatcherAttachResult): void => {
    if (record.state !== 'pending') return;
    if (result.ok) {
      record.state = 'settled';
    } else {
      record.state = 'disposed';
      forget(record);
    }
    record.resolve(result);
  };

  const notifyAll = (uri: string): void => {
    if (liveCallbacks(uri).size === 0) return;
    const existing = debounceTimers.get(uri);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(uri);
      // A root revoked since subscribe (ADR-018) gets no more change notices on
      // either subscription path. The watcher stays, so notices resume if the
      // root is granted again: a modern listen stream has no way to re-attach.
      // shortcut: a revoked root's watcher holds its slot until the last lease is disposed; hook PathGuard root changes if idle revoked watchers ever hit the cap.
      const path = extractPath(uri);
      const guard = guards.get(uri);
      const entry = watchers.get(uri);
      // A symlink spelled inside a live root can resolve into a revoked one, so
      // the resolved path is checked too.
      if (
        path !== undefined &&
        guard &&
        !(guard.isInsideAllowed(path) && (!entry || guard.isInsideAllowed(entry.path)))
      ) {
        return;
      }
      // One debounce timer per URI — fan out to every subscriber inside it, so
      // a burst of changes still fires one notification round per URI, not per
      // subscriber.
      for (const cb of liveCallbacks(uri)) {
        try {
          cb(uri);
        } catch (err) {
          Logger.warn(
            `Notify callback error for ${shownUri(uri)}: ${formatUnknownErrorMessage(err)}`,
          );
        }
      }
    }, 50);
    timer.unref();
    debounceTimers.set(uri, timer);
  };

  // The primitives below are hoisted out of the returned literal so `acquire`
  // can sequence them from inside the closure. They are closure-private.

  const hasWatcher = (uri: string): boolean => watchers.has(uri);

  const isAtCap = (): boolean => byPath.size >= MAX_WATCHERS;

  const attach = (uri: string, resolvedPath: string, pathGuard: PathGuard): boolean => {
    // Another URI already watches this real path: join its entry, no new OS watcher.
    const shared = byPath.get(resolvedPath);
    if (shared) {
      shared.uris.add(uri);
      watchers.set(uri, shared);
      guards.set(uri, pathGuard);
      return true;
    }
    try {
      // Directories: one recursive watch on macOS and Windows, where the
      // kernel provides it. Not on Linux: Node's recursive watch there walks
      // the whole tree synchronously and arms one inotify watch per directory,
      // so one subscription to a large root would block the event loop and
      // could use up the user's inotify watches. A Linux directory watch
      // reports its direct children only.
      //
      // Files: watch the PARENT directory and filter by name. A watch on
      // the file itself binds to its inode on Linux/macOS, and every atomic
      // write here renames a new inode over the path (fs.ts), after which
      // the old watch never fires again (Node docs, fs.watch "Inodes").
      // Windows' libuv already watches the parent; this makes the other two
      // match. `filename` can be null on some platforms/events; then notify
      // anyway — a spurious debounced notification beats a missed one.
      //
      // `fs.watch` async errors arrive via the 'error' event below, not as a
      // sync throw; the outer catch handles sync throws (inotify
      // exhaustion, path-race).
      const isDirectory = statSync(resolvedPath).isDirectory();
      // Each alias gets its own debounced notification carrying its own URI.
      const notifyEntry = (): void => {
        for (const u of entry.uris) notifyAll(u);
      };
      const watcher = isDirectory
        ? watch(resolvedPath, { recursive: process.platform !== 'linux' }, notifyEntry)
        : watch(dirname(resolvedPath), {}, (_event, filename) => {
            if (filename === null || isSamePath(filename, basename(resolvedPath))) notifyEntry();
          });
      const entry: WatchEntry = { path: resolvedPath, watcher, uris: new Set([uri]) };
      watcher.on('error', (err: Error) => {
        // The path, not `uri`: the URI that created the entry may have left while aliases remain.
        Logger.warn(
          `Watcher error for ${sanitizeLogField(entry.path, 256)}: ${sanitizeLogField(err.message, 256)}`,
        );
        // The client re-reads and learns the file is gone or changed; a later
        // `resources/subscribe` re-acquires because `hasWatcher` is now false.
        // Every alias is dropped first, then each hears its own URI.
        const pending = [...entry.uris].map((u) => [u, [...liveCallbacks(u)]] as const);
        for (const [u] of pending) dropWatcher(u, entry);
        for (const [u, callbacks] of pending) {
          for (const cb of callbacks) {
            try {
              cb(u);
            } catch (cbErr) {
              Logger.warn(
                `Notify callback error for ${shownUri(u)}: ${formatUnknownErrorMessage(cbErr)}`,
              );
            }
          }
        }
      });
      watchers.set(uri, entry);
      byPath.set(resolvedPath, entry);
      guards.set(uri, pathGuard);
      return true;
    } catch (err) {
      Logger.error(
        `Failed to create watcher for ${shownUri(uri)}: ${sanitizeLogField(formatUnknownErrorMessage(err), 256)}`,
      );
      return false;
    }
  };

  /**
   * The attach ladder. Every outcome goes through `settle`, synchronously after
   * the last await, so a lease disposed meanwhile never attaches a watcher.
   */
  const start = async (record: LeaseRecord, pathGuard: PathGuard): Promise<void> => {
    const { uri } = record;
    // A watcher already tracks this uri: no validation or cap work is needed.
    if (hasWatcher(uri)) {
      settle(record, OK);
      return;
    }
    // At cap only an alias of an already-watched path can succeed, and that
    // needs the resolved path, so the cap is checked after validation. A URI
    // that cannot resolve at cap still reports 'capped', as before.
    const capped = (): WatcherAttachResult => {
      warnWatcherCap(uri);
      return { ok: false, reason: 'capped' };
    };

    const filePath = extractPath(uri);
    if (!filePath) {
      settle(record, isAtCap() ? capped() : { ok: false, reason: 'bad-uri' });
      return;
    }

    let resolved: string;
    try {
      resolved = await pathGuard.validateExistingPath(filePath);
    } catch (error: unknown) {
      if (record.state !== 'pending') return;
      settle(record, isAtCap() ? capped() : { ok: false, reason: 'invalid-path', error });
      return;
    }

    // The lease was disposed (or the registry destroyed) mid-await: `ready`
    // already resolved `cancelled`.
    if (record.state !== 'pending') return;
    if (hasWatcher(uri)) {
      settle(record, OK);
      return;
    }
    if (!byPath.has(resolved) && isAtCap()) {
      settle(record, capped());
      return;
    }
    // fs.watch can throw (inotify exhaustion, or a race deleted the path).
    settle(record, attach(uri, resolved, pathGuard) ? OK : { ok: false, reason: 'attach-failed' });
  };

  return {
    hasWatcher,

    /** Live watcher count, for pre-checking a batched listen against remaining capacity. */
    size: (): number => byPath.size,

    /**
     * The one attach ladder every watcher entry point runs: `resources/subscribe`
     * (2025 era) and the `subscriptions/listen` filter (modern era, HTTP and
     * stdio). Returns the lease at once; `ready` never rejects — it reports the
     * outcome and lets each caller decide what that is worth: subscribe owes its
     * caller a precise error, and listen (`prepareListenWatchers`) treats the
     * batch as all-or-nothing. Every acquisition is an independent lease, even
     * for one URI; URIs that resolve to one real path share one watcher.
     */
    acquire(pathGuard: PathGuard, uri: string, notify: (uri: string) => void): WatcherLease {
      const { promise, resolve } = Promise.withResolvers<WatcherAttachResult>();
      const record: LeaseRecord = { uri, notify, state: 'pending', resolve };
      const lease: WatcherLease = {
        ready: promise,
        dispose: () => {
          disposeRecord(record);
        },
      };
      if (destroyed) {
        record.state = 'disposed';
        resolve(CANCELLED);
        return lease;
      }
      let set = leases.get(uri);
      if (!set) {
        set = new Set();
        leases.set(uri, set);
      }
      set.add(record);
      void start(record, pathGuard);
      return lease;
    },

    destroy(): void {
      destroyed = true;
      // Every lease ends first; the guarded loop below closes the watchers.
      for (const set of leases.values()) {
        for (const record of set) {
          const wasPending = record.state === 'pending';
          record.state = 'disposed';
          if (wasPending) record.resolve(CANCELLED);
        }
      }
      leases.clear();
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      for (const { watcher } of byPath.values()) {
        try {
          watcher.close();
        } catch {
          /* ignore close errors so all watchers are attempted */
        }
      }
      byPath.clear();
      watchers.clear();
      guards.clear();
    },
  };
}

export type WatcherRegistry = ReturnType<typeof createWatcherRegistry>;

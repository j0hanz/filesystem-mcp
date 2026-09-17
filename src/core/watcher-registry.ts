import type { FSWatcher } from 'node:fs';
import { statSync, watch } from 'node:fs';

import { formatUnknownErrorMessage } from './errors.ts';
import { extractPath } from './file-uri.ts';
import { Logger } from './observability.ts';
import type { PathGuard } from './path.ts';
import { parseEnvInt } from './util.ts';

// Cap concurrent file watchers to avoid exhausting OS-level watch handles
// (e.g. Linux inotify, default ~8192/user). One subscription == one watcher.
export const MAX_WATCHERS = parseEnvInt('FS_MAX_WATCHERS', 256, 1, 4096);

function warnWatcherCap(uri: string): void {
  Logger.warn(`Cannot subscribe to ${uri}: MAX_WATCHERS limit (${MAX_WATCHERS}) reached.`);
}

/**
 * `ok` means a watcher is live for this uri and `notify` is registered. Every
 * other outcome names why, and only `invalid-path` carries what
 * `validateExistingPath` threw — so `error` is unreachable on a branch that has
 * none.
 */
export type WatcherAttachResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'capped' | 'bad-uri' | 'attach-failed' }
  | { ok: false; reason: 'invalid-path'; error: unknown };

/**
 * Owns the uri → FSWatcher map and the subscription bookkeeping around it:
 * notify callbacks, desired subscribe/unsubscribe state, and the watcher cap —
 * plus `acquire`, the one ladder that sequences them correctly. `acquire` awaits
 * path validation midway and re-checks `isStale` and `hasWatcher` itself
 * afterwards, so callers do not: they take a lease and release it. The
 * individual primitives stay closure-private.
 */
export function createWatcherRegistry() {
  const watchers = new Map<string, FSWatcher>();
  // A URI may have several notification sinks and several independent leases.
  // Callback identity and lifetime are intentionally separate: the HTTP leg
  // uses one stable bus-publishing callback for every listen stream, while each
  // stream still owns one lease that must be released on close.
  // ponytail: no per-subscription id in the SDK unsubscribe contract, so we
  // ref-count by URI. A departed direct-notification callback can linger until
  // the final lease ends; sends to a closed transport already fail harmlessly.
  // The count outlives the watcher (see `dropWatcher`), so a URI whose watcher
  // errored keeps one map entry per still-unreleased lease until they drain —
  // no watcher slot, just bookkeeping. Per-subscription-id keying retires both
  // this and the unsubscribe-by-URI over-release if that churn is observed.
  const activeCallbacks = new Map<string, Set<(uri: string) => void>>();
  const subscriberCounts = new Map<string, number>();
  const desiredState = new Map<string, 'unsubscribed' | 'subscribing'>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  let destroyed = false;

  // 'unsubscribed' exists only to abort a subscribe that is mid-await
  // (isStale). If no subscribe is in flight, keep no entry at all: a lingering
  // 'unsubscribed' would permanently block the modern attach path (which never
  // calls startSubscribe) and leak one map entry per URI ever watched. This
  // must be idempotent: remove()'s teardown branch calls this directly and
  // then unconditionally calls dropWatcher (which also calls this) for the
  // same uri — the second call must not clobber what the first one set.
  const settleDesiredState = (uri: string): void => {
    const current = desiredState.get(uri);
    if (current === 'subscribing') {
      desiredState.set(uri, 'unsubscribed');
    } else if (current !== 'unsubscribed') {
      desiredState.delete(uri);
    }
  };

  // Tears down the watcher itself, NOT the ref-count. The 'error' event calls
  // this with leases still outstanding: clearing the count there would let the
  // next release from one of those leases decrement from zero and drop a
  // watcher a later subscriber re-established for the same URI. `drop` below is
  // the only path that ends leases, and it is the only one that clears them.
  const dropWatcher = (uri: string, watcher: FSWatcher): void => {
    const current = watchers.get(uri);
    if (current !== watcher) return;
    const timer = debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(uri);
    }
    watcher.close();
    watchers.delete(uri);
    activeCallbacks.delete(uri);
    settleDesiredState(uri);
  };

  /** The last lease ended: drop the watcher and every trace of the URI. */
  const drop = (uri: string): void => {
    const timer = debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(uri);
    }
    const watcher = watchers.get(uri);
    if (watcher) dropWatcher(uri, watcher);
    activeCallbacks.delete(uri);
    subscriberCounts.delete(uri);
    settleDesiredState(uri);
  };

  const notifyAll = (uri: string): void => {
    const callbacks = activeCallbacks.get(uri);
    if (!callbacks || callbacks.size === 0) return;
    const existing = debounceTimers.get(uri);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(uri);
      const cbs = activeCallbacks.get(uri);
      if (!cbs) return;
      // One debounce timer per URI — fan out to every subscriber inside it, so
      // a burst of changes still fires one notification round per URI, not per
      // subscriber.
      for (const cb of cbs) {
        try {
          cb(uri);
        } catch (err) {
          Logger.warn(`Notify callback error for ${uri}: ${formatUnknownErrorMessage(err)}`);
        }
      }
    }, 50);
    timer.unref();
    debounceTimers.set(uri, timer);
  };

  // The primitives below are hoisted out of the returned literal so `acquire`
  // can sequence them from inside the closure. They are closure-private.

  const hasWatcher = (uri: string): boolean => watchers.has(uri);

  const isAtCap = (): boolean => watchers.size >= MAX_WATCHERS;

  /** The registry was destroyed, or this uri was unsubscribed, mid-await. */
  const isStale = (uri: string): boolean => destroyed || desiredState.get(uri) === 'unsubscribed';

  const startSubscribe = (uri: string): void => {
    desiredState.set(uri, 'subscribing');
  };

  /**
   * A subscribe that declared intent and then failed — bad URI, unvalidatable
   * path, cap, fs.watch refusal — drops the entry entirely. Not
   * `settleDesiredState`: that maps 'subscribing' onto 'unsubscribed' to abort
   * an attach still mid-await, and a *finished* failure leaving 'unsubscribed'
   * behind would make `isStale` true forever, so the modern attach path (which
   * never calls `startSubscribe`) could never watch this uri again. Only
   * clears its own 'subscribing' — a concurrent unsubscribe that already set
   * 'unsubscribed' still wins.
   */
  const cancelSubscribe = (uri: string): void => {
    if (desiredState.get(uri) === 'subscribing') desiredState.delete(uri);
  };

  const addCallback = (uri: string, notify: (uri: string) => void): void => {
    let callbacks = activeCallbacks.get(uri);
    if (!callbacks) {
      callbacks = new Set();
      activeCallbacks.set(uri, callbacks);
    }
    callbacks.add(notify);
    // A live subscription needs no marker: every reader treats "no entry" the
    // way it treated 'subscribed'. Clearing here is what retires the
    // 'subscribing' marker `startSubscribe` set, so teardown deletes the entry
    // instead of mapping it onto a 'unsubscribed' that would block a later attach.
    desiredState.delete(uri);
  };

  const retain = (uri: string): void => {
    subscriberCounts.set(uri, (subscriberCounts.get(uri) ?? 0) + 1);
  };

  /**
   * Ref-count by URI: only tear down the shared watcher when the last lease
   * ends. Callback identity is independent from this count. A release with no
   * lease outstanding (a rolled-back attach) drops the watcher outright.
   */
  const release = (uri: string): void => {
    const remaining = (subscriberCounts.get(uri) ?? 0) - 1;
    if (remaining > 0) {
      subscriberCounts.set(uri, remaining);
      return;
    }
    drop(uri);
  };

  const attach = (uri: string, resolvedPath: string): boolean => {
    try {
      // Watch directories recursively (children included) and files as-is.
      // `fs.watch` async errors arrive via the 'error' event below, not as a
      // sync throw, so no recursive-fallback try/catch is needed here — the
      // outer catch handles sync throws (inotify exhaustion, path-race).
      // `{ recursive: true }` is honored on macOS, Windows, and — since Node
      // 20.13 — Linux; `engines.node` is >=24, so all three are covered.
      const recursive = statSync(resolvedPath).isDirectory();
      const watcher = watch(resolvedPath, recursive ? { recursive: true } : undefined, () => {
        notifyAll(uri);
      });
      watcher.on('error', (err: Error) => {
        Logger.warn(`Watcher error for ${uri}: ${err.message}`);
        dropWatcher(uri, watcher);
      });
      // Two attaches that both cleared `hasWatcher` before either finished
      // validating land here for the same uri. Keep the one already wired to
      // the callback set and close this one — overwriting the map entry would
      // strand the first watcher's fd with nothing left holding a reference.
      if (watchers.has(uri)) {
        watcher.close();
        return true;
      }
      watchers.set(uri, watcher);
      return true;
    } catch (err) {
      Logger.error(`Failed to create watcher for ${uri}: ${formatUnknownErrorMessage(err)}`);
      return false;
    }
  };

  return {
    hasWatcher,

    /** Live watcher count, for pre-checking a batched listen against remaining capacity. */
    size: (): number => watchers.size,

    release,

    /**
     * The one attach ladder both watcher entry points run: `resources/subscribe`
     * (2025 era) and the `subscriptions/listen` filter (modern era, HTTP and
     * stdio). Never throws — it reports the outcome and lets each caller decide
     * what that is worth: subscribe owes its caller a precise error, and listen
     * (`prepareListenWatchers`) treats the batch as all-or-nothing, releasing
     * every lease it already took and rejecting the request. Idempotent per URI
     * — a second call for an already-watched URI re-registers the notify
     * callback (one watcher per URI).
     *
     * `markSubscribe` is the one branch that differs: only `resources/subscribe`
     * declares desired state (what `isStale` aborts against). The listen path
     * must not, or a rejected attach past that point strands a `'subscribing'`
     * entry nothing settles. Whoever declares it, this function settles it:
     * every failing exit past that point cancels the declaration, so no uri is
     * poisoned for a later attach.
     *
     * Every `ok` return takes one lease; lifetime is the caller's to manage.
     * HTTP releases when the listen response closes. Stdio tracks the listen
     * request ID and releases on cancellation, SDK rejection, or graceful
     * completion. In both legs the ref-count is by URI, so a watcher another
     * stream still holds survives.
     */
    async acquire(
      pathGuard: PathGuard,
      uri: string,
      notify: (uri: string) => void,
      { markSubscribe = false }: { markSubscribe?: boolean } = {},
    ): Promise<WatcherAttachResult> {
      // Every failing exit below routes through here, so the declaration made by
      // `startSubscribe` can never outlive the attach that made it.
      const fail = (result: WatcherAttachResult & { ok: false }): WatcherAttachResult => {
        if (markSubscribe) cancelSubscribe(uri);
        return result;
      };

      if (hasWatcher(uri)) {
        // A watcher already tracks this uri; just (re)register the callback so
        // its change events reach the new subscriber. No validation or cap work
        // is needed for an already-live watcher.
        addCallback(uri, notify);
        retain(uri);
        return { ok: true };
      }
      // A cap hit before validation and one found after the await are the same
      // condition, and both are reported the same way.
      if (isAtCap()) {
        warnWatcherCap(uri);
        return { ok: false, reason: 'capped' };
      }

      if (markSubscribe) startSubscribe(uri);

      const filePath = extractPath(uri);
      if (!filePath) return fail({ ok: false, reason: 'bad-uri' });

      let resolved: string;
      try {
        resolved = await pathGuard.validateExistingPath(filePath);
      } catch (error: unknown) {
        return fail({ ok: false, reason: 'invalid-path', error });
      }

      // Re-check what the await could have changed. A stale uri is the one
      // failure that must NOT cancel: an unsubscribe landed mid-await and its
      // 'unsubscribed' marker is the thing that aborted this attach.
      if (isStale(uri)) return { ok: false, reason: 'stale' };
      if (hasWatcher(uri)) {
        addCallback(uri, notify);
        retain(uri);
        return { ok: true };
      }
      if (isAtCap()) {
        warnWatcherCap(uri);
        return fail({ ok: false, reason: 'capped' });
      }

      addCallback(uri, notify);
      if (!attach(uri, resolved)) {
        // fs.watch threw (inotify exhaustion, or a race deleted the path): roll
        // back so no dangling callback is left believing a watcher exists. No
        // lease was taken yet, so `release` drops the entry outright.
        release(uri);
        return fail({ ok: false, reason: 'attach-failed' });
      }
      retain(uri);
      return { ok: true };
    },

    destroy(): void {
      destroyed = true;
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          /* ignore close errors so all watchers are attempted */
        }
      }
      watchers.clear();
      activeCallbacks.clear();
      subscriberCounts.clear();
      desiredState.clear();
    },
  };
}

export type WatcherRegistry = ReturnType<typeof createWatcherRegistry>;

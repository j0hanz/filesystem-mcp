import { randomUUID } from 'node:crypto';

import { ErrorCode, FsError } from './errors.js';

const DEFAULT_MAX_SNAPSHOTS = 32;
const DEFAULT_TTL_MS = 60 * 1000;

interface StoredPageSnapshot {
  readonly queryKey: string;
  readonly items: readonly unknown[];
  readonly metadata: unknown;
  readonly expiresAt: number;
}

export interface PageSnapshot<T = unknown, M = unknown> {
  readonly items: readonly T[];
  readonly metadata: M;
}

export interface PageSnapshotStoreOptions {
  readonly maxSnapshots?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * The one cursor rejection: a cursor whose snapshot expired, was evicted, was
 * already consumed past its end, or belongs to a different query. Every case
 * has the same remedy, so they share one message.
 */
export function invalidCursor(): FsError {
  return new FsError(
    ErrorCode.INVALID_INPUT,
    'Invalid cursor. Request the first page without a cursor.',
  );
}

/**
 * Short-lived snapshots of a completed query's full result set, so later pages
 * slice a stored array instead of re-scanning and re-sorting the filesystem.
 *
 * ponytail: bounded by snapshot count and TTL, not by bytes — 32 x 20,000
 * `list` entries or 32 x 10,000 `search_text` matches, each match retaining up
 * to 20 more line strings at `context: 10`, order of a few hundred MB held for
 * 60s, and the HTTP leg shares one store so any caller can drive it. If that
 * shows up as memory pressure, meter bytes the way `ResourceStore` does.
 */
export class PageSnapshotStore {
  private readonly byId = new Map<string, StoredPageSnapshot>();
  private readonly maxSnapshots: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PageSnapshotStoreOptions = {}) {
    this.maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [snapshotId, entry] of this.byId) {
      if (entry.expiresAt <= now) this.byId.delete(snapshotId);
    }
  }

  create(params: { queryKey: string; items: readonly unknown[]; metadata?: unknown }): string {
    this.pruneExpired();
    const snapshotId = randomUUID();
    this.byId.set(snapshotId, {
      queryKey: params.queryKey,
      items: params.items,
      metadata: params.metadata,
      expiresAt: this.now() + this.ttlMs,
    });
    // Oldest first: Map keeps insertion order and `read` re-inserts, so the
    // first key is the least recently used snapshot.
    while (this.byId.size > this.maxSnapshots) {
      const oldest = this.byId.keys().next();
      if (oldest.done) break;
      this.byId.delete(oldest.value);
    }
    return snapshotId;
  }

  read<T, M = undefined>(snapshotId: string, queryKey: string): PageSnapshot<T, M> {
    this.pruneExpired();
    const entry = this.byId.get(snapshotId);
    if (entry?.queryKey !== queryKey) throw invalidCursor();
    this.byId.delete(snapshotId);
    this.byId.set(snapshotId, entry);
    return {
      items: entry.items as readonly T[],
      metadata: entry.metadata as M,
    };
  }

  clear(): void {
    this.byId.clear();
  }
}

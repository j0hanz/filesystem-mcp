import type { ContentBlock } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

import { ErrorCode, FsError } from './errors.ts';
import { MIB } from './util.ts';

// ─── TTL + LRU map ───────────────────────────────────────────────────────────

/**
 * A bounded, expiring map. `Map` keeps insertion order and a read re-inserts,
 * so the first key is always the least recently used one. Entries carry an
 * optional weight so a byte budget can be enforced next to the entry cap.
 */
class TtlLru<V> {
  readonly #byKey = new Map<string, { value: V; expiresAt: number; weight: number }>();
  readonly #maxEntries: number;
  readonly #maxWeight: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #weight = 0;

  constructor(opts: { maxEntries: number; ttlMs: number; maxWeight?: number; now?: () => number }) {
    this.#maxEntries = opts.maxEntries;
    this.#maxWeight = opts.maxWeight ?? Number.POSITIVE_INFINITY;
    this.#ttlMs = opts.ttlMs;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#byKey.size;
  }

  /** Drop every expired entry; true when at least one went. */
  prune(): boolean {
    const now = this.#now();
    const before = this.#byKey.size;
    for (const [key, entry] of this.#byKey) {
      if (entry.expiresAt <= now) this.delete(key);
    }
    return this.#byKey.size !== before;
  }

  /** The live value, bumped to most recently used; `undefined` when missing or expired. */
  get(key: string): V | undefined {
    const entry = this.#byKey.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.delete(key);
      return undefined;
    }
    this.#byKey.delete(key);
    this.#byKey.set(key, entry);
    return entry.value;
  }

  /** Insert (pruning expired first) and evict least recently used entries past either cap. */
  set(key: string, value: V, weight = 0): void {
    this.prune();
    this.delete(key);
    this.#byKey.set(key, { value, expiresAt: this.#now() + this.#ttlMs, weight });
    this.#weight += weight;
    while (
      this.#byKey.size > 0 &&
      (this.#byKey.size > this.#maxEntries || this.#weight > this.#maxWeight)
    ) {
      const oldest = this.#byKey.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: string): void {
    const entry = this.#byKey.get(key);
    if (!entry) return;
    this.#weight -= entry.weight;
    this.#byKey.delete(key);
  }

  /** Live keys, least recently used first. Prunes expired entries first. */
  keys(): string[] {
    this.prune();
    return [...this.#byKey.keys()];
  }

  clear(): void {
    this.#byKey.clear();
    this.#weight = 0;
  }
}

// ─── Resource store: externalized tool results ───────────────────────────────

interface ResourceEntry {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  expiresAt: string;
  text: string;
}

const MAX_ENTRIES = 64;
const MAX_TOTAL_BYTES = 25 * MIB;
const MAX_ENTRY_BYTES = 10 * MIB;
const ENTRY_TTL_MS = 60 * 1000;

export class ResourceStore {
  readonly #entries = new TtlLru<ResourceEntry>({
    maxEntries: MAX_ENTRIES,
    maxWeight: MAX_TOTAL_BYTES,
    ttlMs: ENTRY_TTL_MS,
  });
  readonly #onListChanged: (() => void) | undefined;

  constructor(onListChanged?: () => void) {
    this.#onListChanged = onListChanged;
  }

  getEntry(uri: string): ResourceEntry {
    const entry = this.#entries.get(uri);
    if (entry) return entry;
    // Not found and expired share a remedy; only the wording differs, and an
    // expiry seen here changed the list a client may hold.
    if (this.#entries.prune()) this.#onListChanged?.();
    throw new FsError(
      ErrorCode.NOT_FOUND,
      `Resource not found: ${uri}. Re-run the tool to regenerate.`,
    );
  }

  putText(params: { name: string; mimeType?: string; text: string }): ResourceEntry {
    const entryBytes = Buffer.byteLength(params.text, 'utf8');
    if (entryBytes > MAX_ENTRY_BYTES) {
      if (this.#entries.prune()) this.#onListChanged?.();
      throw new FsError(ErrorCode.TOO_LARGE, `Resource too large to cache (${entryBytes} bytes).`);
    }
    const entry: ResourceEntry = {
      uri: `filesystem-mcp://result/${randomUUID()}`,
      name: params.name,
      mimeType: params.mimeType ?? 'text/plain',
      size: entryBytes,
      expiresAt: new Date(Date.now() + ENTRY_TTL_MS).toISOString(),
      text: params.text,
    };
    this.#entries.set(entry.uri, entry, entryBytes);
    this.#onListChanged?.();
    return entry;
  }

  /**
   * Live URIs, oldest first. Deliberately silent about the prune it runs:
   * this is the read path `resources/list` runs through, and the caller is
   * already receiving the post-prune list.
   */
  keys(): string[] {
    return this.#entries.keys();
  }
}

export interface JsonResourceResult {
  entry: {
    uri: string;
    size: number;
    mimeType: string;
    expiresAt: string;
  };
  link: ContentBlock;
}

/**
 * Owner of the externalize-a-payload rule: a tool whose inline response is
 * truncated publishes the full value to the resource store as pretty-printed
 * JSON and hands back the URI to reach it by, plus the link block that offers
 * it to the user.
 */
export function putJsonResource(
  store: ResourceStore,
  name: string,
  // `Record<string, unknown> | readonly unknown[]`, not `unknown` or `object`:
  // JSON.stringify returns undefined for undefined and for functions, and `null`
  // is excluded so non-string payloads cannot enter the store's text entry.
  value: Record<string, unknown> | readonly unknown[],
): JsonResourceResult {
  const entry = store.putText({
    name,
    mimeType: 'application/json',
    text: JSON.stringify(value, null, 2),
  });

  return {
    entry: {
      uri: entry.uri,
      size: entry.size,
      mimeType: entry.mimeType,
      expiresAt: entry.expiresAt,
    },
    link: {
      type: 'resource_link',
      uri: entry.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      size: entry.size,
      annotations: { audience: ['user'] },
    },
  };
}

// ─── Page snapshots: paginated result sets ───────────────────────────────────

export interface PageSnapshot<T = unknown, M = unknown> {
  readonly items: readonly T[];
  readonly metadata: M;
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
 * shows up as memory pressure, pass a byte weight to `set` the way
 * `ResourceStore` does.
 */
export class PageSnapshotStore {
  readonly #byId: TtlLru<PageSnapshot & { queryKey: string }>;

  constructor(options: { maxSnapshots?: number; ttlMs?: number; now?: () => number } = {}) {
    this.#byId = new TtlLru({
      maxEntries: options.maxSnapshots ?? 32,
      ttlMs: options.ttlMs ?? 60 * 1000,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  create(params: { queryKey: string; items: readonly unknown[]; metadata?: unknown }): string {
    const snapshotId = randomUUID();
    this.#byId.set(snapshotId, {
      queryKey: params.queryKey,
      items: params.items,
      metadata: params.metadata,
    });
    return snapshotId;
  }

  read<T, M = undefined>(snapshotId: string, queryKey: string): PageSnapshot<T, M> {
    const entry = this.#byId.get(snapshotId);
    if (entry?.queryKey !== queryKey) throw invalidCursor();
    return { items: entry.items as readonly T[], metadata: entry.metadata as M };
  }

  clear(): void {
    this.#byId.clear();
  }
}

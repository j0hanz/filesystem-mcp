import type { ContentBlock } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

import { ErrorCode, FsError } from './errors.js';
import { Logger } from './observability.js';
import { MIB } from './util.js';

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

function isExpired(entry: ResourceEntry, now = Date.now()): boolean {
  const expiresAt = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return expiresAt <= now;
}

export class ResourceStore {
  private readonly byUri = new Map<string, ResourceEntry>();
  private _totalBytes = 0;

  private readonly onListChanged: (() => void) | undefined;

  constructor(onListChanged?: () => void) {
    this.onListChanged = onListChanged;
  }

  private emitListChanged(changed: boolean): void {
    if (changed) this.onListChanged?.();
  }

  private bumpLru(uri: string, entry: ResourceEntry): void {
    if (!this.byUri.has(uri)) {
      return;
    }
    this.byUri.delete(uri);
    this.byUri.set(uri, entry);
  }

  private removeEntry(uri: string): ResourceEntry | undefined {
    const existing = this.byUri.get(uri);
    if (!existing) {
      return undefined;
    }
    this._totalBytes -= existing.size;
    this.byUri.delete(uri);
    return existing;
  }

  private evictOldest(): void {
    const first = this.byUri.values().next();
    if (first.done) {
      return;
    }
    this.removeEntry(first.value.uri);
  }

  private pruneExpiredEntries(now = Date.now()): boolean {
    const toRemove: string[] = [];
    for (const entry of this.byUri.values()) {
      if (isExpired(entry, now)) {
        toRemove.push(entry.uri);
      }
    }
    for (const uri of toRemove) {
      this.removeEntry(uri);
    }
    return toRemove.length > 0;
  }

  private enforceLimits(): void {
    while (this.byUri.size > MAX_ENTRIES) {
      this.evictOldest();
    }
    while (this._totalBytes > MAX_TOTAL_BYTES) {
      if (this.byUri.size === 0) {
        Logger.error(
          `[resource-store] enforceLimits invariant violation: totalBytes=${this._totalBytes} but entryCount=0`,
        );
        break;
      }
      this.evictOldest();
    }
  }

  getEntry(uri: string): ResourceEntry {
    const existing = this.byUri.get(uri);

    if (!existing) {
      throw new FsError(
        ErrorCode.NOT_FOUND,
        `Resource not found: ${uri}. Re-run the tool to regenerate.`,
      );
    }

    if (isExpired(existing)) {
      this.removeEntry(uri);
      this.emitListChanged(true);
      throw new FsError(
        ErrorCode.NOT_FOUND,
        `Resource expired: ${uri}. Re-run the tool to regenerate.`,
      );
    }

    this.bumpLru(uri, existing);
    return existing;
  }

  private checkBeforePut(entryBytes: number): void {
    const changed = this.pruneExpiredEntries();
    if (entryBytes > MAX_ENTRY_BYTES) {
      this.emitListChanged(changed);
      throw new FsError(ErrorCode.TOO_LARGE, `Resource too large to cache (${entryBytes} bytes).`);
    }
  }

  putText(params: { name: string; mimeType?: string; text: string }): ResourceEntry {
    const entryBytes = Buffer.byteLength(params.text, 'utf8');
    this.checkBeforePut(entryBytes);

    const storedAt = new Date();
    const entry: ResourceEntry = {
      uri: `filesystem-mcp://result/${randomUUID()}`,
      name: params.name,
      mimeType: params.mimeType ?? 'text/plain',
      size: entryBytes,
      expiresAt: new Date(storedAt.getTime() + ENTRY_TTL_MS).toISOString(),
      text: params.text,
    };
    this.byUri.set(entry.uri, entry);
    this._totalBytes += entryBytes;
    this.enforceLimits();
    this.emitListChanged(true);
    return entry;
  }

  /**
   * Returns live URIs currently in the store.
   * Side effect: prunes expired entries before returning.
   *
   * Deliberately silent: this is the read path `resources/list` runs through,
   * and the caller is already receiving the post-prune list. Emitting here
   * would tell the client its list changed while handing it that same list.
   */
  keys(): string[] {
    this.pruneExpiredEntries();
    return Array.from(this.byUri.keys());
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

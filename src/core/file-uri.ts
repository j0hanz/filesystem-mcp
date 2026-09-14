import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import { detectMimeFromContent } from './mime.js';
import { countLines } from './read.js';
import type { FileKind } from './schema.js';
import type { ResourceStore } from './store.js';
import { getMaxTextFileSize } from './util.js';

// Single owner of the `filesystem-mcp://file/` URI scheme — the template string,
// the path→URI encoder, the URI→path decoder, the link blocks built from them,
// and the post-write metadata block every write tool reports alongside them.

export const FILESYSTEM_FILE_URI_TEMPLATE = 'filesystem-mcp://file/{+path}';

/**
 * The `{+path}` template-variable form of a path — what `completion/complete`
 * must return, since a client expands a suggestion into the template verbatim.
 * Unescaped, a '#' or '?' in a filename truncates the URI into a fragment or
 * query (silently naming a different path) and a '%' makes the decode throw.
 * Separators are restored so the value still reads as a path.
 */
export function encodeFileUriPath(validPath: string): string {
  const posix = validPath.replace(/\\/g, '/');
  return encodeURIComponent(posix).replace(/%2F/gi, '/');
}

/** Inverse of {@link encodeFileUriPath}; `undefined` on invalid percent-encoding. */
export function decodeFileUriPath(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export function buildFileResourceUri(validPath: string): string {
  return `filesystem-mcp://file/${encodeFileUriPath(validPath)}`;
}

/**
 * The link block for a URI already built by `buildFileResourceUri`. Callers that
 * hold the URI must use this rather than rebuilding from a path: a path that
 * differs only in case (the drive letter, on Windows) yields a *different* URI
 * string, and watchers key on that string — a link and a `resourceUri` that
 * disagree hand the client two subscriptions for one file.
 */
export function buildFileResourceLinkFor(
  uri: string,
  name: string,
  mimeType: string,
  size: number,
): ContentBlock {
  return {
    type: 'resource_link',
    uri,
    name,
    mimeType,
    size,
    annotations: { audience: ['user', 'assistant'] },
  };
}

export function buildFileResourceLink(
  validPath: string,
  mimeType: string,
  size: number,
): ContentBlock {
  return buildFileResourceLinkFor(
    buildFileResourceUri(validPath),
    basename(validPath),
    mimeType,
    size,
  );
}

export function extractPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'filesystem-mcp:' || url.host !== 'file') return undefined;
    return decodeFileUriPath(url.pathname.slice(1));
  } catch {
    return undefined;
  }
}

export interface WrittenFileMeta {
  size: number;
  lineCount: number;
  mimeType: string;
  kind: FileKind;
  /**
   * Undefined when the resulting file exceeds the text-size cap: the store
   * serves the URI via readRaw, which would reject it with TOO_LARGE.
   */
  resourceUri: string | undefined;
  /** Undefined when no resource store is configured — nothing to link into. */
  resourceLink: ContentBlock | undefined;
}

/**
 * The five-step block every write tool runs on its post-write content: size,
 * line count, MIME, the file's resource URI, and the store-gated link block.
 */
export function buildWrittenFileMeta(
  validPath: string,
  content: string,
  resourceStore: ResourceStore | undefined,
): WrittenFileMeta {
  const size = Buffer.byteLength(content, 'utf-8');
  const mimeInfo = detectMimeFromContent(validPath, content);
  // An edit or patch can push a readable file past the text-size cap; the
  // store serves the URI via readRaw, which would reject it with TOO_LARGE.
  const servable = size <= getMaxTextFileSize();
  return {
    size,
    lineCount: countLines(content),
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    resourceUri: servable ? buildFileResourceUri(validPath) : undefined,
    resourceLink:
      resourceStore && servable
        ? buildFileResourceLink(validPath, mimeInfo.mimeType, size)
        : undefined,
  };
}

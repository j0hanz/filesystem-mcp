import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import { detectMimeFromContent } from './mime.ts';
import type { FileKind } from './mime.ts';
import { countLines } from './read.ts';
import { getMaxTextFileSize } from './util.ts';

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
  /** ISO-8601 mtime of the file the link names, when the caller has one. */
  lastModified?: string,
): ContentBlock {
  return {
    type: 'resource_link',
    uri,
    name,
    mimeType,
    size,
    annotations: {
      audience: ['user', 'assistant'],
      ...(lastModified !== undefined ? { lastModified } : {}),
    },
  };
}

function buildFileResourceLink(
  validPath: string,
  mimeType: string,
  size: number,
  lastModified?: string,
): ContentBlock {
  return buildFileResourceLinkFor(
    buildFileResourceUri(validPath),
    basename(validPath),
    mimeType,
    size,
    lastModified,
  );
}

export function extractPath(uri: string): string | undefined {
  const url = URL.parse(uri);
  if (url?.protocol !== 'filesystem-mcp:' || url.host !== 'file') return undefined;
  return decodeFileUriPath(url.pathname.slice(1));
}

export interface WrittenFileMeta {
  size: number;
  lineCount: number;
  mimeType: string;
  kind: FileKind;
  /** Undefined unless {@link writtenFileLinks} allows it: see there for when. */
  resourceUri: string | undefined;
  /** Undefined unless {@link writtenFileLinks} allows it: see there for when. */
  resourceLink: ContentBlock | undefined;
}

/**
 * The URI and link a write tool may advertise for the file it wrote. None on a
 * dry run — nothing was written, so the file on disk is still the one the
 * caller already has. None when the size is unknown or over the text-size cap —
 * the store serves the URI via readRaw, which would reject it with TOO_LARGE.
 * File resources are read directly from disk, not from the result store.
 * `lastModified` is the post-write mtime when the caller stat'd the file; a
 * link without it is still valid.
 */
export function writtenFileLinks(
  validPath: string,
  mimeType: string,
  size: number | undefined,
  dryRun = false,
  lastModified?: string,
): Pick<WrittenFileMeta, 'resourceUri' | 'resourceLink'> {
  if (dryRun || size === undefined || size > getMaxTextFileSize()) {
    return { resourceUri: undefined, resourceLink: undefined };
  }
  return {
    resourceUri: buildFileResourceUri(validPath),
    resourceLink: buildFileResourceLink(validPath, mimeType, size, lastModified),
  };
}

/**
 * The block every write tool reports for the content it wrote (or, with
 * `dryRun`, would have written): size, line count, MIME, and whatever
 * {@link writtenFileLinks} allows it to advertise. Named fields, because
 * `validPath` and `content` are both strings and a positional swap type-checks.
 */
export function buildWrittenFileMeta(options: {
  validPath: string;
  content: string;
  dryRun?: boolean | undefined;
  lastModified?: string | undefined;
}): WrittenFileMeta {
  const { validPath, content } = options;
  const size = Buffer.byteLength(content, 'utf-8');
  const { mimeType, kind } = detectMimeFromContent(validPath, content);
  return {
    size,
    lineCount: countLines(content),
    mimeType,
    kind,
    ...writtenFileLinks(validPath, mimeType, size, options.dryRun, options.lastModified),
  };
}

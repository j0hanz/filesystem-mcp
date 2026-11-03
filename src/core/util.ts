import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';

import { cli } from './config.ts';
import { warnInvalidSetting } from './path-utils.ts';

const KIB = 1024;
export const MIB = 1024 * KIB;

export function parseEnvInt(
  envVar: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  return parseIntSetting(envVar, process.env[envVar], defaultValue, min, max);
}

/** Validate a raw integer setting (env var or CLI override) with a logged fallback. */
function parseIntSetting(
  name: string,
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (!value) {
    return defaultValue;
  }

  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (
    trimmed === '' ||
    Number.isNaN(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    warnInvalidSetting(name, value, `${String(min)}-${String(max)}`, defaultValue);
    return defaultValue;
  }
  return parsed;
}

/**
 * Split a comma-separated config value into trimmed, non-empty entries. Empty
 * entries are dropped so "," or " " reads as unset rather than as a list of
 * blanks. Every comma-separated env var this server accepts parses through
 * here, so they all agree on what "configured" means.
 */
export function splitCsvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Parse a boolean env flag: `true`/`1` enable, `false`/`0`/empty disable.
 * Any other value warns once per var (when `name` is given) and reads as
 * false, so a typo like `FS_ALLOW_SENSITIVE=yes` is never silent.
 */
export function parseTrueEnvFlag(value: string | undefined, name?: string): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === '1') return true;
  if (name && trimmed !== '' && trimmed !== 'false' && trimmed !== '0') {
    warnInvalidSetting(name, value, '"true" or "1"', false);
  }
  return false;
}

/** sha256 of `data` as lowercase hex, the digest every result hash uses. */
export const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

// A file whose every newline is CRLF gets LF-only edit text converted to match
// — the rule jsdiff's autoConvertLineEndings applies for `patch`. Range, head
// and tail reads strip `\r`, so the oldText a model sends is LF-only; text that
// already carries a `\r` is taken as written. Mixed-ending files are not
// converted: there is no one ending to convert to.
export function usesCrlf(content: string): boolean {
  return content.includes('\r\n') && !/(?<!\r)\n/u.test(content);
}

export function toCrlf(text: string): string {
  return text.includes('\r') ? text : text.replaceAll('\n', '\r\n');
}

export const PARALLEL_CONCURRENCY = Math.min(Math.max(availableParallelism(), 4), 32);

/** Memory kept for undo history (saved file contents). 0 turns undo off. */
export function getMaxUndoBytes(): number {
  return parseEnvInt('FS_MAX_UNDO_BYTES', 32 * MIB, 0, 1024 * MIB);
}

export const ROOTS_TIMEOUT_MS = 5000;

export function getMaxTextFileSize(): number {
  return parseIntSetting(
    'FS_MAX_FILE_SIZE',
    cli.maxFileSize ?? process.env['FS_MAX_FILE_SIZE'],
    10 * MIB,
    MIB,
    100 * MIB,
  );
}

/**
 * Upper bound, in bytes, on one inbound JSON-RPC message on either transport.
 * Derived from the file-size limit so that a schema-valid `create` — whose
 * combined content is capped at getMaxTextFileSize() (create.ts) in UTF-8
 * bytes — still fits after JSON encoding. Per counted byte the wire carries at
 * most two bytes for well-formed text: non-ASCII UTF-8 goes on the wire
 * unescaped, and an escaped ASCII character (newline, quote, backslash, tab)
 * is two. So 2× the content plus 1 MiB for the envelope, paths and sibling
 * arguments would fit; the 3× bound below keeps headroom. Not covered, deliberately:
 * C0 control characters (JSON-escaped to six bytes each) — the read tools
 * already refuse such content as binary, and a caller sending it only loses
 * its own connection.
 * Past this bound HTTP answers 413 and stdio closes the connection (the
 * SDK's ReadBuffer contract), so it is also the number the instructions
 * resource and --print-config report.
 */
export function getMaxInboundMessageBytes(): number {
  return 3 * getMaxTextFileSize() + MIB;
}
/** Combined byte budget for one batched `read`. */
export const READ_MANY_MAX_TOTAL_BYTES = 512 * KIB;

/** Default line chunk size for read continuation when no explicit range was given. */
export const DEFAULT_CONTINUATION_CHUNK_SIZE = 200;

/**
 * Deadline for one call of a tool that walks or reads the disk (list, stat,
 * read, find_files, search_text, replace_text). Read per call, so the
 * `--tool-timeout` flag applied by cli.ts after module load still counts.
 */
export function getToolTimeoutMs(): number {
  return parseIntSetting(
    'FS_TOOL_TIMEOUT_MS',
    cli.toolTimeout ?? process.env['FS_TOOL_TIMEOUT_MS'],
    5000,
    1000,
    600_000,
  );
}

export const MAX_TREE_DEPTH = 50;
export const DEFAULT_TREE_ENTRIES = 1000;

export const MAX_LIST_ENTRIES = 20000;

export const MAX_SEARCH_RESULTS = 10000;
export const DEFAULT_SEARCH_RESULTS = 100;
export const MAX_SEARCH_DEPTH = 100;

export const DEFAULT_SEARCH_CONTENT_RESULTS = 500;

/**
 * Upper bound on array elements plus object members in one `tools/call`
 * `arguments` payload, counted by the SDK before any schema runs
 * (`McpServerOptions.maxToolInputElements`). Must clear the largest
 * schema-legal call: an `edit` batch of 5 files × 100 edits is 1517 nodes
 * and a 1000-path `read`/`delete` is ~1005, so 4096 is ~2.7× headroom.
 * Raise it in the same change that raises any of those schema caps.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 4096;

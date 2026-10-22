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

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/]/;
const REGEXP_OTHER_PUNCTUATORS = /[,\-=<>#&!%:;@~'`"]/;
const REGEXP_CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  '\t': 't',
  '\n': 'n',
  '\v': 'v',
  '\f': 'f',
  '\r': 'r',
};

const hexEscape = (code: number, width: 2 | 4): string =>
  `\\${width === 2 ? 'x' : 'u'}${code.toString(16).padStart(width, '0')}`;

function encodeForRegExpEscape(ch: string): string {
  if (REGEXP_SYNTAX.test(ch)) return `\\${ch}`;
  const control = REGEXP_CONTROL_ESCAPES[ch];
  if (control !== undefined) return `\\${control}`;
  const code = ch.codePointAt(0) ?? 0;
  const loneSurrogate = ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
  if (!REGEXP_OTHER_PUNCTUATORS.test(ch) && !/\s/.test(ch) && !loneSurrogate) return ch;
  if (code <= 0xff) return hexEscape(code, 2);
  return ch
    .split('')
    .map((unit) => hexEscape(unit.charCodeAt(0), 4))
    .join('');
}

/** The TC39 `RegExp.escape` algorithm, for runtimes that lack it. */
export function escapeRegExpFallback(input: string): string {
  let out = '';
  for (const ch of input) {
    out +=
      out === '' && /[0-9A-Za-z]/.test(ch)
        ? hexEscape(ch.charCodeAt(0), 2)
        : encodeForRegExpEscape(ch);
  }
  return out;
}

/**
 * `RegExp.escape` shipped in Node 24. Older runtimes still load the published
 * package (npm only warns on `engines`), so fall back rather than crash.
 */
export const escapeRegExp: (input: string) => string =
  typeof RegExp.escape === 'function' ? (input) => RegExp.escape(input) : escapeRegExpFallback;

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
 * combined content is capped at getMaxTextFileSize() (create.ts) in UTF-16
 * units — still fits after JSON encoding. Per unit the schema counted, the
 * wire carries at most three bytes for well-formed text: a BMP character is
 * up to three UTF-8 bytes, an escaped ASCII character (newline, quote,
 * backslash, tab) is two, a surrogate pair is four bytes for two units. Hence
 * 3× the content, plus 1 MiB for the envelope, paths and sibling arguments.
 * Not covered, deliberately: C0 control characters and lone surrogates
 * (JSON-escaped to six bytes each) — the read tools already refuse such
 * content as binary, and a caller sending it only loses its own connection.
 * Past this bound HTTP answers 413 and stdio closes the connection (the
 * SDK's ReadBuffer contract), so it is also the number the instructions
 * resource and --print-config report.
 */
export function getMaxInboundMessageBytes(): number {
  return 3 * getMaxTextFileSize() + MIB;
}
/** Combined byte budget for one batched `read`. */
export const READ_MANY_MAX_TOTAL_BYTES = 512 * KIB;

/**
 * Ceiling on JSON-encoded tool and resource results over stdio. The SDK's
 * fixed 10 MiB ReadBuffer applies regardless of `--max-file-size`; escaping,
 * duplicated metadata, and base64 can overflow it even when the source fits.
 * A tool call that changed nothing (read-only, or a dry run) and a resource
 * read return TOO_LARGE instead, and the stdio result store refuses an entry
 * whose read would overflow it; HTTP is unaffected. ~256 KiB covers the
 * JSON-RPC envelope this measure omits, including the bounded request ID.
 * Mutating tools need pre-commit safeguards rather than a post-commit output
 * refusal.
 */
export const MAX_OUTBOUND_RESULT_BYTES = 10 * MIB - 256 * KIB;

/**
 * JSON-encoded stdio request IDs and string progress tokens, including
 * quotes/escapes, must fit the envelope reserve: each is echoed into frames.
 */
export const MAX_STDIO_REQUEST_ID_BYTES = KIB;

/**
 * An upper bound on `Buffer.byteLength(JSON.stringify(value))` for the plain
 * JSON data tool and resource results are made of, from a walk that reads
 * string lengths but never encodes a string. JSON spends at most six bytes on
 * one UTF-16 code unit (`\uXXXX` for a control character or a lone surrogate;
 * any other BMP character is at most three UTF-8 bytes, a surrogate pair four
 * for its two units), so a string or key costs at most 6 × length + 2 quotes.
 * A finite number costs its `String()` form, which is what JSON writes, and a
 * non-finite one `null`; `true`, `false` and `null` at most five. Each array
 * element and object member adds one separator, and a member one colon, on top
 * of the two brackets. A member JSON would omit (undefined, a function) only
 * overcounts. `toJSON` is followed the way JSON.stringify follows it.
 */
export function jsonByteBound(value: unknown): number {
  if (typeof value === 'string') return 6 * value.length + 2;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value !== 'object' || value === null) return 5;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return jsonByteBound((value as { toJSON: () => unknown }).toJSON());
  }
  let bytes = 2;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) bytes += jsonByteBound(item) + 1;
    return bytes;
  }
  for (const [key, item] of Object.entries(value)) {
    bytes += 6 * key.length + 2 + 1 + jsonByteBound(item) + 1;
  }
  return bytes;
}

/**
 * `size` raw bytes' length once base64-encoded: the wire cost of an embedded
 * binary resource. 4/3 rounded up per 3-byte group, standard base64, no line
 * wrapping.
 */
export function base64EncodedBytes(size: number): number {
  return 4 * Math.ceil(size / 3);
}

/**
 * `value`'s JSON-encoded size in bytes when it is over `limit`, else
 * `undefined`. {@link jsonByteBound} clears most values without encoding them;
 * only one it cannot clear pays for the exact `JSON.stringify` measure.
 */
export function jsonBytesOver(value: unknown, limit: number): number | undefined {
  if (jsonByteBound(value) <= limit) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  return bytes > limit ? bytes : undefined;
}

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

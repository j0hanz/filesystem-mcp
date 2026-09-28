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

/** Combined byte budget for one batched `read`. */
export const READ_MANY_MAX_TOTAL_BYTES = 512 * KIB;

/** Default line chunk size for read continuation when no explicit range was given. */
export const DEFAULT_CONTINUATION_CHUNK_SIZE = 200;

export const DEFAULT_SEARCH_TIMEOUT_MS = 5000;

export const MAX_TREE_DEPTH = 50;
export const DEFAULT_TREE_ENTRIES = 1000;

export const MAX_LIST_ENTRIES = 20000;

export const MAX_SEARCH_RESULTS = 10000;
export const DEFAULT_SEARCH_RESULTS = 100;
export const MAX_SEARCH_DEPTH = 100;

export const DEFAULT_SEARCH_CONTENT_RESULTS = 500;

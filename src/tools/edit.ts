import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { diffStatsFromPatch, unifiedPatch } from '../core/diff.ts';
import { ErrorCode, FsError, type PerPathResult } from '../core/errors.ts';
import type { WrittenFileMeta } from '../core/file-uri.ts';
import { joinRoster, truncateProgressPattern } from '../core/fmt.ts';
import { isSamePath } from '../core/path-utils.ts';
import { rewriteFile } from '../core/rewrite.ts';
import {
  defaultFalseBoolean,
  mapSingleOrBatchPaths,
  nonBlankString,
  RequiredPath,
} from '../core/schema.ts';
import { compileRegex, execMatches, freeRegex } from '../core/search.ts';
import { escapeRegExp, toCrlf, usesCrlf } from '../core/util.ts';
import { type BatchResult, isTotalFailure, runOverPaths } from './batch.ts';
import { defineTool, type ToolCtx } from './define.ts';

const EditSpecSchema = z.strictObject({
  oldText: nonBlankString('oldText')
    .describe(
      'Exact literal text to locate in the file; it must match exactly once. Include 3-5 lines of context so it does — an oldText found in several places fails with their line numbers.',
    )
    .meta({ examples: ['const x = 1;', 'function oldName('] }),
  newText: z
    .string()
    .describe('Replacement text. Use an empty string to delete the matched oldText.')
    .meta({ examples: ['const x = 2;', 'function newName(', ''] }),
});
// No `id`, so no `$defs`/`$ref`: this subschema is inlined at both `edits` and
// `files[].edits`. Hoisting it saved ~1.3 kB, but clients whose schema
// converter cannot follow a `$ref` fell back to an opaque pass-through for
// `edit` alone and sent its arguments as a serialized string (issue #51).

const MAX_MULTI_FILES = 5;
const MAX_EDITS_PER_FILE = 100;

const EditFileInputSchema = z
  .strictObject({
    path: RequiredPath.optional().describe('Single file path; mutually exclusive with files'),
    edits: z
      .array(EditSpecSchema)
      .min(1)
      .max(MAX_EDITS_PER_FILE)
      .optional()
      .describe('Replacements applied to path (required with path); not allowed with files'),
    files: z
      .array(
        z.strictObject({
          path: RequiredPath,
          edits: z
            .array(EditSpecSchema)
            .min(1)
            .max(MAX_EDITS_PER_FILE)
            .describe('Replacements to apply to this specific file'),
        }),
      )
      .min(1)
      .max(MAX_MULTI_FILES)
      .optional()
      .describe('Per-file entries (batch mode)'),
    dryRun: defaultFalseBoolean(
      'Preview diffs without writing to disk (default: false = apply edits)',
    ),
    ignoreWhitespace: defaultFalseBoolean(
      'Ignore leading/trailing whitespace differences when matching oldText; newText is re-indented to the match and replaces its inner blank lines',
    ),
  })
  .superRefine((value, ctx) => {
    const hasPath = value.path !== undefined;
    const hasFiles = value.files !== undefined;
    if (hasPath === hasFiles) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Provide exactly one of 'path' or 'files'",
        input: value,
      });
    }
    if (hasPath && value.edits === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['edits'],
        message: "'edits' required when using 'path'",
        input: value,
      });
    }
    if (hasFiles && value.edits !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['edits'],
        message: "'edits' not allowed with 'files'; each file carries its own edits",
        input: value,
      });
    }
    // Batch entries run in parallel and each rewrites its file whole, so two
    // entries for one file race: the last write wins and the other's edits are
    // lost while both report success. One entry per file.
    const files = value.files ?? [];
    for (const [index, file] of files.entries()) {
      const first = files.findIndex((other) => isSamePath(other.path, file.path));
      if (first < index) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: `duplicate of files[${String(first)}].path; put every edit for one file in a single entry`,
          input: value,
        });
      }
    }
  });

type EditFileValue = Omit<WrittenFileMeta, 'resourceLink'> & {
  path: string;
  modified: string;
  appliedEdits: number;
  linesAdded?: number;
  linesRemoved?: number;
  diff?: string;
  unmatchedEdits?: string[];
};

interface TextRange {
  startIndex: number;
  length: number;
}

interface EditResult {
  content: string;
  appliedEdits: number;
  unmatchedEdits: string[];
  linesAdded?: number;
  linesRemoved?: number;
  diff?: string;
}

const MAX_REPORTED_MATCH_LINES = 5;

interface EditMatches {
  /** The first match; undefined when oldText matches nothing. */
  first: TextRange | undefined;
  count: number;
  /** UTF-16 start offsets of the first {@link MAX_REPORTED_MATCH_LINES} matches. */
  starts: number[];
  truncated: boolean;
}

// Whitespace-flexible matching for ignoreWhitespace, without a regex. One RE2
// pattern built from the whole oldText outgrew re2-wasm's fixed heap at a few
// thousand lines, and the file itself shares that heap (issue #157); V8's
// backtracking engine overflows its stack on the same pattern. oldText is
// literal tokens with no whitespace in them, separated by whitespace gaps, and
// every gap is followed by a literal or the end, so a greedy walk from each
// candidate start is exact and never backtracks.

export interface FlexMatch {
  /** UTF-16 offset into the full content. */
  start: number;
  /** UTF-16 length; always > 0, since oldText holds at least one non-whitespace character. */
  length: number;
}

/**
 * A whitespace run of oldText. `horizontal` stays on one line; `required`
 * keeps two word characters apart. `lines` contains a newline: between two
 * pieces of text it stays flexible (`count` undefined) — at least one
 * newline, as many as the file has. At either edge of oldText it matches
 * exactly `count` newlines: a flexible edge would swallow the blank lines
 * around the match and, at the trailing edge, the next line's indentation,
 * all of which newText then replaces. Each newline may carry horizontal
 * whitespace before it, which covers the `\r` of a CRLF file and a blank
 * line with stray spaces. `tail` takes the horizontal whitespace after the
 * last newline; a trailing edge takes none unless the caller wrote
 * indentation there.
 */
type Gap =
  | { kind: 'horizontal'; required: boolean }
  | { kind: 'lines'; count: number | undefined; tail: boolean };

interface FlexSpec {
  lead: Gap | undefined;
  /** Non-empty, whitespace-free; `gaps[k]` sits between `literals[k]` and `literals[k + 1]`. */
  literals: string[];
  gaps: Gap[];
  trail: Gap | undefined;
}

// Horizontal whitespace is JS `\s` minus the newline, the class oldText is
// split on; the RE2 pattern took only ASCII there, so an NBSP oldText could
// not match the same NBSP in the file.
const isHorizontal = (ch: string | undefined): boolean =>
  ch !== undefined && ch !== '\n' && /\s/u.test(ch);
const HORIZONTAL_RUN = /[^\S\n]*/y;
const WHITESPACE_RUN = /\s*/y;

function skipRun(run: RegExp, content: string, at: number): number {
  run.lastIndex = at;
  run.exec(content);
  return run.lastIndex;
}

function buildFlexSpec(oldText: string): FlexSpec {
  // `split` on whitespace puts text at even indices and whitespace runs at odd ones.
  const tokens = oldText.split(/(\s+)/u);
  const last = tokens.length - 1;
  const spec: FlexSpec = { lead: undefined, literals: [], gaps: [], trail: undefined };
  for (const [i, token] of tokens.entries()) {
    if (i % 2 === 0) {
      if (token !== '') spec.literals.push(token);
      continue;
    }
    const leading = i === 1 && tokens[0] === '';
    const trailing = i === last - 1 && tokens[last] === '';
    let gap: Gap;
    if (token.includes('\n')) {
      gap =
        leading || trailing
          ? {
              kind: 'lines',
              count: token.split('\n').length - 1,
              tail: !(trailing && token.endsWith('\n')),
            }
          : { kind: 'lines', count: undefined, tail: true };
    } else {
      const required = /\w$/.test(tokens[i - 1] ?? '') && /^\w/.test(tokens[i + 1] ?? '');
      gap = { kind: 'horizontal', required };
    }
    if (leading) spec.lead = gap;
    else if (trailing) spec.trail = gap;
    else spec.gaps.push(gap);
  }
  return spec;
}

/** Where a gap starting at `at` ends, or -1 when the content there does not fit it. */
function walkGap(content: string, at: number, gap: Gap): number {
  if (gap.kind === 'horizontal') {
    const end = skipRun(HORIZONTAL_RUN, content, at);
    return gap.required && end === at ? -1 : end;
  }
  if (gap.count === undefined) {
    const end = skipRun(WHITESPACE_RUN, content, at);
    const newline = content.indexOf('\n', at);
    return newline !== -1 && newline < end ? end : -1;
  }
  let pos = at;
  for (let n = 0; n < gap.count; n++) {
    pos = skipRun(HORIZONTAL_RUN, content, pos);
    if (content[pos] !== '\n') return -1;
    pos += 1;
  }
  return gap.tail ? skipRun(HORIZONTAL_RUN, content, pos) : pos;
}

/**
 * Where the leading gap ending at `at` starts, never below `floor`, or -1.
 * Walking back as far as it fits gives the leftmost start.
 */
function walkLeadBack(content: string, at: number, gap: Gap, floor: number): number {
  const back = (pos: number): number => {
    let p = pos;
    while (p > floor && isHorizontal(content[p - 1])) p -= 1;
    return p;
  };
  if (gap.kind === 'horizontal') return back(at);
  let pos = back(at);
  for (let n = 0; n < (gap.count ?? 0); n++) {
    if (pos <= floor || content[pos - 1] !== '\n') return -1;
    pos = back(pos - 1);
  }
  return pos;
}

/** Where a match whose first literal sits at `at` ends, or -1. */
function walkForward(content: string, at: number, spec: FlexSpec): number {
  let pos = at + (spec.literals[0]?.length ?? 0);
  for (const [k, gap] of spec.gaps.entries()) {
    pos = walkGap(content, pos, gap);
    const literal = spec.literals[k + 1] ?? '';
    if (pos === -1 || !content.startsWith(literal, pos)) return -1;
    pos += literal.length;
  }
  return spec.trail ? walkGap(content, pos, spec.trail) : pos;
}

/**
 * Leftmost non-overlapping matches of oldText's whitespace-flexible form,
 * scanning content from `from` (default 0) as if `content.slice(from)` were
 * all there is, with offsets into the full content. Lazy, so a caller can
 * stop after a few.
 */
export function* flexMatches(content: string, oldText: string, from = 0): Generator<FlexMatch> {
  const spec = buildFlexSpec(oldText);
  const first = spec.literals[0];
  if (first === undefined) return;
  // Every candidate's first literal starts with non-whitespace and a leading
  // gap walks back over whitespace only, so candidate starts rise with the
  // literal's offset and the first hit that fits is the leftmost match.
  let floor = from;
  let at = content.indexOf(first, floor);
  while (at !== -1) {
    const start = spec.lead ? walkLeadBack(content, at, spec.lead, floor) : at;
    const end = start === -1 ? -1 : walkForward(content, at, spec);
    if (end === -1) {
      at = content.indexOf(first, at + 1);
      continue;
    }
    yield { start, length: end - start };
    floor = end;
    at = content.indexOf(first, floor);
  }
}

/**
 * Pattern for a whitespace run of oldText that contains a newline. Between two
 * pieces of text it stays flexible — at least one newline, as many as the file
 * has. At either edge of oldText it matches exactly the newlines written: a
 * flexible edge swallows the blank lines around the match and, at the trailing
 * edge, the next line's indentation, all of which newText then replaces. Each
 * newline may carry horizontal whitespace before it, which covers the `\r` of
 * a CRLF file and a blank line with stray spaces.
 */
function newlineRunPattern(token: string, edge: { leading: boolean; trailing: boolean }): string {
  if (!edge.leading && !edge.trailing) return '(?:[^\\S\\n]*\\n)+[^\\S\\n]*';
  const count = token.split('\n').length - 1;
  const lines = `(?:[^\\S\\n]*\\n){${String(count)}}`;
  // Nothing after the final newline unless the caller wrote indentation there.
  return edge.trailing && token.endsWith('\n') ? lines : `${lines}[^\\S\\n]*`;
}

/**
 * Where `oldText` matches. `count` is non-overlapping occurrences, except that a
 * lone match with a second one overlapping it counts two (`abab` in `ababab`),
 * since either is a span the caller could have meant — the count is exact only
 * when it answers "once or not". Only the count and the first few starts are
 * kept: a short oldText in a large file can match millions of times.
 */
function findEditMatches(content: string, oldText: string, ignoreWhitespace: boolean): EditMatches {
  const found: EditMatches = { first: undefined, count: 0, starts: [], truncated: false };
  // Returns true once the match is known ambiguous: applyEdits only needs
  // 0 / 1 / >1 and a few starts, and counting every occurrence of a short
  // oldText in a big file is wasted work (seconds under re2-wasm).
  const add = (startIndex: number, length: number): boolean => {
    found.first ??= { startIndex, length };
    found.count += 1;
    if (found.starts.length < MAX_REPORTED_MATCH_LINES) found.starts.push(startIndex);
    found.truncated = found.count > MAX_REPORTED_MATCH_LINES;
    return found.truncated;
  };

  if (ignoreWhitespace) {
    // Make whitespace flexible (tolerate indentation/spacing differences)
    // without letting it cross line boundaries: a whitespace run that contains
    // a newline keeps at least one newline, so a single-line oldText cannot
    // match across a newline and a multi-line oldText cannot collapse onto one
    // line. Horizontal whitespace stays mandatory between word characters so
    // adjacent identifiers are not merged. Built token by token: `split` on
    // whitespace puts text at even indices and whitespace runs at odd ones.
    // A newline run at either edge of oldText matches exactly, so the edit
    // cannot reach past the lines the caller named.
    const tokens = oldText.split(/(\s+)/u);
    const last = tokens.length - 1;
    let pattern = '';
    for (const [i, token] of tokens.entries()) {
      if (i % 2 === 0) {
        pattern += escapeRegExp(token);
      } else if (token.includes('\n')) {
        pattern += newlineRunPattern(token, {
          leading: i === 1 && tokens[0] === '',
          trailing: i === last - 1 && tokens[last] === '',
        });
      } else if (/\w$/.test(tokens[i - 1] ?? '') && /^\w/.test(tokens[i + 1] ?? '')) {
        pattern += '[^\\S\\n]+';
      } else {
        pattern += '[^\\S\\n]*';
      }
    }
    const regex = compileRegex(pattern, { caseSensitive: true });
    try {
      // execMatches resets lastIndex and reports UTF-16 offsets; the raw RE2
      // index counts code points and would splice off-by-one per emoji.
      const scan = (from: number): void => {
        for (const match of execMatches(regex, from === 0 ? content : content.slice(from))) {
          // A zero-length match names an empty span, which cannot be replaced.
          if (match.text.length > 0 && add(from + match.start, match.text.length)) return;
          if (from > 0) return;
        }
      };
      scan(0);
      // execMatches resumes past each match, so a second match overlapping the
      // first is never reported; look once more from just past its first
      // non-whitespace character. Starting inside the leading whitespace would
      // re-find the same occurrence, since the pattern's leading run is `*`. The
      // pattern carries no anchors, so matching a suffix finds the same spans.
      if (found.count === 1 && found.first) {
        const { startIndex, length } = found.first;
        const lead = content.slice(startIndex, startIndex + length).search(/\S/u);
        scan(afterCodePoint(content, startIndex + lead));
      }
    } finally {
      // The compiled pattern owns wasm memory re2-wasm never reclaims on its
      // own; its lifetime is this one search.
      freeRegex(regex);
    }
    return found;
  }

  // Non-overlapping, so the scan stays linear on repetitive content; the one
  // overlap that matters — a second match inside the only one — is checked after.
  for (
    let i = content.indexOf(oldText);
    i !== -1;
    i = content.indexOf(oldText, i + oldText.length)
  ) {
    if (add(i, oldText.length)) break;
  }
  if (found.count === 1 && found.first) {
    const overlap = content.indexOf(oldText, afterCodePoint(content, found.first.startIndex));
    if (overlap !== -1) add(overlap, oldText.length);
  }
  return found;
}

/** The UTF-16 offset just past the code point at `index`, so a surrogate pair is never split. */
function afterCodePoint(content: string, index: number): number {
  return index + ((content.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);
}

const indentOf = (line: string): string => /^\s*/u.exec(line)?.[0] ?? '';

// The flexible match absorbs the file's indentation, so newText is mapped back
// onto the matched lines. Pairs come from the non-blank lines of oldText and
// matched, which correspond one to one under ignoreWhitespace.
function reindentNewText(
  newText: string,
  oldText: string,
  matched: string,
  atLineStart: boolean,
): string {
  const counted = (line: string, i: number): boolean => /\S/u.test(line) && (i > 0 || atLineStart);
  const indents = (text: string): string[] =>
    text.split('\n').flatMap((line, i) => (counted(line, i) ? [indentOf(line)] : []));
  const from = indents(oldText);
  const to = indents(matched);
  const lines = newText.split('\n');
  const positional = lines.filter(counted).length === from.length;
  // Indexed once, so a line finds its indent without scanning every one of `from`.
  const firstIndex = new Map<string, number>();
  for (const [k, ind] of from.entries()) if (!firstIndex.has(ind)) firstIndex.set(ind, k);
  const lengths = [...new Set(from.map((ind) => ind.length))].sort((a, b) => b - a);
  let next = 0;
  return lines
    .map((line, i) => {
      if (!counted(line, i)) return line;
      const own = indentOf(line);
      let j = positional ? next++ : -1;
      if (!positional) {
        // The longest indent that prefixes the line; on a tie the earliest.
        const len = lengths.find((n) => n <= own.length && firstIndex.has(own.slice(0, n)));
        j = len === undefined ? -1 : (firstIndex.get(own.slice(0, len)) ?? -1);
      }
      const base = from[j];
      const target = to[j];
      if (base === undefined || target === undefined || !own.startsWith(base)) return line;
      return target + line.slice(base.length);
    })
    .join('\n');
}

function ambiguousEditError(
  content: string,
  found: EditMatches,
  editIndex: number,
  shifted: boolean,
): FsError {
  const lines = [
    ...new Set(found.starts.map((start) => content.slice(0, start).split('\n').length)),
  ];
  const label = lines.length === 1 ? 'line' : 'lines';
  const more = found.count > found.starts.length ? ', ...' : '';
  // Offsets come from the content as earlier edits in this call left it, which
  // is not the file the caller read once one of them has applied.
  const where = shifted ? ' after earlier edits' : '';
  const count = found.truncated ? `at least ${String(found.count)}` : String(found.count);
  return new FsError(
    ErrorCode.INVALID_INPUT,
    `edits[${String(editIndex)}]: oldText matches ${count} places${where} ` +
      `(${label} ${lines.join(', ')}${more}). Add surrounding lines so it matches once.`,
  );
}

function applyEdits(
  content: string,
  edits: z.infer<typeof EditSpecSchema>[],
  ignoreWhitespace: boolean,
): EditResult {
  let newContent = content;
  let appliedEdits = 0;
  const unmatchedEdits: string[] = [];
  const crlf = usesCrlf(content);

  for (const [index, edit] of edits.entries()) {
    const oldText = crlf ? toCrlf(edit.oldText) : edit.oldText;
    const newText = crlf ? toCrlf(edit.newText) : edit.newText;
    const found = findEditMatches(newContent, oldText, ignoreWhitespace);

    // A second match is an error rather than a pick: splicing the first would
    // edit a block the caller may not have meant and still report success.
    if (found.count > 1) throw ambiguousEditError(newContent, found, index, appliedEdits > 0);

    if (!found.first) {
      unmatchedEdits.push(edit.oldText);
      continue;
    }

    const first = found.first;
    const end = first.startIndex + first.length;
    // The flexible match absorbs the file's indentation, so newText is mapped back onto it.
    const replacement = ignoreWhitespace
      ? reindentNewText(
          newText,
          oldText,
          newContent.slice(first.startIndex, end),
          first.startIndex === 0 || newContent[first.startIndex - 1] === '\n',
        )
      : newText;
    newContent = newContent.slice(0, first.startIndex) + replacement + newContent.slice(end);
    appliedEdits += 1;
  }

  return { content: newContent, appliedEdits, unmatchedEdits };
}

async function editOnce(
  filePath: string,
  edits: z.infer<typeof EditSpecSchema>[],
  options: { dryRun: boolean; ignoreWhitespace: boolean },
  ctx: ToolCtx,
): Promise<{ file: EditFileValue; resourceLink?: ContentBlock }> {
  const done = await rewriteFile(
    {
      fs: ctx.fs,
      path: filePath,
      dryRun: options.dryRun,
      signal: ctx.signal,
      transport: ctx.transport,
      tool: 'edit',
    },
    (content) => {
      const result = applyEdits(content, edits, options.ignoreWhitespace);
      if (!options.dryRun && result.unmatchedEdits.length > 0) {
        throw new FsError(
          ErrorCode.INVALID_INPUT,
          `no match for oldText ${joinRoster(
            result.unmatchedEdits.map((t) => JSON.stringify(truncateProgressPattern(t))),
            ', ',
          )}; it must match the file exactly`,
          filePath,
        );
      }
      return { content: result.content, result, write: result.appliedEdits > 0 };
    },
  );
  const editResult = done.result;
  // One Myers pass serves both the dry-run preview and the line counts.
  const patch =
    editResult.appliedEdits > 0
      ? unifiedPatch(basename(done.validPath), done.before, done.after)
      : undefined;
  if (patch !== undefined) Object.assign(editResult, diffStatsFromPatch(patch));
  if (options.dryRun && patch !== undefined) editResult.diff = patch;
  if (done.written) {
    ctx.log(
      'info',
      `edit: ${filePath} (${editResult.appliedEdits} edits, +${String(editResult.linesAdded ?? 0)}/-${String(editResult.linesRemoved ?? 0)})`,
      'edit',
    );
  }

  const { resourceLink, validPath, modified, ...fileMeta } = done.report();
  return {
    file: {
      path: validPath,
      ...fileMeta,
      modified,
      appliedEdits: editResult.appliedEdits,
      ...(editResult.appliedEdits > 0 &&
      editResult.linesAdded !== undefined &&
      editResult.linesRemoved !== undefined
        ? { linesAdded: editResult.linesAdded, linesRemoved: editResult.linesRemoved }
        : {}),
      ...(editResult.unmatchedEdits.length > 0
        ? { unmatchedEdits: editResult.unmatchedEdits }
        : {}),
      ...(editResult.diff ? { diff: editResult.diff } : {}),
    },
    ...(resourceLink ? { resourceLink } : {}),
  };
}

function formatEditSummary(
  results: readonly PerPathResult<EditFileValue>[],
  dryRun: boolean,
): string {
  const tag = dryRun ? ' [dry run]' : '';
  // Single-file failure: say why here rather than making the caller read
  // structuredContent for the one message that can apply.
  const [only] = results;
  if (results.length === 1 && only && 'error' in only) {
    return `edit: ${only.path} FAILED — ${only.error.message}${tag}`;
  }
  const tokens = results.map((r) => {
    if ('error' in r) return `${basename(r.path)} FAILED`;
    const v = r.value;
    if (v.unmatchedEdits && v.unmatchedEdits.length > 0) {
      const quoted = v.unmatchedEdits.map((t) => JSON.stringify(truncateProgressPattern(t)));
      return `${basename(v.path)} NO MATCH ${joinRoster(quoted, ', ')}`;
    }
    // Counts are absent only when the Myers diff hit DIFF_TIMEOUT_MS; the edit still applied.
    if (v.appliedEdits > 0 && v.linesAdded === undefined) {
      return `${basename(v.path)} changed (too many lines to diff)`;
    }
    const added = v.linesAdded ?? 0;
    const removed = v.linesRemoved ?? 0;
    if (added === 0 && removed === 0) return `${basename(v.path)} (no change)`;
    return `${basename(v.path)} +${String(added)} -${String(removed)}`;
  });

  const failed = results.filter((r) => 'error' in r).length;
  const ok = results.length - failed;
  const ratio = failed > 0 ? ` (${String(ok)}/${String(results.length)} ok)` : '';
  // Only a dry run carries a diff, and it is the preview the caller asked for:
  // the structured value ships under `_meta`, which clients do not show the model.
  // A no-op edit still yields a header-only diff; it previews nothing.
  const diffs = results
    .map((r) => ('value' in r ? (r.value.diff ?? '') : ''))
    .filter((d) => d.includes('\n@@'))
    .join('');
  return `edit: ${tokens.join(' · ')}${ratio}${tag}${diffs ? `\n\n${diffs}` : ''}`;
}

export const EDIT = defineTool<typeof EditFileInputSchema, BatchResult<EditFileValue>>({
  name: 'edit',
  title: 'Edit Files',
  description:
    'Edit text files in place by replacing exact oldText with newText, like str_replace. ' +
    'Pass path with edits, or files for a batch; never both. ' +
    'Each oldText must match exactly once, and a file is written only if all its edits match. ' +
    'replace_text replaces every occurrence across files.',
  input: EditFileInputSchema,
  readOnlyHint: false,
  progress: (args) => {
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    let subject: string;
    if (args.path !== undefined) {
      subject = basename(args.path);
    } else if (args.files !== undefined) {
      subject = `${args.files.length} files`;
    } else {
      subject = 'files';
    }
    return { label: `Edit${dryLabel}`, subject };
  },
  mapPaths: mapSingleOrBatchPaths,
  run: async (args, ctx) => {
    const items =
      args.path !== undefined ? [{ path: args.path, edits: args.edits ?? [] }] : (args.files ?? []);

    const batch = await runOverPaths(items, ctx, ErrorCode.UNKNOWN, ({ path, edits }) =>
      editOnce(path, edits, args, ctx),
    );

    const perPathResults: PerPathResult<EditFileValue>[] = [];
    const resourceLinks: ContentBlock[] = [];
    for (const r of batch.results) {
      if ('error' in r) {
        perPathResults.push({ path: r.path, error: r.error });
        continue;
      }
      perPathResults.push({ path: r.path, value: r.value.file });
      if (r.value.resourceLink) resourceLinks.push(r.value.resourceLink);
    }

    const summaryText = formatEditSummary(perPathResults, args.dryRun);

    return {
      structured: {
        results: perPathResults,
        summary: batch.summary,
      },
      text: summaryText,
      isError: isTotalFailure(batch.summary),
      ...(resourceLinks.length > 0 ? { resources: resourceLinks } : {}),
    };
  },
});

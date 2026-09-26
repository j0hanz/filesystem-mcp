import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { computeDiffStats, unifiedPatch } from '../core/diff.ts';
import { ErrorCode, FsError } from '../core/errors.ts';
import { buildWrittenFileMeta, type WrittenFileMeta } from '../core/file-uri.ts';
import { joinRoster, truncateProgressPattern } from '../core/fmt.ts';
import { isSamePath } from '../core/path-utils.ts';
import {
  defaultFalseBoolean,
  FileKind,
  isBlank,
  IsoDateTime,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  RequiredPath,
  singleOrBatchAccessPaths,
} from '../core/schema.ts';
import { compileRegex, execMatches, freeRegex } from '../core/search.ts';
import type { ResourceStore } from '../core/store.ts';
import { isTotalFailure, runOverPaths } from './batch.ts';
import { defineTool, type ToolCtx } from './define.ts';

const EditSpecSchema = z
  .strictObject({
    oldText: z
      .string()
      .min(1, 'oldText required')
      .refine((val) => !isBlank(val), {
        message: 'oldText cannot be empty or whitespace-only',
      })
      .describe(
        'Exact literal text to locate in the file; it must match exactly once. Include 3-5 lines of context so it does — an oldText found in several places fails with their line numbers.',
      )
      .meta({ examples: ['const x = 1;', 'function oldName('] }),
    newText: z
      .string()
      .describe('Replacement text. Use an empty string to delete the matched oldText.')
      .meta({ examples: ['const x = 2;', 'function newName(', ''] }),
  })
  // The one document in this server where a `$ref` pays: this subschema is used
  // at both `edits` and `files[].edits`, so an `id` hoists it into `$defs` once
  // instead of inlining ~1.3 kB twice. Shared schemas used once per document
  // deliberately carry no `id` — there a `$ref` costs more than it saves.
  .meta({ id: 'EditSpec' });

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
      .describe('Replacements applied to path; not allowed when using files'),
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
      'Ignore leading/trailing whitespace differences when matching oldText',
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
  })
  // Mirror the superRefine on the wire: exactly one input mode, and single-file
  // mode carries its own `edits`. Without `edits` in the first branch, `{ path }`
  // alone validated against the published schema and was then rejected at
  // runtime — the model had no way to see that coming.
  .meta({ oneOf: [{ required: ['path', 'edits'] }, { required: ['files'] }] });

const PerFileResultSchema = z.strictObject({
  path: z.string().describe('Resolved absolute path of the edited file'),
  size: NonNegInt.describe('File size in bytes after edits'),
  lineCount: NonNegInt.describe('Number of lines in the file after edits'),
  mimeType: z.string().describe('Detected MIME type of the file'),
  kind: FileKind.describe('Broad file kind: text, binary, image, audio, or pdf'),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'Resource URI pointing to the updated file content; omitted when no edit matched (appliedEdits is 0) and the file was left untouched',
    ),
  modified: IsoDateTime.describe('Last modification timestamp after edits (ISO 8601 UTC)'),
  appliedEdits: NonNegInt.describe('Number of edits successfully applied'),
  linesAdded: NonNegInt.optional().describe('Net lines added by all applied edits'),
  linesRemoved: NonNegInt.optional().describe('Net lines removed by all applied edits'),
  diff: z.string().optional().describe('Unified diff of all changes (present only in dryRun mode)'),
  unmatchedEdits: z
    .array(z.string())
    .optional()
    .describe('oldText values that did not match any content in the file'),
});

const EditPerPathSchema = z.strictObject({
  path: z.string().describe('Requested file path'),
  value: PerFileResultSchema.optional().describe('Edit result; present on success'),
  error: PerFileErrorSchema.optional().describe('Error details; present on failure'),
});

const EditFileOutputSchema = z.strictObject({
  results: z
    .array(EditPerPathSchema)
    .describe('Per-path edit results ordered to match the input paths'),
  summary: OperationSummarySchema,
});

type EditFileValue = z.infer<typeof PerFileResultSchema>;

interface TextRange {
  startIndex: number;
  length: number;
}

interface EditResult {
  content: string;
  appliedEdits: number;
  unmatchedEdits: string[];
  linesAdded: number;
  linesRemoved: number;
  diff?: string;
}

const MAX_REPORTED_MATCH_LINES = 5;

interface EditMatches {
  /** The first match; undefined when oldText matches nothing. */
  first: TextRange | undefined;
  count: number;
  /** UTF-16 start offsets of the first {@link MAX_REPORTED_MATCH_LINES} matches. */
  starts: number[];
}

/**
 * Pattern for a whitespace run of oldText that contains a newline. Between two
 * pieces of text it stays flexible — at least one newline, as many as the file
 * has. At either edge of oldText it matches exactly the newlines written: a
 * flexible edge swallows the blank lines around the match and, at the trailing
 * edge, the next line's indentation, all of which newText then replaces.
 */
function newlineRunPattern(token: string, edge: { leading: boolean; trailing: boolean }): string {
  if (!edge.leading && !edge.trailing) return '[^\\S\\n]*\\n+[^\\S\\n]*';
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
  const found: EditMatches = { first: undefined, count: 0, starts: [] };
  const add = (startIndex: number, length: number): void => {
    found.first ??= { startIndex, length };
    found.count += 1;
    if (found.starts.length < MAX_REPORTED_MATCH_LINES) found.starts.push(startIndex);
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
        pattern += RegExp.escape(token);
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
          if (match.text.length > 0) add(from + match.start, match.text.length);
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
    add(i, oldText.length);
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
  return new FsError(
    ErrorCode.INVALID_INPUT,
    `edits[${String(editIndex)}]: oldText matches ${String(found.count)} places${where} ` +
      `(${label} ${lines.join(', ')}${more}). Add surrounding lines so it matches once.`,
  );
}

function buildEditFileValue(
  validPath: string,
  meta: WrittenFileMeta,
  modified: string,
  result: EditResult,
): EditFileValue {
  return {
    path: validPath,
    size: meta.size,
    lineCount: meta.lineCount,
    mimeType: meta.mimeType,
    kind: meta.kind,
    ...(meta.resourceUri !== undefined ? { resourceUri: meta.resourceUri } : {}),
    modified,
    appliedEdits: result.appliedEdits,
    ...(result.appliedEdits > 0
      ? { linesAdded: result.linesAdded, linesRemoved: result.linesRemoved }
      : {}),
    ...(result.unmatchedEdits.length > 0 ? { unmatchedEdits: result.unmatchedEdits } : {}),
    ...(result.diff ? { diff: result.diff } : {}),
  };
}

function buildEditFileMetadata(
  content: string,
  validPath: string,
  appliedEdits: number,
  resourceStore: ResourceStore | undefined,
): WrittenFileMeta {
  const meta = buildWrittenFileMeta(validPath, content, resourceStore);
  // Omitted rather than empty-stringed when nothing matched: `""` satisfied the
  // schema's `string` and then failed every resources/read a client tried it on.
  const written = appliedEdits > 0;
  return {
    ...meta,
    resourceUri: written ? meta.resourceUri : undefined,
    resourceLink: written ? meta.resourceLink : undefined,
  };
}

function applyEdits(
  content: string,
  edits: z.infer<typeof EditSpecSchema>[],
  ignoreWhitespace: boolean,
): EditResult {
  let newContent = content;
  let appliedEdits = 0;
  const unmatchedEdits: string[] = [];

  for (const [index, edit] of edits.entries()) {
    const found = findEditMatches(newContent, edit.oldText, ignoreWhitespace);

    // A second match is an error rather than a pick: splicing the first would
    // edit a block the caller may not have meant and still report success.
    if (found.count > 1) throw ambiguousEditError(newContent, found, index, appliedEdits > 0);

    if (!found.first) {
      unmatchedEdits.push(edit.oldText);
      continue;
    }

    const first = found.first;
    newContent =
      newContent.slice(0, first.startIndex) +
      edit.newText +
      newContent.slice(first.startIndex + first.length);
    appliedEdits += 1;
  }

  const { linesAdded, linesRemoved } =
    appliedEdits > 0 ? computeDiffStats(content, newContent) : { linesAdded: 0, linesRemoved: 0 };
  return { content: newContent, appliedEdits, unmatchedEdits, linesAdded, linesRemoved };
}

interface EditFileOptions {
  dryRun: boolean;
  ignoreWhitespace: boolean;
}

async function handleEditFile(
  filePath: string,
  edits: z.infer<typeof EditSpecSchema>[],
  options: EditFileOptions,
  ctx: ToolCtx,
): Promise<{ file: EditFileValue; resourceLink?: ContentBlock }> {
  const { validPath, content } = await ctx.fs.readEditableText(filePath, {
    signal: ctx.signal,
  });
  const editResult = applyEdits(content, edits, options.ignoreWhitespace);

  if (options.dryRun) {
    if (editResult.appliedEdits > 0) {
      editResult.diff = unifiedPatch(basename(validPath), content, editResult.content);
    }

    // Nothing was written, so there is no updated content to point a
    // resourceUri or a resource_link at — the file on disk is still the one the
    // caller already has. Same rule the appliedEdits-is-0 case follows: no
    // write, no link.
    const meta = buildEditFileMetadata(editResult.content, validPath, 0, ctx.resourceStore);
    return {
      file: buildEditFileValue(validPath, meta, new Date().toISOString(), editResult),
    };
  }

  if (editResult.unmatchedEdits.length > 0) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `no match for oldText ${joinRoster(
        editResult.unmatchedEdits.map((t) => JSON.stringify(truncateProgressPattern(t))),
        ', ',
      )}; it must match the file exactly`,
      filePath,
    );
  }

  if (editResult.appliedEdits > 0) {
    await ctx.fs.writeFile(filePath, editResult.content, {
      encoding: 'utf-8',
      signal: ctx.signal,
    });
    ctx.log?.(
      'info',
      `edit: ${filePath} (${editResult.appliedEdits} edits, +${editResult.linesAdded}/-${editResult.linesRemoved})`,
      'edit',
    );
  }

  // `modified` is read from a post-write stat and is advisory: under a concurrent
  // writer it may reflect that writer's mtime while `size`/content below come from
  // this edit's atomic write. The file content itself is always consistent.
  const { stats: fileStats } = await ctx.fs.stat(filePath, { signal: ctx.signal });
  const meta = buildEditFileMetadata(
    editResult.content,
    validPath,
    editResult.appliedEdits,
    ctx.resourceStore,
  );
  return {
    file: buildEditFileValue(validPath, meta, fileStats.mtime.toISOString(), editResult),
    ...(meta.resourceLink ? { resourceLink: meta.resourceLink } : {}),
  };
}

function formatEditSummary(
  results: readonly z.infer<typeof EditPerPathSchema>[],
  dryRun: boolean,
): string {
  const tag = dryRun ? ' [dry run]' : '';
  // Single-file failure: say why here rather than making the caller read
  // structuredContent for the one message that can apply.
  const [only] = results;
  if (results.length === 1 && only?.error) {
    return `edit: ${only.path} FAILED — ${only.error.message}${tag}`;
  }
  const tokens = results.map((r) => {
    if (r.error) return `${basename(r.path)} FAILED`;
    const v = r.value;
    if (!v) return `${basename(r.path)} (no result)`;
    if (v.unmatchedEdits && v.unmatchedEdits.length > 0) {
      const quoted = v.unmatchedEdits.map((t) => JSON.stringify(truncateProgressPattern(t)));
      return `${basename(v.path)} NO MATCH ${joinRoster(quoted, ', ')}`;
    }
    const added = v.linesAdded ?? 0;
    const removed = v.linesRemoved ?? 0;
    if (added === 0 && removed === 0) return `${basename(v.path)} (no change)`;
    return `${basename(v.path)} +${String(added)} -${String(removed)}`;
  });

  const failed = results.filter((r) => r.error !== undefined).length;
  const ok = results.length - failed;
  const ratio = failed > 0 ? ` (${String(ok)}/${String(results.length)} ok)` : '';
  // Only a dry run carries a diff, and it is the preview the caller asked for:
  // the structured value ships under `_meta`, which clients do not show the model.
  // A no-op edit still yields a header-only diff; it previews nothing.
  const diffs = results
    .map((r) => r.value?.diff ?? '')
    .filter((d) => d.includes('\n@@'))
    .join('');
  return `edit: ${tokens.join(' · ')}${ratio}${tag}${diffs ? `\n\n${diffs}` : ''}`;
}

export const EDIT = defineTool({
  name: 'edit',
  title: 'Edit Files',
  description:
    'Edit text files in place by replacing exact oldText with newText, like str_replace. ' +
    'Each oldText must match exactly once, and a file is written only if all its edits match. ' +
    'replace_text replaces every occurrence across files.',
  input: EditFileInputSchema,
  output: EditFileOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
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
  accessPaths: singleOrBatchAccessPaths,
  run: async (args, ctx) => {
    const sharedEdits = args.edits ?? [];
    const batchInput = args.path !== undefined ? { path: args.path } : { files: args.files ?? [] };

    const options: EditFileOptions = {
      dryRun: args.dryRun,
      ignoreWhitespace: args.ignoreWhitespace,
    };

    const batch = await runOverPaths<
      { edits: z.infer<typeof EditSpecSchema>[] },
      { file: EditFileValue; resourceLink?: ContentBlock }
    >(
      batchInput,
      ctx,
      ({ path, override }) => handleEditFile(path, override?.edits ?? sharedEdits, options, ctx),
      { defaultErrorCode: ErrorCode.UNKNOWN },
    );

    const perPathResults: z.infer<typeof EditPerPathSchema>[] = [];
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

import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { computeDiffStats, unifiedPatch } from '../core/diff.js';
import { ErrorCode, FsError } from '../core/errors.js';
import { buildWrittenFileMeta, type WrittenFileMeta } from '../core/file-uri.js';
import { escapeRegexLiteral } from '../core/primitives.js';
import {
  defaultFalseBoolean,
  FileKind,
  isBlank,
  IsoDateTime,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  PositiveInt,
  RequiredPath,
  singleOrBatchAccessPaths,
} from '../core/schema.js';
import { compileRegex, freeRegex } from '../core/search.js';
import type { ResourceStore } from '../core/store.js';
import { isTotalFailure, runOverPaths } from './batch.js';
import { defineTool, type ToolCtx } from './define.js';

const EditSpecSchema = z
  .strictObject({
    oldText: z
      .string()
      .min(1, 'oldText required')
      .refine((val) => !isBlank(val), {
        message: 'oldText cannot be empty or whitespace-only',
      })
      .describe(
        'Exact literal text to locate in the file. Must include 3-5 lines of context to ensure uniqueness and avoid matching the wrong block.',
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
  lineRange: z
    .tuple([PositiveInt, PositiveInt])
    .optional()
    .describe('Line range [firstLine, lastLine] covering all applied edits'),
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
  lineRange?: [number, number];
}

function findEditMatch(
  content: string,
  oldText: string,
  ignoreWhitespace: boolean,
): TextRange | undefined {
  if (ignoreWhitespace) {
    // Make whitespace flexible (tolerate indentation/spacing differences)
    // without letting it cross line boundaries: a whitespace run that contains
    // a newline keeps at least one newline, so a single-line oldText cannot
    // match across a newline and a multi-line oldText cannot collapse onto one
    // line. Horizontal whitespace stays mandatory between word characters so
    // adjacent identifiers are not merged.
    const pattern = escapeRegexLiteral(oldText)
      .replace(/[^\S\n]*\n\s*/g, '[^\\S\\n]*\\n+[^\\S\\n]*')
      .replace(/(\w)[^\S\n]+(\w)/g, '$1[^\\S\\n]+$2')
      .replace(/[^\S\n]+/g, '[^\\S\\n]*');
    const regex = compileRegex(pattern, { caseSensitive: true });
    try {
      // The compiled regex is global, so lastIndex may point past a previous
      // exec — reset before searching.
      regex.lastIndex = 0;
      const match = regex.exec(content);

      if (match === null) return undefined;
      // RE2ExecArray types group 0 as optional. A successful match always has it;
      // an empty one would name a zero-length span, which cannot be replaced.
      const matched = match[0];
      if (matched === undefined || matched.length === 0) return undefined;

      return {
        startIndex: match.index,
        length: matched.length,
      };
    } finally {
      // The compiled pattern owns wasm memory re2-wasm never reclaims on its
      // own; its lifetime is this one match.
      freeRegex(regex);
    }
  }

  const index = content.indexOf(oldText);
  if (index === -1) {
    return undefined;
  }

  return {
    startIndex: index,
    length: oldText.length,
  };
}

function replaceEditMatch(content: string, match: TextRange, newText: string): string {
  return (
    content.slice(0, match.startIndex) + newText + content.slice(match.startIndex + match.length)
  );
}

/**
 * Compute the 1-indexed line range of changed lines in `modified` relative to
 * `original`, using a common-prefix/suffix line scan. This is a conservative
 * bound (it widens to cover independent changes between matching bookends), but
 * it is computed against the FINAL content so it is not skewed by earlier edits
 * inserting or removing lines — which the per-edit merge could not account for.
 */
function computeChangedLineRange(original: string, modified: string): [number, number] | undefined {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const minLen = Math.min(origLines.length, modLines.length);

  let firstChanged = -1;
  for (let i = 0; i < minLen; i++) {
    if (origLines[i] !== modLines[i]) {
      firstChanged = i;
      break;
    }
  }
  if (firstChanged === -1 && origLines.length === modLines.length) return undefined;
  if (firstChanged === -1) firstChanged = minLen; // pure append/trim at the tail

  let lastChangedMod = modLines.length - 1;
  let lastChangedOrig = origLines.length - 1;
  while (
    lastChangedMod > firstChanged &&
    lastChangedOrig >= 0 &&
    modLines[lastChangedMod] === origLines[lastChangedOrig]
  ) {
    lastChangedMod--;
    lastChangedOrig--;
  }

  // When the modified content is a strict prefix of the original (a tail trim on
  // a file with no final newline), the loop above never runs and lastChangedMod
  // lands one below firstChanged. Clamp so the range is never inverted.
  return [firstChanged + 1, Math.max(firstChanged, lastChangedMod) + 1];
}

function buildEditFileValue(
  validPath: string,
  meta: EditFileMetadata,
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
    ...(result.lineRange ? { lineRange: result.lineRange } : {}),
  };
}

function finalizeEditResult(
  originalContent: string,
  updatedContent: string,
  appliedEdits: number,
  unmatchedEdits: string[],
  lineRange: EditResult['lineRange'],
): EditResult {
  const { linesAdded, linesRemoved } =
    appliedEdits > 0
      ? computeDiffStats(originalContent, updatedContent)
      : { linesAdded: 0, linesRemoved: 0 };

  return {
    content: updatedContent,
    appliedEdits,
    unmatchedEdits,
    linesAdded,
    linesRemoved,
    ...(lineRange ? { lineRange } : {}),
  };
}

/** {@link WrittenFileMeta}, with `resourceUri` widened: an edit that matched
 *  nothing has no updated content to point at. */
type EditFileMetadata = Omit<WrittenFileMeta, 'resourceUri'> & {
  resourceUri: string | undefined;
};

function buildEditFileMetadata(
  content: string,
  validPath: string,
  appliedEdits: number,
  resourceStore: ResourceStore | undefined,
): EditFileMetadata {
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

  for (const edit of edits) {
    const match = findEditMatch(newContent, edit.oldText, ignoreWhitespace);

    if (!match) {
      unmatchedEdits.push(edit.oldText);
      continue;
    }

    newContent = replaceEditMatch(newContent, match, edit.newText);
    appliedEdits += 1;
  }

  // Compute the line range against the final content so earlier edits whose
  // lines were shifted by later edits are still covered.
  const lineRange = appliedEdits > 0 ? computeChangedLineRange(content, newContent) : undefined;

  return finalizeEditResult(content, newContent, appliedEdits, unmatchedEdits, lineRange);
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
      ...(meta.resourceLink ? { resourceLink: meta.resourceLink } : {}),
    };
  }

  if (editResult.unmatchedEdits.length > 0) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `${editResult.unmatchedEdits.length} edit(s) failed to match. Verify oldText matches exact file content.`,
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
    if (v.unmatchedEdits && v.unmatchedEdits.length > 0) return `${basename(v.path)} NO MATCH`;
    const added = v.linesAdded ?? 0;
    const removed = v.linesRemoved ?? 0;
    if (added === 0 && removed === 0) return `${basename(v.path)} (no change)`;
    return `${basename(v.path)} +${String(added)} -${String(removed)}`;
  });

  const failed = results.filter((r) => r.error !== undefined).length;
  const ok = results.length - failed;
  const ratio = failed > 0 ? ` (${String(ok)}/${String(results.length)} ok)` : '';
  return `edit: ${tokens.join(' · ')}${ratio}${tag}`;
}

export const EDIT = defineTool({
  name: 'edit',
  title: 'Edit Files',
  description:
    'Apply sequential literal string replacements to one or more files (max 5 files per call). ' +
    'Modes: single-file { path, edits } or per-file { files: [{ path, edits }] }. ' +
    'oldText must match file content exactly; include 3-5 lines of surrounding context to ensure uniqueness. ' +
    'Set dryRun=true to preview diffs without writing. ' +
    'For glob-based bulk regex replacement across many files, use replace_text instead.',
  input: EditFileInputSchema,
  output: EditFileOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
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

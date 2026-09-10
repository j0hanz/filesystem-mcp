import * as z from 'zod/v4';

import { isSafeGlobSyntax } from './glob.js';
import { MIME_KINDS } from './mime.js';
import { ENTRY_TYPES } from './primitives.js';
import { MAX_SEARCH_DEPTH } from './util.js';

// Runtime: full ISO-8601 UTC; emits the standard `date-time` format on the wire
// (no AJV warning — it is a known format, unlike sha256_hex / base64url).
// No `id` on this or any other shared schema below: an `id` hoists the schema
// into `$defs` and leaves a `$ref` at every use site, which is exactly the wire
// weight `toDraft202012` (tools/define.ts) publishes without.
export const IsoDateTime = z.iso.datetime().meta({
  description: 'ISO 8601 UTC date-time string (e.g. 2024-01-15T12:00:00.000Z)',
  // `format: "date-time"` already pins the value; zod's ~330-char calendar
  // regex is pure wire weight. Runtime validation still runs it — this
  // suppresses the emitted keyword only.
  pattern: undefined,
});

// pattern (not z.hash('sha256')) so no `format: "sha256_hex"` keyword is emitted;
// the SDK's AJV validator warns on that unknown format at every server start.
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({ description: 'SHA-256 digest as a 64-character lowercase hex string' });

export const NonNegInt = z
  .int({ message: 'Must be integer' })
  .nonnegative({ message: 'Must be ≥ 0' });

export const PositiveInt = z
  .int({ message: 'Must be integer' })
  .positive({ message: 'Must be > 0' });

const FILE_TYPES = ENTRY_TYPES;
export type FileType = (typeof FILE_TYPES)[number];
export const FileType = z.enum(FILE_TYPES);

const FILE_KINDS = MIME_KINDS;
export type FileKind = (typeof FILE_KINDS)[number];
export const FileKind = z.enum(FILE_KINDS);

const MAX_PATH_LENGTH = 4096;

const SHELL_METACHAR_RE = /[\n\r;|`]/;

export const isBlank = (val: string): boolean => val.trim().length === 0;

function refineSafeText(
  label: string,
  specific: (val: string) => string | undefined,
): (val: string, ctx: z.RefinementCtx) => void {
  return (val, ctx) => {
    if (val.length === 0) return;
    const issue = isBlank(val)
      ? `${label} cannot be empty or whitespace-only`
      : val.includes('\0')
        ? `${label} cannot contain null bytes`
        : (specific(val) ??
          (SHELL_METACHAR_RE.test(val)
            ? `${label} contains prohibited characters (newlines or shell metacharacters)`
            : undefined));
    if (issue !== undefined) {
      ctx.addIssue({ code: 'custom', message: issue, fatal: true });
    }
  };
}

const PathBase = z
  .string()
  .min(1, { message: 'Path required' })
  .max(MAX_PATH_LENGTH, { message: `Path too long (max ${MAX_PATH_LENGTH} chars)` })
  .superRefine(
    refineSafeText('Path', (val) =>
      val.includes('..') ? 'Directory traversal sequences ("..") are forbidden' : undefined,
    ),
  )
  .describe('File or directory path inside an allowed workspace root.');

export const OptionalPath = PathBase.optional();
export const RequiredPath = PathBase;

export const SafeGlobPattern = z
  .string()
  .min(1, { message: 'Pattern required' })
  .max(1000, { message: 'Max 1000 chars' })
  .superRefine(
    refineSafeText('Pattern', (val) =>
      isSafeGlobSyntax(val) ? undefined : 'Invalid glob or unsafe path (absolute/.. forbidden)',
    ),
  )
  .describe('Relative glob pattern under the search root (e.g. "**/*.ts", "src/**/*.js").')
  .meta({ examples: ['**/*.ts', 'src/**/*.js', '*.{ts,tsx}'] });

// Only the fields whose key does not already say what they hold carry a
// description. A `.describe('Name')` on `name` costs every client tokens to
// learn nothing.
export const FileInfoSchema = z.strictObject({
  name: z.string(),
  path: z.string(),
  type: FileType,
  // A directory's own inode size says nothing about what is inside it — 0 on
  // Windows, 4096 on ext4 — so say so rather than letting a caller read it as
  // "empty". This caveat used to live in stat's text summary, which is gone.
  size: NonNegInt.describe('Bytes; meaningless for a directory — use list for its contents'),
  tokenEstimate: NonNegInt.optional().describe('Rough token estimate; use to pre-screen read cost'),
  created: IsoDateTime,
  modified: IsoDateTime,
  accessed: IsoDateTime,
  permissions: z.string(),
  isHidden: z.boolean(),
  mimeType: z.string().optional(),
  symlinkTarget: z.string().optional().describe('Target (symlink)'),
});

export const OperationSummarySchema = z.strictObject({
  total: NonNegInt,
  succeeded: NonNegInt,
  failed: NonNegInt,
});

export const PerFileErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  suggestion: z.string().optional(),
});

/** One entry of a tool's `failures[]`: the path that failed and why. */
export const PathFailureSchema = z.strictObject({
  path: z.string(),
  error: PerFileErrorSchema,
});

export function validateReadRange(
  value: {
    head?: number | undefined;
    tail?: number | undefined;
    startLine?: number | undefined;
    endLine?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const hasHead = value.head !== undefined;
  const hasTail = value.tail !== undefined;
  const hasStart = value.startLine !== undefined;
  const hasEnd = value.endLine !== undefined;

  if (hasHead && (hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['head'],
      message:
        "Cannot use 'head' with 'startLine'/'endLine'. Use either 'head' alone or 'startLine'/'endLine' together.",
      input: value,
    });
  }
  if (hasTail && (hasHead || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['tail'],
      message:
        "Cannot use 'tail' with 'head'/'startLine'/'endLine'. Use 'tail' alone, or 'startLine'/'endLine' without 'tail'.",
      input: value,
    });
  }
  if (hasEnd && !hasStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: "'endLine' requires 'startLine' to be set. Provide both together.",
      input: value,
    });
  }
  const effectiveStart = value.startLine ?? 1;
  if (value.endLine !== undefined && value.endLine < effectiveStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: "'endLine' must be >= 'startLine'",
      input: value,
    });
  }
}

export function defaultFalseBoolean(description: string): z.ZodDefault<z.ZodBoolean> {
  return z.boolean().default(false).describe(description);
}

export const includeHiddenField = (): z.ZodDefault<z.ZodBoolean> =>
  defaultFalseBoolean('Include hidden items (starting with .)');
export const includeIgnoredField = (): z.ZodDefault<z.ZodBoolean> =>
  defaultFalseBoolean('Include ignored items (node_modules, .git, etc).');
export const maxDepthField = (): z.ZodOptional<z.ZodNumber> =>
  z
    .uint32()
    .min(0)
    .max(MAX_SEARCH_DEPTH)
    .optional()
    .describe('Max directory depth to scan; 0 = base directory only, omit for unlimited');

const DEFAULT_MAX_BATCH = 1000;

export type SingleOrBatchShape<TExtra extends z.ZodRawShape> = TExtra & {
  path: z.ZodOptional<typeof RequiredPath>;
  paths: z.ZodOptional<z.ZodArray<typeof RequiredPath>>;
};

export function singleOrBatchPathsInput<TExtra extends z.ZodRawShape>(
  extra: TExtra,
): z.ZodObject<SingleOrBatchShape<TExtra>> {
  const shape: z.ZodRawShape = {
    ...extra,
    path: RequiredPath.optional().describe('Single file path; mutually exclusive with paths'),
    paths: z
      .array(RequiredPath)
      .min(1)
      .max(DEFAULT_MAX_BATCH)
      .optional()
      .describe(
        `Array of file paths for batch mode (max ${String(DEFAULT_MAX_BATCH)}); mutually exclusive with path`,
      ),
  };

  const base = z.strictObject(shape).superRefine((value, ctx) => {
    const hasPath = value['path'] !== undefined;
    const hasPaths = value['paths'] !== undefined;

    if (!hasPath && !hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Either 'path' or 'paths' must be provided",
        input: value,
      });
      return;
    }
    if (hasPath && hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['paths'],
        message: "Cannot use both 'path' and 'paths'",
        input: value,
      });
    }
  });

  // Mirror the superRefine above on the wire: exactly one input mode. `{}` and
  // `path`+`paths` both fail this oneOf, matching the runtime rule.
  return base.meta({
    oneOf: [{ required: ['path'] }, { required: ['paths'] }],
  }) as z.ZodObject<SingleOrBatchShape<TExtra>>;
}

/**
 * Extract the filesystem paths from a {@link singleOrBatchPathsInput} shape
 * (`{ path?, paths?, files?[{path}] }`) for the executor's access-grant
 * pre-check. Exactly one of the three is set (enforced by the schema's
 * superRefine), so they are checked in priority order.
 */
export function singleOrBatchAccessPaths(args: {
  path?: string | undefined;
  paths?: string[] | undefined;
  files?: readonly { path: string }[] | undefined;
}): string[] {
  if (args.path) return [args.path];
  if (args.paths) return [...args.paths];
  if (args.files) return args.files.map((f) => f.path);
  return [];
}

// `args` is the exact argument object the one producer (read's
// buildReadContinuation) emits, not a free-form record: a bare
// `z.record(z.string(), z.unknown())` renders as `additionalProperties: {}`,
// which carries no validation keyword and constrains nothing — the Inspector's
// portability check flags it, and a client cannot tell what to pass. Widen this
// (to a union) only when a second tool starts emitting continuations.
export const ContinuationSchema = z.strictObject({
  tool: z.string().describe('Tool name to call for the next chunk'),
  args: z
    .strictObject({ path: z.string(), startLine: PositiveInt, endLine: PositiveInt })
    .describe('Ready-to-use arguments for the next call; pass verbatim'),
  hint: z.string().describe('One-sentence description of the data still remaining to be read'),
});

// ponytail: charset regex, not z.base64url() — the SDK's AJV warns on the
// unknown `base64url` format; the server's own decode (cursor.ts) is the real
// validation, so loosening the client-facing schema to the alphabet is safe.
const base64urlCursor = z.string().regex(/^[A-Za-z0-9_-]+$/);

// Ships once per paginated tool — wording is budgeted (TOOL-SURFACE-002).
export const CursorSchema = base64urlCursor
  .optional()
  .describe(
    'Opaque pagination cursor; pass unchanged for the next page. Pages slice one snapshot ' +
      'taken on the first call; it expires after ~60s — re-request without a cursor if rejected.',
  );

export const NextCursorSchema = base64urlCursor
  .optional()
  .describe('Cursor for the next page; omitted when this is the final page.');

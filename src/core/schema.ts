import * as z from 'zod/v4';

import { isSafeGlobSyntax } from './glob.ts';
import { MAX_SEARCH_DEPTH } from './util.ts';

export const PositiveInt = z
  .int({ message: 'Must be integer' })
  .positive({ message: 'Must be > 0' });

const MAX_PATH_LENGTH = 4096;

const LINE_BREAK_RE = /[\n\r]/;

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
          (LINE_BREAK_RE.test(val) ? `${label} cannot contain line breaks` : undefined));
    if (issue !== undefined) {
      ctx.addIssue({ code: 'custom', message: issue, fatal: true });
    }
  };
}

// Only a whole `..` segment is traversal. `..` inside a segment
// (`[...slug]`, `v1..2.md`) is a plain file name; PathGuard re-checks
// containment on the resolved path regardless.
const hasTraversalSegment = (val: string): boolean => val.split(/[\\/]/u).includes('..');

export const RequiredPath = z
  .string()
  .min(1, { message: 'Path required' })
  .max(MAX_PATH_LENGTH, { message: `Path too long (max ${MAX_PATH_LENGTH} chars)` })
  .superRefine(
    refineSafeText('Path', (val) =>
      hasTraversalSegment(val) ? 'Directory traversal sequences ("..") are forbidden' : undefined,
    ),
  )
  .describe('File or directory path inside an allowed workspace root.');

export const OptionalPath = RequiredPath.optional();

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
  .meta({ examples: ['**/*.ts', 'src/**/*.js', '**/*.{ts,tsx}'] });

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

export const IncludeHidden = defaultFalseBoolean('Include hidden items (starting with .)');
export const IncludeIgnored = defaultFalseBoolean(
  'Include ignored items (node_modules, .git, etc).',
);
export const MaxDepth = z
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

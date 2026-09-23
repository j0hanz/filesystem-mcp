import { ProtocolErrorCode } from '@modelcontextprotocol/server';

export const ErrorCode = {
  ACCESS_DENIED: 'ACCESS_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  NOT_FILE: 'NOT_FILE',
  NOT_DIRECTORY: 'NOT_DIRECTORY',
  TOO_LARGE: 'TOO_LARGE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  INVALID_PATTERN: 'INVALID_PATTERN',
  INVALID_INPUT: 'INVALID_INPUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SYMLINK_NOT_ALLOWED: 'SYMLINK_NOT_ALLOWED',
  IO_ERROR: 'IO_ERROR',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface Problem {
  readonly code: ErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly suggestion?: string;
}

interface ProblemFactoryOptions {
  path?: string;
  suggestion?: string;
}

function build(code: ErrorCode, message: string, opts: ProblemFactoryOptions = {}): Problem {
  return {
    code,
    message,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.suggestion !== undefined ? { suggestion: opts.suggestion } : {}),
  };
}

export const Problem = {
  invalidInput: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.INVALID_INPUT, msg, o),
  accessDenied: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.ACCESS_DENIED, msg, o),
  cancelled: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.CANCELLED, msg, o),
  fromUnknown(error: unknown, defaultCode: ErrorCode, path?: string): Problem {
    const problem = classify(error);
    const shouldOverride =
      problem.code === ErrorCode.UNKNOWN || problem.code === ErrorCode.IO_ERROR;
    const code = shouldOverride ? defaultCode : problem.code;
    const suggestion =
      (shouldOverride ? DEFAULT_SUGGESTIONS[code] : undefined) ??
      problem.suggestion ??
      DEFAULT_SUGGESTIONS[problem.code];
    const resolvedPath = path ?? problem.path;
    return build(code, problem.message, {
      ...(resolvedPath !== undefined ? { path: resolvedPath } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    });
  },
  toText(error: unknown, defaultCode: ErrorCode): string {
    return formatDetailedError(Problem.fromUnknown(error, defaultCode));
  },
} as const;

const DEFAULT_SUGGESTIONS: Readonly<Partial<Record<ErrorCode, string>>> = {
  [ErrorCode.ACCESS_DENIED]: 'Run list_roots to list allowed directories.',
  [ErrorCode.NOT_FOUND]: 'Run list or find_files to verify the path.',
  [ErrorCode.NOT_FILE]: 'Target is a directory, not a file.',
  [ErrorCode.NOT_DIRECTORY]: 'Target is a file, not a directory.',
  [ErrorCode.TOO_LARGE]: 'Use head/tail or line ranges to read partially.',
  [ErrorCode.TIMEOUT]: 'Reduce scope, depth, or maxResults.',
  [ErrorCode.INVALID_PATTERN]: 'Check syntax and escape special characters.',
  [ErrorCode.PERMISSION_DENIED]: 'Check OS file permissions.',
  [ErrorCode.SYMLINK_NOT_ALLOWED]: 'Symlink escapes allowed directories.',
};

export const ERRNO_MAP: Readonly<Record<string, ErrorCode>> = {
  ENOENT: ErrorCode.NOT_FOUND,
  EACCES: ErrorCode.PERMISSION_DENIED,
  EPERM: ErrorCode.PERMISSION_DENIED,
  ENOTDIR: ErrorCode.NOT_DIRECTORY,
  EISDIR: ErrorCode.NOT_FILE,
  ELOOP: ErrorCode.SYMLINK_NOT_ALLOWED,
  ENAMETOOLONG: ErrorCode.INVALID_INPUT,
  ETIMEDOUT: ErrorCode.TIMEOUT,
  EMFILE: ErrorCode.IO_ERROR,
  ENFILE: ErrorCode.IO_ERROR,
  EBUSY: ErrorCode.IO_ERROR,
  ENOTEMPTY: ErrorCode.NOT_DIRECTORY,
  EEXIST: ErrorCode.INVALID_INPUT,
  EINVAL: ErrorCode.INVALID_INPUT,
};

const ERRNO_RE = /^E[A-Z]+$/;

// NOT_FOUND is in here (not just ENOENT) because a dangling symlink whose
// target sits inside an allowed root surfaces as an FsError NOT_FOUND. Skipping
// the entry is the point of a listing; rethrowing would fail the whole listing.
export const SKIPPABLE_FS_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.ACCESS_DENIED,
  ErrorCode.NOT_FOUND,
  // OS-level EACCES/EPERM on a symlink target during a listing is exactly as
  // skippable as the other three codes.
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.SYMLINK_NOT_ALLOWED,
]);

export const SKIPPABLE_ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'ELOOP']);

/**
 * Walk `error` and its `cause` chain once for the three facts error handling
 * needs: an abort anywhere, a timeout anywhere, and the FIRST errno seen.
 * `visited` guards a cyclic chain. A node that reads as an abort or a timeout
 * never also contributes its errno.
 */
function scanCauseChain(error: unknown): {
  aborted: boolean;
  timedOut: boolean;
  errno: { code: string; path?: string } | undefined;
} {
  const visited = new Set<unknown>();
  let aborted = false;
  let timedOut = false;
  let errno: { code: string; path?: string } | undefined;

  for (
    let current: unknown = error;
    current !== undefined && current !== null && !visited.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    visited.add(current);
    if (!(current instanceof Error)) continue;
    const raw = (current as { code?: unknown }).code;
    const code = typeof raw === 'string' ? raw : undefined;
    if (current.name === 'AbortError' || code === 'ABORT_ERR') {
      aborted = true;
    } else if (current.name === 'TimeoutError' || code === 'ETIMEDOUT') {
      timedOut = true;
    } else if (errno === undefined && code !== undefined && ERRNO_RE.test(code)) {
      const { path } = current as NodeJS.ErrnoException;
      errno = { code, ...(typeof path === 'string' ? { path } : {}) };
    }
  }

  return { aborted, timedOut, errno };
}

/** The scan's facts as a Problem: an abort wins, then a timeout, then errno. */
function classifyCauseChain(error: unknown): Problem {
  const message = formatUnknownErrorMessage(error);
  const { aborted, timedOut, errno } = scanCauseChain(error);
  if (aborted) return Problem.cancelled(message);
  if (timedOut) return build(ErrorCode.TIMEOUT, message);
  if (errno !== undefined) {
    return build(ERRNO_MAP[errno.code] ?? ErrorCode.IO_ERROR, message, {
      ...(errno.path !== undefined ? { path: errno.path } : {}),
    });
  }
  return build(ErrorCode.UNKNOWN, message);
}

export function isFsError(error: unknown): error is FsError {
  return error instanceof FsError;
}

/** FsError traces to a caller-supplied argument; anything else is server-side. */
export function fsErrorCode(error: unknown): ProtocolErrorCode {
  return isFsError(error) ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError;
}

function classify(error: unknown): Problem {
  if (error === null || error === undefined) {
    return build(ErrorCode.UNKNOWN, 'Unknown error');
  }
  if (isFsError(error)) return error.problem;
  // No `ZodError` branch, deliberately. Tool arguments are validated by
  // `safeParse` inside the SDK's validator seam (tools/define.ts), which never
  // throws — it hands back `z.prettifyError`'s string — and nothing in `src/`
  // calls `.parse()`. A ZodError reaching here would fall through to
  // UNKNOWN with Zod's raw JSON-dump `.message`, so if a `.parse()`
  // is ever added, add the branch back with it rather than discovering this.
  if (!(error instanceof Error)) {
    return build(ErrorCode.UNKNOWN, typeof error === 'string' ? error : '[non-Error thrown]');
  }
  return classifyCauseChain(error);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  if (!('code' in error)) return false;
  const { code } = error as { code?: unknown };
  return typeof code === 'string';
}

/** True when `error` is a Node errno error with code `ENOENT` (path not found). */
export function isNotFoundErrno(error: unknown): error is NodeJS.ErrnoException {
  return isNodeError(error) && error.code === 'ENOENT';
}

/**
 * Rethrow when `error` reads as cancelled. Answers the question directly rather
 * than through `classify`, which allocated a Problem — and ran
 * `formatUnknownErrorMessage`, i.e. a `JSON.stringify` on a non-Error — for a
 * boolean. This sits in eight catch blocks, several inside per-entry scan loops.
 */
export function rethrowIfAborted(error: unknown): void {
  if (isFsError(error)) {
    if (error.code === ErrorCode.CANCELLED) throw error;
    return;
  }
  if (scanCauseChain(error).aborted) throw error;
}

export function formatUnknownErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return `[non-serializable: ${Object.prototype.toString.call(error)}]`;
  }
}

export function normalizeUnknownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatUnknownErrorMessage(error));
}

function formatDetailedError(
  error: Pick<Problem, 'code' | 'message' | 'path' | 'suggestion'>,
): string {
  const lines: string[] = [`${error.code}: ${error.message}`];
  if (error.path && !error.message.includes(error.path)) {
    lines.push(error.path);
  }
  if (error.suggestion) {
    lines.push(error.suggestion);
  }
  return lines.join('\n');
}

export class FsError extends Error {
  readonly problem: Problem;

  constructor(code: ErrorCode, message: string, path?: string, cause?: unknown) {
    super(message, cause === undefined ? {} : { cause });
    const suggestion = DEFAULT_SUGGESTIONS[code];
    this.problem = {
      code,
      message,
      ...(path !== undefined ? { path } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    };
    this.name = 'FsError';
  }

  get code(): ErrorCode {
    return this.problem.code;
  }
}

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
  timeout: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.TIMEOUT, msg, o),
  cancelled: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.CANCELLED, msg, o),
  unknown: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.UNKNOWN, msg, o),
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
  toText(error: unknown, defaultCode: ErrorCode): { code: ErrorCode; text: string } {
    const resolved = Problem.fromUnknown(error, defaultCode);
    return { code: resolved.code, text: formatDetailedError(resolved) };
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

type ClassificationSignal =
  | { kind: 'abort' }
  | { kind: 'timeout' }
  | { kind: 'errno'; errno: string; syscall?: string; path?: string }
  | { kind: 'unknown' };

function readErrnoCode(value: unknown): string | undefined {
  if (!(value instanceof Error)) return undefined;
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string') return undefined;
  return code;
}

function isAbortSingle(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  if (value.name === 'AbortError') return true;
  const code = readErrnoCode(value);
  return code === 'ABORT_ERR';
}

function isTimeoutSingle(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  if (value.name === 'TimeoutError') return true;
  return readErrnoCode(value) === 'ETIMEDOUT';
}

function readSignalSingle(value: unknown): ClassificationSignal | undefined {
  if (isAbortSingle(value)) return { kind: 'abort' };
  if (isTimeoutSingle(value)) return { kind: 'timeout' };
  const code = readErrnoCode(value);
  if (code !== undefined && ERRNO_RE.test(code)) {
    const v = value as NodeJS.ErrnoException;
    return {
      kind: 'errno',
      errno: code,
      ...(typeof v.syscall === 'string' ? { syscall: v.syscall } : {}),
      ...(typeof v.path === 'string' ? { path: v.path } : {}),
    };
  }
  return undefined;
}

function walkCauseChain(error: unknown): ClassificationSignal {
  let current: unknown = error;
  const visited = new Set<unknown>();
  let abortSeen = false;
  let timeoutSeen = false;
  let errnoSignal: ClassificationSignal | undefined;

  while (current !== undefined && current !== null && !visited.has(current)) {
    const signal = readSignalSingle(current);
    if (signal !== undefined) {
      if (signal.kind === 'abort') abortSeen = true;
      else if (signal.kind === 'timeout') timeoutSeen = true;
      else if (signal.kind === 'errno' && errnoSignal === undefined) {
        errnoSignal = signal;
      }
    }
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }

  if (abortSeen) return { kind: 'abort' };
  if (timeoutSeen) return { kind: 'timeout' };
  if (errnoSignal !== undefined) return errnoSignal;
  return { kind: 'unknown' };
}

function buildProblemFromSignal(signal: ClassificationSignal, error: unknown): Problem {
  const message = formatUnknownErrorMessage(error);
  switch (signal.kind) {
    case 'abort':
      return Problem.cancelled(message);
    case 'timeout':
      return Problem.timeout(message);
    case 'errno': {
      const code = ERRNO_MAP[signal.errno] ?? ErrorCode.IO_ERROR;
      return build(code, message, {
        ...(signal.path !== undefined ? { path: signal.path } : {}),
      });
    }
    case 'unknown':
      return Problem.unknown(message);
    default: {
      const _exhaustive: never = signal;
      return _exhaustive;
    }
  }
}

export function isFsError(error: unknown): error is FsError {
  if (!(error instanceof Error) || error.name !== 'FsError') return false;
  if (!('problem' in error)) return false;
  const p = (error as { problem?: unknown }).problem;
  if (p === null || typeof p !== 'object') return false;
  const c = p as Record<string, unknown>;
  return typeof c['code'] === 'string' && typeof c['message'] === 'string';
}

/** FsError traces to a caller-supplied argument; anything else is server-side. */
export function fsErrorCode(error: unknown): ProtocolErrorCode {
  return isFsError(error) ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError;
}

/**
 * Structural discriminator for SDK error classes (`ProtocolError`, `SdkError`).
 * Checks `name` + `code` properties rather than `instanceof` so discrimination
 * survives cross-realm / multi-SDK-copy conditions where the prototype chain
 * breaks. Mirrors the isFsError pattern.
 */
export function hasErrorShape(
  error: unknown,
  name: string,
): error is Error & { code: string | number } {
  if (!(error instanceof Error) || error.name !== name) return false;
  const c = (error as { code?: unknown }).code;
  return typeof c === 'string' || typeof c === 'number';
}

function classify(error: unknown): Problem {
  if (error === null || error === undefined) {
    return Problem.unknown('Unknown error');
  }
  if (isFsError(error)) return error.problem;
  // No `ZodError` branch, deliberately. Tool arguments are validated by
  // `safeParse` inside the SDK's validator seam (tools/define.ts), which never
  // throws — it hands back `z.prettifyError`'s string — and nothing in `src/`
  // calls `.parse()`. A ZodError reaching here would fall through to
  // `Problem.unknown` with Zod's raw JSON-dump `.message`, so if a `.parse()`
  // is ever added, add the branch back with it rather than discovering this.
  if (!(error instanceof Error)) {
    return Problem.unknown(typeof error === 'string' ? error : '[non-Error thrown]');
  }
  const signal = walkCauseChain(error);
  return buildProblemFromSignal(signal, error);
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

function isAbortError(error: unknown): boolean {
  return classify(error).code === ErrorCode.CANCELLED;
}

export function rethrowIfAborted(error: unknown): void {
  if (isAbortError(error)) throw error;
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
    Object.setPrototypeOf(this, FsError.prototype);
  }

  get code(): ErrorCode {
    return this.problem.code;
  }
}

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
  BINARY_FILE: 'BINARY_FILE',
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
  path?: string | undefined;
  suggestion?: string | undefined;
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
  /** `rows` lets an operation read some errnos its own way (e.g. `DELETE_ERRNOS`). */
  fromUnknown(error: unknown, defaultCode: ErrorCode, path?: string, rows?: ErrnoRows): Problem {
    const problem = classify(error, rows);
    const shouldOverride =
      problem.code === ErrorCode.UNKNOWN || problem.code === ErrorCode.IO_ERROR;
    const code = shouldOverride ? defaultCode : problem.code;
    const suggestion =
      (shouldOverride ? DEFAULT_SUGGESTIONS[code] : undefined) ??
      problem.suggestion ??
      DEFAULT_SUGGESTIONS[problem.code];
    return build(code, problem.message, { path: path ?? problem.path, suggestion });
  },
  toText(error: unknown, defaultCode: ErrorCode): string {
    return formatDetailedError(Problem.fromUnknown(error, defaultCode));
  },
} as const;

/** One path's outcome: either a value or the Problem that stopped it. */
export type PerPathResult<T> = { path: string; value: T } | { path: string; error: Problem };

/** For a path outside the roots only: other ACCESS_DENIED refusals explain themselves. */
export const OUTSIDE_ROOTS_SUGGESTION =
  'Use a path under an allowed root; list_roots names them. A path outside them needs a new startup root or an accepted grant.';

/** For an out-of-root path no grant is offered for: a system folder, a drive root, outside FS_ROOT_BOUNDARY. */
export const NO_GRANT_SUGGESTION =
  'Use a path under an allowed root; list_roots names them. No grant is offered for this location; only a startup root can admit it.';

const DEFAULT_SUGGESTIONS: Readonly<Partial<Record<ErrorCode, string>>> = {
  [ErrorCode.NOT_FOUND]: 'Run list or find_files to verify the path.',
  [ErrorCode.NOT_FILE]: 'Target is a directory, not a file.',
  [ErrorCode.NOT_DIRECTORY]: 'Target is a file, not a directory.',
  [ErrorCode.TOO_LARGE]: 'Use head/tail or line ranges to read partially.',
  [ErrorCode.TIMEOUT]: 'Reduce scope, depth, or maxResults.',
  [ErrorCode.INVALID_PATTERN]: 'Check syntax and escape special characters.',
  [ErrorCode.BINARY_FILE]:
    'Text tools do not accept binary files. read returns the whole file with binary: true.',
  [ErrorCode.PERMISSION_DENIED]: 'Check OS file permissions.',
  [ErrorCode.SYMLINK_NOT_ALLOWED]: 'Symlink escapes allowed directories.',
};

const ERRNO_MAP: Readonly<Record<string, ErrorCode>> = {
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

/** An errno's reading for one operation: its code and the message that replaces the raw errno text. */
interface ErrnoRow {
  readonly code: ErrorCode;
  readonly message: string;
}

/** Rows an operation declares over ERRNO_MAP, applied by `Problem.fromUnknown`. */
export type ErrnoRows = Readonly<Record<string, ErrnoRow>>;

const DIRECTORY_NOT_EMPTY: ErrnoRow = {
  code: ErrorCode.INVALID_INPUT,
  message: 'Directory not empty. Set recursive: true.',
};

/**
 * `delete`'s reading: a missing path says so as `stat` does, without the
 * syscall text, and every way the OS refuses a non-recursive directory removal
 * (ENOTEMPTY, EISDIR on unlink, EEXIST on some platforms) names `recursive`.
 */
export const DELETE_ERRNOS: ErrnoRows = {
  ENOENT: { code: ErrorCode.NOT_FOUND, message: 'Path not found' },
  ENOTEMPTY: DIRECTORY_NOT_EMPTY,
  EISDIR: DIRECTORY_NOT_EMPTY,
  EEXIST: DIRECTORY_NOT_EMPTY,
};

/** The way forward when a folder's delete needs a confirmation the client cannot show. */
export const ASK_PERSON_TO_DELETE =
  'Ask the person to delete the folder, or to agree to you emptying it first. ' +
  'Only the person can remove protected files in it, which listings hide.';

const DIRECTORY_NOT_EMPTY_NO_CONFIRM: ErrnoRow = {
  code: ErrorCode.INVALID_INPUT,
  message: `Directory not empty. ${ASK_PERSON_TO_DELETE}`,
};

/** `DELETE_ERRNOS` on a client that cannot confirm, where naming `recursive` leads only to the next refusal. */
export const DELETE_ERRNOS_NO_CONFIRM: ErrnoRows = {
  ...DELETE_ERRNOS,
  ENOTEMPTY: DIRECTORY_NOT_EMPTY_NO_CONFIRM,
  EISDIR: DIRECTORY_NOT_EMPTY_NO_CONFIRM,
  EEXIST: DIRECTORY_NOT_EMPTY_NO_CONFIRM,
};

const ERRNO_RE = /^E[A-Z]+$/;

// NOT_FOUND is in here (not just ENOENT) because a dangling symlink whose
// target sits inside an allowed root surfaces as an FsError NOT_FOUND. Skipping
// the entry is the point of a listing; rethrowing would fail the whole listing.
const SKIPPABLE_FS_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.ACCESS_DENIED,
  ErrorCode.NOT_FOUND,
  // OS-level EACCES/EPERM on a symlink target during a listing is exactly as
  // skippable as the other three codes.
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.SYMLINK_NOT_ALLOWED,
]);

// Derived, not hand-maintained: an errno is skippable exactly when the code
// ERRNO_MAP classifies it as a code in SKIPPABLE_FS_CODES. EPERM maps to
// PERMISSION_DENIED, so OS-level EPERM is as skippable as EACCES — the hand-
// maintained list above omitted it and diverged from its own comment.
const SKIPPABLE_ERRNOS: ReadonlySet<string> = new Set(
  Object.entries(ERRNO_MAP)
    .filter(([, code]) => SKIPPABLE_FS_CODES.has(code))
    .map(([errno]) => errno),
);

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

/** The scan's facts as a Problem: a timeout wins over an outer abort wrapper, then abort, then errno. */
export function classifyCauseChain(error: unknown, rows?: ErrnoRows): Problem {
  const message = formatUnknownErrorMessage(error);
  const { aborted, timedOut, errno } = scanCauseChain(error);
  if (timedOut) return build(ErrorCode.TIMEOUT, message);
  if (aborted) return Problem.cancelled(message);
  if (errno !== undefined) {
    const row = rows?.[errno.code];
    if (row !== undefined) return build(row.code, row.message, { path: errno.path });
    return build(ERRNO_MAP[errno.code] ?? ErrorCode.IO_ERROR, message, { path: errno.path });
  }
  return build(ErrorCode.UNKNOWN, message);
}

export function isFsError(error: unknown): error is FsError {
  return error instanceof FsError;
}

function classify(error: unknown, rows?: ErrnoRows): Problem {
  if (error === null || error === undefined) {
    return build(ErrorCode.UNKNOWN, 'Unknown error');
  }
  if (isFsError(error)) return error.problem;
  // No `ZodError` branch, deliberately. Tool arguments are validated by the
  // SDK from the zod schema `defineTool` hands it (tools/define.ts); the SDK
  // formats issues itself and never throws a ZodError into a handler, and
  // nothing in `src/` calls `.parse()`. A ZodError reaching here would fall
  // through to UNKNOWN with Zod's raw JSON-dump `.message`, so if a
  // `.parse()` is ever added, add the branch back with it rather than
  // discovering this.
  if (!(error instanceof Error)) {
    return build(ErrorCode.UNKNOWN, typeof error === 'string' ? error : '[non-Error thrown]');
  }
  return classifyCauseChain(error, rows);
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

/** True when `error` says "absent", in either shape: a Node ENOENT or a guarded NOT_FOUND. */
export const isMissing = (error: unknown): boolean =>
  isNotFoundErrno(error) || (isFsError(error) && error.code === ErrorCode.NOT_FOUND);

/** `promise`'s value, or `undefined` when it rejects as absent (`isMissing`); any other rejection propagates. */
export const unlessMissing = <T>(promise: Promise<T>): Promise<T | undefined> =>
  promise.catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return undefined;
  });

/** True when `error` is a Node errno error whose code is in `SKIPPABLE_ERRNOS`. */
export function isSkippableErrno(error: unknown): error is NodeJS.ErrnoException {
  return isNodeError(error) && error.code !== undefined && SKIPPABLE_ERRNOS.has(error.code);
}

/** True when a walk may skip the entry `error` stopped: a skippable FsError code or errno. */
export function isSkippable(error: unknown): boolean {
  return isFsError(error) ? SKIPPABLE_FS_CODES.has(error.code) : isSkippableErrno(error);
}

/**
 * Rethrow when `error` reads as cancelled. Answers the question directly rather
 * than through `classify`, which allocated a Problem — and ran
 * `formatUnknownErrorMessage`, i.e. a `JSON.stringify` on a non-Error — for a
 * boolean. This sits in eight catch blocks, several inside per-entry scan loops.
 */
export function rethrowIfAborted(error: unknown): void {
  if (isFsError(error)) {
    if (error.code === ErrorCode.CANCELLED || error.code === ErrorCode.TIMEOUT) throw error;
    return;
  }
  const { aborted, timedOut } = scanCauseChain(error);
  if (aborted || timedOut) throw error;
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

export function formatDetailedError(
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

  /** `suggestion` replaces the code's default for a thrower that knows the better next step. */
  constructor(
    code: ErrorCode,
    message: string,
    path?: string,
    cause?: unknown,
    suggestion: string | undefined = DEFAULT_SUGGESTIONS[code],
  ) {
    super(message, cause === undefined ? {} : { cause });
    this.problem = build(code, message, { path, suggestion });
    this.name = 'FsError';
  }

  get code(): ErrorCode {
    return this.problem.code;
  }
}

/** `label` qualifies the size parenthetical; `suggestion` overrides the TOO_LARGE default remedy. */
export function createTooLargeError(
  bytesRead: number,
  maxSize: number,
  requestedPath: string,
  { label, suggestion }: { label?: string; suggestion?: string } = {},
): FsError {
  return new FsError(
    ErrorCode.TOO_LARGE,
    `File exceeds size limit (${bytesRead} > ${maxSize} bytes${label ? `, ${label}` : ''})`,
    requestedPath,
    undefined,
    suggestion,
  );
}

/** The text path's binary refusal; `read` catches its code to offer `binary: true`. */
export const BINARY_FILE_MESSAGE = 'Binary file detected.';

export function isBinaryRefusal(error: unknown): error is FsError {
  return error instanceof FsError && error.code === ErrorCode.BINARY_FILE;
}

/** The refusal of a file whose bytes a writer would not round-trip as UTF-8. */
export const NOT_UTF8_MESSAGE = 'Binary or non-UTF-8 file detected.';

/** The refusal `read`, `edit`, `patch` and `diff` give for a binary verdict. */
export function binaryRefusal(kind: 'binary' | 'utf16', filePath: string): FsError {
  return kind === 'utf16'
    ? new FsError(
        ErrorCode.INVALID_INPUT,
        'UTF-16 text file detected; convert it to UTF-8 first.',
        filePath,
      )
    : new FsError(ErrorCode.BINARY_FILE, BINARY_FILE_MESSAGE, filePath);
}

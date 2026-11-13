// Settings: the one owner of the flag-beats-env rule (ADR-017).
//
// `parseArgs` (cli.ts) assigns flag values onto `cli` once at startup. Each
// Setting has one named read here that answers flag, else `FS_*` variable,
// else default, parsed, and warns once about a rejected value. Reads resolve
// on every call: flags land after module load, and tests change the
// environment per case. No other module applies the flag-beats-env rule;
// path-discovery.ts reads a directory-list variable by name only when it is
// handed no raw value.
//
// This module imports only `path-utils.ts`, which imports no repo module, so
// any core module can read it without a cycle. Keep it that way.
import { warnInvalidSetting } from './path-utils.ts';

const MIB = 1024 * 1024;

/**
 * How an operator gives this server a root. Lives here rather than beside its
 * readers because both ends of the repo need it — `index.ts` prints it at
 * startup, `list_roots` returns it when it has nothing to list — and this
 * module is the one place either can import without a cycle.
 */
export const NO_POSITIONAL_ROOTS_GUIDANCE =
  'No root directories given. Pass directory arguments, set FS_ALLOWED_DIRS, or use --allow-cwd. A client with elicitation can also call a tool with a concrete path and approve the requested grant.';

export interface CliOverrides {
  /** `--log-level` */
  logLevel?: string;
  /** `--max-file-size` (raw string; validated by the reader like the env var) */
  maxFileSize?: string;
  /** `--tool-timeout` (raw string; validated by the reader like the env var) */
  toolTimeout?: string;
  /** `--root-boundary` */
  rootBoundary?: string;
  /** `--allow-sensitive` */
  allowSensitive?: boolean;
  /** `--walk-cwd` */
  allowCwdWalk?: boolean;
  /** `--allow-cwd` */
  allowCwd?: boolean;
  /** `--allow-missing-roots` */
  allowMissingRoots?: boolean;
  /** `--deny` entries (merged with FS_DENYLIST by the reader) */
  denyPatterns?: readonly string[];
  /** `--allow` entries (merged with FS_ALLOWLIST by the reader; relieve built-ins only) */
  allowPatterns?: readonly string[];
}

/** Written once by cli.ts; an absent key means "not set on the command line". Read it through the Setting reads below; only the two pattern lists are read directly (sensitive.ts). */
export const cli: CliOverrides = {};

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
 * Deadline for one call of a tool that walks or reads the disk (list, stat,
 * read, find_files, search_text, edit, replace_text). Read per call, so the
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

export type LoggingLevel =
  'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

// RFC 5424 severities, most severe first. A message is emitted when its
// severity is at least as high as the configured minimum.
export const LOG_LEVEL_ORDER: readonly LoggingLevel[] = [
  'emergency',
  'alert',
  'critical',
  'error',
  'warning',
  'notice',
  'info',
  'debug',
];

function isLoggingLevel(value: string): value is LoggingLevel {
  return (LOG_LEVEL_ORDER as readonly string[]).includes(value);
}

function parseLogLevel(raw: string | undefined): LoggingLevel {
  if (!raw) return 'info';
  // `warn` is the common short form; the canonical RFC 5424 level is `warning`.
  if (raw === 'warn') return 'warning';
  if (isLoggingLevel(raw)) return raw;
  warnInvalidSetting('FS_LOG_LEVEL', raw, LOG_LEVEL_ORDER.join('|'), 'info');
  return 'info';
}

// Seeded to the value `parseLogLevel(undefined)` returns, so an unset
// FS_LOG_LEVEL — the initial `cachedRaw` — needs no first-call special case.
let cachedRaw: string | undefined;
let cachedLevel: LoggingLevel = 'info';

/**
 * Minimum severity that reaches stderr, from `FS_LOG_LEVEL` / `--log-level`.
 * Memoized on the raw value, not resolved once: `cli.logLevel` lands after
 * `parseArgs`, and writes happen before that. Keying on the raw string keeps it
 * live while the invalid-value warning fires once per setting, not per line.
 */
export function getLogLevel(): LoggingLevel {
  const raw = (cli.logLevel ?? process.env['FS_LOG_LEVEL'])?.trim().toLowerCase();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedLevel = parseLogLevel(raw);
  }
  return cachedLevel;
}

/** Raw root-boundary path list (`--root-boundary`, `FS_ROOT_BOUNDARY`), unparsed. */
export function getRootBoundary(): string | undefined {
  return cli.rootBoundary ?? process.env['FS_ROOT_BOUNDARY'];
}

/** Whether missing allowed roots are tolerated (`--allow-missing-roots`, `FS_ALLOW_MISSING_ROOTS`). */
export function getAllowMissingRoots(): boolean {
  return (
    cli.allowMissingRoots ??
    parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS')
  );
}

/** Whether built-in sensitive-file patterns are suppressed (`--allow-sensitive`, `FS_ALLOW_SENSITIVE`). */
export function getAllowSensitive(): boolean {
  return (
    cli.allowSensitive ?? parseTrueEnvFlag(process.env['FS_ALLOW_SENSITIVE'], 'FS_ALLOW_SENSITIVE')
  );
}

/** Whether `--allow-cwd` walks up from cwd to the project root (`--walk-cwd`, `FS_ALLOW_CWD_WALK`). */
export function getAllowCwdWalk(): boolean {
  return (
    cli.allowCwdWalk ?? parseTrueEnvFlag(process.env['FS_ALLOW_CWD_WALK'], 'FS_ALLOW_CWD_WALK')
  );
}

/** Whether the working directory is added as an allowed root (`--allow-cwd`, `--walk-cwd`, `FS_ALLOW_CWD_WALK`). */
export function getAllowCwd(): boolean {
  return (
    Boolean(cli.allowCwd) ||
    Boolean(cli.allowCwdWalk) ||
    parseTrueEnvFlag(process.env['FS_ALLOW_CWD_WALK'], 'FS_ALLOW_CWD_WALK')
  );
}

/**
 * The per-request-envelope protocol revision this server serves next to the
 * 2025 `initialize` handshake. The SDK keeps its own copy internal
 * (`FIRST_MODERN_PROTOCOL_VERSION`), so this is asserted against SDK
 * behaviour in `cli.test.ts` rather than imported.
 */
export const MODERN_PROTOCOL_REVISION = '2026-07-28';

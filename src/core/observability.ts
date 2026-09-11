import { cli } from './config.js';
import { warnInvalidSetting } from './primitives.js';

export type LoggingLevel =
  'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

// RFC 5424 severities, most severe first. A message is emitted when its
// severity is at least as high as the configured minimum.
const LEVEL_ORDER: readonly LoggingLevel[] = [
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
  return (LEVEL_ORDER as readonly string[]).includes(value);
}

function parseLogLevel(raw: string | undefined): LoggingLevel {
  if (!raw) return 'info';
  // `warn` is the common short form; the canonical RFC 5424 level is `warning`.
  if (raw === 'warn') return 'warning';
  if (isLoggingLevel(raw)) return raw;
  warnInvalidSetting('FS_LOG_LEVEL', raw, LEVEL_ORDER.join('|'), 'info');
  return 'info';
}

// Seeded to the value `parseLogLevel(undefined)` returns, so an unset
// LOG_LEVEL — the initial `cachedRaw` — needs no first-call special case.
let cachedRaw: string | undefined;
let cachedLevel: LoggingLevel = 'info';

/**
 * Minimum severity that reaches stderr, from `FS_LOG_LEVEL` / `--log-level`.
 * Memoized on the raw value, not resolved once: `cli.logLevel` lands after
 * `parseArgs`, and writes happen before that. Keying on the raw string keeps it
 * live while the invalid-value warning fires once per setting, not per line.
 */
function getLogLevel(): LoggingLevel {
  const raw = (cli.logLevel ?? process.env['FS_LOG_LEVEL'])?.trim().toLowerCase();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedLevel = parseLogLevel(raw);
  }
  return cachedLevel;
}

/** True when `level` is at least as severe as the configured minimum. */
function isLevelEnabled(level: LoggingLevel, minimum: LoggingLevel = getLogLevel()): boolean {
  return LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(minimum);
}

function write(level: LoggingLevel, message: string, args: readonly unknown[]): void {
  if (!isLevelEnabled(level)) return;
  const prefix = `[${level}]`;
  console.error(`${prefix} ${message}`, ...args);
}

export const Logger = {
  emit: (level: LoggingLevel, message: string) => {
    write(level, message, []);
  },
  info: (message: string, ...args: unknown[]) => {
    write('info', message, args);
  },
  warn: (message: string, ...args: unknown[]) => {
    write('warning', message, args);
  },
  error: (message: string, ...args: unknown[]) => {
    write('error', message, args);
  },
  debug: (message: string, ...args: unknown[]) => {
    write('debug', message, args);
  },
};

export function logRuntimeFailure(id: string, scope: string, method: string, error: unknown): void {
  write('error', `Runtime failure: ${id} [${scope}.${method}]`, [error]);
}

import { getLogLevel, LOG_LEVEL_ORDER, type LoggingLevel } from './config.ts';
import { formatUnknownErrorMessage } from './errors.ts';

/** True when `level` is at least as severe as the configured minimum. */
function isLevelEnabled(level: LoggingLevel, minimum: LoggingLevel = getLogLevel()): boolean {
  return LOG_LEVEL_ORDER.indexOf(level) <= LOG_LEVEL_ORDER.indexOf(minimum);
}

function write(level: LoggingLevel, message: string, args: readonly unknown[]): void {
  if (!isLevelEnabled(level)) return;
  const prefix = `[${level}]`;
  console.error(`${prefix} ${message}`, ...args);
}

/**
 * A client-supplied value (a JSON-RPC id, a `traceparent`, a tool's own log
 * message) made safe for one stderr line: a control character or a Unicode
 * line/paragraph separator (U+2028/U+2029, which `\p{Cc}` misses) would let
 * a caller forge extra log lines, and an unbounded value would let it flood
 * one. `max` bounds the value; pass `Infinity` for free text that is only
 * flattened.
 */
export function sanitizeLogField(value: string, max = 128): string {
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, max);
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

/** A failed notify means the connection went away: nothing to recover, so log and drop it. */
export function voidSend(send: Promise<unknown> | undefined, label: string, fields?: object): void {
  void send?.catch((error: unknown) => {
    Logger.debug(`${label} not delivered`, { ...fields, error: formatUnknownErrorMessage(error) });
  });
}

export function logRuntimeFailure(id: string, scope: string, method: string, error: unknown): void {
  write('error', `Runtime failure: ${id} [${scope}.${method}]`, [error]);
}

import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseArgs as utilParseArgs } from 'node:util';

import { printHelpAndExit, printVersionAndExit } from './cli-help.js';
import { cli } from './core/config.js';
import { formatUnknownErrorMessage } from './core/errors.js';
import { cliFmt, padEndVisible } from './core/fmt.js';
import {
  getReservedDeviceNameForPath,
  isWindowsDriveRelativePath,
  normalizePath,
} from './core/path-utils.js';
import { PathGuard } from './core/path.js';
import { IS_WINDOWS, parseTrueEnvFlag } from './core/primitives.js';
import { getMaxTextFileSize } from './core/util.js';
import { registeredTools } from './tools/index.js';

// ════════════════════════════════════════════════════════════
// Path & Config Utilities — pure functions and error types
// ════════════════════════════════════════════════════════════

export class CliExitError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliExitError';
    this.exitCode = exitCode;
  }
}

function validateCliPath(inputPath: string): void {
  if (inputPath.includes('\0')) {
    throw new CliExitError('Path contains null bytes.', 1);
  }

  if (isWindowsDriveRelativePath(inputPath)) {
    throw new CliExitError(
      'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
      1,
    );
  }

  const reserved = getReservedDeviceNameForPath(inputPath);
  if (reserved) {
    throw new CliExitError(`Windows reserved device name not allowed: ${reserved}.`, 1);
  }
}

async function validateDirectoryPath(inputPath: string, allowMissing = false): Promise<string> {
  const normalized = normalizePath(inputPath);

  let stats: Stats;
  try {
    stats = await stat(normalized);
  } catch (error) {
    if (allowMissing) return normalized;
    // Node's own message already names the syscall and the errno.
    throw new Error(`Cannot access directory ${inputPath}: ${formatUnknownErrorMessage(error)}`, {
      cause: error,
    });
  }

  if (!stats.isDirectory()) throw new Error(`${inputPath} is not a directory`);
  return normalized;
}

async function normalizeAndValidateDirs(
  paths: readonly string[],
  allowMissing = false,
): Promise<string[]> {
  const normalized: string[] = [];
  for (const p of paths) {
    normalized.push(await validateDirectoryPath(p, allowMissing));
  }
  return deduplicateAllowedDirectories(normalized);
}

function normalizeCliExitMessage(error: unknown): string {
  const rawMessage = formatUnknownErrorMessage(error);
  return rawMessage.startsWith('Error:') ? rawMessage : `Error: ${rawMessage}`;
}

function deduplicateAllowedDirectories(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduplicated: string[] = [];

  for (const dir of dirs) {
    const key = IS_WINDOWS ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(dir);
  }

  return deduplicated;
}

function parsePortOption(raw: unknown): number | undefined {
  // '' reads as unset: FS_PORT set-but-empty (compose templating) means stdio.
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CliExitError(`Error: --port / FS_PORT must be an integer between 1 and 65535`, 1);
  }
  return n;
}

const CLI_PARSER_CONFIG = {
  options: {
    'allow-cwd': { type: 'boolean', default: false },
    'read-only': { type: 'boolean', default: false },
    safe: { type: 'boolean', default: false },
    'print-config': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    'log-level': { type: 'string' },
    'http-host': { type: 'string' },
    'api-key': { type: 'string' },
    'allow-sensitive': { type: 'boolean', default: false },
    'root-boundary': { type: 'string' },
    'max-file-size': { type: 'string' },
    'walk-cwd': { type: 'boolean', default: false },
    deny: { type: 'string', multiple: true },
    'allow-missing-roots': { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: true,
} as const;

export async function parseArgs(): Promise<{
  allowedDirs: string[];
  allowCwd: boolean;
  port: number | undefined;
  readOnly: boolean;
  printConfig: boolean;
  json: boolean;
  httpHost: string | undefined;
  apiKey: string | undefined;
}> {
  try {
    const parsed = utilParseArgs(CLI_PARSER_CONFIG);

    if (parsed.values.help) {
      printHelpAndExit();
    }

    if (parsed.values.version) {
      printVersionAndExit();
    }

    for (const positional of parsed.positionals) {
      validateCliPath(positional);
    }

    const vals = parsed.values as Record<string, unknown>;
    // `--http-host` and `--api-key` are returned to the caller and handed to
    // the server as config. Every other flag lands in the CLI-override store
    // (core/config.ts) — the one owner of the flag-beats-env rule — which deep
    // core readers (path, sensitive, observability, util) consult before
    // falling back to the operator's environment. Nothing writes process.env.
    const httpHost =
      typeof vals['http-host'] === 'string' ? vals['http-host'] : process.env['FS_HTTP_HOST'];
    const apiKey =
      typeof vals['api-key'] === 'string' ? vals['api-key'] : process.env['FS_API_KEY'];

    if (typeof vals['log-level'] === 'string') cli.logLevel = vals['log-level'];
    if (typeof vals['max-file-size'] === 'string') cli.maxFileSize = vals['max-file-size'];
    if (typeof vals['root-boundary'] === 'string') cli.rootBoundary = vals['root-boundary'];
    if (vals['allow-sensitive'] === true) cli.allowSensitive = true;
    if (vals['walk-cwd'] === true) cli.allowCwdWalk = true;
    if (vals['allow-missing-roots'] === true) cli.allowMissingRoots = true;
    if (Array.isArray(vals['deny'])) {
      const denyPatterns = vals['deny']
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (denyPatterns.length > 0) cli.denyPatterns = [...new Set(denyPatterns)];
    }

    const allowCwd =
      (vals['allow-cwd'] as boolean) ||
      (vals['walk-cwd'] as boolean) ||
      parseTrueEnvFlag(process.env['FS_ALLOW_CWD_WALK'], 'FS_ALLOW_CWD_WALK');
    const readOnly = (vals['read-only'] as boolean) || (vals['safe'] as boolean);
    const printConfig = vals['print-config'] as boolean;
    const json = vals['json'] as boolean;
    const port = parsePortOption(parsed.values.port ?? process.env['FS_PORT']);
    const allowMissingRoots =
      (vals['allow-missing-roots'] as boolean) ||
      parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS');

    let allowedDirs: string[] = [];
    try {
      allowedDirs =
        parsed.positionals.length > 0
          ? await normalizeAndValidateDirs(parsed.positionals, allowMissingRoots)
          : [];
    } catch (error: unknown) {
      throw new CliExitError(normalizeCliExitMessage(error), 1);
    }

    return {
      allowedDirs,
      allowCwd,
      port,
      readOnly,
      printConfig,
      json,
      httpHost,
      apiKey,
    };
  } catch (error: unknown) {
    if (error instanceof CliExitError) {
      throw error;
    }

    throw new CliExitError(normalizeCliExitMessage(error), 1);
  }
}

// ════════════════════════════════════════════════════════════
// Effective config reporting — prints the resolved server config
// ════════════════════════════════════════════════════════════

export async function runPrintConfig(options: {
  allowedDirs: string[];
  allowCwd: boolean;
  readOnly: boolean;
  json: boolean;
  /** Resolved `--port`. Present means the launch this reports on is an HTTP bind. */
  port?: number;
  httpHost?: string;
  apiKey?: string;
}): Promise<void> {
  const write = (s: string) => process.stdout.write(s);

  const pathGuard = new PathGuard({
    allowCwd: options.allowCwd,
    cliAllowedDirs: options.allowedDirs,
  });
  await pathGuard.recomputeAllowedDirectories();
  const allowedRoots = pathGuard.getAllowedDirectories();

  const tools = registeredTools(options.readOnly).map((t) => t.name);

  // Derived, never assumed: `--print-config --port 3000` reports the HTTP bind
  // that `--port` would actually have started, not the stdio default.
  const config = {
    transport:
      options.port !== undefined
        ? `http://${options.httpHost ?? '127.0.0.1'}:${String(options.port)}`
        : 'stdio',
    readOnly: options.readOnly,
    allowedRoots,
    tools,
    apiKey: options.apiKey ? '***' : null,
    limits: { maxFileSizeBytes: getMaxTextFileSize() },
  };

  if (options.json) {
    write(JSON.stringify(config, null, 2));
  } else {
    const key = (k: string) => padEndVisible(cliFmt.cyan(k), 14);
    write(`${key('transport:')}${config.transport}\n`);
    write(`${key('readOnly:')}${cliFmt.bool(config.readOnly)}\n`);
    write(`${key('apiKey:')}${cliFmt.dim(config.apiKey ?? 'none')}\n`);
    write(`${key('allowedRoots:')}${config.allowedRoots.join(', ') || cliFmt.dim('(none)')}\n`);
    write(`${key('tools:')}${cliFmt.dim(config.tools.join(', '))}\n`);
    write(`${key('maxFileSize:')}${cliFmt.yellow(String(config.limits.maxFileSizeBytes))}\n`);
  }
}

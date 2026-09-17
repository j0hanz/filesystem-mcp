import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseArgs as utilParseArgs } from 'node:util';

import { printHelpAndExit, printVersionAndExit } from './cli-help.ts';
import { cli } from './core/config.ts';
import { formatUnknownErrorMessage } from './core/errors.ts';
import {
  getReservedDeviceNameForPath,
  isWindowsDriveRelativePath,
  normalizePath,
  parseTrueEnvFlag,
} from './core/path-utils.ts';
import { PathGuard } from './core/path.ts';
import { getMaxTextFileSize } from './core/util.ts';
import { registeredTools } from './tools/index.ts';

// ════════════════════════════════════════════════════════════
// Path & Config Utilities — pure functions and error types
// ════════════════════════════════════════════════════════════

export class CliExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliExitError';
  }
}

function validateCliPath(inputPath: string): void {
  if (inputPath.includes('\0')) {
    throw new CliExitError('Path contains null bytes.');
  }

  if (isWindowsDriveRelativePath(inputPath)) {
    throw new CliExitError(
      'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
    );
  }

  const reserved = getReservedDeviceNameForPath(inputPath);
  if (reserved) {
    throw new CliExitError(`Windows reserved device name not allowed: ${reserved}.`);
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

// No dedupe here: PathGuard's `normalizeAllowedDirectories` already Set-dedupes
// the normalized set, and containment checks are case-insensitive where the
// filesystem is.
async function normalizeAndValidateDirs(
  paths: readonly string[],
  allowMissing = false,
): Promise<string[]> {
  const normalized: string[] = [];
  for (const p of paths) {
    normalized.push(await validateDirectoryPath(p, allowMissing));
  }
  return normalized;
}

function normalizeCliExitMessage(error: unknown): string {
  const rawMessage = formatUnknownErrorMessage(error);
  return rawMessage.startsWith('Error:') ? rawMessage : `Error: ${rawMessage}`;
}

function parsePortOption(raw: unknown): number | undefined {
  // '' reads as unset: FS_PORT set-but-empty (compose templating) means stdio.
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CliExitError(`Error: --port / FS_PORT must be an integer between 1 and 65535`);
  }
  return n;
}

const CLI_PARSER_CONFIG = {
  options: {
    'allow-cwd': { type: 'boolean', default: false },
    'read-only': { type: 'boolean', default: false },
    'print-config': { type: 'boolean', default: false },
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
    allow: { type: 'string', multiple: true },
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

    const v = parsed.values;
    // `--http-host` and `--api-key` are returned to the caller and handed to
    // the server as config. Every other flag lands in the CLI-override store
    // (core/config.ts) — the one owner of the flag-beats-env rule — which deep
    // core readers (path, sensitive, observability, util) consult before
    // falling back to the operator's environment. Nothing writes process.env.
    const httpHost = v['http-host'] ?? process.env['FS_HTTP_HOST'];
    const apiKey = v['api-key'] ?? process.env['FS_API_KEY'];
    if (v['log-level'] !== undefined) cli.logLevel = v['log-level'];
    if (v['max-file-size'] !== undefined) cli.maxFileSize = v['max-file-size'];
    if (v['root-boundary'] !== undefined) cli.rootBoundary = v['root-boundary'];
    if (v['allow-sensitive']) cli.allowSensitive = true;
    if (v['walk-cwd']) cli.allowCwdWalk = true;
    if (v['allow-missing-roots']) cli.allowMissingRoots = true;
    const patternList = (entries: readonly string[] | undefined): readonly string[] => [
      ...new Set((entries ?? []).map((entry) => entry.trim()).filter(Boolean)),
    ];
    const denyPatterns = patternList(v.deny);
    if (denyPatterns.length > 0) cli.denyPatterns = denyPatterns;
    const allowPatterns = patternList(v.allow);
    if (allowPatterns.length > 0) cli.allowPatterns = allowPatterns;

    const allowCwd =
      v['allow-cwd'] ||
      v['walk-cwd'] ||
      parseTrueEnvFlag(process.env['FS_ALLOW_CWD_WALK'], 'FS_ALLOW_CWD_WALK');
    const readOnly = v['read-only'];
    const printConfig = v['print-config'];
    const port = parsePortOption(v.port ?? process.env['FS_PORT']);
    const allowMissingRoots =
      v['allow-missing-roots'] ||
      parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS');

    let allowedDirs: string[] = [];
    try {
      allowedDirs =
        parsed.positionals.length > 0
          ? await normalizeAndValidateDirs(parsed.positionals, allowMissingRoots)
          : [];
    } catch (error: unknown) {
      throw new CliExitError(normalizeCliExitMessage(error));
    }

    return {
      allowedDirs,
      allowCwd,
      port,
      readOnly,
      printConfig,
      httpHost,
      apiKey,
    };
  } catch (error: unknown) {
    if (error instanceof CliExitError) {
      throw error;
    }

    throw new CliExitError(normalizeCliExitMessage(error));
  }
}

// ════════════════════════════════════════════════════════════
// Effective config reporting — prints the resolved server config as JSON
// ════════════════════════════════════════════════════════════

export async function runPrintConfig(options: {
  allowedDirs: string[];
  allowCwd: boolean;
  readOnly: boolean;
  /** Resolved `--port`. Present means the launch this reports on is an HTTP bind. */
  port?: number;
  httpHost?: string;
  apiKey?: string;
}): Promise<void> {
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

  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

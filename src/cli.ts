import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';

import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseArgs as utilParseArgs } from 'node:util';

import packageJson from '../package.json' with { type: 'json' };
import { printHelpAndExit, printVersionAndExit } from './cli-help.ts';
import { cli, MODERN_PROTOCOL_REVISION } from './core/config.ts';
import { formatUnknownErrorMessage, isNodeError } from './core/errors.ts';
import {
  getReservedDeviceNameForPath,
  IS_WINDOWS,
  isWindowsDrivePath,
  isWindowsDriveRelativePath,
  normalizePath,
} from './core/path-utils.ts';
import { PathGuard } from './core/path.ts';
import { describeSensitivePolicy } from './core/sensitive.ts';
import {
  getMaxInboundMessageBytes,
  getMaxTextFileSize,
  getToolTimeoutMs,
  parseTrueEnvFlag,
} from './core/util.ts';
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

  if (!IS_WINDOWS && isWindowsDrivePath(inputPath)) {
    throw new CliExitError(
      `Windows-style path received on a POSIX host (${process.platform}): ${inputPath}. Use a POSIX path.`,
    );
  }

  if (isWindowsDriveRelativePath(inputPath)) {
    throw new CliExitError(
      'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
    );
  }

  const reserved = IS_WINDOWS ? getReservedDeviceNameForPath(inputPath) : undefined;
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

const ENV_PLACEHOLDER = /^\$\{([A-Za-z_]\w*)\}$/;

/**
 * Plugin hosts start servers outside the project and substitute only the
 * variables they know: Antigravity CLI passes `${PWD}` through verbatim, and
 * Copilot CLI does when the launching shell exported no PWD (PowerShell, cmd).
 * A whole-argument `${NAME}` resolves from this process's environment; unset
 * or empty drops it, so it never becomes a bogus relative root.
 */
function expandEnvPlaceholder(arg: string): string[] {
  const name = ENV_PLACEHOLDER.exec(arg)?.[1];
  if (name === undefined) return [arg];
  const value = process.env[name];
  return value ? [value] : [];
}

const READ_ONLY_ROOTS_FLAG = '--read-only-roots';
const UNFILLED_USER_CONFIG = /^\$\{user_config\.[^}]+\}$/;

/**
 * An MCPB host spreads a multi-select setting into separate arguments, so a
 * repeatable flag would cover only the first and the rest would become writable
 * roots. Everything after the flag leaves the argument list before parsing. A
 * host passes an empty setting through as its literal placeholder.
 */
export function splitReadOnlyRoots(argv: readonly string[]): {
  args: string[];
  readOnlyRoots: string[];
} {
  const at = argv.indexOf(READ_ONLY_ROOTS_FLAG);
  if (at === -1) return { args: [...argv], readOnlyRoots: [] };
  return {
    args: argv.slice(0, at),
    readOnlyRoots: argv.slice(at + 1).filter((entry) => !UNFILLED_USER_CONFIG.test(entry)),
  };
}

/** Under `node -e` or `-p` and their long forms, arguments start one place earlier. */
function mainArgs(): string[] {
  const isEval = process.execArgv.some((arg) => ['-e', '--eval', '-p', '--print'].includes(arg));
  return process.argv.slice(isEval ? 1 : 2);
}

const CLI_PARSER_CONFIG = {
  options: {
    'allow-cwd': { type: 'boolean', default: false },
    'read-only': { type: 'boolean', default: false },
    'read-only-root': { type: 'string', multiple: true },
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
    'tool-timeout': { type: 'string' },
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
  readOnlyDirs: string[];
  printConfig: boolean;
  httpHost: string | undefined;
  apiKey: string | undefined;
}> {
  try {
    const { args, readOnlyRoots } = splitReadOnlyRoots(mainArgs());
    // An option here would silently become a folder and lose its own effect.
    const misplaced = readOnlyRoots.find((entry) => entry.startsWith('-'));
    if (misplaced !== undefined) {
      throw new CliExitError(
        `--read-only-roots must come last: "${misplaced}" looks like an option. Write a folder starting with - as ./${misplaced}`,
      );
    }
    const parsed = utilParseArgs({ ...CLI_PARSER_CONFIG, args });

    if (parsed.values.help) {
      printHelpAndExit();
    }

    if (parsed.values.version) {
      printVersionAndExit();
    }

    const positionals = parsed.positionals.flatMap(expandEnvPlaceholder);
    for (const positional of positionals) {
      validateCliPath(positional);
    }

    const v = parsed.values;
    // `--http-host` and `--api-key` are returned to the caller and handed to
    // the server as config. Every other flag lands in the CLI-override store
    // (core/config.ts) — the one owner of the flag-beats-env rule — which deep
    // core readers (path, sensitive, observability, util) consult before
    // falling back to the operator's environment. Nothing writes process.env.
    const httpHost = v['http-host'] ?? process.env['FS_HTTP_HOST'];
    // '' reads as unset, like FS_PORT: a set-but-empty FS_API_KEY (compose templating) means no key.
    const rawApiKey = v['api-key'] ?? process.env['FS_API_KEY'];
    const apiKey = rawApiKey === '' ? undefined : rawApiKey;
    if (v['log-level'] !== undefined) cli.logLevel = v['log-level'];
    if (v['max-file-size'] !== undefined) cli.maxFileSize = v['max-file-size'];
    if (v['tool-timeout'] !== undefined) cli.toolTimeout = v['tool-timeout'];
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
    const readOnly =
      v['read-only'] || parseTrueEnvFlag(process.env['FS_READ_ONLY'], 'FS_READ_ONLY');
    const printConfig = v['print-config'];
    const port = parsePortOption(v.port ?? process.env['FS_PORT']);
    const allowMissingRoots =
      v['allow-missing-roots'] ||
      parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS');

    // A read-only dir need not be an allowed root — the guard unions these
    // with FS_READ_ONLY_DIRS and matches by containment, so an out-of-root
    // entry denies nothing new. The same shape rules as positional roots
    // apply: a drive-relative or reserved-name value would silently name a
    // different directory than the operator meant.
    for (const raw of [...(v['read-only-root'] ?? []), ...readOnlyRoots]) {
      validateCliPath(raw);
      if (raw.trim() !== raw) {
        throw new CliExitError(
          `Read-only directory path has leading or trailing whitespace: ${raw}`,
        );
      }
    }
    // A missing folder only warns: a chosen one deleted later must not stop the
    // server. One replaced by a file does stop it.
    const listedReadOnly = await normalizeAndValidateDirs(readOnlyRoots, true);
    for (const dir of listedReadOnly) {
      await stat(dir).catch((error: unknown) => {
        const missing = isNodeError(error) && ['ENOENT', 'ENOTDIR'].includes(error.code ?? '');
        console.error(
          missing
            ? `[warning] Read-only folder not found: ${dir}. Check the spelling. It is protected if it appears.`
            : `[warning] Read-only folder cannot be checked: ${dir}: ${formatUnknownErrorMessage(error)}`,
        );
      });
    }
    const readOnlyDirs = [
      ...(await normalizeAndValidateDirs(v['read-only-root'] ?? [], allowMissingRoots)),
      ...listedReadOnly,
    ];

    const allowedDirs =
      positionals.length > 0 ? await normalizeAndValidateDirs(positionals, allowMissingRoots) : [];

    return {
      allowedDirs,
      allowCwd,
      port,
      readOnly,
      readOnlyDirs,
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

export async function runPrintConfig(
  options: Awaited<ReturnType<typeof parseArgs>>,
): Promise<void> {
  const pathGuard = new PathGuard({
    allowCwd: options.allowCwd,
    cliAllowedDirs: options.allowedDirs,
    readOnlyDirs: options.readOnlyDirs,
  });
  await pathGuard.recomputeAllowedDirectories();
  const allowedRoots = pathGuard.getRoots();

  const tools = registeredTools(options.readOnly).map((t) => t.name);

  // Derived, never assumed: `--print-config --port 3000` reports the HTTP bind
  // that `--port` would actually have started, not the stdio default.
  const config = {
    transport:
      options.port !== undefined
        ? `http://${options.httpHost ?? '127.0.0.1'}:${String(options.port)}`
        : 'stdio',
    readOnly: options.readOnly,
    readOnlyDirs: pathGuard.getReadOnlyDirs(),
    allowedRoots,
    tools,
    apiKey: options.apiKey ? '***' : null,
    limits: {
      maxFileSizeBytes: getMaxTextFileSize(),
      maxInboundMessageBytes: getMaxInboundMessageBytes(),
      toolTimeoutMs: getToolTimeoutMs(),
    },
    // What the binary negotiates with, so an era mismatch ("unsupported
    // protocol version") can be diagnosed without attaching a client. The
    // legacy list is the SDK's own; the modern revision has no SDK export.
    // The pins are exact (package.json), so the manifest value is the
    // installed one.
    protocol: {
      modern: MODERN_PROTOCOL_REVISION,
      legacy: { latest: LATEST_PROTOCOL_VERSION, supported: SUPPORTED_PROTOCOL_VERSIONS },
      sdk: {
        server: packageJson.dependencies['@modelcontextprotocol/server'],
        node: packageJson.dependencies['@modelcontextprotocol/node'],
        express: packageJson.dependencies['@modelcontextprotocol/express'],
      },
    },
    // Everything that can produce ACCESS_DENIED, read through the same
    // sources the guard and the matcher use (flag beats env).
    policy: {
      ...describeSensitivePolicy(),
      rootBoundary: cli.rootBoundary ?? process.env['FS_ROOT_BOUNDARY'] ?? null,
      allowMissingRoots:
        cli.allowMissingRoots ??
        parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS'),
    },
  };

  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

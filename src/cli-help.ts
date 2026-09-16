import packageJson from '../package.json' with { type: 'json' };
import { cliFmt, padEndVisible } from './core/fmt.js';
import { MUTATING_TOOL_NAMES } from './tools/index.js';

// Help text and its rendering. Split out of cli.ts so that module holds only
// argument parsing and directory validation: this file is static copy plus a
// formatter, and shares no state with the parser.

const { version: SERVER_VERSION } = packageJson;

interface HelpRow {
  flags: string;
  desc: string;
}

const OPTIONS_HELP: HelpRow[] = [
  { flags: '-h, --help', desc: 'Show this help message' },
  { flags: '-v, --version', desc: 'Show the server version' },
  { flags: '--allow-cwd', desc: 'Add the current working directory as an allowed root' },
  {
    flags: '--port <number>',
    desc: 'Start HTTP transport on this port (env: FS_PORT)',
  },
  {
    flags: '--read-only',
    desc: `Disable write tools: ${[...MUTATING_TOOL_NAMES].sort().join(', ')}`,
  },
  { flags: '--safe', desc: 'Alias for --read-only' },
  {
    flags: '--print-config',
    desc: 'Print the active configuration and exit (use with --json for machine output)',
  },
  { flags: '--json', desc: 'Output --print-config as JSON' },
  {
    flags: '--log-level <level>',
    desc: 'Log level, RFC 5424: debug|info|notice|warn|error|critical|alert|emergency (env: FS_LOG_LEVEL)',
  },
  { flags: '--http-host <host>', desc: 'HTTP server bind address (env: FS_HTTP_HOST)' },
  {
    flags: '--api-key <key>',
    desc: 'Require this API key on HTTP requests; prefer FS_API_KEY (argv is world-readable)',
  },
  {
    flags: '--allow-sensitive',
    desc: 'Allow access to sensitive system paths (env: FS_ALLOW_SENSITIVE)',
  },
  {
    flags: '--root-boundary <path>',
    desc: 'Require all allowed roots to fall under this path (env: FS_ROOT_BOUNDARY)',
  },
  {
    flags: '--max-file-size <bytes>',
    desc: 'Maximum file size for reads in bytes (env: FS_MAX_FILE_SIZE)',
  },
  { flags: '--walk-cwd', desc: 'Walk up from CWD to find a project root; implies --allow-cwd' },
  { flags: '--deny <pattern>', desc: 'Block paths matching this pattern; repeatable' },
  {
    flags: '--allow <pattern>',
    desc: 'Exempt a pattern from the built-in sensitive denylist; repeatable (env: FS_ALLOWLIST)',
  },
  {
    flags: '--allow-missing-roots',
    desc: 'Start even if configured allowed directories do not exist',
  },
];

const ENV_HELP: HelpRow[] = [
  {
    flags: 'FS_LOG_LEVEL',
    desc: 'Log level, RFC 5424: debug|info|notice|warn|error|critical|alert|emergency',
  },
  { flags: 'FS_PORT', desc: 'Start HTTP transport on this port (unset = stdio)' },
  { flags: 'FS_HTTP_HOST', desc: 'HTTP bind address' },
  { flags: 'FS_API_KEY', desc: 'HTTP API key' },
  {
    flags: 'FS_TRUST_PROXY',
    desc: 'Express trust-proxy setting: hop count or expression (unset = do not trust X-Forwarded-*)',
  },
  {
    flags: 'FS_ALLOW_SENSITIVE',
    desc: 'Allow sensitive system paths ("true" or "1" enables this)',
  },
  { flags: 'FS_ROOT_BOUNDARY', desc: 'Path prefix all allowed roots must fall under' },
  { flags: 'FS_MAX_FILE_SIZE', desc: 'Maximum file size for reads in bytes' },
  {
    flags: 'FS_ALLOWED_DIRS',
    desc: 'Allowed dirs: colon-separated (Unix), semicolon-separated (Windows)',
  },
  {
    flags: 'FS_ALLOW_CWD_WALK',
    desc: 'Walk up from CWD to find a project root ("true" or "1" enables this)',
  },
  { flags: 'FS_DENYLIST', desc: 'Paths/patterns to block, comma-separated' },
  {
    flags: 'FS_ALLOWLIST',
    desc: 'Patterns exempted from the built-in sensitive denylist, comma-separated; --deny/FS_DENYLIST still win',
  },
  {
    flags: 'FS_ALLOW_MISSING_ROOTS',
    desc: 'Start even if configured allowed directories do not exist ("true" or "1" enables this)',
  },
  {
    flags: 'FS_ALLOWED_HOSTS',
    desc: 'Comma-separated Host header values to accept (HTTP transport)',
  },
  { flags: 'FS_ALLOWED_ORIGINS', desc: 'Comma-separated origin hostnames for CORS' },
  {
    flags: 'FS_ALLOW_UNRESTRICTED_HOSTS',
    desc: 'Bind a wildcard host with no Host validation, accepts the risk ("true" or "1" enables this)',
  },
  { flags: 'FS_PUBLIC_URL', desc: 'Resource identifier URL for RFC 9728 discovery' },
  {
    flags: 'FS_RATE_LIMIT_RPM',
    desc: 'Per-client-IP requests/min (default 120 authenticated, 6000 keyless loopback; 1–100000)',
  },
  {
    flags: 'FS_MAX_REQUEST_BYTES',
    desc: 'Max HTTP request body bytes (default 4194304, 1024–268435456)',
  },
  {
    flags: 'FS_KEEPALIVE_TIMEOUT_MS',
    desc: 'HTTP keep-alive timeout; set above any fronting proxy idle timeout (default 5000, 1000–600000)',
  },
  {
    flags: 'FS_MAX_WATCHERS',
    desc: 'Max concurrent file watchers (default 256, 1–4096)',
  },
  {
    flags: 'FS_MAX_INLINE_MATCHES',
    desc: 'Deprecated and ignored; maxResults sets the search_text page size. Removed in the next major',
  },
  {
    flags: 'FS_MAX_READ_MANY_BYTES',
    desc: 'Max total bytes across one batch read (default 524288, 10240–104857600)',
  },
  { flags: 'FS_SEARCH_TIMEOUT_MS', desc: 'Search timeout in ms (default 5000, 100–60000)' },
  { flags: 'NO_COLOR', desc: 'Any value disables ANSI color output' },
  {
    flags: 'FS_REQUEST_STATE_KEY',
    desc: 'HMAC key for input_required state; optional outside fleet mode, shared and >=32 bytes in fleet mode',
  },
];

const EXAMPLES_HELP = [
  '$ filesystem-mcp /path/to/allowed/dir',
  '$ filesystem-mcp --allow-cwd',
  '$ filesystem-mcp /project/src /project/tests --allow-cwd',
  '$ filesystem-mcp --port 3000 /path/to/allowed/dir',
  '$ filesystem-mcp --read-only /data/readonly',
  '$ filesystem-mcp --print-config --json /project',
];

export function printHelpAndExit(): never {
  const { bold, dim, section, flag, yellow, cyan } = cliFmt;
  const COL = 27;

  const optRow = (flags: string, desc: string): string => {
    const colored = flags
      .replace(/<[^>]+>/g, (m) => yellow(m))
      .replace(/-{1,2}[\w-]+/g, (m) => flag(m));
    return `  ${padEndVisible(colored, COL)}${desc}`;
  };

  const envRow = (name: string, desc: string): string => {
    return `  ${padEndVisible(cyan(name), COL - 1)} ${desc}`;
  };

  const lines = [
    '',
    `${bold('Filesystem MCP')} ${dim(`v${SERVER_VERSION}`)}`,
    '',
    dim('Pass one or more directories to set the allowed access roots.'),
    '',
    section('Options:'),
    ...OPTIONS_HELP.map(({ flags, desc }) => optRow(flags, desc)),
    '',
    `${section('Environment variables:')} ${dim('(flags take precedence when both are set)')}`,
    ...ENV_HELP.map(({ flags, desc }) => envRow(flags, desc)),
    '',
    section('Examples:'),
    ...EXAMPLES_HELP.map((ex) => `  ${dim(ex)}`),
    '',
  ];

  process.stdout.write(lines.join('\n'));
  process.exit(0);
}

export function printVersionAndExit(): never {
  process.stdout.write(`${cliFmt.cyan(SERVER_VERSION)}\n`);
  process.exit(0);
}

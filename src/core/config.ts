// Resolved CLI-flag overrides — the one owner of the flag-beats-env rule.
//
// `parseArgs` (cli.ts) used to write flag values back into `process.env` so
// deep core readers (path, sensitive, observability, util) would pick them up.
// That made the environment a hidden mutable config bus. Instead, cli.ts
// assigns onto `cli` once at startup and each reader consults it first, falling
// back to the operator's environment. This module deliberately has zero imports
// so any core module can read it without a cycle.

/**
 * How an operator gives this server a root. Lives here rather than beside its
 * readers because both ends of the repo need it — `index.ts` prints it at
 * startup, `list_roots` returns it when it has nothing to list — and this
 * module is the one place either can import without a cycle.
 */
export const NO_POSITIONAL_ROOTS_GUIDANCE =
  'No positional directories specified. Configure roots with directory arguments, FS_ALLOWED_DIRS, or --allow-cwd. Modern clients with elicitation can also call a tool with a concrete path and approve the requested grant.';

export interface CliOverrides {
  /** `--log-level` */
  logLevel?: string;
  /** `--max-file-size` (raw string; validated by the reader like the env var) */
  maxFileSize?: string;
  /** `--root-boundary` */
  rootBoundary?: string;
  /** `--allow-sensitive` */
  allowSensitive?: boolean;
  /** `--walk-cwd` */
  allowCwdWalk?: boolean;
  /** `--allow-missing-roots` */
  allowMissingRoots?: boolean;
  /** `--deny` entries (merged with DENYLIST by the reader) */
  denyPatterns?: readonly string[];
  /** `--allow` entries (merged with FS_ALLOWLIST by the reader; relieve built-ins only) */
  allowPatterns?: readonly string[];
}

/** Written once by cli.ts; an absent key means "not set on the command line". */
export const cli: CliOverrides = {};

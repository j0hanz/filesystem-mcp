import type { InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import type * as z from 'zod/v4';

import { GuardedFileSystem } from '../src/core/fs.ts';
import type { LoggingLevel } from '../src/core/observability.ts';
import type { PathGuard } from '../src/core/path.ts';
import { PageSnapshotStore, ResourceStore } from '../src/core/store.ts';
import { UndoJournal } from '../src/core/undo.ts';
import type { DefinedToolOf, ToolCtx, ToolDef } from '../src/tools/define.ts';
import { makeGuard } from './helpers.ts';

type RunOutcome<O extends object> = Awaited<ReturnType<ToolDef<z.ZodType, O>['run']>>;
type RunResultOf<O extends object> = Exclude<RunOutcome<O>, InputRequiredResult>;

export interface LogLine {
  readonly level: LoggingLevel;
  readonly data: unknown;
  readonly logger?: string | undefined;
}

export interface ToolBodyOptions {
  /** Allowed roots for a fresh `PathGuard`; ignored when `guard` or `fs` is given. */
  readonly roots?: readonly string[];
  readonly guard?: PathGuard;
  /** A prepared filesystem (e.g. a subclass that fails one call); wins over `guard`/`roots`. */
  readonly fs?: GuardedFileSystem;
  readonly signal?: AbortSignal;
}

interface ToolBodyRun<O extends object> {
  readonly result: RunOutcome<O>;
  readonly logs: readonly LogLine[];
  readonly progress: readonly { current: number; total?: number }[];
}

/**
 * The tool body has no business with the SDK request context; a body that
 * reaches for it fails loudly here instead of reading a half-built stub.
 */
const NO_SERVER_CTX = new Proxy({} as ServerContext, {
  get(_target, key) {
    throw new Error(`tool-harness: the tool body read serverCtx.${String(key)}`);
  },
});

/**
 * Drive one tool's `run` with a minimal `ToolCtx` — no MCP pair, no executor.
 * Arguments go through the tool's own Zod schema so defaults apply as on the
 * wire; relative-path resolution, the access-grant round-trip, undo capture,
 * deadlines and response assembly are the executor's and are not exercised.
 */
async function runToolBody<I extends z.ZodType, O extends object>(
  tool: DefinedToolOf<I, O>,
  args: z.input<I>,
  options: ToolBodyOptions = {},
): Promise<ToolBodyRun<O>> {
  const fs =
    options.fs ?? new GuardedFileSystem(options.guard ?? (await makeGuard(options.roots ?? [])));
  const logs: LogLine[] = [];
  const progress: { current: number; total?: number }[] = [];
  const ctx: ToolCtx = {
    signal: options.signal ?? new AbortController().signal,
    requestId: 'tool-harness',
    fs,
    pageStore: new PageSnapshotStore(),
    undoJournal: new UndoJournal(),
    resourceStore: new ResourceStore(),
    log: (level, data, logger) => {
      logs.push({ level, data, logger });
    },
    onProgress: (p) => {
      progress.push(p);
    },
    serverCtx: NO_SERVER_CTX,
  };
  const parsed: z.infer<I> = tool.def.input.parse(args);
  const result = await tool.def.run(parsed, ctx);
  return { result, logs, progress };
}

/** `runToolBody` for a call expected to complete: rejects an `input_required` outcome. */
export async function runToolBodyResult<I extends z.ZodType, O extends object>(
  tool: DefinedToolOf<I, O>,
  args: z.input<I>,
  options: ToolBodyOptions = {},
): Promise<RunResultOf<O> & { readonly logs: readonly LogLine[] }> {
  const { result, logs } = await runToolBody(tool, args, options);
  if (isInputRequiredResult(result)) {
    throw new Error(`tool-harness: ${tool.name} asked for input`);
  }
  return { ...result, logs };
}

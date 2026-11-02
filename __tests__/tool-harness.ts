import type {
  ClientCapabilities,
  InputRequiredResult,
  RequestStateAccessor,
} from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { GuardedFileSystem } from '../src/core/fs.ts';
import {
  bindContextOf,
  type PendingState,
  requestStateCodec,
  type RoundBind,
} from '../src/core/input-required.ts';
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

/** One embedded Confirmation question, as the client would render it. */
interface ConfirmPrompt {
  readonly key: string;
  readonly message: string;
  readonly choices: readonly string[];
}

/** The bare elicitation result a client returns for one prompt. */
export type ConfirmAnswer =
  | { readonly action: 'accept'; readonly content: Record<string, unknown> }
  | { readonly action: 'decline' | 'cancel' };

/** Answer every prompt by accepting `choice`. */
export const choose = (choice: string) => (): ConfirmAnswer => ({
  action: 'accept',
  content: { choice },
});

export interface ToolBodyOptions {
  /** Allowed roots for a fresh `PathGuard`; ignored when `guard` or `fs` is given. */
  readonly roots?: readonly string[];
  readonly guard?: PathGuard;
  /** A prepared filesystem (e.g. a subclass that fails one call); wins over `guard`/`roots`. */
  readonly fs?: GuardedFileSystem;
  readonly signal?: AbortSignal;
  readonly pageStore?: PageSnapshotStore;
  readonly resourceStore?: ResourceStore;
  /** The journal `ctx.undoJournal` reads; `undo` needs one shared across calls. */
  readonly undoJournal?: UndoJournal;
  /** `ctx.transport`, which the executor sets from the hosting leg; unset is the in-memory pair. */
  readonly transport?: ToolCtx['transport'];
  readonly onProgress?: ToolCtx['onProgress'];
  /**
   * The fake client's answer to each Confirmation prompt. When set, an
   * `input_required` round is answered and the call retried with the verified
   * `requestState` and these `inputResponses`, as a client would; `round`
   * counts from 1. When unset, the first `input_required` ends the run.
   */
  readonly confirm?: (
    prompt: ConfirmPrompt,
    round: number,
  ) => ConfirmAnswer | Promise<ConfirmAnswer>;
  readonly clientCapabilities?: ClientCapabilities;
}

interface ToolBodyRun<O extends object> {
  readonly result: RunOutcome<O>;
  readonly logs: readonly LogLine[];
  readonly progress: readonly { current: number; total?: number }[];
  /** Confirmation rounds the fake client answered. */
  readonly rounds: number;
}

/** A Confirmation runs three rounds at most (confirmation.ts); more is a loop. */
const MAX_CONFIRM_ROUNDS = 3;

const HARNESS_ROUND_BIND: RoundBind = { method: 'tools/call' };

function promptsOf(result: InputRequiredResult): ConfirmPrompt[] {
  return Object.entries(result.inputRequests ?? {}).map(([key, request]) => {
    const params = (request as { params?: { message?: string; requestedSchema?: unknown } }).params;
    const schema = params?.requestedSchema as
      { properties?: { choice?: { enum?: string[] } } } | undefined;
    return { key, message: params?.message ?? '', choices: schema?.properties?.choice?.enum ?? [] };
  });
}

/**
 * Drive one tool's `run` with a minimal `ToolCtx` — no MCP pair, no executor.
 * Arguments go through the tool's own Zod schema so defaults apply as on the
 * wire; relative-path resolution, the access-grant round-trip, undo capture,
 * deadlines and response assembly are the executor's and are not exercised.
 * With `options.confirm`, Confirmation rounds are answered by a fake client.
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
  const base = {
    signal: options.signal ?? new AbortController().signal,
    requestId: 'tool-harness',
    fs,
    pageStore: options.pageStore ?? new PageSnapshotStore(),
    undoJournal: options.undoJournal ?? new UndoJournal(),
    resourceStore: options.resourceStore ?? new ResourceStore(),
    transport: options.transport,
    log: (level: LoggingLevel, data: unknown, logger?: string) => {
      logs.push({ level, data, logger });
    },
    onProgress: (p: { current: number; total?: number }) => {
      progress.push(p);
      options.onProgress?.(p);
    },
    clientCapabilities: options.clientCapabilities,
    roundBind: HARNESS_ROUND_BIND,
  } satisfies ToolCtx;
  const parsed: z.infer<I> = tool.def.input.parse(args);

  let state: PendingState | undefined;
  let inputResponses: Record<string, unknown> | undefined;
  for (let rounds = 0; ; rounds += 1) {
    const ctx: ToolCtx = {
      ...base,
      requestState: (() => state) as RequestStateAccessor,
      inputResponses,
    };
    const result = await tool.def.run(parsed, ctx);
    if (!isInputRequiredResult(result) || options.confirm === undefined) {
      return { result, logs, progress, rounds };
    }
    if (rounds === MAX_CONFIRM_ROUNDS) {
      throw new Error(`tool-harness: ${tool.name} asked for input past round ${String(rounds)}`);
    }
    // The real seam verifies the echoed state before the handler runs.
    state =
      result.requestState === undefined
        ? undefined
        : await requestStateCodec.verify(result.requestState, bindContextOf(HARNESS_ROUND_BIND));
    inputResponses = {};
    for (const prompt of promptsOf(result)) {
      inputResponses[prompt.key] = await options.confirm(prompt, rounds + 1);
    }
  }
}

/** `runToolBody` for a call expected to complete: rejects an `input_required` outcome. */
export async function runToolBodyResult<I extends z.ZodType, O extends object>(
  tool: DefinedToolOf<I, O>,
  args: z.input<I>,
  options: ToolBodyOptions = {},
): Promise<RunResultOf<O> & { readonly logs: readonly LogLine[]; readonly rounds: number }> {
  const { result, logs, rounds } = await runToolBody(tool, args, options);
  if (isInputRequiredResult(result)) {
    throw new Error(`tool-harness: ${tool.name} asked for input`);
  }
  return { ...result, logs, rounds };
}

/**
 * The issue messages of a body run whose arguments the tool's own input
 * schema refuses; the run never reaches `run`. Fails if the schema accepts.
 */
export async function schemaIssues(run: Promise<unknown>): Promise<string[]> {
  try {
    await run;
  } catch (error) {
    if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message);
    throw error;
  }
  throw new Error('tool-harness: the input schema accepted the call');
}

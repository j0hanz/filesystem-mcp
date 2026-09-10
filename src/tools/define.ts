import type {
  CallToolResult,
  ClientCapabilities,
  ContentBlock,
  InputRequiredResult,
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
  McpServer,
  Notification,
  RegisteredTool,
  RequestMeta,
  RequestStateAccessor,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import {
  CLIENT_CAPABILITIES_META_KEY,
  fromJsonSchema,
  isInputRequiredResult,
} from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { ErrorCode, formatUnknownErrorMessage, Problem } from '../core/errors.js';
import type { ProgressCtx } from '../core/fmt.js';
import { plainMessage } from '../core/fmt.js';
import { GuardedFileSystem } from '../core/fs.js';
import {
  confirmKey,
  multiSelectInput,
  pendingRoundTrip,
  readAcceptedConfirm,
  readAcceptedMultiChoice,
} from '../core/input-required.js';
import { Logger } from '../core/observability.js';
import type { LoggingLevel } from '../core/observability.js';
import type { PageSnapshotStore } from '../core/page-store.js';
import { isSamePath } from '../core/path-utils.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { McpProgressSink, ProgressSession } from './progress.js';

export interface ToolCtx {
  readonly signal: AbortSignal;
  readonly _meta?: RequestMeta | undefined;
  readonly fs: GuardedFileSystem;
  readonly pageStore: PageSnapshotStore;
  readonly resourceStore: ResourceStore | undefined;
  /** Emits a log line to stderr via `Logger.emit`, gated by `LOG_LEVEL`. */
  readonly log?: (level: LoggingLevel, data: unknown, logger?: string) => void;
  readonly sendNotification?: (notification: Notification) => Promise<void>;
  readonly onProgress?: (params: { current: number; total?: number }) => void;
  /**
   * Multi-round-trip `inputResponses` carried by a retried `tools/call`
   * (protocol revision 2026-07-28); `undefined` on the first round. Bare,
   * unvalidated client values — handlers read them through
   * `readAcceptedConfirm`.
   */
  readonly inputResponses?: Record<string, unknown> | undefined;
  /**
   * Reads the verified multi-round-trip `requestState` for the current round:
   * the decoded `PendingState` the `requestStateCodec` verified, or `undefined`
   * when the round carried no state (the first round). `undefined` when no
   * live request context is available.
   */
  readonly requestState?: RequestStateAccessor | undefined;
  /**
   * What the connected client declared it can do, or `undefined` when this
   * connection cannot say. Read by the `input_required` flows: an embedded
   * elicitation sent to a client that never declared `elicitation` is rejected
   * by the SDK with `-32021` before it reaches the wire, so the handlers check
   * first and answer with an actionable tool error instead.
   *
   * Two sources, because the eras differ: a legacy connection negotiated them
   * at `initialize` (`Server.getClientCapabilities()`), a modern one carries
   * them per request in the `_meta` envelope and never runs `initialize` at
   * all. `undefined` means "cannot tell" — never "no capabilities".
   */
  readonly clientCapabilities?: ClientCapabilities | undefined;
}

interface ToolDeps {
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly pageStore: PageSnapshotStore;
  readonly resourceStore: ResourceStore | undefined;
}

interface RunResult<T> {
  readonly structured: T;
  readonly text?: string;
  readonly resources?: ContentBlock[];
  /**
   * The call as a whole failed. Batch tools set it from `isTotalFailure` in
   * `batch.ts` — every requested item failed — so the executor never has to
   * know a tool's output shape. Absent or `false` means the call did work.
   */
  readonly isError?: boolean;
}

/**
 * `ToolAnnotations` with `readOnlyHint` required. It is optional in the SDK, but
 * MUTATING_TOOL_NAMES derives the `--read-only` gate from it, so a tool that
 * forgets it must be a compile error rather than a silent reclassification.
 */
type DeclaredAnnotations = ToolAnnotations & { readonly readOnlyHint: boolean };

export interface ToolDef<I extends z.ZodType, O extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly annotations: DeclaredAnnotations;
  readonly timeoutMs?: number;
  readonly progress?: (args: z.infer<I>) => ProgressCtx;
  readonly progressDone?: (args: z.infer<I>, result: z.infer<O>) => Partial<ProgressCtx>;
  readonly defaultErrorCode?: ErrorCode;
  /**
   * The filesystem paths this tool will operate on, extracted from its parsed
   * args. The executor runs an access-grant pre-check over these BEFORE `run`
   * (R7): any path outside the granted roots yields an `input_required`
   * round-trip requesting a grant, and nothing is touched until the client
   * retries with an accepted grant (R8). Omit for tools that do not operate on
   * caller-supplied filesystem paths.
   */
  readonly accessPaths?: (args: z.infer<I>) => readonly string[];
  readonly run: (
    args: z.infer<I>,
    ctx: ToolCtx,
  ) => Promise<RunResult<z.infer<O>> | InputRequiredResult>;
}

export interface DefinedTool {
  readonly name: string;
  readonly annotations: DeclaredAnnotations;

  register(deps: ToolDeps): RegisteredTool;
}

function toToolCtx(
  ctx: ServerContext,
  deps: Pick<ToolDeps, 'pathGuard' | 'pageStore' | 'resourceStore' | 'server'>,
): ToolCtx {
  // Envelope first, accessor second — the two eras carry this differently.
  // A modern request states the capabilities in its own `_meta` envelope; a
  // legacy connection fixed them at `initialize` and has no envelope at all.
  // The deprecated accessor still answers for both today (the SDK backfills it
  // per request from the validated envelope on modern instances), but reading
  // the envelope directly is the supported path, so it leads: when the accessor
  // goes, legacy degrades to "cannot tell", which fails open to the behavior
  // that predates this check.
  //
  // The cast is the SDK's shipped `RequestMetaEnvelope` declaration collapsing
  // to `{}` — the reserved keys survive at runtime but not in the .d.ts, so the
  // key constant cannot index the declared type.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const clientCapabilities =
    (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ??
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only source of client capabilities on a legacy connection, where no envelope exists.
    deps.server.server.getClientCapabilities();

  return {
    signal: ctx.mcpReq.signal,
    ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
    fs: new GuardedFileSystem(deps.pathGuard),
    pageStore: deps.pageStore,
    resourceStore: deps.resourceStore,
    sendNotification: async (notification) => ctx.mcpReq.notify(notification),
    inputResponses: ctx.mcpReq.inputResponses,
    requestState: ctx.mcpReq.requestState,
    ...(clientCapabilities ? { clientCapabilities } : {}),
  };
}

/**
 * Claude Code — and any client that treats `structuredContent` as the canonical
 * model view — discards the `text` blocks when `structuredContent` is present,
 * showing the model `JSON.stringify(structuredContent)` instead. A tool that
 * authored a text result (list's ASCII tree, read's file) meant that text for
 * the model, so it ships its metadata under `_meta`, which no client renders in
 * place of the content. Tools with no `text` keep `structuredContent`: the JSON
 * *is* their model-facing view.
 */
function buildSuccessResponse<O>(result: RunResult<O>): CallToolResult {
  const hasText = result.text !== undefined;
  const text = result.text ?? JSON.stringify(result.structured);
  const content: ContentBlock[] = [{ type: 'text' as const, text }, ...(result.resources ?? [])];
  return {
    content,
    ...(hasText
      ? // Safe because every `ToolDef.output` is a Zod object schema, so
        // `structured` is always a plain object. Constraining `O` to prove it
        // is not worth the cost: the bound has to thread through five generic
        // sites and still loses to `exactOptionalPropertyTypes` variance on
        // `RunResult`'s optional fields.
        { _meta: result.structured as Record<string, unknown> }
      : { structuredContent: result.structured }),
    ...(result.isError ? { isError: true } : {}),
  };
}

class ToolExecutor<I extends z.ZodType, O extends z.ZodType> {
  readonly signal: AbortSignal;
  private readonly def: ToolDef<I, O>;
  private readonly parsedArgs: z.infer<I>;
  private readonly toolCtx: ToolCtx;

  readonly #progressCtx: ProgressCtx;
  readonly #mcpSink?: McpProgressSink;
  readonly #progressSession: ProgressSession;

  constructor(toolName: string, ctx: ToolCtx, def: ToolDef<I, O>, parsedArgs: z.infer<I>) {
    this.def = def;
    this.parsedArgs = parsedArgs;
    this.signal = def.timeoutMs
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(def.timeoutMs)])
      : ctx.signal;
    this.#progressCtx = def.progress ? def.progress(parsedArgs) : { label: def.title };
    const token = ctx._meta?.progressToken;
    if (token !== undefined && ctx.sendNotification !== undefined) {
      this.#mcpSink = new McpProgressSink(toolName, token, ctx.sendNotification);
    }
    const isTest = process.env['NODE_ENV'] === 'test' || process.execArgv.includes('--test');
    this.#progressSession = new ProgressSession({
      label: this.#progressCtx.label,
      ...(this.#mcpSink ? { sink: this.#mcpSink } : {}),
      ...(isTest ? { rateLimitMs: 0 } : {}),
    });
    this.toolCtx = {
      ...ctx,
      signal: this.signal,
      log: (level: LoggingLevel, data: unknown, logger?: string) => {
        const msg = typeof data === 'string' ? data : String(data);
        const prefix = logger ? `[${logger}] ` : '';
        Logger.emit(level, `${prefix}${msg}`);
      },
      onProgress: (p) => {
        this.#tick(p);
      },
    };
  }

  #tick(p: { current: number; total?: number }): void {
    const tickCtx: ProgressCtx = {
      ...this.#progressCtx,
      current: p.current,
      ...(p.total !== undefined ? { total: p.total } : {}),
    };
    this.#progressSession.set({ ...p, message: plainMessage('tick', tickCtx) });
  }

  async #flushProgress(): Promise<void> {
    if (this.#mcpSink) await this.#mcpSink.flush();
  }

  private async completeProgress(result: z.infer<O>): Promise<void> {
    const doneCtx: ProgressCtx = this.def.progressDone
      ? { ...this.#progressCtx, ...this.def.progressDone(this.parsedArgs, result) }
      : this.#progressCtx;
    this.#progressSession.complete(plainMessage('done', doneCtx));
    await this.#flushProgress();
  }

  private async failProgress(error: unknown): Promise<{ isError: true; content: ContentBlock[] }> {
    const errMsg = formatUnknownErrorMessage(error);
    const message = plainMessage('fail', { ...this.#progressCtx, error: errMsg });
    this.#progressSession.fail(error, message);
    await this.#flushProgress();
    const { text: errorText } = Problem.toText(
      error,
      this.def.defaultErrorCode ?? ErrorCode.UNKNOWN,
    );
    return {
      content: [{ type: 'text' as const, text: errorText }],
      isError: true,
    };
  }

  /**
   * Access-grant pre-check (R7/R8/R9). Before `run` touches the filesystem,
   * ask PathGuard which of the tool's declared paths are out-of-root and
   * grantable. If any are and this round carries no verified `requestState`,
   * return `input_required` (nothing is read or written — R7). On retry, the
   * verified state must bind this grant set (R9); apply each accepted grant for
   * the session (R8) and proceed. A declined or ungrantable path is left for
   * `validateAccess` to fail closed during the operation. Returns `undefined`
   * when no round-trip is needed and any applicable grants have been applied.
   */
  private async precheckGrant(): Promise<InputRequiredResult | undefined> {
    const extract = this.def.accessPaths;
    if (!extract) return undefined;
    const paths = extract(this.parsedArgs);
    if (paths.length === 0) return undefined;
    const grantDirs = await this.toolCtx.fs.pathGuard.precheckAccess(paths);
    if (grantDirs.length === 0) return undefined;

    // One grant dir: a single boolean confirm. Multiple: one multi-select
    // elicitation so the client picks the subset to allow in one round-trip
    // (N dirs → 1 round-trip, not N). `pendingRoundTrip` still binds
    // `paths: grantDirs` sorted, so R9 path-binding is unaffected.
    const multi = grantDirs.length > 1;
    const round = await pendingRoundTrip({
      op: 'grant',
      pending: grantDirs,
      requestState: this.toolCtx.requestState,
      clientCapabilities: this.toolCtx.clientCapabilities,
      buildInputs: (dirs) =>
        multi
          ? [
              multiSelectInput(
                'grant',
                'Grant filesystem access to these directories? Select the ones to allow.',
                dirs.map((d) => ({ value: d, title: d })),
              ),
            ]
          : dirs.map((dir, i) => ({
              key: confirmKey(i),
              message: `Grant filesystem access to "${dir}"?`,
            })),
    });
    if (round !== undefined) return round;
    // Apply accepted grants for the session (R8). Declined/missing dirs are
    // skipped here; their paths fail with ACCESS_DENIED during the operation.
    //
    // No list-changed notification follows: a grant widens the allowed roots,
    // and no resource list reads them. The instructions resource has a fixed
    // URI, the result template lists the ResourceStore, and the file template
    // lists nothing at all (see resources.ts). Notifying here only bought the
    // client a round trip to re-fetch a list that could not have changed.
    //
    // `readAcceptedMultiChoice` does NOT validate against the offered choices
    // (attacker-controlled inputResponses on re-entry). Only grant dirs that
    // were actually offered by precheckAccess — a value outside grantDirs is
    // ignored and fails closed in validateAccess. The single-select path reads
    // `confirmKey(i)` for `grantDirs[i]`, so the isSamePath filter is a no-op
    // there; it only bites for the multi-select array.
    const accepted = multi
      ? (readAcceptedMultiChoice(this.toolCtx.inputResponses, 'grant') ?? [])
      : grantDirs.filter((_dir, i) =>
          readAcceptedConfirm(this.toolCtx.inputResponses, confirmKey(i)),
        );
    for (const dir of accepted) {
      if (!grantDirs.some((g) => isSamePath(g, dir))) continue;
      await this.toolCtx.fs.pathGuard.applyGrant(dir);
    }
    return undefined;
  }

  async execute(): Promise<CallToolResult | InputRequiredResult> {
    try {
      // Access-grant pre-check before any filesystem touch (R7/R8/R9). A
      // grant input_required short-circuits here (progress paused, not
      // finished); an R9 mismatch throws, which this catch surfaces as an
      // isError tool result like every other handler failure — not a raw
      // JSON-RPC error (GRANT-1 impact #2).
      const grantRequired = await this.precheckGrant();
      if (grantRequired !== undefined) return grantRequired;
      const result = await this.def.run(this.parsedArgs, this.toolCtx);
      // input_required is a return value, not a completed call: the client
      // retries the same tools/call carrying inputResponses, and this
      // handler re-enters from the top. Skip the progress "done" close and
      // return it verbatim — progress is paused, not finished.
      if (isInputRequiredResult(result)) {
        return result;
      }
      await this.completeProgress(result.structured);
      return buildSuccessResponse(result);
    } catch (error) {
      return await this.failProgress(error);
    } finally {
      await this.#flushProgress();
    }
  }
}

/**
 * Validate with Zod while publishing the precomputed JSON Schema: clients get
 * draft-2020-12, handlers get Zod's coercions, defaults and error messages.
 *
 * Each validator instance is built for exactly one schema and handed straight
 * to `fromJsonSchema(thatSchema, ...)`, which calls `getValidator` once with
 * the same schema — so the argument is redundant here and deliberately ignored.
 * Reusing one instance across schemas would silently validate against `schema`.
 */
function zodJsonSchemaValidator(schema: z.ZodType): jsonSchemaValidator {
  return {
    getValidator<U>(): JsonSchemaValidator<U> {
      return (input: unknown) => {
        const result = schema.safeParse(input);
        if (result.success) {
          return {
            valid: true as const,
            data: result.data as U,
            errorMessage: undefined,
          };
        }
        return {
          valid: false as const,
          data: undefined,
          errorMessage: z.prettifyError(result.error),
        };
      };
    },
  };
}

/**
 * Generate the wire copy of a schema for `tools/list`. The Zod schema keeps
 * every constraint for runtime validation; the `override` pass only trims what
 * the wire copy costs every client at session start:
 *
 * - `$schema` and `title` carry no information the host uses.
 * - `maximum: Number.MAX_SAFE_INTEGER` is zod's int() artifact, not a bound.
 * - `examples` is dropped in both directions: on output it describes a field the
 *   server itself fills in, and on input every description that carried one
 *   already spells the same example out inline, so the keyword paid twice.
 *
 * Output `description`s are NOT dropped. They were, and the result was a wire
 * contract the model had to guess at: `delete` returns `path` XOR `paths`,
 * `edit.diff` appears only under dryRun, `read.value` has no required field at
 * all. None of that is inferable from types alone.
 *
 * No shared subschema carries a `.meta({ id })`, so zod inlines every one of
 * them and the emitted document has no `$defs`/`$ref` to dereference.
 */
function toDraft202012(schema: z.ZodType, io: 'input' | 'output'): JsonSchemaType {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    override: ({ jsonSchema }) => {
      const node = jsonSchema as Record<string, unknown>;
      delete node['title'];
      if (node['maximum'] === Number.MAX_SAFE_INTEGER) delete node['maximum'];
      delete node['examples'];
    },
  }) as Record<string, unknown>;
  delete generated['$schema'];
  return generated;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): DefinedTool {
  const inputJsonSchema = toDraft202012(def.input, 'input');

  // Nothing here depends on `deps`, so it is built once per tool definition
  // rather than once per `register` — the HTTP leg registers every tool afresh
  // on each request.
  // Published annotations are derived, not passed through. `readOnlyHint` is
  // load-bearing (MUTATING_TOOL_NAMES derives the --read-only gate from it) and
  // `openWorldHint: false` is a real claim for a filesystem server. The other
  // two describe behavior a read-only tool cannot have, and restate the default
  // for a mutating one — 29 tokens per tool for nothing a client acts on.
  const publishedAnnotations: ToolAnnotations = {
    readOnlyHint: def.annotations.readOnlyHint,
    openWorldHint: def.annotations.openWorldHint ?? false,
    ...(def.annotations.readOnlyHint
      ? {}
      : { destructiveHint: def.annotations.destructiveHint ?? true }),
  };

  const toolDefShape = {
    title: def.title,
    description: def.description,
    inputSchema: fromJsonSchema<z.infer<I>>(inputJsonSchema, zodJsonSchemaValidator(def.input)),
    // No `outputSchema`, ever. Publishing one obliges the result to carry
    // `structuredContent` (clients enforce it), and every tool that authors its
    // own text ships its metadata under `_meta` instead — see
    // `buildSuccessResponse`. The two cannot both hold, and the text is what
    // the model reads. `TOOL-SURFACE-001` pins this for the whole surface.
    //
    // `def.output` stays: it types `RunResult<z.infer<O>>`, which is what makes
    // a tool returning the wrong shape a compile error.
    annotations: publishedAnnotations,
  };

  return {
    name: def.name,
    annotations: def.annotations,

    register(deps: ToolDeps): RegisteredTool {
      return deps.server.registerTool(def.name, toolDefShape, async (args, ctx) =>
        new ToolExecutor<I, O>(def.name, toToolCtx(ctx, deps), def, args).execute(),
      );
    },
  };
}

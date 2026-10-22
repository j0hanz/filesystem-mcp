import type {
  CallToolResult,
  ClientCapabilities,
  ContentBlock,
  InputRequiredResult,
  McpServer,
  Notification,
  RegisteredTool,
  RequestId,
  RequestStateAccessor,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import {
  CLIENT_CAPABILITIES_META_KEY,
  isInputRequiredResult,
  TRACEPARENT_META_KEY,
} from '@modelcontextprotocol/server';

import type * as z from 'zod/v4';

import { ErrorCode, formatUnknownErrorMessage, FsError, Problem } from '../core/errors.ts';
import type { ProgressCtx } from '../core/fmt.ts';
import { plainMessage } from '../core/fmt.ts';
import { GuardedFileSystem } from '../core/fs.ts';
import {
  confirmKey,
  pendingRoundTrip,
  readAcceptedConfirm,
  readAcceptedMultiChoice,
} from '../core/input-required.ts';
import { Logger, sanitizeLogField } from '../core/observability.ts';
import type { LoggingLevel } from '../core/observability.ts';
import { isSamePath } from '../core/path-utils.ts';
import type { PathGuard } from '../core/path.ts';
import { withSplitArgsRecovery } from '../core/schema.ts';
import type { PageSnapshotStore, ResourceStore } from '../core/store.ts';
import type { UndoCapture, UndoJournal } from '../core/undo.ts';
import { getToolTimeoutMs, jsonBytesOver, MAX_OUTBOUND_RESULT_BYTES } from '../core/util.ts';
import { ProgressSession } from './progress.ts';

export interface ToolCtx {
  readonly signal: AbortSignal;
  /** The JSON-RPC id of the `tools/call` this context serves; prefixes every log line. */
  readonly requestId: RequestId;
  readonly fs: GuardedFileSystem;
  readonly pageStore: PageSnapshotStore;
  readonly undoJournal: UndoJournal;
  readonly resourceStore: ResourceStore;
  /** Emits a log line to stderr via `Logger.emit`, gated by `FS_LOG_LEVEL`. */
  readonly log: (level: LoggingLevel, data: unknown, logger?: string) => void;
  readonly onProgress: (params: { current: number; total?: number }) => void;
  /**
   * Multi-round-trip `inputResponses` carried by a retried `tools/call`
   * (protocol revision 2026-07-28); `undefined` on the first round. Bare,
   * unvalidated client values — handlers read them through
   * `readAcceptedConfirm`.
   */
  readonly inputResponses?: Record<string, unknown> | undefined;
  /**
   * Keys of `inputResponses` entries the SDK dropped on this round because
   * they were not bare results (the `{ method, result }` wrapper some hosts
   * send). `pendingRoundTrip` re-issues a confirmation whose key is listed
   * here once; `describeRefusal` names the cause after that.
   */
  readonly droppedInputResponseKeys?: readonly string[] | undefined;
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
  /** The SDK request context this call runs under; `pendingRoundTrip` binds minted state to it. */
  readonly serverCtx: ServerContext;
  /** `stdio` alone has a 10 MiB frame limit; `http` on HTTP, unset on the in-memory test pair. */
  readonly transport?: 'stdio' | 'http' | undefined;
}

export interface ToolDeps {
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly pageStore: PageSnapshotStore;
  readonly undoJournal: UndoJournal;
  readonly resourceStore: ResourceStore;
  readonly era?: 'legacy' | 'modern';
  readonly transport?: 'stdio' | 'http';
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

export interface ToolDef<I extends z.ZodType, O extends object> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: I;
  /** Required: drives both the --read-only gate and published annotations. */
  readonly readOnlyHint: boolean;
  /** Set on the undo tool itself: its calls are never captured (no redo). */
  readonly noUndo?: true;
  /** Abort the call after getToolTimeoutMs() (`--tool-timeout`, FS_TOOL_TIMEOUT_MS). */
  readonly deadline?: boolean;
  readonly progress?: (args: z.infer<I>) => ProgressCtx;
  readonly progressDone?: (args: z.infer<I>, result: O) => Partial<ProgressCtx>;
  readonly defaultErrorCode?: ErrorCode;
  /**
   * The parsed args with every caller-supplied filesystem path passed through
   * `fn`. Before `run`, the executor reads the paths through it to resolve
   * relative ones (`PathGuard.resolveRelativePaths`) and writes the results
   * back, so every check `run` makes — duplicates and overlaps included — sees
   * one spelling. It then runs the access-grant pre-check over the same paths
   * (R7): any path outside the granted roots yields an `input_required`
   * round-trip requesting a grant, and nothing is touched until the client
   * retries with an accepted grant (R8). Omit for tools that do not operate on
   * caller-supplied filesystem paths.
   */
  readonly mapPaths?: (args: z.infer<I>, fn: (path: string) => string) => z.infer<I>;
  readonly run: (args: z.infer<I>, ctx: ToolCtx) => Promise<RunResult<O> | InputRequiredResult>;
  /**
   * What the stdio size refusal tells the caller to do instead, for a tool
   * that knows better than the generic advice (see `refuseOversized`).
   */
  readonly oversizeRemedy?: (result: RunResult<O>) => string;
}

export interface DefinedTool {
  readonly name: string;
  readonly readOnlyHint: boolean;

  register(deps: ToolDeps): RegisteredTool;
}

function toToolCtx(
  ctx: ServerContext,
  deps: ToolDeps,
  capture?: UndoCapture,
): Omit<ToolCtx, 'log' | 'onProgress'> {
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
    deps.server.server.getClientCapabilities() ??
    // A legacy instance that never saw `initialize` is the HTTP leg's
    // per-request serving (`createMcpHandler` with `legacy: 'stateless'`):
    // there is no return path for a server-to-client request, so read the
    // client as having declared nothing. The `input_required` flows then
    // answer with their named workaround instead of the SDK's generic refusal.
    // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
    (deps.era === 'legacy' ? {} : undefined);

  return {
    signal: ctx.mcpReq.signal,
    requestId: ctx.mcpReq.id,
    fs: new GuardedFileSystem(deps.pathGuard, capture),
    pageStore: deps.pageStore,
    undoJournal: deps.undoJournal,
    resourceStore: deps.resourceStore,
    inputResponses: ctx.mcpReq.inputResponses,
    droppedInputResponseKeys: ctx.mcpReq.droppedInputResponseKeys,
    requestState: ctx.mcpReq.requestState,
    serverCtx: ctx,
    ...(clientCapabilities ? { clientCapabilities } : {}),
    ...(deps.transport ? { transport: deps.transport } : {}),
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
function buildSuccessResponse<O extends object>(result: RunResult<O>): CallToolResult {
  const hasText = result.text !== undefined;
  const text = result.text ?? JSON.stringify(result.structured);
  const content: ContentBlock[] = [{ type: 'text' as const, text }, ...(result.resources ?? [])];
  return {
    content,
    ...(hasText // Result interfaces have named fields; the SDK metadata requires an index signature.
      ? { _meta: result.structured as Record<string, unknown> }
      : { structuredContent: result.structured }),
    ...(result.isError ? { isError: true } : {}),
  };
}

class ToolExecutor<I extends z.ZodType, O extends object> {
  readonly signal: AbortSignal;
  private readonly def: ToolDef<I, O>;
  /** Rewritten once, by `resolveRelativePaths`, before anything reads a path. */
  private parsedArgs: z.infer<I>;
  private readonly toolCtx: ToolCtx;
  private readonly capture: UndoCapture | undefined;

  readonly #progressCtx: ProgressCtx;
  readonly #progressSession: ProgressSession;

  constructor(
    toolName: string,
    ctx: Omit<ToolCtx, 'log' | 'onProgress'>,
    def: ToolDef<I, O>,
    parsedArgs: z.infer<I>,
    capture?: UndoCapture,
  ) {
    this.def = def;
    this.parsedArgs = parsedArgs;
    this.capture = capture;
    this.signal = def.deadline
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(getToolTimeoutMs())])
      : ctx.signal;
    this.#progressCtx = def.progress ? def.progress(parsedArgs) : { label: def.title };
    const { mcpReq } = ctx.serverCtx;
    const token = mcpReq._meta?.progressToken;
    const notify = async (notification: Notification): Promise<void> => mcpReq.notify(notification);
    this.#progressSession = new ProgressSession({
      label: this.#progressCtx.label,
      ...(token !== undefined ? { sink: { toolName, token, notify } } : {}),
    });
    const traceparent = mcpReq._meta?.[TRACEPARENT_META_KEY];
    this.toolCtx = {
      ...ctx,
      signal: this.signal,
      // Per-call views, so a response refused after `run` can take back the
      // cached result and page snapshot behind a link or cursor it never sent.
      pageStore: ctx.pageStore.forCall(),
      resourceStore: ctx.resourceStore.forCall(),
      log: (level: LoggingLevel, data: unknown, logger?: string) => {
        const msg = typeof data === 'string' ? data : String(data);
        // `[req <id>]` first so one grep finds every line of one call; the
        // traceparent rides along only when the client sent one. Both are
        // client-supplied, so they pass through `sanitizeLogField`: a control
        // character in a JSON-RPC id or a traceparent would forge log lines.
        // The message is flattened too (uncapped): it can carry a resolved
        // path or OS error text, and input schemas reject CR/LF but not the
        // Unicode line separators.
        const trace = typeof traceparent === 'string' ? ` ${sanitizeLogField(traceparent)}` : '';
        const prefix = logger ? `[${logger}] ` : '';
        const text = sanitizeLogField(msg, Infinity);
        Logger.emit(
          level,
          `[req ${sanitizeLogField(String(ctx.requestId))}${trace}] ${prefix}${text}`,
        );
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

  private completeProgress(result: O): void {
    const doneCtx: ProgressCtx = this.def.progressDone
      ? { ...this.#progressCtx, ...this.def.progressDone(this.parsedArgs, result) }
      : this.#progressCtx;
    this.#progressSession.complete(plainMessage('done', doneCtx));
  }

  private failProgress(
    error: unknown,
    undoSuffix = '',
  ): { isError: true; content: ContentBlock[] } {
    const errMsg = formatUnknownErrorMessage(error);
    this.#progressSession.fail(plainMessage('fail', { ...this.#progressCtx, error: errMsg }));
    const errorText =
      Problem.toText(error, this.def.defaultErrorCode ?? ErrorCode.UNKNOWN) + undoSuffix;
    return {
      content: [{ type: 'text' as const, text: errorText }],
      isError: true,
    };
  }

  /**
   * The undo suffix for a captured call, minted once: ` · undo <id>` when the
   * capture holds records, ` · not undoable: <reason>` when it was abandoned,
   * `''` for a capture that recorded nothing (dry run, early failure) or a
   * read-only call. Sets `undo`/`undoUnavailable` on `structured` when given.
   */
  /** The undo id for this call, minted once; a re-run of #undoSuffix reuses it. */
  #undoId: string | undefined;

  #undoSuffix(structured?: Record<string, unknown>): string {
    const capture = this.capture;
    if (capture === undefined) return '';
    if (capture.unavailable !== undefined) {
      if (structured !== undefined) structured['undoUnavailable'] = capture.unavailable;
      return ` · not undoable: ${capture.unavailable}`;
    }
    if (capture.records.length === 0) return '';
    // Minted once: the catch path re-runs this after the success path, and a
    // second add would double-journal the same records under a fresh id.
    this.#undoId ??= this.toolCtx.undoJournal.add(this.def.name, capture.records);
    const id = this.#undoId;
    if (structured !== undefined) structured['undo'] = id;
    return ` · undo ${id}`;
  }

  /** `suffix` goes at the end of the text's first line, not the end of the text. */
  #insertSuffix(text: string, suffix: string): string {
    const nl = text.indexOf('\n');
    return nl < 0 ? text + suffix : text.slice(0, nl) + suffix + text.slice(nl);
  }

  private collectPaths(): string[] {
    const paths: string[] = [];
    this.def.mapPaths?.(this.parsedArgs, (path) => {
      paths.push(path);
      return path;
    });
    return paths;
  }

  private async resolveRelativePaths(): Promise<void> {
    const { mapPaths } = this.def;
    if (!mapPaths) return;
    const resolved = await this.toolCtx.fs.pathGuard.resolveRelativePaths(this.collectPaths());
    if (resolved.size === 0) return;
    const rewritten = mapPaths(this.parsedArgs, (path) => resolved.get(path) ?? path);
    // The schema compared the spellings the caller sent, so `a.txt` and
    // `<root>/a.txt` passed create's and edit's one-entry-per-file rule as two
    // files. Its checks judge the resolved paths too.
    const check = this.def.input.safeParse(rewritten);
    if (!check.success) {
      const issues = check.error.issues.map(
        (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
      );
      throw new FsError(ErrorCode.INVALID_INPUT, issues.join('; '));
    }
    this.parsedArgs = rewritten;
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
    const paths = this.collectPaths();
    if (paths.length === 0) return undefined;
    const grantDirs = await this.toolCtx.fs.pathGuard.precheckAccess(paths);
    if (grantDirs.length === 0) return undefined;

    // One grant dir: a single boolean confirm. Multiple: one multi-select
    // elicitation so the client picks the subset to allow in one round-trip
    // (N dirs → 1 round-trip, not N). `pendingRoundTrip` still binds
    // `paths: grantDirs` sorted, so R9 path-binding is unaffected.
    const multi = grantDirs.length > 1;
    const round = await pendingRoundTrip(this.toolCtx, {
      op: 'grant',
      pending: grantDirs,
      buildInputs: (dirs) =>
        multi
          ? [
              {
                key: 'grant',
                message: 'Grant filesystem access to these directories? Select the ones to allow.',
                choices: dirs,
                multi: true,
              },
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
      await this.toolCtx.fs.pathGuard.applyGrant(dir, 'access');
    }
    return undefined;
  }

  /**
   * stdio's SDK reader drops the connection on a message past 10 MiB, so a
   * response that would overflow it becomes TOO_LARGE instead. Only a call
   * that changed nothing can be refused after `run` — a read-only tool, or a
   * dry run (every tool with `dryRun` writes nothing under it); a mutation may
   * already have committed. The whole encoded response counts, duplicated
   * metadata and escaping included; the ceiling leaves room for the envelope.
   */
  private refuseOversized(result: RunResult<O>, response: CallToolResult): void {
    if (this.toolCtx.transport !== 'stdio') return;
    const dryRun = (this.parsedArgs as { dryRun?: unknown }).dryRun === true;
    if (!this.def.readOnlyHint && !dryRun) return;
    const encodedBytes = jsonBytesOver(response, MAX_OUTBOUND_RESULT_BYTES);
    if (encodedBytes === undefined) return;
    // The client never receives the link or cursor these back, so they would
    // only push live entries out of the stores' caps.
    this.toolCtx.resourceStore.discard();
    this.toolCtx.pageStore.discard();
    const remedy =
      this.def.oversizeRemedy?.(result) ??
      (dryRun
        ? 'Nothing was written. Preview fewer files or a smaller file per call, or connect over HTTP.'
        : 'Reduce the requested output or connect over HTTP.');
    // The remedy stands in for TOO_LARGE's default head/tail advice, which
    // fits neither media nor a dry run.
    throw new FsError(
      ErrorCode.TOO_LARGE,
      `${this.def.name} result too large to return (${String(encodedBytes)} bytes once JSON-encoded, over the ${String(MAX_OUTBOUND_RESULT_BYTES)}-byte stdio message limit).`,
      undefined,
      undefined,
      remedy,
    );
  }

  async execute(): Promise<CallToolResult | InputRequiredResult> {
    try {
      // Access-grant pre-check before any filesystem touch (R7/R8/R9). A
      // grant input_required short-circuits here (progress paused, not
      // finished); an R9 mismatch throws, which this catch surfaces as an
      // isError tool result like every other handler failure — not a raw
      // JSON-RPC error (GRANT-1 impact #2). Relative paths resolve first, so
      // the pre-check judges the path the call will use; with several roots
      // that probes each candidate through validation, and reads nothing.
      await this.resolveRelativePaths();
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
      // `undo` rides inside the structured result both ways (`_meta` and
      // `structuredContent`); the text suffix only when the tool authored a
      // text (`create`'s text is JSON and stays untouched).
      const structured = result.structured as Record<string, unknown>;
      const suffix = this.#undoSuffix(structured);
      const finalResult: RunResult<O> =
        result.text !== undefined && suffix !== ''
          ? { ...result, text: this.#insertSuffix(result.text, suffix) }
          : result;
      const response = buildSuccessResponse(finalResult);
      this.refuseOversized(finalResult, response);
      this.completeProgress(finalResult.structured);
      return response;
    } catch (error) {
      return this.failProgress(error, this.#undoSuffix());
    } finally {
      this.toolCtx.undoJournal.endCapture(this.capture);
      await this.#progressSession.flush();
    }
  }
}

export function defineTool<I extends z.ZodType, O extends object>(def: ToolDef<I, O>): DefinedTool {
  // Nothing here depends on `deps`, so it is built once per tool definition
  // rather than once per `register` — the HTTP leg registers every tool afresh
  // on each request.
  // Filesystem tools are closed-world; only mutating tools are destructive.
  const publishedAnnotations: ToolAnnotations = {
    readOnlyHint: def.readOnlyHint,
    openWorldHint: false,
    ...(def.readOnlyHint ? {} : { destructiveHint: true }),
  };

  const toolDefShape = {
    title: def.title,
    description: def.description,
    // The Zod schema goes in behind `withSplitArgsRecovery` only: the SDK
    // validates with it and publishes its own draft-2020-12 conversion in
    // `tools/list`, which the preprocess step leaves unchanged. The cast only
    // names the in/out types a generic `ZodType` cannot surface through
    // `~standard`.
    inputSchema: withSplitArgsRecovery(def.input) as unknown as StandardSchemaWithJSON<
      z.input<I>,
      z.output<I>
    >,
    // No `outputSchema`, ever. Publishing one obliges the result to carry
    // `structuredContent` (clients enforce it), and every tool that authors its
    // own text ships its metadata under `_meta` instead — see
    // `buildSuccessResponse`. The two cannot both hold, and the text is what
    // the model reads. `TOOL-SURFACE-001` pins this for the whole surface.
    // Result shapes are checked by TypeScript, not unused runtime schemas.
    annotations: publishedAnnotations,
  };

  return {
    name: def.name,
    readOnlyHint: def.readOnlyHint,

    register(deps: ToolDeps): RegisteredTool {
      return deps.server.registerTool(def.name, toolDefShape, async (args, ctx) => {
        // Tools marked noUndo are never captured (no redo); read-only calls
        // change nothing. Past the journal's live-capture cap the call runs,
        // pre-abandoned with the reason. The slot is released in execute()'s
        // finally.
        const capture =
          deps.undoJournal.enabled && !def.readOnlyHint && !def.noUndo
            ? deps.undoJournal.beginCapture()
            : undefined;
        return new ToolExecutor<I, O>(
          def.name,
          toToolCtx(ctx, deps, capture),
          def,
          args,
          capture,
        ).execute();
      });
    },
  };
}

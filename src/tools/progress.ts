import type { Notification, ProgressNotificationParams } from '@modelcontextprotocol/server';

import { formatUnknownErrorMessage } from '../core/errors.js';
import { Logger } from '../core/observability.js';

function reportDetachedError(toolName: string, context: string, error: unknown): void {
  const message = formatUnknownErrorMessage(error);
  Logger.emit('warning', `${toolName}: ${context} failed: ${message}`);
}

type ProgressEvent =
  | { kind: 'tick'; current: number; total?: number; message: string }
  | { kind: 'complete'; current: number; total?: number; message: string }
  | {
      kind: 'fail';
      current: number;
      total?: number;
      message: string;
      error: unknown;
    };

interface ProgressSessionOptions {
  label: string;
  sink?: McpProgressSink;
  /** Override the rate limit window. Default: 50ms. */
  rateLimitMs?: number;
}

const DEFAULT_RATE_LIMIT_MS = 50;

export class ProgressSession {
  readonly #label: string;
  readonly #sink: McpProgressSink | undefined;
  readonly #rateLimitMs: number;
  readonly #startTime: number;

  #cursor = 0;
  #lastSentMs = 0;
  #done = false;

  constructor(opts: ProgressSessionOptions) {
    this.#label = opts.label;
    this.#sink = opts.sink;
    this.#rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;

    const now = Date.now();
    this.#startTime = now;
    this.#lastSentMs = now - this.#rateLimitMs;

    // Synthetic start tick — preserves today's "fire 0 at session creation" wire behavior.
    this.#dispatch({
      kind: 'tick',
      current: 0,
      message: this.#label,
    });
  }

  set(input: { current: number; total?: number; message?: string }): void {
    if (this.#done) return;
    // The spec requires `progress` to increase on every notification, and the
    // constructor already dispatched current: 0. A repeated or backward tick
    // would put a duplicate value on the wire — drop it.
    if (input.current <= this.#cursor) return;
    this.#cursor = input.current;
    this.#dispatch({
      kind: 'tick',
      current: this.#cursor,
      ...(input.total !== undefined ? { total: input.total } : {}),
      message: input.message ?? this.#label,
    });
  }

  complete(message: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#dispatch({
      kind: 'complete',
      current: this.#cursor,
      message,
    });
  }

  fail(error: unknown, message?: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#dispatch({
      kind: 'fail',
      current: this.#cursor,
      message: message ?? this.#label,
      error,
    });
  }

  #dispatch(event: ProgressEvent): void {
    if (this.#shouldRateLimit(event)) {
      return;
    }

    this.#lastSentMs = Date.now();

    if (!this.#sink) return;
    try {
      this.#sink.emit(event);
    } catch (err) {
      // A sink failure must never fail the tool call it is reporting on.
      Logger.warn('progress sink emit failed', { eventKind: event.kind, err });
    }
  }

  #shouldRateLimit(event: ProgressEvent): boolean {
    if (event.kind !== 'tick') {
      return false;
    }

    // Widen the window after 5s of execution; a rateLimitMs of 0 (tests) stays 0
    // only inside the first 5s, which every test run fits in.
    const now = Date.now();
    const effectiveRateLimit =
      now - this.#startTime > 5000 ? Math.max(this.#rateLimitMs, 250) : this.#rateLimitMs;

    const elapsed = now - this.#lastSentMs;
    return elapsed < effectiveRateLimit;
  }
}

export class McpProgressSink {
  private readonly toolName: string;
  private readonly token: string | number;
  private readonly notify: (n: Notification) => Promise<void>;
  readonly #pending = new Set<Promise<void>>();
  #lastProgress = -1;

  constructor(
    toolName: string,
    token: string | number,
    notify: (n: Notification) => Promise<void>,
  ) {
    this.toolName = toolName;
    this.token = token;
    this.notify = notify;
  }

  emit(event: ProgressEvent): void {
    let current = event.current;
    let total = event.total;
    if (event.kind === 'complete') {
      current = total ?? current;
      total = current;
    }
    if (event.kind !== 'tick') {
      // A terminal frame carries the outcome message, so it must reach the
      // wire. It repeats the cursor whenever the session has no `total` (there
      // is nothing higher to report), and the spec requires progress to
      // increase per token — so advance past the last value instead of dropping
      // the frame.
      current = Math.max(current, this.#lastProgress + 1);
      if (total !== undefined && total < current) total = current;
    }
    // Spec: progress must increase on every notification for the same token.
    if (current <= this.#lastProgress) return;
    this.#lastProgress = current;
    const notificationParams: ProgressNotificationParams = {
      progressToken: this.token,
      progress: current,
      ...(total !== undefined ? { total } : {}),
      message: event.message,
    };
    const promise = this.notify({
      method: 'notifications/progress',
      params: notificationParams,
    })
      .catch((error: unknown) => {
        reportDetachedError(this.toolName, 'progressNotification', error);
      })
      .finally(() => {
        this.#pending.delete(promise);
      });
    this.#pending.add(promise);
  }

  async flush(): Promise<void> {
    if (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }
}

import type { Notification, ProgressNotificationParams } from '@modelcontextprotocol/server';

import { formatUnknownErrorMessage } from '../core/errors.ts';
import { Logger } from '../core/observability.ts';

/** Where progress frames go: the `notifications/progress` sink for one `progressToken`. */
export interface ProgressSink {
  toolName: string;
  token: string | number;
  notify: (n: Notification) => Promise<void>;
}

interface ProgressSessionOptions {
  label: string;
  /** Absent when the client sent no `progressToken`; the session then only tracks state. */
  sink?: ProgressSink;
  /** Override the tick rate-limit window. Default: 50ms. */
  rateLimitMs?: number;
}

const DEFAULT_RATE_LIMIT_MS = 50;

/**
 * One tool call's progress stream: a monotonic cursor, a tick rate limit, and
 * the wire guard the spec requires (`progress` strictly increases per token).
 * Terminal frames (`complete`, `fail`) always reach the wire — they carry the
 * outcome message — so they advance past the last value instead of dropping.
 */
export class ProgressSession {
  readonly #label: string;
  readonly #sink: ProgressSink | undefined;
  readonly #rateLimitMs: number;
  readonly #startTime: number;
  readonly #pending = new Set<Promise<void>>();

  #cursor = 0;
  #lastSentMs = 0;
  #lastProgress = -1;
  #done = false;

  constructor(opts: ProgressSessionOptions) {
    this.#label = opts.label;
    this.#sink = opts.sink;
    this.#rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.#startTime = Date.now();
    this.#lastSentMs = this.#startTime - this.#rateLimitMs;
    // Synthetic start tick: the wire sees 0 at session creation.
    this.#emit('tick', 0, undefined, this.#label);
  }

  set(input: { current: number; total?: number; message?: string }): void {
    if (this.#done) return;
    // A repeated or backward tick would put a duplicate value on the wire — drop it.
    if (input.current <= this.#cursor) return;
    this.#cursor = input.current;
    this.#emit('tick', this.#cursor, input.total, input.message ?? this.#label);
  }

  complete(message: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#emit('complete', this.#cursor, undefined, message);
  }

  fail(message?: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#emit('fail', this.#cursor, undefined, message ?? this.#label);
  }

  /** Await every notification in flight; a failed send is logged, never thrown. */
  async flush(): Promise<void> {
    if (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  #emit(
    kind: 'tick' | 'complete' | 'fail',
    current: number,
    total: number | undefined,
    message: string,
  ): void {
    const now = Date.now();
    if (kind === 'tick') {
      // Widen the window after 5s of execution; a rateLimitMs of 0 (tests)
      // stays 0 only inside the first 5s, which every test run fits in.
      const window =
        now - this.#startTime > 5000 ? Math.max(this.#rateLimitMs, 250) : this.#rateLimitMs;
      if (now - this.#lastSentMs < window) return;
    }
    this.#lastSentMs = now;
    if (!this.#sink) return;

    if (kind === 'complete') {
      current = total ?? current;
      total = current;
    }
    if (kind !== 'tick') {
      current = Math.max(current, this.#lastProgress + 1);
      if (total !== undefined && total < current) total = current;
    }
    // Spec: progress must increase on every notification for the same token.
    if (current <= this.#lastProgress) return;
    this.#lastProgress = current;

    const { toolName, token, notify } = this.#sink;
    const params: ProgressNotificationParams = {
      progressToken: token,
      progress: current,
      ...(total !== undefined ? { total } : {}),
      message,
    };
    const promise = notify({ method: 'notifications/progress', params })
      .catch((error: unknown) => {
        // A sink failure must never fail the tool call it is reporting on.
        Logger.warn(
          `${toolName}: progressNotification failed: ${formatUnknownErrorMessage(error)}`,
        );
      })
      .finally(() => {
        this.#pending.delete(promise);
      });
    this.#pending.add(promise);
  }
}

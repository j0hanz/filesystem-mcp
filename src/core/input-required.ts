// Shared infrastructure for the SEP-2577 `input_required` multi-round-trip
// destructive-confirmation flows (recursive delete, move overwrite, out-of-root
// access grant). A handler returns `inputRequired(...)` instead of the deprecated
// push-style server-to-client elicitation request; the client retries the same
// `tools/call` carrying `inputResponses`, and the handler re-enters from the top
// reading the verified `requestState` and the accepted responses.
//
// `requestState` round-trips through the client (attacker-controlled on
// re-entry), so it is sealed with the SDK's HMAC-SHA256 codec. The payload binds
// each confirmation to its operation kind and sorted target-path set (spec R9,
// R10); the handler additionally rejects any retry whose decoded paths do not
// match the retried request's parameters (the codec only proves the state was
// not tampered — it cannot see the current args).
import type {
  ClientCapabilities,
  InputRequest,
  InputRequiredResult,
  RequestStateCodec,
} from '@modelcontextprotocol/server';
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
} from '@modelcontextprotocol/server';

import { randomBytes } from 'node:crypto';

import * as z from 'zod/v4';

import { ErrorCode, FsError } from './errors.js';
import { Logger } from './observability.js';

/** The destructive operation a pending confirmation authorizes. */
type PendingOp = 'delete' | 'move' | 'copy' | 'grant';

/**
 * Integrity-protected state minted into an `input_required` result and echoed
 * back by the client on retry. `paths` is the sorted canonical set of target
 * paths the confirmation covers; the handler compares it to the retried
 * request's parameters and rejects a mismatch (R9).
 */
export interface PendingState {
  readonly op: PendingOp;
  readonly paths: readonly string[];
}

/** One embedded form-mode confirmation, keyed within the call. */
interface PendingInput {
  /** Server-assigned key, unique within the `tools/call`. */
  readonly key: string;
  /** Human-readable prompt for this item. */
  readonly message: string;
  /**
   * When set, the form offers a titled single-select enum (`choice` field)
   * instead of a boolean `confirm`. Each entry is a `{ value, title }` pair.
   */
  readonly choices?: readonly { value: string; title: string }[];
  /**
   * When set with `choices`, the form offers a multi-select enum: `choice` is
   * a string array (`MultiSelectEnumSchema` shape) and the caller reads the
   * accepted set with `readAcceptedMultiChoice`. Single-select otherwise.
   */
  readonly multi?: boolean;
}

/**
 * HMAC key for the requestState codec. Read once from
 * `FS_REQUEST_STATE_KEY` (UTF-8, must be >=32 bytes); a random
 * 32-byte key is generated at boot when the env var is unset or too short. A
 * per-process key is correct for stdio and the single-node HTTP leg (decision
 * record 11). A server restart invalidates in-flight tokens; the client
 * re-requests, which is fail-closed and safe.
 */
function configuredRequestStateKey(): Uint8Array | undefined {
  const env = process.env['FS_REQUEST_STATE_KEY'];
  if (env) {
    const bytes = Buffer.from(env, 'utf8');
    if (bytes.length >= 32) return bytes;
    Logger.warn(
      `FS_REQUEST_STATE_KEY is ${String(bytes.length)} bytes; 32 are required. Falling back to a random per-boot key — in-flight input_required rounds will not survive a restart.`,
    );
  }
  return undefined;
}

// Built on first use, not at module load, so an unset env var costs nothing at
// import and the random per-boot fallback is minted only once something needs it.
let codec: RequestStateCodec<PendingState> | undefined;

function getRequestStateCodec(): RequestStateCodec<PendingState> {
  codec ??= createRequestStateCodec<PendingState>({
    key: configuredRequestStateKey() ?? randomBytes(32),
  });
  return codec;
}

/**
 * The codec: `mint` seals a `PendingState` into the opaque wire string a
 * handler returns from `inputRequired({ requestState })`; `verify` drops into
 * `ServerOptions.requestState.verify` and throws on tamper, expiry, or bind
 * mismatch (the seam answers with the frozen `-32602`).
 */
export const requestStateCodec: RequestStateCodec<PendingState> = {
  mint: (payload, ctx) => getRequestStateCodec().mint(payload, ctx),
  verify: (state, ctx) => getRequestStateCodec().verify(state, ctx),
};

/**
 * Build a single-select enum confirmation input. The form renders a `choice`
 * field whose options are the titled `choices`; the caller reads the selection
 * with `readAcceptedChoice`.
 */
export function choiceInput(
  key: string,
  message: string,
  choices: readonly { value: string; title: string }[],
): PendingInput {
  return { key, message, choices };
}

/**
 * Build a multi-select enum confirmation input. Like `choiceInput` but the
 * form renders `choice` as a string array (`MultiSelectEnumSchema` shape), so
 * the client may accept a subset; the caller reads the accepted set with
 * `readAcceptedMultiChoice`.
 */
export function multiSelectInput(
  key: string,
  message: string,
  choices: readonly { value: string; title: string }[],
): PendingInput {
  return {
    key,
    message,
    choices,
    multi: true,
  };
}

/**
 * Build an `input_required` result carrying one boolean confirmation per pending
 * item, plus the integrity-protected `requestState` sealing the operation kind
 * and sorted target paths. `mint` is async (HMAC + base64url).
 */
export async function buildInputRequired(
  pending: PendingState,
  inputs: readonly PendingInput[],
): Promise<InputRequiredResult> {
  const inputRequests: Record<string, InputRequest> = {};
  for (const input of inputs) {
    const requestedSchema = input.choices
      ? input.multi
        ? {
            // Multi-select enum (matches MultiSelectEnumSchema): `choice` is a
            // string array; the client may accept a subset of the offered dirs.
            type: 'object' as const,
            properties: {
              choice: {
                type: 'array' as const,
                items: {
                  anyOf: input.choices.map((c) => ({ const: c.value, title: c.title })),
                },
              },
            },
            required: ['choice'],
          }
        : {
            type: 'object' as const,
            properties: {
              choice: {
                type: 'string' as const,
                oneOf: input.choices.map((c) => ({ const: c.value, title: c.title })),
              },
            },
            required: ['choice'],
          }
      : {
          type: 'object' as const,
          properties: { confirm: { type: 'boolean' as const, title: 'Confirm' } },
          required: ['confirm'],
        };
    inputRequests[input.key] = inputRequired.elicit({
      message: input.message,
      requestedSchema,
    });
  }
  const requestState = await requestStateCodec.mint({
    op: pending.op,
    paths: [...pending.paths].sort(),
  });
  return inputRequired({ inputRequests, requestState });
}

/**
 * The shared read-state → `buildInputRequired` → mismatch-throw flow used by
 * every destructive-confirmation handler (delete, move, grant). No verified
 * state, OR a verified state belonging to a different `op` (e.g. a chained
 * call's grant round already resolved and this is now that same call's own
 * delete/move confirmation round), mints a fresh `input_required` for this
 * op. A retry whose verified state matches this op but not the pending path
 * set throws `FsError(INVALID_INPUT)` (R9) — uniformly surfaced as an
 * `isError` tool result by the handler's catch. Returns `undefined` on a
 * matching same-op retry so the caller proceeds.
 *
 * One home for the R9 binding check means a future fix cannot miss two of three
 * sites. The caller supplies `buildInputs` so only the prompt text varies.
 */
interface PendingRoundTripOpts {
  readonly op: PendingOp;
  readonly pending: readonly string[];
  readonly requestState: (() => PendingState | undefined) | undefined;
  /**
   * What the client declared it can do, or `undefined` when this connection
   * cannot say. Only a positively-absent `elicitation` short-circuits; see
   * {@link assertCanElicit}.
   */
  readonly clientCapabilities?: ClientCapabilities | undefined;
  readonly buildInputs: (pending: readonly string[]) => readonly PendingInput[];
}

/**
 * What to tell the model when the round-trip cannot happen. Each names the way
 * forward that does not need a confirmation, or says plainly that there is
 * none — a dead end the model can report is worth more than a retry loop.
 */
const NO_ELICITATION_HINT: Readonly<Record<PendingOp, string>> = {
  delete:
    'Deleting a non-empty directory needs a confirmation this client cannot show. ' +
    'Delete the entries inside it individually, or connect a client that declares the elicitation capability.',
  move:
    'Overwriting an existing destination needs a confirmation this client cannot show. ' +
    'Delete the destination first, or move to a path that does not exist yet.',
  copy:
    'Overwriting an existing destination needs a confirmation this client cannot show. ' +
    'Pass overwrite=true to replace it without confirming, or copy to a path that does not exist yet.',
  grant:
    'Granting access to a directory outside the allowed roots needs a confirmation this client cannot show. ' +
    'Call list_roots and use a path under one of the roots it returns.',
};

/**
 * Fail early, and legibly, when the client cannot answer an embedded request.
 * The SDK checks each `inputRequests` entry against the declared client
 * capabilities and rejects the whole call with `-32021` before anything reaches
 * the wire — a protocol error the model never sees. Throwing `FsError` here
 * instead lands in the tool executor's catch and reaches the model as an
 * `isError` result carrying the workaround.
 *
 * `undefined` capabilities mean the connection cannot report them, NOT that the
 * client has none: proceed and let the SDK decide, exactly as before this check
 * existed.
 */
function assertCanElicit(op: PendingOp, capabilities: ClientCapabilities | undefined): void {
  if (capabilities === undefined) return;
  if (capabilities.elicitation !== undefined) return;
  throw new FsError(ErrorCode.INVALID_INPUT, `${op}: ${NO_ELICITATION_HINT[op]}`);
}

export async function pendingRoundTrip(
  opts: PendingRoundTripOpts,
): Promise<InputRequiredResult | undefined> {
  const state = opts.requestState?.();
  // No verified state yet, OR the verified state belongs to a different
  // flow (e.g. an access-grant round's state is still the retried request's
  // requestState after the grant was applied, and this call is now the
  // destructive-confirmation round for the SAME tool call) — either way,
  // this op has not yet had its own round-trip, so mint a fresh
  // input_required rather than treating a foreign-but-valid state as a
  // tamper/mismatch error.
  if (state?.op !== opts.op) {
    assertCanElicit(opts.op, opts.clientCapabilities);
    return buildInputRequired({ op: opts.op, paths: opts.pending }, opts.buildInputs(opts.pending));
  }
  // Retry for THIS op (R9): the verified state must bind the same pending set.
  if (!pathsEqual(state.paths, opts.pending)) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `${opts.op}: confirmation does not match the requested paths`,
    );
  }
  return undefined;
}

// Response shapes handed to the SDK's schema-aware `acceptedContent` overload:
// it returns `undefined` for a missing key, a decline/cancel, a non-elicit
// response, AND a payload that fails validation — one call covers every refusal
// case the readers below used to hand-check.
const ConfirmContent = z.object({ confirm: z.boolean() });
const ChoiceContent = z.object({ choice: z.string() });
const MultiChoiceContent = z.object({ choice: z.array(z.string()) });

/**
 * Read one pending item's boolean confirmation from a retried request's
 * `inputResponses`. Returns `true` only when the client explicitly accepted AND
 * the `confirm` field is `true`; every other outcome (decline, cancel, missing
 * key, accept-without-confirm) returns `false`, which the caller reports as
 * `CANCELLED` (R3 proceed, R4/R5 cancelled).
 */
export function readAcceptedConfirm(
  responses: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return acceptedContent(responses, key, ConfirmContent)?.confirm === true;
}

/**
 * Read one pending item's enum selection from a retried request's
 * `inputResponses`. Returns the chosen `value` only when the client explicitly
 * accepted AND the `choice` field is a string; every other outcome (decline,
 * cancel, missing key, accept-without-choice) returns `undefined`, which the
 * caller reports as `CANCELLED` — same contract as the boolean reader.
 *
 * The shape is SDK-validated, but the returned value is NOT checked for
 * membership in the `choices` offered in the request schema. Callers must
 * compare against the expected values (e.g. `choice === 'overwrite'`) before
 * acting — never echo the string back into a path or trust it as an enum
 * member.
 */
export function readAcceptedChoice(
  responses: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return acceptedContent(responses, key, ChoiceContent)?.choice;
}

/**
 * Read one pending item's multi-select enum selection from a retried request's
 * `inputResponses`. Returns the accepted `value`s only when the client
 * explicitly accepted AND `choice` is a string array of strings; every other
 * outcome (decline, cancel, missing key, accept-without-choice, non-array
 * `choice`, non-string elements) returns `undefined`, which the caller reports
 * as `CANCELLED` — same contract as the single-select reader.
 *
 * As with `readAcceptedChoice`, the returned values are NOT checked for
 * membership in the offered `choices`; callers must compare against the
 * expected set before acting.
 */
export function readAcceptedMultiChoice(
  responses: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  return acceptedContent(responses, key, MultiChoiceContent)?.choice;
}

/**
 * Order-independent equality of two sorted, de-duplicated path lists. Used to
 * compare a recomputed pending set against the `requestState`-bound set (R9):
 * both are sorted by construction, so a straight element-wise compare settles
 * it without allocating.
 */
function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

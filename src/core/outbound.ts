import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import { ErrorCode, FsError } from './errors.ts';
import type { FileKind } from './mime.ts';
import { MIB } from './util.ts';

const KIB = 1024;

// Single owner of the stdio Message limit: what one stdio response can carry
// once JSON-encoded, and the measures that decide whether a result fits it.

/**
 * Ceiling on JSON-encoded tool and resource results over stdio. The SDK's
 * fixed 10 MiB ReadBuffer applies regardless of `--max-file-size`; escaping,
 * duplicated metadata, and base64 can overflow it even when the source fits.
 * A tool call that changed nothing (read-only, or a dry run) and a resource
 * read return TOO_LARGE instead, and the stdio result store refuses an entry
 * whose read would overflow it; HTTP is unaffected. ~256 KiB covers the
 * JSON-RPC envelope this measure omits, including the bounded request ID.
 * Mutating tools need pre-commit safeguards rather than a post-commit output
 * refusal.
 */
export const MAX_OUTBOUND_RESULT_BYTES = 10 * MIB - 256 * KIB;

/**
 * JSON-encoded stdio request IDs and string progress tokens, including
 * quotes/escapes, must fit the envelope reserve: each is echoed into frames.
 */
export const MAX_STDIO_REQUEST_ID_BYTES = KIB;

/**
 * An upper bound on `Buffer.byteLength(JSON.stringify(value))` for the plain
 * JSON data tool and resource results are made of, from a walk that reads
 * string lengths but never encodes a string. JSON spends at most six bytes on
 * one UTF-16 code unit (`\uXXXX` for a control character or a lone surrogate;
 * any other BMP character is at most three UTF-8 bytes, a surrogate pair four
 * for its two units), so a string or key costs at most 6 × length + 2 quotes.
 * A finite number costs its `String()` form, which is what JSON writes, and a
 * non-finite one `null`; `true`, `false` and `null` at most five. Each array
 * element and object member adds one separator, and a member one colon, on top
 * of the two brackets. A member JSON would omit (undefined, a function) only
 * overcounts. `toJSON` is followed the way JSON.stringify follows it.
 */
export function jsonByteBound(value: unknown): number {
  if (typeof value === 'string') return 6 * value.length + 2;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value !== 'object' || value === null) return 5;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return jsonByteBound((value as { toJSON: () => unknown }).toJSON());
  }
  let bytes = 2;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) bytes += jsonByteBound(item) + 1;
    return bytes;
  }
  for (const [key, item] of Object.entries(value)) {
    bytes += 6 * key.length + 2 + 1 + jsonByteBound(item) + 1;
  }
  return bytes;
}

/**
 * `size` raw bytes' length once base64-encoded: the wire cost of an embedded
 * binary resource. 4/3 rounded up per 3-byte group, standard base64, no line
 * wrapping.
 */
export function base64EncodedBytes(size: number): number {
  return 4 * Math.ceil(size / 3);
}

/**
 * `value`'s JSON-encoded size in bytes when it is over `limit`, else
 * `undefined`. {@link jsonByteBound} clears most values without encoding them;
 * only one it cannot clear pays for the exact `JSON.stringify` measure.
 */
export function jsonBytesOver(value: unknown, limit: number): number | undefined {
  if (jsonByteBound(value) <= limit) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  return bytes > limit ? bytes : undefined;
}

/** The transport a result leaves on; unset is the in-memory pair. */
export type Transport = 'stdio' | 'http' | undefined;

/**
 * The least a file of `size` bytes costs in a resources/read result: text
 * encodes to at least its own bytes, and binary comes back base64.
 */
function readResultFloor(size: number, binary: boolean): number {
  return binary ? base64EncodedBytes(size) : size;
}

/**
 * That floor for a file of `size` bytes when it is already over the Message
 * limit on `transport`, else `undefined`: a read refused before it is encoded.
 */
export function readFloorOver(
  transport: Transport,
  size: number,
  binary: boolean,
): number | undefined {
  const floor = readResultFloor(size, binary);
  return transport === 'stdio' && floor > MAX_OUTBOUND_RESULT_BYTES ? floor : undefined;
}

/**
 * `value`'s JSON-encoded size when it is over the Message limit on
 * `transport`, else `undefined`. Only stdio has one (ADR-003).
 */
export function bytesOverMessageLimit(transport: Transport, value: unknown): number | undefined {
  return transport === 'stdio' ? jsonBytesOver(value, MAX_OUTBOUND_RESULT_BYTES) : undefined;
}

/** A file a tool may offer as a link, as far as the caller knows it. */
export interface LinkCandidate {
  /** The file resource URI the link would name; it counts toward the read. */
  readonly uri: string;
  readonly mimeType: string;
  readonly size: number;
  readonly kind: FileKind;
  /** Only when the caller wrote it; a read slice is not the file. */
  readonly content?: string | undefined;
}

/**
 * Whether stdio's resources/read would serve `file`, so a link to it is one
 * the client can follow. Written text is measured as the read encodes it;
 * otherwise the rule is the read's own size pre-check. HTTP always serves.
 */
export function canLinkFile(transport: Transport, file: LinkCandidate): boolean {
  if (transport !== 'stdio') return true;
  // readRaw returns any non-text kind as base64 (`isBinary: kind !== 'text'`).
  if (file.kind !== 'text') return readFloorOver(transport, file.size, true) === undefined;
  if (file.content === undefined) {
    // shortcut: size-only text links skip escaping and the envelope, so wrapRead can still refuse > ~5.1 MB of quotes/backslashes or a file a few hundred bytes under the limit; measure the file if clients hit it (ADR-006)
    return readFloorOver(transport, file.size, false) === undefined;
  }
  const result = {
    contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.content }],
  };
  return jsonBytesOver(result, MAX_OUTBOUND_RESULT_BYTES) === undefined;
}

/** A tool result's refusal; `remedy` replaces TOO_LARGE's default advice. */
export function refuseToolResult(toolName: string, bytes: number, remedy: string): FsError {
  return new FsError(
    ErrorCode.TOO_LARGE,
    `${toolName} result too large to return (${String(bytes)} bytes once JSON-encoded, over the ${String(MAX_OUTBOUND_RESULT_BYTES)}-byte stdio message limit).`,
    undefined,
    undefined,
    remedy,
  );
}

/**
 * The refusal for a resource result stdio's fixed-size reader cannot carry.
 * `atLeast` when `bytes` is a lower bound known before the result was encoded.
 */
export function refuseResourceRead(bytes: number, atLeast = false): ProtocolError {
  const suggestion = 'Read smaller slices/pages with tools, or connect over HTTP.';
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Resource result too large to return (${atLeast ? 'at least ' : ''}${String(bytes)} bytes once JSON-encoded, over the ${String(MAX_OUTBOUND_RESULT_BYTES)}-byte stdio message limit). ${suggestion}`,
    { code: ErrorCode.TOO_LARGE, suggestion },
  );
}

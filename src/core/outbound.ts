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

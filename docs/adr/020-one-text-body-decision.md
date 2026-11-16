# ADR-020: One module decides a file's text body

**Status**: accepted, 2026-11-16
**Deciders**: j0hanz, in the architecture review of 2026-11-16 (Candidate 1)

## Context

ADR-015 made `GuardedFileSystem` own every read and promised that `stat`,
`read` and `readText` agree on UTF-16 probes. They agreed on the probe but not
on what follows it:

- `read` and `readText` each decoded UTF-16, with different size checks
  (decoded UTF-8 against `maxSize` in `read`; re-encoded bytes against
  `getMaxTextFileSize()` in `readText`).
- Decoding was a per-call `decodeUtf16` flag. `tools/read.ts` and
  `core/search.ts` set it; `tools/stat.ts` did not, so `stat` gave no
  `lineCount` for a UTF-16 file that `read` returns with `totalLines`.
- `read` never checked the body for valid UTF-8 and returned lossy text;
  `readText` called the same file `undecodable`, so `stat` gave no count.

## Decision

One function in `src/core/read.ts` (internal to `fs.ts`, per ADR-015) settles
a file's text body from its bytes: binary, or text with an encoding
(`utf-8`, `utf-16le`, `utf-16be`) and a `lossy` mark. Every reader uses it.

- **UTF-16 with a byte-order mark is always decoded.** The `decodeUtf16`
  option is removed. A Rewrite refuses a text body whose encoding is not
  `utf-8`, with the UTF-16 refusal it has always given.
- **Non-UTF-8 text is text, marked lossy.** `read` returns it with U+FFFD and
  adds `lossy: true` to that path's result; `stat` counts its lines; a text
  search searches it lossily as before; a Rewrite refuses it. A slice is
  judged lossy on the bytes it read.
- **The size limit is judged on bytes on disk only.** UTF-16 past the limit
  still fails `TOO_LARGE` in every read mode.
- **The NUL rule stays where it is.** A text search skips a body holding a NUL
  byte as binary (grep -I), and a Rewrite refuses it; `read` and `stat` treat
  it as text. File class stays settled by extension and the leading 512 bytes.

## Considered options

- **Undecodable everywhere** (`read` refuses non-UTF-8 like a Rewrite).
  Rejected: `search_text` would stop matching in Latin-1 files, a deliberate
  grep-like behaviour, and `read` would lose files agents can read today.
- **Size limit on decoded text, or on both.** Rejected: unknown until the file
  is read whole, and it disagrees with the size `stat` reports.
- **The text-body module owns the NUL rule.** Rejected: it is a search and
  Rewrite convention, not a File class decision; moving it would make `read`
  refuse files it serves today.
- **A truncated head for oversize UTF-16.** Deferred: a feature, not part of
  this deepening; it can land later inside the module.

## Consequences

- `read`'s per-path result gains an optional `lossy: true`; the contract
  snapshot changes additively.
- `TextVerdict` loses `undecodable` and `binary.utf16`; its `text` arm carries
  `encoding` and `lossy`. Scan skip accounting is unchanged.
- One table test in `__tests__/core-fs.test.ts` pins the verdict for UTF-8,
  BOM UTF-8, UTF-16LE, UTF-16BE, Latin-1, a late NUL and an oversize file.

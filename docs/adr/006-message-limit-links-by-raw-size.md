# ADR-006: Over stdio, link a file by its raw size against the Message limit

**Status**: accepted, 2026-10-27
**Deciders**: j0hanz, in the grilling of the outbound-limit candidate from that day's architecture review

## Context

The SDK's stdio reader drops the connection on a message past 10 MiB. The
server keeps every stdio response under the **Message limit**,
`MAX_OUTBOUND_RESULT_BYTES` (10 MiB less 256 KiB for the envelope). Four
files own a piece of that rule today. `util.ts` holds the constant and the
measures, `file-uri.ts` decides which files a write tool may link,
`resources.ts` refuses a resource read, and `define.ts` refuses a tool
result.

The pieces disagree. `read` never asks whether stdio can serve the link it
offers: it links any file up to the file size limit (`read.ts:249`). Over
stdio with the defaults, `read {head: 1}` of a 10,300,000-byte text file
returns a `resourceUri` and a `resource_link`, and `resources/read` on that
link fails with `-32602 TOO_LARGE`, because `resources.ts:237` refuses any
file whose raw size is over the limit. Every text file whose raw size is in
(10,223,616, 10,485,760] reproduces it.

The write tools ask, but with a different rule from the one the read
enforces. When they do not have the content, as for a `create` append,
they assume every byte escapes to six (`file-uri.ts:123`). A binary file
also gets 64 KiB of slack that the read does not apply (`file-uri.ts:126`).

A link must name a file that `resources/read` will serve. The question is
how to know that before linking, when the server has only the file's size.

## Considered options

- **Raw size against the limit (chosen).** A text file is linkable when its
  raw size is at most the limit, and a binary one when its base64 length
  is. These are the read's own pre-checks (`resources.ts:237` and `:244`),
  so the link and the refusal follow one rule, and the check costs a
  `stat` the caller already has.
- **Worst-case escape, 6x the size.** Rejected: over stdio, `read` would
  stop linking any text file above about 1.7 MB. That takes the link away
  from almost every large file stdio can serve, to cover a file stdio
  rarely sees.
- **Read the whole file to measure it.** Rejected: a `head: 1` read of a
  9 MB file would read 9 MB just to decide whether to attach a link.

## Decision

A new core module, `src/core/outbound.ts`, owns the Message limit: the
constant, the measures, the "does it fit" check and both refusals (the
tool's `FsError` `TOO_LARGE` and the resource read's `ProtocolError`). It
answers per transport. HTTP and the in-memory pair always fit: only the SDK's fixed 10 MiB stdio
read buffer limits a message.

Over stdio, a file is linkable when:

- the caller wrote the content and it is text: the exact encoded
  `resources/read` result fits, measured as `wrapRead` measures it;
- the file is not text: its base64 length plus the result around it (URI,
  MIME type, JSON framing) is at most the limit, which is exact;
- the caller knows only the size of a text file (a read slice, a `create`
  append): its raw size plus that same result is at most the limit.

`read` and the write tools both ask the module before they link.

## Consequences

- `read` over stdio no longer offers a link that `resources/read` refuses
  by its pre-check.
- `create` with `append` over stdio links more often: any text file up to
  the limit, not only one under about 1.7 MB. A binary write links up to
  the exact size `resources/read` serves, without the 64 KiB slack.
- A residual is accepted. A text file the server has only the size of can
  still be linked and then refused by `wrapRead`'s exact measure. That
  needs escapes that double the file past the limit (more than about
  5.1 MB of quotes or backslashes). The refusal is a clean `TOO_LARGE`, not a dropped connection. The code
  marks the shortcut in `canLinkFile`, with what would make it worth
  measuring the file instead.
- The refusal texts do not change, so the contract snapshot does not
  either.

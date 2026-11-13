# filesystem-mcp

A guarded filesystem served to MCP clients: every path a client names is checked
against the allowed roots before anything reads or changes it.

## Path views

**Entry**:
The directory entry a requested path names, taken as itself: a final symlink is
the link, not what it points at.
_Avoid_: source (when no move is involved), real path

**Landing**:
Where a write to a requested path ends up: the path with a final symlink
followed, which may not exist yet.
_Avoid_: target, resolved target, destination (when no move is involved)

**Respelling**:
A requested path that names an existing entry in another case or Unicode
spelling; acting on it renames that entry rather than creating a second one.
_Avoid_: spelling-only rename, case rename

**Self-move**:
A move or rename whose destination lands on its own source, in either
direction (a link onto its target, or onto a link to it); it changes nothing.
_Avoid_: no-op move, same-path move

**Relocation**:
A move or copy that gives a directory's entries new paths, including undo
moving a directory back. A relocation must keep every entry's protection: no
entry may leave or enter the sensitive-file policy because its path changed.
_Avoid_: transfer (when undo is meant too), rename (when the entries move)

**Transfer**:
A move or copy of one source to one destination on a client's behalf, settled
before any Confirmation is asked for and checked again before anything changes.
A Self-move, or a copy onto its own Respelling, changes nothing; a directory
transfer must be a Relocation. It refuses when the destination is no longer the
entry it saw when it was settled.
_Avoid_: relocation (which also covers undo moving a directory back), move (one
of its two kinds)

## Scans

**Scan**:
A walk of a directory scope on a client's behalf that rules on every entry it
finds: usable, sensitive, inaccessible, binary, undecodable or too large. A
sensitive entry is passed over without a trace; every other entry it cannot
use, including a directory it could not read, is counted, so a scan with holes
never reads as complete. A scan does not follow a symlinked file, and it stops
by one rule shared by every tool that scans.
_Avoid_: walk (the raw traversal, which relocation and undo also use), search
(one tool's use of a scan), sweep

## Text

**File class**:
Whether an entry is treated as UTF-8 text, media (`image` or `audio`), PDF,
UTF-16, or binary, settled once by extension and the leading 512 bytes. A `read`
call refuses UTF-16 even with `binary: true` so the caller converts it first,
whereas a resource read serves UTF-16 as binary bytes.
_Avoid_: mime sniff, content guess

**Text view**:
The text of a file as a tool judges it: a leading byte-order mark is hidden,
and a file whose every line ends in CRLF is shown with LF endings; a file
with mixed endings is shown as written. A write through the view puts both
back, so the file keeps its mark and its endings. A text search and every
Rewrite read through one view; what a Rewrite reports as before and after is
the text on disk, not the view. Text a client typed keeps a leading U+FEFF as
content unless the Mark rule takes it.
_Avoid_: normalised text, decoded content, prepared text

**Mark**:
A file's leading byte-order mark, which the Text view hides. Text a client
sends is first judged as typed; only when that finds nothing is a leading
U+FEFF in it taken for the mark, and then only where the text sits at the
start of the file. Text placed at the start of a marked file loses its
leading U+FEFF to the mark rather than adding a second one.
_Avoid_: BOM (the bytes on disk), signature

## Matching

**Match plan**:
What a text search or a replacement settles about its needle before any text
is read: which engine judges it — a native literal pass or the regex engine —
under the flags, and the per-text bails that hand judgment to the regex
engine (a fold character in the text; U+FFFD or a lone surrogate in the
needle). Search and replace ask one module for their plans, their byte-level
prefiltering, their matches, and their replacements, directly over the Text
view, so a preview judges exactly what its replacement will touch. The engine
adapts a literal needle and its replacement for an all-CRLF view internally,
and enforces output size limits on restored content. A match may span a line
break in both; a search reports it on the line where it starts. In a text with
mixed endings a regex sees each CRLF as LF, so `$` matches before it and
`\r\n` matches nothing; a literal needle sees that text as written.
_Avoid_: matcher selection, dispatch, engine choice, fast path

## Writes

**Rewrite**:
A call that replaces a text file's content with a transform of its current
content (`edit`, `patch`, `replace_text`), under the file's write lock unless
it is a dry run, which reads and reports but writes nothing.
_Avoid_: edit (one tool), transaction, write (`create` also writes)

**Deletion**:
The removal of one or more entries from the filesystem under the sensitive-file
and workspace root policies, planned before any confirmation is asked for and
checked again before anything is removed. A recursive deletion of a non-empty
directory requires Confirmation; an entry replaced while the prompt was open
is refused, not deleted.
_Avoid_: remove, rm, unlink

**Creation**:
The writing of a whole text file on a client's behalf — a new file, an
overwrite, or an append — planned before any Confirmation is asked for and
checked again before anything is written. A plan seals the Landing identity
of a file that would be replaced: an entry replaced while the prompt was
open is refused, not overwritten, and one that appeared while it was open is
refused too, not clobbered. An append, or an overwrite the client declared
up front, destroys nothing, so it is pre-settled with no prompt.
_Avoid_: write (a Rewrite replaces content; a Creation fills a file whole),
create (one tool), mkdir (one kind of Creation)

## Batches

**Batch**:
A multi-item execution on a client's behalf that preserves the client's input
order across all settled items. Pre-settled items (noops, duplicates, plan-time
refusals) take their slots without mutation; pending items run concurrently under
the call's concurrency and cancellation rules. On abort or deadline, finished
items are preserved and unstarted items report the abort, so a retried call knows
what already landed.
_Avoid_: parallel loop, bulk run, multi-op

## Undo

**Capture**:
The record of a tool call's filesystem changes, held from before the first
mutation until the result is returned; abandoned, with a reason, when undo
becomes impossible or not worth the budget. A capture that is unavailable
records nothing further, and the mutation still runs. Each path a call changes
has its own capture, so abandoning one costs only that path's undo; a copy
has one capture for its destination, abandoned when the copy fails part-way
or its files total more than eight times the undo budget. A path's capture
reports only once that path has, or may have, changed; an exit before that
reports nothing.
_Avoid_: undo session, transaction, undo buffer

**Undo journal**:
The session's record of undoable calls, newest last, and the one place an
undo runs: it picks the entries, previews a dry run across all of them,
keeps moved entries traceable after a restore replaces a file, and drops
what was restored. A cancelled undo keeps what it finished.
_Avoid_: undo log, history, undo stack

## Approval

**Confirmation**:
The round in which the client approves deleting or overwriting the entries a
call would destroy. An approval covers the exact entries the client was shown:
an entry replaced while the prompt was open is asked about again, once.
An entry replaced after the approval, once writing has begun, is refused,
not asked about again. An entry that vanished needs no approval. Two items
that name one entry ask one question, and it is asked when either requires it;
two that saw different entries at one path count as an entry replaced.
_Avoid_: prompt, elicitation (the protocol mechanism), access grant (widening
the allowed roots is a different question)

**Round bind**:
What a minted `requestState` is sealed to: the request's JSON-RPC method
and its authenticated caller. A retried call whose context yields a
different value is refused, so a round minted for one request cannot be
replayed onto another.
_Avoid_: request context (the whole SDK shape a tool body never sees),
bind context

## Configuration

**Setting**:
An operator's choice that can be given as a command-line flag or as an `FS_*`
environment variable. The flag wins. A flag whose value is invalid falls back
to the default, never to the variable, and a rejected value is warned about
once. A setting has one answer for the guard, the tools and `--print-config`
alike. A list an operator can give both ways (deny patterns, allow patterns,
read-only folders) is the union of both and is not a setting; neither is a
choice settled once at startup (port, host, API key, read-only).
_Avoid_: config value, option, override (the flag half), env var (the other
half)

## Transport

**Message limit**:
What one stdio response can carry, after JSON encoding; a link the server
offers over stdio must name a file that fits it.
_Avoid_: outbound budget, size cap (that is `FS_MAX_FILE_SIZE`)

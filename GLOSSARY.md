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

## Matching

**Match plan**:
What a text search or a replacement settles about its needle before any text
is read: which engine judges it — a native literal pass or the regex engine —
under the flags, and the per-text bails that hand judgment to the regex
engine (a fold character in the text; U+FFFD or a lone surrogate in the
needle). Search and replace ask one module for their plans, so a preview
judges exactly what its replacement will touch.
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

## Undo

**Capture**:
The record of a tool call's filesystem changes, held from before the first
mutation until the result is returned; abandoned, with a reason, when undo
becomes impossible or not worth the budget. A capture that is unavailable
records nothing further, and the mutation still runs. Each path a call changes
has its own capture, so abandoning one costs only that path's undo; a copy
abandons the whole call. A path's capture reports only once that path has, or
may have, changed; an exit before that reports nothing.
_Avoid_: undo session, transaction, undo buffer

## Approval

**Confirmation**:
The round in which the client approves deleting or overwriting the entries a
call would destroy. An approval covers the exact entries the client was shown:
an entry replaced while the prompt was open is asked about again, once.
An entry replaced after the approval, once writing has begun, is refused,
not asked about again. An entry that vanished needs no approval.
_Avoid_: prompt, elicitation (the protocol mechanism), access grant (widening
the allowed roots is a different question)

**Round bind**:
What a minted `requestState` is sealed to: the request's JSON-RPC method
and its authenticated caller. A retried call whose context yields a
different value is refused, so a round minted for one request cannot be
replayed onto another.
_Avoid_: request context (the whole SDK shape a tool body never sees),
bind context

## Transport

**Message limit**:
What one stdio response can carry, after JSON encoding; a link the server
offers over stdio must name a file that fits it.
_Avoid_: outbound budget, size cap (that is `FS_MAX_FILE_SIZE`)

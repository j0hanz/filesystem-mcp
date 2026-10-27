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

## Undo

**Capture**:
The record of a tool call's filesystem changes, held from before the first
mutation until the result is returned; abandoned, with a reason, when undo
becomes impossible or not worth the budget. A capture that is unavailable
records nothing further, and the mutation still runs.
_Avoid_: undo session, transaction, undo buffer

## Approval

**Confirmation**:
The round in which the client approves deleting or overwriting the entries a
call would destroy. An approval covers the exact entries the client was shown:
an entry replaced while the prompt was open is asked about again, once, and an
entry that vanished needs no approval.
_Avoid_: prompt, elicitation (the protocol mechanism), access grant (widening
the allowed roots is a different question)

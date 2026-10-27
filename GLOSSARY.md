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

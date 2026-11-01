# ADR-010: Per-root read-only is a containment check in the PathGuard

**Status**: accepted, 2026-11-01
**Deciders**: j0hanz, from [#162](https://github.com/j0hanz/filesystem-mcp/issues/162)

## Context

`--read-only` removes every mutating tool from the advertised surface — all
roots or none. A single container serving a writable workspace and a
reference tree had no way to make one root read-only without running a second
server. The issue asks for a per-root access level; the server already tracks
which root a path belongs to (`PathGuard.allowedRootContaining`).

Two designs fit. A **per-root mode table**: each allowed root carries
`ro`/`rw`, and a write checks the mode of the root it lands in. Or a
**containment list**: the server holds a set of read-only directories and
refuses any resolved write or delete path inside one.

## Decision

The containment list, enforced inside the PathGuard validators — not a mode
table on roots.

- `--read-only-root <dir>` (repeatable) and `FS_READ_ONLY_DIRS` union like the
  allowed roots do; the PathGuard stores every spelling of each dir
  (configured and realpath alias) and a mutation is refused when its
  _resolved_ path sits inside any of them (`assertWritable`, called from
  `validatePathForWrite` and `validatePathForDelete`).
- Containment, not root identity, so a read-only dir may be a whole root, a
  subtree of a writable root, or a directory containing several roots. A
  symlink in a writable root cannot smuggle a write into a read-only one,
  because the check runs on the resolved spelling; deleting such a link is
  allowed, since the link itself lives in the writable root.
- Read-only dirs are deliberately not filtered by `FS_ROOT_BOUNDARY`: a dir
  outside every boundary denies nothing new, because paths there are already
  refused. A dir that matches no allowed root warns — a typo would otherwise
  leave the intended root writable.
- Access grants stay writable unless they land under a read-only dir; the
  same containment check covers them.
- The global `--read-only` flag is unchanged: it still gates at registration
  time and removes the mutating tools entirely. Mixed mode keeps every tool
  advertised and refuses at call time, so the advertised surface does not
  depend on the roots' modes.
- `undo` needs no rule of its own: the journal is session-scoped, and a
  restore revalidates through the same guard methods, so an entry that
  targets a read-only dir is refused at restore time.

## Consequences

- The check shares the TOCTOU window documented on the PathGuard class
  (`src/core/path.ts`): validation returns a path and the syscall follows, so
  a directory swapped in between could redirect a write. Same residual, same
  documented mitigations.
- `list_roots` (`readOnlyDirs`) and `--print-config` (`readOnlyDirs`) are the
  discovery surfaces; the refusal names the read-only dir and the flags.
- The tools/list description of `list_roots` grew by ~100 chars, so the
  session-start byte budget rose with it (TOOL-SURFACE-002).

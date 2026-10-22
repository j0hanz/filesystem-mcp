# Ponytail Debt Ledger

Harvested 2026-10-22 via `/ponytail:ponytail-debt`. Code markers only; prose
mentions in `docs/`, `plans/`, and specs are excluded by the comment-prefix rule.

Convention: `ponytail: <ceiling>, <upgrade path>`.

## src/core/watcher-registry.ts:44

Ref-count by URI; no per-subscription id. Simplified: departed direct-notification
callbacks linger until the final lease ends; a URI whose watcher errored keeps one
map entry per still-unreleased lease (bookkeeping only, no watcher slot).
ceiling: SDK unsubscribe contract has no per-subscription id.
upgrade: per-subscription-id keying retires both quirks (see memory
`watcher-no-subscription-id`).

## src/core/undo.ts:661

Recreated directory gets its recorded mode back through `mkdir` on undo, with
owner rwx forced so the server can write the children back. Simplified: no
chmod; mkdir's mode is masked by the umask, so group/other bits can come back
narrower than they were, never wider.
ceiling: umask-cleared bits (group/other write, e.g. `0775` as `0755`) are not
restored; an owner-read-only folder comes back owner-writable; a parent that an
older move's undo recreated first keeps the default mode (its `mkdir` record
then counts it as done).
upgrade: a guarded `chmod` on `GuardedFileSystem` for exact bits.

## src/core/store.ts:297

`PageSnapshotStore` bounded by snapshot count and TTL, not bytes.
ceiling: MAX_SNAPSHOTS x 20,000 `list` entries or MAX_SNAPSHOTS x 10,000
`search_text` matches (each retaining up to 20 more line strings at
`context: 10`), order of a few hundred MB held for 60s; HTTP leg shares one
store so any caller can drive it.
upgrade: pass a byte weight to `set` the way `ResourceStore` does, if memory
pressure shows up.

## src/core/schema.ts:232

Charset regex, not `z.base64url()`. Simplified: the SDK's AJV warns on the
unknown `base64url` format; the server's own decode (cursor.ts) is the real
validation, so the alphabet-only client schema is safe.
ceiling: client-facing schema accepts any base64url-alphabet string.
upgrade: `z.base64url()`, once the SDK's AJV registers the `base64url` format.

## src/core/fs.ts:301

Rename undo check is identity-only. Simplified: a moved directory whose
contents changed after the move is still moved back.
ceiling: no content fidelity for moved directories.
upgrade: hash the tree under `to` before recording it.

## src/core/fs.ts:446

Undo capture saves the whole old file, not its size. Simplified: a multi-GB
append goes over the capture budget and reads as not undoable.
ceiling: whole-file capture against the undo budget.
upgrade: a `truncate` record with a streamed after-hash.

## src/core/fs.ts:610

Forced `cp` abandons the undo capture. Simplified: undoing a forced cp means
telling new files apart from overwritten ones across a merged tree.
ceiling: copies are not undoable.
upgrade: snapshot destination entries here before `fsCp`, the way
`snapshotTree` does.

## src/server.ts:143

SDK `debouncedNotificationMethods` coalesces same-tick duplicates only.
Simplified: parallel tools/call on one connection can still send the same
notification several times; the modern HTTP leg publishes through the
ServerEventBus, which this option does not touch.
ceiling: cross-tick bursts (batch externalizations separated by fs awaits)
still fan out; protects the stdio/in-memory leg only.
upgrade: a store-level debounce, if clients ever report the cross-tick burst.

## examples/clients/gatekeeper/agent.ts:161

No stale-preview check between dry run and apply. Simplified: exact-match edit
fails instead of corrupting, and the model sees that error.
ceiling: an edit applied after the file changed under it fails rather than
being caught pre-apply.
upgrade: a content-hash check, if a user reports an apply that differs from its
preview.

---

9 markers, 0 with no trigger.

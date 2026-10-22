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

## src/core/undo.ts:383

Recreated directory gets the default mode on undo. Simplified: no chmod record;
mkdir's mode is masked by the umask. Files get their exact mode back;
directories do not.
ceiling: `GuardedFileSystem` has no chmod.
upgrade: add a chmod record.

## src/core/store.ts:297

`PageSnapshotStore` bounded by snapshot count and TTL, not bytes.
ceiling: MAX_SNAPSHOTS x 20,000 `list` entries or MAX_SNAPSHOTS x 10,000
`search_text` matches (each retaining up to 20 more line strings at
`context: 10`), order of a few hundred MB held for 60s; HTTP leg shares one
store so any caller can drive it.
upgrade: pass a byte weight to `set` the way `ResourceStore` does, if memory
pressure shows up.

## src/core/schema.ts:232 (no-trigger)

Charset regex, not `z.base64url()`. Simplified: the SDK's AJV warns on the
unknown `base64url` format; the server's own decode (cursor.ts) is the real
validation, so the alphabet-only client schema is safe.
ceiling: client-facing schema accepts any base64url-alphabet string.
upgrade: none named — comment argues the simplification is permanently safe
and gives no revisit trigger. Rot risk: revisit if the SDK's AJV ever learns
the `base64url` format.

## src/core/fs.ts:269

Rename undo check is identity-only. Simplified: a moved directory whose
contents changed after the move is still moved back.
ceiling: no content fidelity for moved directories.
upgrade: hash the tree under `to` before recording it.

## src/core/fs.ts:413

Undo capture saves the whole old file, not its size. Simplified: a multi-GB
append goes over the capture budget and reads as not undoable.
ceiling: whole-file capture against the undo budget.
upgrade: a `truncate` record with a streamed after-hash.

## src/core/fs.ts:570

Forced `cp` abandons the undo capture. Simplified: undoing a forced cp means
telling new files apart from overwritten ones across a merged tree.
ceiling: copies are not undoable.
upgrade: snapshot destination entries here before `fsCp`, the way
`#snapshotTree` does.

## src/server.ts:143

SDK `debouncedNotificationMethods` coalesces same-tick duplicates only.
Simplified: parallel tools/call on one connection can still send the same
notification several times; the modern HTTP leg publishes through the
ServerEventBus, which this option does not touch.
ceiling: cross-tick bursts (batch externalizations separated by fs awaits)
still fan out; protects the stdio/in-memory leg only.
upgrade: a store-level debounce, if clients ever report the cross-tick burst.

## examples/clients/gatekeeper/agent.ts:161 (no-trigger)

No stale-preview check between dry run and apply. Simplified: exact-match edit
fails instead of corrupting, and the model sees that error.
ceiling: an edit applied after the file changed under it fails rather than
being caught pre-apply.
upgrade: none named — example code, low rot risk, but no revisit trigger.

---

10 markers, 2 with no trigger.
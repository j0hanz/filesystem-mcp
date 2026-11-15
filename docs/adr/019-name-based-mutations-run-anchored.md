# ADR-019: Name-based mutations run anchored to their validated directory

**Status**: accepted, 2026-11-15
**Deciders**: j0hanz, in the upstream parity review

## Context

Path validation returns a string, and the mutation resolves that string again (`src/core/path.ts:337-348`). Between the two, a writable parent can be swapped for a link that points outside the roots. `#assertParentStillWritable` narrows that window, but the temp-file write and the rename still walk the path from the top, so a swap after the check carries both outside.

Reads already close this gap with `lstatPinned` in [`src/core/pinned.ts`](../../src/core/pinned.ts): it enters the directory with `chdir`, reads `getcwd` back, and acts on the base name. The kernel reports the directory it actually entered, not the string it was given.

## Decision

- **On POSIX, on the main thread (`CAN_PIN`), a name-based mutation runs anchored.** `inPinnedDirectory(directory, action)` enters the validated directory, confirms where the kernel put it, runs `action` on base names, and restores the previous working directory (or the root, when that one is gone). A directory that resolves elsewhere is refused with `ACCESS_DENIED`.
- **Scope.** The whole-file write commit: the temp file create and the rename are anchored; the write, sync, owner and mode go through the descriptor the anchored open returned (this ADR). Recursive `mkdir` and single-entry delete follow, then move. Plain `mkdir` stays path-based; `rm` falls back to the path-based delete when lstat finds no entry.
- **Every anchored section is synchronous.** The working directory is process-wide, so no other request may run while it is borrowed. No `await` inside an anchor.
- **An injected raw rename keeps the path-based route**, so tests that inject one still see the call.

## Residuals

- **Windows and worker threads keep the re-validation check.** On Windows the working directory is a string and proves nothing; `process.chdir` throws in a worker.
- **Recursive directory delete and copy stay path-based.** A synchronous tree walk would block the event loop for the whole tree.

## Consequences

- A parent swapped between validation and the write commit makes the write fail with `ACCESS_DENIED`, and nothing lands outside the roots.
- The anchored write blocks the event loop only for the open and the rename. The bytes and the flush run async through the descriptor, so a slow disk or hung mount does not stall other requests.
- `__tests__/pinned.test.ts` covers the anchor; `__tests__/swap-after-validation.test.ts` covers the swapped commit and defines the `swapBeforeChdir` seam later tasks reuse.

# ADR-015: GuardedFileSystem owns every read mode and shares one classification table

**Status**: accepted, 2026-11-13
**Deciders**: j0hanz, in the architecture review of Candidate 1 (Unified File Classification & Single-Open Reads)

## Context

Three modules shared file classification and reading inconsistently:

- `src/core/mime.ts` kept media and core types in `EXT_MAP` and binary-only extensions (`bin`, `dat`, `sqlite`, `mp4`, …) in a separate `EXTRA_BINARY_EXTENSIONS` list outside `EXT_MAP`, while `isBinarySample` only flagged NUL bytes and invalid UTF-8 prefixes (missing UTF-16 byte-order marks). `tools/read.ts` patched around that drift when falling back from `readFile` to `readRaw`.
- `tools/read.ts` could open a file twice (once in `readFile`, then again in `readRaw` on binary fallback or media pre-check), and `src/resources.ts` ran `fs.stat` before `fs.readRaw` on stdio.
- `src/core/read.ts` exported 19 internal helpers across `fs.ts`, `scan.ts`, `tools/read.ts`, `file-uri.ts`, `rewrite.ts`, and `tools/patch.ts`, while `src/core/scan.ts` exported `readText` and `readNamedText` (the guarded text-verdict read) instead of `GuardedFileSystem`.

## Decision

`GuardedFileSystem` in `src/core/fs.ts` owns every guarded read through three purpose-shaped single-open methods backed by one unified **File class** in `src/core/mime.ts`:

- **Unified classification (`src/core/mime.ts`)**: `EXTRA_BINARY_EXTENSIONS` folds into `EXT_MAP` (`KNOWN_BINARY_EXTENSIONS` derives from non-text entries other than `.svg`), and `isBinarySample` treats UTF-16 byte-order marks as binary everywhere. A full `read` still refuses UTF-16 with `INVALID_INPUT` even when `binary: true`, whereas `resources/read` serves UTF-16 as a base64 `blob`.
- **Single-open read surface (`GuardedFileSystem`)**:
  - `read(filePath, options?)`: client delivery (full or head/tail/range slice, policy `'refuse' | 'media' | 'allow' | 'raw'`, optional `beforeBody` check run after the guarded stat, the one verified open and the 512-byte classification, and before the body read). The stat stays ahead of the open so a FIFO or directory is refused before an open could block.
  - `readText(filePath, options?)`: non-throwing **Scan** / **Rewrite** / search `TextVerdict` returning the raw bytes and the `fstat` result; callers already hold the validated path.
  - `readNamedText(filePath, options?)`: strict named UTF-8 text read (`diff`, `edit`, `patch`) translating non-text verdicts into `FsError`.
- **Private read mechanics**: `src/core/read.ts` becomes strictly internal to `src/core/fs.ts`. `countLines` moves to `src/core/fmt.ts`, and `createTooLargeError` (with binary/UTF-8 error constants and `isBinaryRefusal`) moves to `src/core/errors.ts`.

## Considered options

- **One 7-overload `read(filePath, spec)` with custom `AcceptPolicy` callbacks.** Rejected: pushes generic overload complexity and callback variation onto callers while risking per-tool classification drift.
- **Keep `readNamedText` in `src/core/scan.ts` with only `read` and `readText` on `GuardedFileSystem`.** Rejected: leaves a named-file text read inside the directory **Scan** module and forces `diff` and `rewrite` to depend on `scan.ts`.

## Consequences

- `tools/read.ts` and `resources.ts` never double-open or pre-stat for classification or stdio **Message limit** enforcement.
- `stat`, `read`, `resources/read`, and `readText` agree on binary extensions and UTF-16 probes.
- No wire schema or tool description changes; `__tests__/contract.test.ts` stays unchanged. `__tests__/resources.test.ts`, `__tests__/scan.test.ts`, and `__tests__/core-fs.test.ts` migrate from `readRaw` / `scan.readText` / `core/read.ts` helpers to `GuardedFileSystem`.

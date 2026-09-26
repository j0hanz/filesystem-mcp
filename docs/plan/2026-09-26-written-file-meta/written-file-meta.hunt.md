# Bug hunt: written-file-meta

## 2026-09-26

Hunted `fix/written-file-meta` at `9e29d0ca` against base `89b2a8f5`.

**Verdict**: the worst thing on the branch is a doc comment. The
`WrittenFileMeta` field docs name one "undefined when" condition each, and the
code now produces more. No runtime defect was found.

### Confirmed

**1. Minor — `WrittenFileMeta` field docs are incomplete.**
[`file-uri.ts:85-91`](../../../src/core/file-uri.ts#L85-L91)

- **What**: `resourceUri` says "Undefined when the resulting file exceeds the
  text-size cap". `resourceLink` says "Undefined when no resource store is
  configured".
- **Trigger**: any write tool builds metadata with `dryRun: true` (`edit`,
  `patch`, `replace_text`), or `create`'s append branch cannot stat the file.
- **Impact**: both fields are `undefined` in those cases too, and
  `resourceLink` is also `undefined` over the cap. Someone reading the type
  expects a URI where the code gives none. No runtime effect.
- **Ruled out**: the full rule exists only on the helper, at
  [`file-uri.ts:107`](../../../src/core/file-uri.ts#L107):
  `if (options.dryRun || size === undefined || size > getMaxTextFileSize()) {`.
  A hover over a field does not show it.
- **Fix**: point both field docs at `writtenFileLinks`, e.g. "Undefined unless
  {@link writtenFileLinks} allows it: see there."

### Suspected

None.

### Dismissed

- Brief tell `__tests__/tools.test.ts:200` SECRET: a test sentinel string in
  unchanged code, not a credential.
- Brief tell `src/tools/replace-text.ts:60` MARKER: `TODO` is an example value
  in a schema's `examples`, not a work marker.
- Brief tell `src/tools/create.ts:194` LOOSE: the comment still matches the
  overwrite/append split below it.
- Un-exporting `buildFileResourceLink`: `package.json` exports only
  `./transport` and `./package.json`, so it was never public API.
- `replace_text` now builds metadata on a dry run only to drop the link. That
  is one file's size, MIME sniff and line count per call: a cost, not a defect.

### Coverage

- **Read in full**: `src/core/file-uri.ts`, `src/tools/patch.ts` handler
  (`:59-181`).
- **Read around every changed hunk**: `src/tools/edit.ts:395-470`,
  `src/tools/create.ts:180-285`, `src/tools/replace-text.ts:96-156` and
  `:576-596`, the test hunks in `__tests__/core-fs.test.ts` and
  `__tests__/tools.test.ts`.
- **Not read in full**: the rest of `edit.ts`, `create.ts`,
  `replace-text.ts`, `tools.test.ts` (2938 lines). The diff does not touch
  those regions, and no changed contract reaches them.
- **Blast radius**: `buildFileResourceUri`, `extractPath`, the URI template
  and codecs are unchanged in signature. Their callers (`resources.ts`,
  `read.ts`, `watcher-registry.ts`) were not re-read.
- **Taken on trust**: `detectMimeFromContent` and `countLines` behave as they
  did before; only their arguments changed.

### Resolution

Finding 1 fixed in `6a50bc9e`: both field docs now point at
`writtenFileLinks`.

# Plan hunt: overeng-residue-2

Hunted 2026-09-09 against commit `f7e47a1d`. All 22 steps checked
against the repo — every cited path resolved, every named symbol opened,
every grep gate dry-run. One confirmed finding; one candidate killed by its
refuter (dropped).

## Confirmed

### C1 — step 4's Verify gate can never pass

finding step 4 [`overeng-residue-2.plan.md`](overeng-residue-2.plan.md)

The step and the Done checklist both gate on
`git grep -n "skipBinary\|BufferEncoding" src/` → empty. It cannot reach
empty: step 4 touches [`fs.ts`](../../../src/core/fs.ts) only at lines
241-247 (`readEditableText`), and the two surviving `BufferEncoding` hits are
in the **write** path, which no step touches:

- [`fs.ts:63`](../../../src/core/fs.ts#L63) — `atomicWriteFile` options:
  `{ encoding?: BufferEncoding; signal?: AbortSignal | undefined } = {}`
- [`fs.ts:185`](../../../src/core/fs.ts#L185) — `writeFile` options, same shape

Both are live knobs, not dead ones: [`patch.ts:130`](../../../src/tools/patch.ts#L130)
calls `ctx.fs.writeFile(args.path, patched, { encoding: 'utf-8', signal: ctx.signal })`.
Forcing the grep empty would mean editing the write path and `patch.ts` —
both out of scope.

Also under this gate: [`read.ts:548`](../../../src/core/read.ts#L548)
(`readFullContent` parameter `encoding: BufferEncoding`) survives step 4 as
typed — the step changes call sites to pass `'utf-8'`, not the parameter's
type.

Impact: the executor finishes the edits, runs the gate, gets hits it was told
to read as failure, and either false-STOPS or "fixes" untouched write-path
code to force the grep clean — a scope violation the plan itself forbids.

Fix (owner: write-plan): narrow the gate to what the step actually deletes.
Suggested replacement for both the step-4 Verify line and the matching Done
item:

```text
git grep -n "skipBinary" src/ → empty
git grep -n "BufferEncoding" src/core/read.ts src/tools/read.ts → empty
```

(`fs.ts:63/185` and `read.ts:548` are expected survivors; the Done item must
not name them as failures.)

Refuter verdict: confirmed, independently — quoted `fs.ts:63` and
`fs.ts:185` live after faithful execution of every step-4 line, and found the
`patch.ts:130` caller that makes the write-path knobs live.

## Killed (dropped)

- Step 5 `stoppedByLimit` ambiguity — the plan's own text disambiguates: the
  deletion is anchored to the line-440 return and qualified "write-only",
  which uniquely matches the line-401 declaration; the tail-path declaration
  ([`read.ts:474`](../../../src/core/read.ts#L474)) is read at 523/531 and so
  cannot be the one named. Wrong deletion fails the step's own test gate.

## Verdict

**REQUEST_CHANGES** — one confirmed dead gate. Fix C1 in write-plan, then
re-hunt or proceed to run-plan.
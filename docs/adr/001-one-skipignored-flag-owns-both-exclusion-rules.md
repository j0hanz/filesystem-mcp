# ADR-001: One `skipIgnored` flag owns both exclusion rules a walk applies

**Status**: accepted, 2026-09-11
**Deciders**: j0hanz — settled on the [arch-audit-six plan](../plan/2026-09-10-arch-audit-six/arch-audit-six.plan.md) and merged as [#26](https://github.com/j0hanz/filesystem-mcp/pull/26)

## Context

Every file-walking tool exposes one input, `includeIgnored`, whose schema has a
single owner at
[`schema.ts:193`](../../src/core/schema.ts#L193). Its _meaning_ had none: the
core walk took two separate options, `excludePatterns` and `respectGitignore`,
and each of the four tools translated the one input into that pair itself.
`list` translated it a third way — it passed `excludePatterns` but never
`respectGitignore`, and post-filtered with its own gitignore matcher instead.

An architecture audit found the two options were not independent in practice:
across all five call sites `excludePatterns` only ever received
`DEFAULT_EXCLUDE_PATTERNS` or `[]`, always selected by the same boolean that
set `respectGitignore`. Two fields encoded one decision, and the tool that got
the pair wrong was the one whose divergence the missing owner had produced.

## Options

- **Keep both fields; add a shared `walkOptionsFrom(args)` helper that owns the
  translation** — its product is a new module wrapping a one-line expression,
  and it leaves `excludePatterns` alive as configuration nothing configures.
- **Delete `excludePatterns`, keep the name `respectGitignore`** — the
  surviving flag also drops `node_modules`, `dist` and the rest of
  `DEFAULT_EXCLUDE_PATTERNS`, so the name would describe half of what the flag
  does; a flag whose name understates it is how the next caller justifies
  reaching around it.
- **Delete `excludePatterns` and rename the survivor to `skipIgnored`**
  (chosen) — one field, one decision, and a name that covers both rules it now
  selects.

## Decision

We will express "what a walk should not surface" as exactly one boolean,
`skipIgnored`, on `GlobEntriesOptions`
([`glob.ts:202`](../../src/core/glob.ts#L202)) and on the search options that
forward to it. `glob.ts` is the sole owner of what it means: `skipIgnored`
selects `DEFAULT_EXCLUDE_PATTERNS`
([`glob.ts:308`](../../src/core/glob.ts#L308)) _and_ the `.gitignore` walk
([`glob.ts:417`](../../src/core/glob.ts#L417)). Tools translate their public
`includeIgnored` input into it and decide nothing further — the only form a
call site may take is `skipIgnored: !args.includeIgnored`.

Exclusion is applied by pruning the walk, never by filtering its output. A
caller that post-filters is re-deriving the rule this record gives to `glob.ts`.

## Consequences

- A change to what a walk hides is now one edit in `glob.ts` rather than four,
  and a new tool cannot get the pair half-right because there is no pair.
- **The cost accepted: custom exclude patterns are no longer expressible.** The
  old `excludePatterns` was a `readonly string[]` any caller could have filled
  with arbitrary globs. None ever did, so nothing regressed — but a future
  feature wanting per-call exclusions (a `--exclude` flag, a per-tool ignore
  list) cannot add a pattern at the call site. It must either extend
  `skipIgnored` into something richer or reintroduce a second field, and this
  record is what that change has to argue with.
- **A second cost, discovered after landing:** with the array of patterns gone
  from the public option, `createExcludeFilter`'s choice between returning a
  pattern array and returning a predicate
  ([`glob.ts:348-352`](../../src/core/glob.ts#L348-L352)) became invisible to
  callers — and the two are not equivalent. Node's `fs.glob` drops a rejected
  entry given an array, but given a function it prunes descent while still
  yielding the rejected dirent and any rejected entry below the top level. The
  presence of a `.gitignore` anywhere under the root silently switched modes.
  The guard at [`glob.ts:404`](../../src/core/glob.ts#L404) makes the two forms
  agree, and it is load-bearing for this decision: consolidating on one flag is
  only safe while both branches of that filter mean the same thing.
- Revisiting this means reintroducing a second field. Before doing so, check
  whether the new case genuinely varies twice — the first version of this option
  pair did not, which is what produced the finding.

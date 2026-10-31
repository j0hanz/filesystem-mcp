# Mutation triage

Survived mutants from StrykerJS audits (`npm run test:mutation`, config in
`stryker.config.mjs`) that are deliberately left alive, with the reason. A
rerun that reports a mutant listed here is expected; a survivor that is not
listed here is a finding.

Line numbers refer to the commit that added or last updated each entry.

## Audit 1: `src/core/path.ts`, `src/core/sensitive.ts` (2026-10-30)

Pass 1 ran each file against the tests that import it; pass 2 reran the
survivors against the full suite on Windows; pass 3 reran those on Linux.

### Security checks that are backstops

Each check below can be removed without any test failing, because another
check on the same path refuses the same input with the same error code. They
stay as defense in depth: the code they back up can change.

| Site           | Check removed                               | Covered by                                                                    |
| :------------- | :------------------------------------------ | :---------------------------------------------------------------------------- |
| `path.ts:636`  | denylist on the requested spelling          | `:637`, the same check on the normalized path                                 |
| `path.ts:710`  | denylist on a respelled name                | `:637` (patterns fold Unicode spellings alike) and `:735` on the real path    |
| `path.ts:985`  | link target outside the roots               | `:979` on the next hop and the caller's containment check (`:663`, `:1140`)   |
| `path.ts:1158` | denylist on a respelled write path          | `:1168` on the resolved target, and `:637`                                    |
| `path.ts:1163` | containment after a respelled write         | `:1084`, which refuses the escaping link before the respelling returns        |
| `path.ts:1202` | denylist on a respelled delete path         | `:1237`/`:1238` for a link, `:1255` for a file                                |
| `path.ts:1237` | denylist on a link as typed                 | `:1238`, the same link spelled through its real parent                        |
| `path.ts:1253` | real target of a non-link outside the roots | `:1222`: a non-link entry under an in-root real parent cannot resolve outside |

Five removed checks were real gaps and now have killing tests:

- `path.ts:979`, a dangling link stored outside the roots was followed back
  in: `TC-SEC-006c` in `__tests__/security.test.ts`.
- `path.ts:1084`, a respelled link that escapes the roots had its target
  directory scanned: the "never scans the directory" test in
  `__tests__/unicode-paths.test.ts`.
- `path.ts:1223`, delete returned a link outside the roots behind a linked
  parent: `TC-SEC-006b` in `__tests__/security.test.ts`.
- `path.ts:1238` and `:1255`, delete matched path patterns only as typed, so
  `alias/credentials` reached `.aws/credentials` through an aliased parent,
  as a link and as a file: `TC-SEC-006d` in `__tests__/security.test.ts`.

### Error and log text

Mutants that empty a message string (`'Cannot access path'` → `""`) are not
asserted. The contract is the `ErrorCode`, which tests do assert; wording
stays free to change. This covers every surviving `StringLiteral` inside an
`FsError` message, a `Logger` call, or a hint string in both files.

### Not yet triaged

279 mutants survived on both Windows and Linux (87 in `sensitive.ts`, 192
in `path.ts`); Linux alone killed 21 more, in POSIX-only branches. Apart
from the security checks and message text above, the logic-branch and
equivalent survivors among them are open for the next round.

# Plan hunt: Stdio cancellation envelopes

## 2026-09-29 - zero findings

**Plan:** [stdio-cancellation-envelope.plan.md](stdio-cancellation-envelope.plan.md)
against commit `105fb972`.

**Verdict:** no confirmed or suspected dead steps. Ready for run-plan.
Implementation has not started; this verdict does not claim the bug is
fixed or the proposed new tests pass.

This was an in-thread plan review. No candidate survived the direct checks
to require a blind refuter; no independent-agent review is claimed.

| Tell | Evidence and disposition |
| --- | --- |
| Invented API | The installed [guard declaration](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CfX6zgs1.d.mts#L1694) exists. Runtime assertions confirm it accepts a genuine cancellation notification and rejects a request carrying its own ID; the looser spec-type guard accepts that request. |
| Unresolvable paths | All 43 relative file links in the initial plan and their cited line ranges resolved. Tracked source, test, changelog, dependency, and design-reference paths were also checked with `git ls-files`. The SDK declarations are installed, ignored dependencies, not tracked source. |
| Convention violation | The plan uses the existing [raw stdio harness](../../../__tests__/helpers.ts#L460-L520), [single-write queued scenario](../../../__tests__/stdio.test.ts#L415-L466), and [bounded-read helper](../../../__tests__/stdio.test.ts#L32-L39). It preserves method-first filtering instead of reopening the [rejected every-message schema migration](../../../plans/README.md#L330-L332). |
| Missing gate | Step 1 explicitly requires behavioral RED with type checking green. Step 2 specifies tests, no-emit type checking, scoped lint/formatting, and worktree boundaries, each with an expected result. The four added cases explain the final test count. |
| Unavailable dependency | [The manifest](../../../package.json#L60-L63) pins server 2.2.0; the proposed guard runs from that installed public package. No new dependency, package upgrade, or private SDK import is needed. |

### Scenario assumptions checked

- Active-lease loss was reproduced using a real stdio subprocess and a
  one-watcher budget before the plan was written.
- Queued suppression was separately reproduced with string and numeric
  zero target IDs: the baseline acknowledged B instead of preserving A and
  returning the invalid request's error.
- The [SDK router](../../../node_modules/@modelcontextprotocol/server/dist/mcp-DYuW2ZSs.mjs#L390-L414)
  stamps the original request ID, without converting it to a string. The
  plan's numeric-zero subscription assertions match the installed behavior.
- The [SDK cancellation branch](../../../node_modules/@modelcontextprotocol/server/dist/stdio.mjs#L378-L381)
  uses the same envelope guard the plan adds locally.
- Queued replies are matched by ID rather than arrival order. The invalid
  request carries the existing modern envelope, avoiding a legacy opening
  during the SDK's probe phase.
- Both scenarios require an actual resource-update notification after A
  changes, in addition to capacity checks, then exercise genuine
  cancellation. Capacity alone is not the acceptance criterion.

### Commands exercised on the unchanged implementation

| Command | Result |
| --- | --- |
| `npm test -- __tests__\stdio.test.ts` | 17 passed; zero failures, cancellations, or skips. |
| `npm run type-check:test` | Exit 0. |
| `npm exec --no -- eslint src\transport\stdio.ts __tests__\stdio.test.ts --max-warnings=0` | Exit 0. |
| `npm exec --no -- prettier --check src\transport\stdio.ts __tests__\stdio.test.ts CHANGELOG.md` | Exit 0. |
| `git diff --stat 105fb972..HEAD -- src\transport\stdio.ts __tests__\stdio.test.ts CHANGELOG.md` | No drift at review time. |

The future RED/GREEN outcomes remain implementation gates. Only the plan
and this review artifact were authored; production code, tests, and the
changelog are unchanged.

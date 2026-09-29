# Plan hunt: SDK audit follow-ups

Reviewed [the five-step plan](sdk-audit-followups.plan.md) against commit
`bfe5ac37` on 2026-09-29. The plan has not entered implementation.
This review checks executability, not whether the proposed fixes already exist.

## Initial result

One confirmed citation defect; no confirmed dead implementation step.
Return the citation to the plan author for correction before handoff.

### PH1: Baseline manifest range extends beyond EOF

- **Location:** [preflight / installed SDK baseline](sdk-audit-followups.plan.md#baseline-and-installed-sdk).
- **Claim:** the manifest link ends at line 90, beyond the source file.
- **Trigger:** a cold executor follows the pinned-package/runtime evidence.
- **Impact:** the plan fails its valid-source-range requirement.
- **Blind refuter verdict:** confirmed.
- **Independent evidence:** the relative link resolves to tracked
  [`package.json`](../../../package.json), but its final line is
  [`package.json:85`](../../../package.json#L85), whose text is `}`; line 90
  does not exist.
- **Author action:** correct the range to end at line 85 and rerun the complete
  relative-link and line-range check.

## Step coverage

Each step was checked for API existence, paths, repository conventions,
verification gates, and dependency/runtime assumptions.

| Step | Evidence and result |
| --- | --- |
| 1. Resource cancellation | The [callback drops context](../../../src/resources.ts#L205-L222); the [raw reader accepts an optional signal](../../../src/core/fs.ts#L365-L386). The [native mock/restore precedent](../../../__tests__/core-fs.test.ts#L347-L398) exists, and the plan accounts for the [incomplete context fixture](../../../__tests__/resources.test.ts#L41). The resource test command passes on baseline. |
| 2. Form-mode gate | The [existing predicate](../../../src/core/input-required.ts#L226-L230), operation-specific hints, and [modern harness exemplar](../../../__tests__/helpers.ts#L193-L261) exist. The mode matrix preserves implicit form support and does not require a new SDK API. The input-required test command passes on baseline. |
| 3. Progress rounds | The [constructor emits zero](../../../src/tools/progress.ts#L41-L48) before the [executor's early returns](../../../src/tools/define.ts#L353-L378). Existing [sequence assertions](../../../__tests__/progress.test.ts#L34-L93) can remain unchanged with lazy start. The plan requires nonempty, same-token wire evidence and avoids modern client-local synthetic progress. Both progress and tool test files pass on baseline. |
| 4. CORS response headers | The [allowed-origin branch](../../../src/transport/http-policy.ts#L342-L351), [HTTP fixture](../../../__tests__/helpers.ts#L357-L413), and [rate limiter](../../../src/transport/http-policy.ts#L376-L407) exist. The one-request fixture avoids spending its budget on SDK discovery. Policy and HTTP test commands pass on baseline. |
| 5. Documentation and full gate | [Unreleased](../../../CHANGELOG.md#unreleased) and the [repository check script](../../../package.json#L29-L39) exist. `npm run check` passed: 474 tests passed, three existing platform skips, zero failures. No runtime source was changed during planning. |

## Review method and boundaries

- Read the entire plan and its cited source/test seams.
- Checked all 93 local links: 33 unique targets, including 29 tracked repository
  sources plus installed declaration files and the plan itself. The manifest
  range was the only initial path/anchor/range failure.
- Sent PH1 to one separate general-purpose blind refuter without the hunter's
  reasoning; its independent check confirmed the out-of-range endpoint.
- Ran all four targeted test commands, both typecheck commands, the full
  repository check, and the whitespace/scope commands listed by the plan.
- New regression cases are executor work and were not fabricated as passing
  baseline tests. The audit's read-only reproductions establish the current
  defects; the plan specifies the expected post-fix observations.
- No production code, existing tests, manifests, or earlier effort artifacts
  were edited by this review.

## 2026-09-29 author correction and recheck

PH1 is resolved: the author corrected the manifest range to
[`package.json:66-85`](../../../package.json#L66-L85). The author also tightened
the progress-test ranges to their last nonempty source line,
[`progress.test.ts:93`](../../../__tests__/progress.test.ts#L93), during the
final link check. Those citation corrections change no implementation step.

All eight Current state excerpts match the unchanged source text. Additional
read-only, real-tool probes confirmed the exact proposed legacy fixtures:
accepted skip on an existing file produces one form and wire progress
`[0, 0, 1]`; access grant followed by accepted overwrite-skip produces two
forms and `[0, 0, 0, 1]`. Each sequence uses one token, and both leave the
existing file unchanged. Thus the new tests exercise the actual production
paths, not only a synthetic tool.

**Final disposition:** no open confirmed or suspected findings; the plan is
ready for `run-plan`. This is a handoff only: no implementation run or
verify-specs report has been created.

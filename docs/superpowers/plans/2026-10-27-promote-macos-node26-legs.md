# Promote the macOS and Node 26 CI legs implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two subscription-test flakes at their root cause, prove both test files stable over 25 runs on macOS and Node 26, and then make `Check (macos-latest)` and `Check (ubuntu-latest, node 26)` required by CI, the release gate and the main ruleset.

**Architecture:** Both flakes are test-timing bugs. The product code is not changed. One helper registers its notification handler too late, and two tests assume that one `writeFile` gives exactly one watcher round. Task 2 changes the helper contract so a missed update cannot happen. Task 3 makes the count assertions check "one notification per debounce round", which is the property a duplicated sink breaks. A scratch-branch loop workflow measures the flakes before the fixes and proves them gone after. Task 5 then removes `experimental` and adds the two legs to every required-check list.

**Tech Stack:** Node test runner, `@modelcontextprotocol/client`, GitHub Actions, GitHub rulesets API (`gh api`).

**Spec:** GitHub issue #131, "Promote the macOS and Node 26 CI legs to blocking" (https://github.com/j0hanz/filesystem-mcp/issues/131).

## Root causes (verified 2026-10-27)

- **Node 26 timeout** (`subscriptions-listen.test.ts:102`, run 40096057453 attempt 1, job 120878449855). The failure was `no notifications/resources/updated ... within 5000ms (waited 5018ms; other URIs notified: none)`. The cause is in `waitForResourceUpdate` (`__tests__/helpers.ts:87`). It registers its handler only when called, and every caller calls it after `await writeFile(...)` has settled. The server sends the update 50 ms after the write event. If the `writeFile` continuation is late by more than about 50 ms (a loaded runner), the update reaches a client with no handler and is dropped. Local proof: put `await setTimeout(150)` between the write and the wait at `resources-subscribe.test.ts:44`. The test then fails every time with the same message.
- **macOS double count** (`resources-subscribe.test.ts:64`, run 40094798363 attempt 1, job 120874689479, `2 !== 1`). libuv watches directories on macOS through FSEvents with `latency = 0.05` and `kFSEventStreamCreateFlagNoDefer` (`libuv/src/unix/fsevents.c`). The first event of a burst arrives at once, and the rest of the batch arrives about 50 ms later. That equals the 50 ms debounce in `src/core/watcher-registry.ts:127`, so one `writeFile` sometimes gives two rounds. The rounds are at least 50 ms apart. A duplicated sink (the regression the test guards) gives two notifications inside one round, about 0 ms apart.
- The same exact-count shape is also at `subscriptions-listen.test.ts:276-277` ("both subscribers receive the update"). It has not flaked yet, but it is in a file the 25-run proof covers.

## Global Constraints

- Do not change the 50 ms debounce in `src/core/watcher-registry.ts:127`, and do not change any `src/` file outside a temporary mutation check that is reverted.
- In `.github/workflows/ci.yml`, keep the `node: ['']` key and its comment.
- Required check names, exactly: `Check (ubuntu-latest)`, `Check (windows-latest)`, `Check (macos-latest)`, `Check (ubuntu-latest, node 26)`, `Release build paths`.
- Required-check decision (maintainer, 2026-10-27): both new legs go into the release gate and ruleset 24928791.
- Proof bar: both test files pass 25 consecutive runs on `macos-latest` (`.nvmrc` Node) and on `ubuntu-latest` Node 26. The issue asks for at least 20.
- `npm run check` passes locally before the PR.
- Work branch: `ci/promote-macos-node26-legs` from `main`. Scratch branches: `scratch/flake-loop-131-base` and `scratch/flake-loop-131-fixed`. Never merge the scratch branches.
- Commits end with the two attribution trailer lines from the session reminder.

## Review Focus

1. **An update lands before the trigger settles** (a slow `writeFile` continuation on a loaded runner). The wait must still see it. Pinned by Task 2, test "counts an update that lands before its trigger settles".
2. **One write gives two watcher rounds** (macOS FSEvents batch tail at +50 ms). This must pass. Pinned by Task 3 unit case `[10, 70]`.
3. **A duplicated sink** gives two notifications in one round. This must still fail. Pinned by Task 3 unit case `[10, 11]` and the Task 3 mutation step.
4. **A trigger that throws.** The wait must reject at once with the trigger's error, not time out after 5 s. Pinned by Task 2, test "rejects with the trigger error at once".
5. **A silent watcher** (zero notifications) must not pass the per-round assertion. Pinned by Task 3 unit case `[]`.

---

### Task 1: Baseline loop on unfixed code

**Files:**

- Create (scratch branch only): `.github/workflows/flake-loop.yml`

**Interfaces:**

- Produces: commit "ci: scratch flake loop for #131" on `scratch/flake-loop-131-base`. Task 4 cherry-picks it.

- [ ] **Step 1: Create the scratch branch from `main`**

```bash
git switch -c scratch/flake-loop-131-base main
```

- [ ] **Step 2: Write `.github/workflows/flake-loop.yml`**

```yaml
# Scratch only (issue #131): never merge this file.
name: Flake loop
on:
  push:
    branches: ['scratch/flake-loop-131-*']
permissions:
  contents: read
jobs:
  loop:
    name: Loop (${{ matrix.os }}${{ matrix.node && format(', node {0}', matrix.node) || '' }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            node: ''
          - os: ubuntu-latest
            node: '26'
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: ${{ matrix.node }}
          node-version-file: ${{ !matrix.node && '.nvmrc' || '' }}
          cache: npm
      - run: npm ci
      - name: Run both files 25 times
        shell: bash
        run: |
          fail=0
          for i in $(seq 1 25); do
            if ! node --test --test-timeout=60000 __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts > "run-$i.log" 2>&1; then
              fail=$((fail + 1))
              echo "::error::run $i failed"
              grep -E '✖|AssertionError|no notifications' "run-$i.log" | head -20
            fi
          done
          echo "failed $fail of 25"
          test "$fail" -eq 0
```

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/flake-loop.yml
git commit -m "ci: scratch flake loop for #131"
git push -u origin scratch/flake-loop-131-base
```

Expected: one `Flake loop` run with two jobs. One iteration takes about 15 s, so a job takes about 7 min. Do not wait for it. Go on to Task 2.

- [ ] **Step 4: Record the baseline when it finishes**

Run: `gh run list --workflow "Flake loop" --branch scratch/flake-loop-131-base --limit 1`, then `gh run view <id> --log | grep -E "failed [0-9]+ of 25|::error::run"`.

Expected: one `failed N of 25` line per job. Any N is a valid result. Record both numbers and the run URL for the PR body. If N is 0 on both legs, the flakes are not reproduced, but the mechanisms stay proven (see Root causes). Proceed either way.

---

### Task 2: Register the update handler before the trigger

**Files:**

- Modify: `__tests__/helpers.ts:86-106` (`waitForResourceUpdate`)
- Modify (callers): `__tests__/resources-subscribe.test.ts:44-45`, `__tests__/stdio.test.ts:106-108`, `__tests__/http-shared-guard.test.ts:72-76`, `__tests__/subscriptions-listen.test.ts:117-118`, `:349-350`, `:491-492`, `:545-546`
- Test: `__tests__/resources-subscribe.test.ts` (describe "Resource subscriptions round-trip")

**Interfaces:**

- Produces: `waitForResourceUpdate(client: Client, uri: string, trigger: () => Promise<unknown>, timeoutMs = 5000): Promise<void>`. It registers the handler, then awaits `trigger()`, then polls. A rejected `trigger` rejects the wait with the same error.

- [ ] **Step 1: Create the work branch and commit this plan on it**

```bash
git switch -c ci/promote-macos-node26-legs main
git add docs/superpowers/plans/2026-10-27-promote-macos-node26-legs.md
git commit -m "docs(plan): add the promote macOS and Node 26 legs plan"
```

- [ ] **Step 2: Write the failing tests**

Add both tests inside describe "Resource subscriptions round-trip" (`resources-subscribe.test.ts`), after the first `it`:

```ts
it('waitForResourceUpdate counts an update that lands before its trigger settles', async () => {
  const filePath = await writeTestFile(tmpDir, 'early.txt', 'initial');
  const uri = buildFileResourceUri(filePath);
  await pair.client.subscribeResource({ uri });
  try {
    // The update is sent 50 ms after the write; this trigger settles at 150 ms.
    await waitForResourceUpdate(pair.client, uri, async () => {
      await writeFile(filePath, 'changed');
      await setTimeout(150);
    });
  } finally {
    await pair.client.unsubscribeResource({ uri });
  }
});

it('waitForResourceUpdate rejects with the trigger error at once', async () => {
  const started = performance.now();
  await assert.rejects(
    waitForResourceUpdate(pair.client, 'file:///never', () => Promise.reject(new Error('boom'))),
    /boom/,
  );
  assert.ok(performance.now() - started < 1000, 'must not wait out the timeout');
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm test -- --test-name-pattern="waitForResourceUpdate" __tests__/resources-subscribe.test.ts`

Expected: FAIL, 2 tests. The old helper never calls the trigger.

- [ ] **Step 4: Change `waitForResourceUpdate` to the signature in Interfaces**

Register the handler first, then `await trigger()`, then do the existing poll and assert. Update the doc comment: "Run `trigger` and resolve when … The handler is registered before `trigger` runs, so an update that lands before it settles still counts."

- [ ] **Step 5: Convert the 7 callers**

Each pair `await writeFile(P, T);` followed by `await waitForResourceUpdate(C, U);` becomes `await waitForResourceUpdate(C, U, () => writeFile(P, T));`. In `http-shared-guard.test.ts`, keep the "No update means…" comment above the merged call.

- [ ] **Step 6: Verify**

Run: `npm run type-check:test`
Expected: exit 0. A missed caller fails here, because `trigger` is required.

Run: `npm test -- __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts __tests__/stdio.test.ts __tests__/http-shared-guard.test.ts`
Expected: `ℹ fail 0`.

Run: `git grep -n "waitForResourceUpdate(" __tests__`
Expected: every call passes 3 arguments.

- [ ] **Step 7: Commit**

```bash
git add __tests__/helpers.ts __tests__/resources-subscribe.test.ts __tests__/stdio.test.ts __tests__/http-shared-guard.test.ts __tests__/subscriptions-listen.test.ts
git commit -m "test: register the resource-update handler before the write"
```

---

### Task 3: Assert one notification per debounce round

**Files:**

- Modify: `__tests__/helpers.ts` (new export next to `waitForResourceUpdate`)
- Modify: `__tests__/resources-subscribe.test.ts:64-90`, `__tests__/subscriptions-listen.test.ts:256-277`
- Test: `__tests__/resources-subscribe.test.ts` (new describe "assertOneNotificationPerRound")

**Interfaces:**

- Produces: `assertOneNotificationPerRound(arrivalsMs: readonly number[], what: string): void`. `arrivalsMs` holds the `performance.now()` stamps of each notification, in order. The function asserts `arrivalsMs.length >= 1`, with a message that contains `no notification`. It asserts that every consecutive gap is `>= 25` ms, with a message that contains `one debounce round` and lists the gaps. 25 is half the 50 ms debounce. Doc comment, one or two lines: rounds are always at least the debounce apart, and macOS FSEvents can split one write into two rounds; a duplicated sink fires twice inside one round.

- [ ] **Step 1: Write the failing unit tests**

```ts
describe('assertOneNotificationPerRound', () => {
  it('accepts one notification, and two rounds a debounce apart', () => {
    assertOneNotificationPerRound([10], 'one');
    assertOneNotificationPerRound([10, 70], 'macOS split round');
  });
  it('rejects two notifications in one round, and none at all', () => {
    assert.throws(() => assertOneNotificationPerRound([10, 11], 'dup'), /one debounce round/);
    assert.throws(() => assertOneNotificationPerRound([], 'silent'), /no notification/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="assertOneNotificationPerRound" __tests__/resources-subscribe.test.ts`
Expected: FAIL, because the export does not exist.

- [ ] **Step 3: Implement `assertOneNotificationPerRound` in `__tests__/helpers.ts`**

- [ ] **Step 4: Rewrite the two count assertions**

- `resources-subscribe.test.ts:64-90`: the handler pushes `performance.now()` into `arrivals`. After the 200 ms settle, call `assertOneNotificationPerRound(arrivals, 'a doubled subscribe')`. For the unsubscribe half, snapshot `arrivals.length` before `unsubscribeResource`, and after the 300 ms wait assert that the length is unchanged ("one unsubscribe must end a doubled subscription"). Replace the "Settle past the 50ms debounce" comment with one line on why rounds, not raw counts, are counted.
- `subscriptions-listen.test.ts:256-277`: give `arrivalsA` and `arrivalsB` the same treatment. The URI filter stays. `waitFor` waits for both to be non-empty. After the 150 ms settle, call `assertOneNotificationPerRound` once per client, with the old messages as `what`.

- [ ] **Step 5: Run the tests**

Run: `npm test -- __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Mutation check (not committed)**

In `src/core/watcher-registry.ts:122`, change `cb(uri);` to `cb(uri); cb(uri);`. Run the Step 5 command.
Expected: FAIL in both rewritten tests, with `one debounce round`.

Revert, and confirm that `src/` is clean:

```bash
git checkout -- src/core/watcher-registry.ts
git status --short src
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add __tests__/helpers.ts __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts
git commit -m "test: count notifications per debounce round, not per write"
```

---

### Task 4: Prove both files stable on the fixed code

**Interfaces:**

- Consumes: the Task 1 loop commit, and the Task 2 and Task 3 commits on `ci/promote-macos-node26-legs`.

- [ ] **Step 1: Branch from the work branch and add the loop**

```bash
git switch -c scratch/flake-loop-131-fixed ci/promote-macos-node26-legs
git cherry-pick scratch/flake-loop-131-base
git push -u origin scratch/flake-loop-131-fixed
```

- [ ] **Step 2: Wait for the run and read the result**

Run: `gh run watch <id> --exit-status`, then `gh run view <id> --log | grep -E "failed [0-9]+ of 25|::error::run"`.
Expected: both jobs `success`, each with `failed 0 of 25`. Record the run URL.

- [ ] **Step 3: On any failure, STOP**

Read the failing iteration's lines. If a new failure shape appears (not one of the two root causes), report it to the user and do not promote that leg. Task 5 then promotes only the leg that passed and keeps the `continue-on-error` line. Do not re-run until it passes.

---

### Task 5: Make both legs required

**Files:**

- Modify: `.github/workflows/ci.yml:21-42`, `.github/workflows/release.yml:63-70`, `CONTRIBUTING.md:78`

- [ ] **Step 1: Edit `ci.yml`**

Make these four changes:

1. Delete `experimental: true` from both `include` entries.
2. Delete the whole `- os: macos-latest` include entry. Without the key it only repeats an existing combination.
3. Delete lines 26-28: the `continue-on-error` line and its comment. No leg uses them now.
4. Change the comment at lines 21-22 to say that all four leg names are required by the main ruleset and by the release gate, so their spelling must not change.

The resulting matrix:

```yaml
os: [ubuntu-latest, windows-latest, macos-latest]
# '' means the .nvmrc pin. Keep this key: without it the node 26
# include below merges into the default Ubuntu leg instead of adding one.
node: ['']
include:
  - os: ubuntu-latest
    node: '26'
```

- [ ] **Step 2: Edit `release.yml`**

Set `REQUIRED: 'Check (ubuntu-latest)|Check (windows-latest)|Check (macos-latest)|Check (ubuntu-latest, node 26)|Release build paths'`. In the comment above the step, change "a red or unfinished Windows leg" to "a red or unfinished leg on any OS or Node version".

- [ ] **Step 3: Edit `CONTRIBUTING.md:78`**

Change the first sentence to: "CI runs the same checks as separate steps on Ubuntu, Windows and macOS, plus Ubuntu on Node 26, and all four are required." Keep the rest of the paragraph.

- [ ] **Step 4: Run the full check**

Run: `npm run check`
Expected: exit 0 and `ℹ fail 0`.

- [ ] **Step 5: Commit, push and open the PR**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml CONTRIBUTING.md
git commit -m "ci: require the macOS and Node 26 legs"
git push -u origin ci/promote-macos-node26-legs
```

Open the PR with "Closes #131". The PR body records:

- the two root causes, with the log lines above;
- the baseline counts (Task 1) and the fixed-run URL with 25/25 per leg (Task 4);
- the decision: both legs are required in `release.yml` and ruleset 24928791, chosen by the maintainer on 2026-10-27, with the note that the ruleset is changed after the merge.

Expected: `gh pr checks` lists `Check (ubuntu-latest)`, `Check (windows-latest)`, `Check (macos-latest)`, `Check (ubuntu-latest, node 26)`, `Release build paths` and `Plugin security`, and all are green. Read the bot reviews. The user decides the merge.

- [ ] **Step 6: After the merge, add the two checks to ruleset 24928791 (confirm with the user first)**

PUT replaces the whole rule list. Build the body from the live ruleset, and show the user the new `required_status_checks` list before you send it:

```bash
gh api repos/j0hanz/filesystem-mcp/rulesets/24928791 > ruleset.json
jq '{name, target, enforcement, conditions, bypass_actors: (.bypass_actors | map(if .actor_id == null then del(.actor_id) else . end)), rules: (.rules | map(if .parameters == null then del(.parameters) elif .type == "required_status_checks" then .parameters.required_status_checks += [{"context":"Check (macos-latest)","integration_id":15368},{"context":"Check (ubuntu-latest, node 26)","integration_id":15368}] else . end))}' ruleset.json > ruleset-put.json
gh api -X PUT repos/j0hanz/filesystem-mcp/rulesets/24928791 --input ruleset-put.json
gh api repos/j0hanz/filesystem-mcp/rulesets/24928791 --jq '[.rules[] | .type], [.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context]'
```

Write `ruleset.json` and `ruleset-put.json` in the scratchpad, not in the repo.

Expected: the rule types are still `deletion`, `non_fast_forward`, `pull_request` and `required_status_checks`, and the contexts are the five names from Global Constraints. If the PUT is rejected, STOP and report the error. Do not retry with a hand-edited body.

- [ ] **Step 7: Delete the scratch branches (confirm with the user first)**

```bash
git push origin --delete scratch/flake-loop-131-base scratch/flake-loop-131-fixed
git branch -D scratch/flake-loop-131-base scratch/flake-loop-131-fixed
```

The run logs stay reachable from the URLs in the PR body.

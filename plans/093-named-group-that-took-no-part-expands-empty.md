# Plan 093: `$<name>` for a declared group that took no part in the match expands to nothing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/core/matcher.ts __tests__/matcher.test.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

`replace_text` with `isRegex: true` expands `$1`, `$<name>` and friends in the
replacement. A numbered group that did not take part in a match (the other
side of an alternation) expands to an empty string, as in JavaScript. A
_named_ group in the same position is written into the file as the literal
text `$<name>`. With regex `(?<x>a)|b`, text `b` and replacement `[$<x>]`, the
file gets `[$<x>]` where `[]` is correct. The cause is that the regex engine
(re2-wasm) reports only the named groups that matched, so the expander cannot
tell "declared but empty" from "never declared".

## Current state

Files:

- `src/core/matcher.ts`: the one matching engine for `search_text` and
  `replace_text` (`createMatchEngine`).
- `__tests__/matcher.test.ts`: its tests.

The token pattern and expander (`src/core/matcher.ts:384`, `:405-430`):

```ts
const DOLLAR_TOKEN = /\$(\$|&|`|'|<([^>]*)>|\d{1,2})/g;
```

```ts
function expandDollarTokens(
  template: string,
  match: string,
  groups: (string | undefined)[],
  offset: number,
  input: string,
  named: Record<string, string> | undefined,
): string {
  return template.replace(DOLLAR_TOKEN, (token: string, kind: string, name?: string) => {
    if (kind === '$') return '$';
    if (kind === '&') return match;
    if (kind === '`') return input.slice(0, offset);
    if (kind === "'") return input.slice(offset + match.length);
    if (name !== undefined) {
      if (named && Object.hasOwn(named, name)) return named[name] ?? '';
      return token;
    }
```

Its only caller, inside `createMatchEngine`'s `replace` method
(`src/core/matcher.ts:689-693`):

```ts
updated +=
  text.slice(cursor, m.start) +
  (expand
    ? expandDollarTokens(effectiveReplacement, m.text, m.groups, m.start, text, m.named)
    : effectiveReplacement);
```

`createMatchEngine` starts at `src/core/matcher.ts:432`:

```ts
export function createMatchEngine(
  needle: string,
  flags: { isRegex: boolean; caseSensitive: boolean; wholeWord?: boolean },
): MatchEngine {
  const plan = planMatch(needle, flags);
```

`plan.source` is the regex source string handed to RE2. For a regex needle it
is the needle itself (wrapped in boundary groups when `wholeWord` is set).

Why `named` lacks the group: re2-wasm's
`node_modules/@adguard/re2-wasm/build/src/re2.js:260-267` builds `groups`
only from groups whose value is not `undefined`, and omits `groups` entirely
when none matched. Its own `namedGroups` table is `private` in the typings, so
the server cannot ask the compiled regex for the declared names.

Existing tests to extend (`__tests__/matcher.test.ts:109-114`):

```ts
assert.strictEqual((await replaceWith('(?<x>a)', regex, 'a', '$<x>')).content, 'a');
assert.strictEqual(
  (await replaceWith('(?<x>a)', regex, 'a', '$<y>')).content,
  '$<y>',
  'an absent named group renders literally',
);
```

The second assertion is decided behavior: a name the pattern never declares
stays literal. Keep it.

Comment convention in this repo: a known limit gets a one-line comment of the
form `// shortcut: <the limit>, <when to upgrade>`.

## Commands you will need

| Purpose          | Command                                                      | Expected on success |
| ---------------- | ------------------------------------------------------------ | ------------------- |
| Install          | `npm ci`                                                     | exit 0              |
| Type-check tests | `npm run type-check:test`                                    | exit 0              |
| Lint             | `npm run lint`                                               | exit 0, no warnings |
| Matcher tests    | `node --test --test-timeout=60000 __tests__/matcher.test.ts` | `# fail 0`          |
| Full check       | `npm run check`                                              | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/matcher.ts`
- `__tests__/matcher.test.ts`
- `CHANGELOG.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `node_modules/` (never patch re2-wasm).
- `src/tools/replace-text.ts`: the tool description must not change (it is in
  the contract snapshot).
- The mixed-line-ending branch around `src/core/matcher.ts:590-616`. Plan 097
  owns it.

## Git workflow

- Branch: `advisor/093-named-group-that-took-no-part-expands-empty`
- One commit: `fix(matcher): expand a named group that took no part to nothing`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Failing tests

In `__tests__/matcher.test.ts`, directly after the
`'an absent named group renders literally'` assertion, add:

```ts
assert.strictEqual(
  (await replaceWith('(?<x>a)|b', regex, 'b', '[$<x>]')).content,
  '[]',
  'a declared named group that took no part expands to nothing',
);
assert.strictEqual(
  (await replaceWith('(?P<x>a)|b', regex, 'b', '[$<x>]')).content,
  '[]',
  'the (?P<name>...) spelling too',
);
assert.strictEqual(
  (await replaceWith('(a)|b', regex, 'b', '[$1]')).content,
  '[]',
  'as a numbered group does',
);
```

**Verify**: `node --test --test-timeout=60000 __tests__/matcher.test.ts` →
the first two new assertions FAIL (actual `'[$<x>]'`); the third passes.

### Step 2: Pass the declared names to the expander

In `src/core/matcher.ts`:

1. Add a seventh parameter to `expandDollarTokens`:
   `declared: ReadonlySet<string>,` and change the named branch to:

```ts
if (name !== undefined) {
  if (named && Object.hasOwn(named, name)) return named[name] ?? '';
  return declared.has(name) ? '' : token;
}
```

2. In `createMatchEngine`, directly after `const plan = planMatch(needle, flags);`
   add:

```ts
// The names the pattern declares. re2-wasm reports only the named groups
// that took part in a match, so `$<name>` needs this to expand an idle one
// to nothing, as `$1` does.
// shortcut: read from the source text, so an escaped `\(?<x>` counts as declared; ask the compiled regex if re2-wasm ever exposes its names.
const declared = new Set(
  flags.isRegex
    ? Array.from(plan.source.matchAll(/\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/g), (m) => m[1] ?? '')
    : [],
);
```

3. Pass it at the one call site:
   `expandDollarTokens(effectiveReplacement, m.text, m.groups, m.start, text, m.named, declared)`.

**Verify**: `node --test --test-timeout=60000 __tests__/matcher.test.ts` →
`# fail 0`. Then `npm run build` → exit 0.

### Step 3: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, append:

```markdown
- **replace_text**: `$<name>` for a named group that took no part in a match (the other side of an alternation) now expands to nothing, as `$1` does; before, the text `$<name>` was written into the file.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- Three new assertions in `__tests__/matcher.test.ts` (Step 1), in the same
  `it(...)` block as the existing `$<x>` assertions.
- The existing `'an absent named group renders literally'` assertion must
  still pass.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -c "declared" src/core/matcher.ts` returns at least 4
- [ ] `grep -n "took no part" __tests__/matcher.test.ts` returns 1 match
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `expandDollarTokens` has more than one caller
  (`grep -n "expandDollarTokens(" src/core/matcher.ts` should show the
  definition and one call).
- `plan.source` is not a string at that point, or `planMatch` no longer
  returns `source`.
- A new assertion fails after Step 2 because RE2 rejects `(?<x>a)|b` as a
  pattern.
- The contract snapshot test (`__tests__/contract.test.ts`) fails: nothing in
  this plan should change the advertised surface.

## Maintenance notes

- Plan 097 changes the `replace` method in the same file and depends on this
  plan landing first.
- If re2-wasm is upgraded, check whether it exposes group names and delete the
  source scan.
- Reviewer: the `declared` set is built only when `flags.isRegex`; a literal
  needle is escaped and declares nothing.

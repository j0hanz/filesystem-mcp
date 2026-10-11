# Contributing to Filesystem MCP Server

How to set up, branch, and test.

## Setup

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/filesystem-mcp.git`
3. Add upstream remote: `git remote add upstream https://github.com/j0hanz/filesystem-mcp.git`
4. Install dependencies: `npm install`

## Branch workflow

1. Create a feature branch from `main`: `git checkout -b feat/your-feature`
2. Make commits with clear messages.
3. Push to your fork: `git push origin feat/your-feature`
4. Open a pull request against the upstream repository.

## Issues and project board

Use the issue chooser for **Bug report**, **Feature request**, or **Maintenance
task**. Keep reports short and sanitize paths, logs, and file contents. Never
include secrets or credentials. Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/j0hanz/filesystem-mcp/security/advisories),
not public issues or project cards.

The [Filesystem MCP Project](https://github.com/users/j0hanz/projects/12)
uses issues as work items and linked PRs as implementation. Do not add both an
issue and its PR as separate cards.
A maintainer must verify the hosted configuration below; repository templates
do not configure the Project. Hosted setup is tracked in
[issue #57](https://github.com/j0hanz/filesystem-mcp/issues/57).

### Maintainer setup

1. Use the existing **Filesystem MCP** Project linked above and ensure it is
   linked from the repository's **Projects** tab. Do not create a duplicate.
2. Configure the **Status** field with these five values:

   | Status      | Meaning                               |
   | ----------- | ------------------------------------- |
   | Backlog     | New reports and ideas awaiting triage |
   | Ready       | Accepted, clear scope, ready to start |
   | In progress | Someone is actively working on it     |
   | In review   | Implementation is ready for review    |
   | Done        | Accepted work completed               |

3. Add a single-select **Priority** field: **High**, **Normal**, **Low**.
   Assign priority during triage; use Normal unless urgency or impact warrants
   otherwise.
4. Create a **Board** view grouped by Status. Show only title, assignee, and
   priority on cards. Create a **Triage** table filtered to `status:Backlog`.
   Scope both views to this repository's issues and exclude `duplicate`,
   `invalid`, and `wontfix` labels.
5. Where available, enable the built-in auto-add workflow for
   `repo:j0hanz/filesystem-mcp is:issue is:open -label:duplicate -label:invalid -label:wontfix`.
   Set newly added items to Backlog with the item-added workflow. If auto-add is
   unavailable for the account, add eligible issues manually during triage.
6. Enable the issue-closed workflow to move completed issues to Done. If the
   workflow also handles issues closed as not planned, remove those items from
   the project rather than treating them as completed work. Keep review
   transitions manual.
7. Add only genuinely unfinished issues after checking linked PRs and existing
   plans. Do not bulk-import completed plans or unrelated promotional issues.

Use **bug**, **enhancement**, **maintenance**, and **documentation** to describe
work, plus **blocked** when needed. Keep existing housekeeping labels for
duplicates and rejected reports; do not create labels that duplicate Status.

### Daily workflow

- Triage Backlog: confirm relevance, check for duplicates, assign priority, and
  clarify scope and acceptance criteria before moving an issue to Ready.
- Assign an owner when work starts. Aim for one or two In progress items per
  person.
- For blocked work, add **blocked**, link the dependency, and explain what is
  needed to proceed. Keep its current status; remove the label when unblocked.
- Link the implementation PR to the issue and move the issue to In review when
  ready. A PR that completes the issue should use a closing keyword.
- Move accepted, completed work to Done. Close duplicates or rejected requests
  with the appropriate reason and label, and remove them from the project.
- Keep detailed design and investigation in existing planning documents, linked
  from issues. Use the board as the active task tracker, not a second copy of
  historical plan status tables.

## Running tests locally

Tests run on Node's built-in test runner:

```bash
# Run tests only
npm test
```

Tests must pass before your PR is merged.

## PR checklist

- [ ] Tests pass locally (`npm run check`)
- [ ] No new console warnings or errors
- [ ] Commit messages are clear and descriptive
- [ ] Code follows the project's style guide (run `npm run fix`)
- [ ] Related issues are referenced in the PR description

## Code style

Check formatting and apply auto-fixes:

```bash
npm run fix

npm run check:static
```

## Commit messages

Commit messages are free-form. Describe what the commit does and why, and call out breaking changes explicitly.

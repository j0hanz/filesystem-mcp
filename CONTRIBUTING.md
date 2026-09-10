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

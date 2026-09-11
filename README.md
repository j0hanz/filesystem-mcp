# Filesystem MCP Server

[![License](https://img.shields.io/github/license/j0hanz/filesystem-mcp?style=for-the-badge)](https://github.com/j0hanz/filesystem-mcp/blob/main/LICENSE) [![npm version](https://img.shields.io/npm/v/%40j0hanz%2Ffilesystem-mcp?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@j0hanz/filesystem-mcp) [![Build](https://img.shields.io/github/actions/workflow/status/j0hanz/filesystem-mcp/release.yml?style=for-the-badge&logo=githubactions&logoColor=white&label=build)](https://github.com/j0hanz/filesystem-mcp/actions) [![GitHub stars](https://img.shields.io/github/stars/j0hanz/filesystem-mcp?style=for-the-badge&logo=github)](https://github.com/j0hanz/filesystem-mcp/stargazers)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D&quality=insiders) [![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-Install-C16FDE?logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22filesystem-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D%7D) [![Install in Cursor](https://img.shields.io/badge/Cursor-Install-000000?style=flat-square&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=filesystem&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1tY3BAbGF0ZXN0Il19)

## Overview

Filesystem-MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants read and write files within explicitly allowed directories. Sensitive file patterns (`.env`, `*.pem`, `*id_rsa*`) are blocked by default. It exposes filesystem tools, resources, and prompts over stdio or Streamable HTTP transport.

| Aspect       | Details                                        |
| :----------- | :--------------------------------------------- |
| **Status**   | Active (see npm badge for the current version) |
| **Language** | TypeScript (strict)                            |
| **Runtime**  | Node.js >= 24                                  |
| **Package**  | npm                                            |
| **License**  | MIT                                            |

## Features

| Feature                | Description                                                                                                |
| :--------------------- | :--------------------------------------------------------------------------------------------------------- |
| **Path guarding**      | Every path is validated against allowed roots; `.env`, `*.pem`, `*id_rsa*` and similar patterns are denied |
| **Filesystem tools**   | Navigate, inspect, read, and write across all major file operations                                        |
| **Batch operations**   | Most tools accept `path`, `paths[]`, or `files[]` for parallel execution                                   |
| **Dual transport**     | stdio by default; `--port` enables Streamable HTTP                                                         |
| **File subscriptions** | Resource subscriptions push change notifications when watched files update                                 |
| **Regex safety**       | RE2 in all search tools: linear-time matching, so no pattern can ReDoS the server                          |

## Built with

[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)

| Layer     | Technology                                                             |
| :-------- | :--------------------------------------------------------------------- |
| Protocol  | MCP SDK v2 (`@modelcontextprotocol/server`)                            |
| Runtime   | Node.js >= 24 · TypeScript 6 · ESM                                     |
| Transport | stdio (default) · Streamable HTTP (`--port`)                           |
| Regex     | RE2 (`re2-wasm`) — linear time, no lookahead/lookbehind/backreferences |
| Container | Docker alpine · multi-stage build · non-root user                      |

## Table of Contents

- [Quick start](#quick-start)
- [Usage](#usage)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Quick start

> [!NOTE]
> Requires Node.js ≥ 24.

### Prerequisites

| Requirement | Version / Notes              |
| :---------- | :--------------------------- |
| Node.js     | ≥ 24                         |
| npm         | Bundled with Node.js         |
| Docker      | Optional — for container use |

### Install via npx

```bash
npx -y @j0hanz/filesystem-mcp /path/to/allowed/dir
```

Or install globally:

```bash
npm install -g @j0hanz/filesystem-mcp
filesystem-mcp /path/to/allowed/dir
```

### Install via Docker

```bash
docker run -i --rm \
  -v /path/to/project:/workspace:ro \
  ghcr.io/j0hanz/filesystem-mcp:latest \
  --read-only /workspace
```

### Configure in VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/project"]
    }
  }
}
```

Or install via CLI:

```sh
code --add-mcp '{"name":"filesystem","command":"npx","args":["-y","@j0hanz/filesystem-mcp@latest","/path/to/project"]}'
```

### Configure in Visual Studio

Add to `.vs\mcp.json` in your solution directory, or `%USERPROFILE%\.mcp.json` for a global configuration:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/project"]
    }
  }
}
```

### Configure in Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/project"]
    }
  }
}
```

### Install in Cursor

Add to `.cursor/mcp.json` in your project root (project-scoped), or `~/.cursor/mcp.json` for a global configuration:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/project"]
    }
  }
}
```

### Docker configuration

VS Code (`.vscode/mcp.json`) and Visual Studio (`.vs\mcp.json`):

```json
{
  "servers": {
    "filesystem": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/path/to/project:/workspace",
        "ghcr.io/j0hanz/filesystem-mcp:latest",
        "/workspace"
      ]
    }
  }
}
```

Claude Desktop (`claude_desktop_config.json`) and Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/path/to/project:/workspace",
        "ghcr.io/j0hanz/filesystem-mcp:latest",
        "/workspace"
      ]
    }
  }
}
```

> [!NOTE]
> For least privilege, use both controls: `:ro` makes the container mount
> read-only at the operating-system boundary, while the server's `--read-only`
> flag removes mutating tools (`create`, `edit`, `move`, `delete`, `patch`,
> `replace_text`) from `tools/list`.

## Usage

### Tools

All tools are scoped to the configured roots. Call `list_roots` first to discover what is allowed.

#### Navigate

| Tool         | Description                                                                            |
| :----------- | :------------------------------------------------------------------------------------- |
| `list_roots` | List allowed workspace roots. Call this first — all other tools scope to these.        |
| `list`       | List directory contents. Returns entries (dirs-first, alphabetical) and an ASCII tree. |
| `find_files` | Find files by glob pattern (e.g. `**/*.ts`). Returns matching files with metadata.     |

#### Inspect

| Tool          | Description                                                                               |
| :------------ | :---------------------------------------------------------------------------------------- |
| `stat`        | Get file/directory metadata: size, modified time, permissions, MIME type, token estimate. |
| `search_text` | Search file contents for text (grep-like). Returns matching lines with context.           |
| `diff`        | Compare two files and return a unified diff with added/removed line counts.               |

#### Read

| Tool   | Description                                                                          |
| :----- | :----------------------------------------------------------------------------------- |
| `read` | Read a text file. Supports head/tail and line ranges. Accepts `paths[]` for batches. |

#### Write

| Tool           | Description                                                                                       |
| :------------- | :------------------------------------------------------------------------------------------------ |
| `create`       | Create one or more files, overwriting existing content and creating parent directories as needed. |
| `edit`         | Apply sequential literal string replacements to one or more files (max 5 per call).               |
| `move`         | Move, rename, or copy (`copy: true`) one or more files/directories to explicit destinations.      |
| `delete`       | Permanently delete one or more files or directories. This action is irreversible.                 |
| `replace_text` | Bulk search-and-replace across files matching a glob pattern.                                     |
| `patch`        | Apply a single-file unified diff and write the result.                                            |

### Resources

| URI                             | Description                                                                           |
| :------------------------------ | :------------------------------------------------------------------------------------ |
| `internal://instructions`       | Server navigation guide — tools overview, constraints, and error recovery.            |
| `filesystem-mcp://file/{+path}` | Read a workspace file. Subscribe to receive push notifications on change.             |
| `filesystem-mcp://result/{id}`  | Ephemeral cached tool output. Expires after ~60 seconds, eviction, or server restart. |

### Prompts

| Prompt     | Description                                                           |
| :--------- | :-------------------------------------------------------------------- |
| `get-help` | Return usage instructions, optionally filtered to a specific section. |

## Project structure

```text
filesystem-mcp/
├── __tests__/        Test suites
├── src/
│   ├── core/         Path guarding, filesystem abstraction, concurrency, observability
│   ├── tools/        Tool definitions and registration
│   ├── index.ts      Process entrypoint and transport selection
│   ├── server.ts     Server factory and registrar composition
│   ├── transport/    stdio and Streamable HTTP transport setup
│   ├── prompts.ts    Prompt definitions and registration
│   └── resources.ts  Resource definitions and registration
└── Dockerfile        Multi-stage alpine build, non-root user
```

Runtime composition flows from `src/index.ts` to `src/transport.ts`, then to
`src/server.ts`, the registrars, and finally `src/core/`. Each registrar owns
the narrow dependency contract it consumes.

| Path                  | Purpose                                                        |
| :-------------------- | :------------------------------------------------------------- |
| `src/core/path.ts`    | `PathGuard` — validates every path against allowed roots       |
| `src/core/fs.ts`      | `GuardedFileSystem` — guarded filesystem facade                |
| `src/tools/define.ts` | Tool registration and execution framework                      |
| `src/tools/batch.ts`  | Batch helpers (runOverPaths, isTotalFailure)                   |
| `src/server.ts`       | Builds shared dependencies and invokes the three registrars    |
| `src/transport.ts`    | Owns stdio and Streamable HTTP setup around the server factory |

## Configuration

The server starts with allowed directories from explicit startup configuration:

1. **Positional directories** passed to `filesystem-mcp`.
2. **Environment variable** `FS_ALLOWED_DIRS` (separated by `:` on POSIX or `;` on Windows).
3. **Current working directory** when `--allow-cwd` is enabled.

Legacy MCP connections may additionally seed roots through the deprecated
`roots/list` flow. Modern 2026-07-28 connections do not automatically send
workspace roots. They can add access after startup by calling a tool with a
concrete path and approving the elicitation-backed grant. `list_roots` reports
the roots already configured or accepted; it cannot discover an unknown
workspace by itself.

### Recommended global recipes

#### VS Code / Cursor / Claude Code (primary recipe)

Configure the project directory explicitly:

Add to your global or project-scoped configuration:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/project"]
    }
  }
}
```

#### Claude Desktop (fallback recipe via environment variable)

Claude Desktop and similar clients don't support the MCP Roots protocol. Use the `FS_ALLOWED_DIRS` environment variable to configure allowed folders.

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest"],
      "env": {
        "FS_ALLOWED_DIRS": "/path/to/project1:/path/to/project2"
      }
    }
  }
}
```

_(On Windows, separate directories with a semicolon `;` instead of a colon `:`)._

### Advanced / per-project positional arguments

You can also restrict access to specific directories by passing positional arguments directly:

```bash
# Start with explicit positional paths
filesystem-mcp /path/to/project1 /path/to/project2
```

---

### Configuration reference

#### CLI flags

| Flag                      | Default | Purpose                                                                            |
| :------------------------ | :------ | :--------------------------------------------------------------------------------- |
| `[dirs...]`               | —       | One or more allowed root directories (positional)                                  |
| `--allow-cwd`             | `false` | Also allow the current working directory as a root                                 |
| `--walk-cwd`              | `false` | Walk up from CWD to find a project root; implies `--allow-cwd`                     |
| `--allow-missing-roots`   | `false` | Start even if configured allowed directories do not exist                          |
| `--port <n>`              | —       | Enable Streamable HTTP transport on the given port (env: `FS_PORT`)                |
| `--http-host <host>`      | —       | HTTP server bind address (env: `FS_HTTP_HOST`)                                     |
| `--api-key <key>`         | —       | Require this API key on HTTP requests (env: `FS_API_KEY`)                          |
| `--read-only`             | `false` | Disable write tools: `create`, `edit`, `delete`, `move`, `patch`, `replace_text`   |
| `--safe`                  | `false` | Alias for `--read-only`                                                            |
| `--deny <pattern>`        | —       | Block paths matching this pattern; repeatable                                      |
| `--allow-sensitive`       | `false` | Allow access to sensitive system paths (env: `FS_ALLOW_SENSITIVE`)                 |
| `--root-boundary <path>`  | —       | Require all allowed roots to fall under this path (env: `FS_ROOT_BOUNDARY`)        |
| `--max-file-size <bytes>` | —       | Maximum file size for reads in bytes (env: `FS_MAX_FILE_SIZE`)                     |
| `--log-level <level>`     | `info`  | RFC 5424 log level, `debug` through `emergency` (env: `FS_LOG_LEVEL`)              |
| `--print-config`          | `false` | Print the active configuration and exit (use `--json` for machine-readable output) |
| `--json`                  | `false` | Output `--print-config` as JSON                                                    |

#### Environment variables

All boolean variables accept `true` or `1` to enable and `false`, `0`, or
unset to disable; any other value logs a warning and reads as disabled.
Flags take precedence when both are set.

| Variable                      | Purpose                                                                                                                                                                                |
| :---------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FS_ALLOWED_DIRS`             | Colon-separated (POSIX) or semicolon-separated (Windows) list of directories to allow.                                                                                                 |
| `FS_ROOT_BOUNDARY`            | Path prefix all allowed roots must fall under (mirrors `--root-boundary`).                                                                                                             |
| `FS_ALLOW_CWD_WALK`           | Walk up from CWD to find a project root (mirrors `--walk-cwd`).                                                                                                                        |
| `FS_ALLOW_MISSING_ROOTS`      | Start even if configured directories do not exist (mirrors `--allow-missing-roots`).                                                                                                   |
| `FS_ALLOW_SENSITIVE`          | Allow access to sensitive system paths (mirrors `--allow-sensitive`).                                                                                                                  |
| `FS_DENYLIST`                 | Comma-separated list of paths or patterns to block (mirrors `--deny`).                                                                                                                 |
| `FS_MAX_FILE_SIZE`            | Maximum file size for reads in bytes (mirrors `--max-file-size`).                                                                                                                      |
| `FS_LOG_LEVEL`                | RFC 5424 log level: `debug`, `info`, `notice`, `warn`/`warning`, `error`, `critical`, `alert`, or `emergency` (mirrors `--log-level`).                                                 |
| `FS_PORT`                     | Start the Streamable HTTP transport on this port; unset = stdio (mirrors `--port`).                                                                                                    |
| `FS_HTTP_HOST`                | HTTP server bind address (mirrors `--http-host`).                                                                                                                                      |
| `FS_API_KEY`                  | API key required on HTTP requests (mirrors `--api-key`).                                                                                                                               |
| `FS_TRUST_PROXY`              | Express `trust proxy` setting: hop count or expression. Unset = do not trust `X-Forwarded-*`.                                                                                          |
| `FS_ALLOWED_HOSTS`            | Comma-separated Host header values to accept (HTTP transport).                                                                                                                         |
| `FS_ALLOWED_ORIGINS`          | Comma-separated origin hostnames for CORS.                                                                                                                                             |
| `FS_ALLOW_UNRESTRICTED_HOSTS` | Bind a wildcard host with no Host validation (accepts the risk).                                                                                                                       |
| `FS_PUBLIC_URL`               | Resource identifier URL for RFC 9728 discovery.                                                                                                                                        |
| `FS_RATE_LIMIT_RPM`           | Per-client-IP requests/minute (default 120 with API-key authentication, 6,000 for keyless loopback; range 1–100000).                                                                   |
| `FS_MAX_REQUEST_BYTES`        | Max HTTP request body bytes (default 4194304, 1024–268435456).                                                                                                                         |
| `FS_KEEPALIVE_TIMEOUT_MS`     | HTTP keep-alive timeout in ms; set above any fronting proxy's idle timeout (default 5000, 1000–600000).                                                                                |
| `FS_MAX_WATCHERS`             | Max concurrent file watchers (default 256, 1–4096).                                                                                                                                    |
| `FS_MAX_INLINE_MATCHES`       | Deprecated and ignored; `maxResults` sets the `search_text` page size. Logs a warning when set; removed in the next major.                                                             |
| `FS_MAX_READ_MANY_BYTES`      | Max total bytes across a batched `read` (default 524288, 10240–104857600).                                                                                                             |
| `FS_SEARCH_TIMEOUT_MS`        | Search timeout in ms (default 5000, 100–60000).                                                                                                                                        |
| `NO_COLOR`                    | Any value disables ANSI color output.                                                                                                                                                  |
| `FS_REQUEST_STATE_KEY`        | HMAC key sealing `input_required` requestState across retry rounds. Optional (random per boot if unset); set it, at >=32 bytes UTF-8, to keep in-flight rounds alive across a restart. |

### Examples

```bash
# Allow current working directory
filesystem-mcp --allow-cwd

# HTTP transport on port 3000
filesystem-mcp --port 3000
```

## Scripts

| Mode             | Command                | Description                                          |
| :--------------- | :--------------------- | :--------------------------------------------------- |
| Full check       | `npm run check`        | Run build, type check, lint, format, knip, and tests |
| Auto-fix + check | `npm run fix`          | Auto-fix formatting/linting and run the full check   |
| Static only      | `npm run check:static` | Run static analysis without tests                    |
| Tests only       | `npm test`             | Run tests; accepts native `node --test` options      |

## Security

> [!IMPORTANT]
> Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/j0hanz/filesystem-mcp/security/advisories). Do not open public issues for security reports.

| Topic           | Detail                                                                          |
| :-------------- | :------------------------------------------------------------------------------ |
| Path traversal  | Every path is resolved and validated against allowed roots before any operation |
| Sensitive files | `.env`, `*.pem`, `*id_rsa*`, and similar patterns are denied by default         |
| Regex safety    | RE2 cannot backtrack, so a hostile pattern cannot hang the server (ReDoS)       |
| Container       | Runs as non-root `mcp` user; bind mounts control what is exposed                |

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/your-feature`.
3. Commit your changes with a clear message.
4. Run `npm run check` to confirm tests, types, lint, formatting, and knip all pass.
5. Open a pull request.

[![Contributors](https://contrib.rocks/image?repo=j0hanz/filesystem-mcp)](https://github.com/j0hanz/filesystem-mcp/graphs/contributors)

## License

Released under the MIT License. See [LICENSE](LICENSE) for details.

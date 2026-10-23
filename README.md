<img src="assets/logo.png" alt="Filesystem MCP logo" width="96" height="96">

# Filesystem MCP

**Let your AI assistant work with your files, safely.**

Read, search, edit, and patch files in the folders you choose.<br>
Secret files stay hidden, and risky changes wait for your OK.

[![npm version](https://img.shields.io/npm/v/%40j0hanz%2Ffilesystem-mcp?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@j0hanz/filesystem-mcp) [![CI](https://img.shields.io/github/actions/workflow/status/j0hanz/filesystem-mcp/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/j0hanz/filesystem-mcp/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/github/license/j0hanz/filesystem-mcp?style=flat-square)](LICENSE) [![GitHub stars](https://img.shields.io/github/stars/j0hanz/filesystem-mcp?style=flat-square&logo=github)](https://github.com/j0hanz/filesystem-mcp/stargazers) [![HOL Trust](https://img.shields.io/endpoint?url=https%3A%2F%2Fhol.org%2Fapi%2Fregistry%2Fbadges%2Fplugin%3Fslug%3Dj0hanz%252Ffilesystem-mcp%26metric%3Dtrust%26style%3Dflat-square)](https://hol.org/registry/plugins/j0hanz%2Ffilesystem-mcp)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D&quality=insiders) [![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-Install-C16FDE?style=flat-square&logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22filesystem-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D%7D) [![Install in Cursor](https://img.shields.io/badge/Cursor-Install-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=filesystem&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1tY3BAbGF0ZXN0Il19) [![Install in Claude Desktop](https://img.shields.io/badge/Claude_Desktop-Install-D97757?style=flat-square&logo=claude&logoColor=white)](https://github.com/j0hanz/filesystem-mcp/releases/latest/download/filesystem-mcp.mcpb)

[![filesystem-mcp MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/j0hanz/filesystem-mcp/badges/card.svg)](https://glama.ai/mcp/servers/j0hanz/filesystem-mcp)

## What is this?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) is how AI apps
such as Claude, GitHub Copilot in VS Code, and Cursor connect to tools.
Filesystem MCP is an MCP server: a small program that runs on your computer
and gives the AI 14 tools for working with files. You choose which folders it
can use, and everything outside them is off limits.

Once it is connected, you can ask things like:

- _"Find every TODO in this repo and group them by file."_
- _"Rename `getUser` to `fetchUser` in all `.ts` files. Show me the diff first."_
- _"What changed between `config.dev.json` and `config.prod.json`?"_
- _"Read the last 50 lines of `server.log` and explain the error."_
- _"Move the old screenshots into `archive/2025/`."_

## Why Filesystem MCP?

- It is safe by default. The AI can use only the folders you allow, and
  `.env` files, private keys, and cloud credentials are blocked. The server
  asks you before the AI deletes a non-empty folder, opens a folder you did
  not allow, or writes over a file with `create` or `move`. Only `create` and
  copies can skip that question, by passing `overwrite: true`. Edits made with
  `edit`, `patch`, and `replace_text` apply without asking, but the AI can
  show you the diff first with `dryRun`. If the AI should never change
  anything, `--read-only` removes every tool that writes.
- Search and editing are made for code. The AI can search inside files like
  `grep`, with a regex engine (RE2) that cannot hang, and by default the
  server skips `.gitignore`d files and folders like `node_modules`. Edits are
  exact-match replacements that return an error when the text does not match,
  and you can preview them as a diff first.
- It saves the AI's context. The AI can read many files in one call or
  only the lines it needs, and it can check a file's size and token estimate
  before reading it.
- It works with any MCP client, over stdio or HTTP, on macOS, Linux, and
  Windows. You can install it with npx, Docker, or a one-click Claude Desktop
  extension, or [build your own client](#build-your-own-client) on it.
- It is private. It runs on your machine, has no telemetry, and makes no
  network calls.

### Compared with the reference server

How this server differs from the official
[`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem),
checked against its README on 2026-10-11:

| Capability                | Filesystem MCP                                     | Reference server                        |
| :------------------------ | :------------------------------------------------- | :-------------------------------------- |
| Search inside files       | `search_text`: literal text or RE2 regex           | None; `search_files` matches names only |
| Secret files              | `.env`, keys, and credentials blocked by default   | Not blocked                             |
| Overwriting a file        | `create` asks you first (unless `overwrite: true`) | `write_file` overwrites without asking  |
| Delete files              | `delete`; asks before deleting a non-empty folder  | None                                    |
| `.gitignore`              | Respected by listing and search tools              | Not supported                           |
| Read-only mode            | `--read-only` removes every tool that writes       | Docker `ro` mounts only                 |
| Apply a unified diff      | `patch`                                            | None                                    |
| Compare two files         | `diff`                                             | None                                    |
| Replace across many files | `replace_text` over a folder or glob               | None                                    |
| Watch files               | Subscribe to a file and get change notifications   | None                                    |
| Transport                 | stdio, or Streamable HTTP with `--port`            | stdio                                   |

## Quick start

> [!NOTE]
> You need Node.js 24 or later. Check with `node --version`.

1. Add the server to your AI app. Pick yours below.
2. Replace `/path/to/project` with the folder the AI may use. You can list
   several folders.
3. Restart the app and ask: _"Which folders can you access?"_

> [!TIP]
> VS Code currently shares the folders you have open with the server, so the
> one-click VS Code install works without a path. In other apps, or over HTTP,
> put the folder in `args`. If the AI says it has no folders, that is the fix.

<details>
<summary><b>VS Code</b></summary>

Click **Install in VS Code** above, or add this to `.vscode/mcp.json`:

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

Or from a terminal:

```sh
code --add-mcp '{"name":"filesystem","command":"npx","args":["-y","@j0hanz/filesystem-mcp@latest","/path/to/project"]}'
```

</details>

<details>
<summary><b>Cursor</b></summary>

Click **Install in Cursor** above, then add your folder to `args`. Or add this
to `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for all
projects:

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

</details>

<details>
<summary><b>Claude Desktop</b></summary>

For a one-click install, download
[`filesystem-mcp.mcpb`](https://github.com/j0hanz/filesystem-mcp/releases/latest/download/filesystem-mcp.mcpb),
open it with Claude Desktop, and pick the folders to allow. Claude Desktop's
built-in Node.js runs it. The extension's settings also let you turn on
read-only mode and block more files.

To set it up by hand, add this to `claude_desktop_config.json`
(Settings → Developer → Edit Config):

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

</details>

<details>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add filesystem -- npx -y @j0hanz/filesystem-mcp@latest /path/to/project
```

Or install the plugin, which points the server at your current project:

```text
/plugin marketplace add j0hanz/j0hanz-marketplace
/plugin install filesystem-mcp@j0hanz-marketplace
```

</details>

<details>
<summary><b>Visual Studio</b></summary>

Add this to `.vs\mcp.json` in your solution folder, or `%USERPROFILE%\.mcp.json`
for all solutions:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "C:/path/to/project"]
    }
  }
}
```

</details>

<details>
<summary><b>GitHub Copilot CLI and Antigravity CLI (plugin)</b></summary>

The [filesystem-mcp plugin](https://github.com/j0hanz/j0hanz-marketplace/tree/main/plugins/filesystem-mcp)
sets the server up for your current project:

| Client          | Install                                                                                                                         |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| Copilot CLI     | `copilot plugin marketplace add j0hanz/j0hanz-marketplace`, then `copilot plugin install filesystem-mcp@j0hanz-marketplace`     |
| Antigravity CLI | `git clone https://github.com/j0hanz/j0hanz-marketplace`, then `agy plugin install ./j0hanz-marketplace/plugins/filesystem-mcp` |

</details>

<details>
<summary><b>Docker</b></summary>

The container can only see the folders you mount. This setup blocks writes
twice, with the `:ro` mount and with the `--read-only` flag.

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
        "/path/to/project:/workspace:ro",
        "ghcr.io/j0hanz/filesystem-mcp:latest",
        "--read-only",
        "/workspace"
      ]
    }
  }
}
```

Drop `:ro` and `--read-only` to let the AI make changes. VS Code and Visual
Studio use `"servers"` instead of `"mcpServers"`. See
[Running in Docker](docs/configuration.md#running-in-docker) for more.

</details>

<details>
<summary><b>Other MCP clients</b></summary>

Windsurf, Cline, and most other clients use the same `mcpServers` JSON as
Claude Desktop above. In any client, the server is:

- **command:** `npx`
- **args:** `-y`, `@j0hanz/filesystem-mcp@latest`, then one or more folders

You can also install it globally and run `filesystem-mcp /path/to/project`:

```sh
npm install -g @j0hanz/filesystem-mcp
```

</details>

## Tools

| Tool             | What it does                                                                                                  |
| :--------------- | :------------------------------------------------------------------------------------------------------------ |
| `list_roots`     | Shows the folders the server may use.                                                                         |
| `list`           | Lists a folder as a tree, like `ls` or `tree`.                                                                |
| `find_files`     | Finds files by name or glob, such as `**/*.test.ts`.                                                          |
| `search_text`    | Searches inside files for text or a regex, like `grep`, with optional context lines.                          |
| `stat`           | Gets size, dates, type, permissions, and a token estimate without reading the file.                           |
| `read`           | Reads text files whole or by lines, head, or tail. Images and audio come back as media; others with `binary`. |
| `diff`           | Compares two files and returns a unified diff.                                                                |
| `create` ✎       | Writes new files, appends, or makes empty folders. Asks before replacing a file, unless `overwrite: true`.    |
| `edit` ✎         | Replaces exact text in files. All edits to a file apply, or none do. `dryRun` shows the diff first.           |
| `patch` ✎        | Applies a unified diff to a file. All hunks apply, or none do.                                                |
| `replace_text` ✎ | Finds and replaces text or a regex across many files. `dryRun` shows what would change.                       |
| `move` ✎         | Moves, renames, or copies files and folders. Asks before overwriting, unless a copy passes `overwrite: true`. |
| `delete` ✎       | Deletes files and folders. Asks before deleting a non-empty folder.                                           |
| `undo` ✎         | Reverts earlier changes by undo id or the last N calls, while the server runs. Skips files changed since.     |

✎ changes files. `--read-only` removes these tools.

Search and listing tools skip hidden files, `.gitignore`d files, and folders
like `node_modules`, `dist`, and `.git` unless the AI asks for them.

## Configuration

Most people only need the folder argument. These options cover the common
cases:

| Option                | What it does                                                                 |
| :-------------------- | :--------------------------------------------------------------------------- |
| `--read-only`         | Removes every tool that changes files.                                       |
| `--deny '<pattern>'`  | Blocks more files, for example `--deny 'private/**'` or `--deny '*.sqlite'`. |
| `--allow '<pattern>'` | Unblocks one built-in secret pattern, for example `--allow '.env.example'`.  |
| `--allow-cwd`         | Also allows the folder the server was started from.                          |
| `--max-file-size <n>` | Largest file `read` will load, in bytes. Default 10 MiB.                     |
| `--port <n>`          | Serves over HTTP at `http://127.0.0.1:<n>/mcp` instead of stdio.             |
| `--print-config`      | Prints the settings the server would use, then exits.                        |

Flags go in `args` after the package name, for example
`["-y", "@j0hanz/filesystem-mcp@latest", "--read-only", "/path/to/project"]`.

The [full configuration reference](docs/configuration.md) covers every flag
and environment variable, the complete secret-file list, limits, HTTP setup
with API keys, Docker, and troubleshooting.

## Security

| Protection         | How it works                                                                                                                                                                                                                                                                                                                                                          |
| :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder sandbox     | The server resolves every path, including symlinks, and the resolved path must stay inside an allowed folder.                                                                                                                                                                                                                                                         |
| Secret files       | `.env`, `*.pem`, `*.key`, SSH keys, `.npmrc`, cloud credentials, and [more](docs/configuration.md#secret-files) are blocked and hidden from listings.                                                                                                                                                                                                                 |
| You stay in charge | The server asks you before the AI deletes a non-empty folder, gets access to a new folder, or writes over a file with `create` or `move`. Only `create` and copies skip that question, when the AI passes `overwrite: true`. In-place edits (`edit`, `patch`, `replace_text`) do not ask, but `dryRun` previews them. A client that cannot ask gets an error instead. |
| Off-limits folders | Neither the AI nor the client can ever add your home folder itself, system folders, or `~/.ssh`, `~/.aws`, and similar folders.                                                                                                                                                                                                                                       |
| Safe writes        | New content goes to a temporary file that is then renamed into place, so a crash never leaves a half-written file. Writes keep the file's permissions.                                                                                                                                                                                                                |
| No regex hangs     | RE2 runs in linear time, so no search pattern can freeze the server.                                                                                                                                                                                                                                                                                                  |
| HTTP               | The server listens only on localhost by default. Any other address requires an API key.                                                                                                                                                                                                                                                                               |
| Container          | The Docker image runs as a non-root user.                                                                                                                                                                                                                                                                                                                             |

If you find a vulnerability, please report it privately.
[SECURITY.md](SECURITY.md) explains how.

## Build your own client

You can also call Filesystem MCP from your own code: an agent, an editor
plugin, a web app, a CI job, or a script. The same rules apply as for an AI
app, so your code cannot reach outside the allowed folders or read secret
files.

```ts
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const dir = '/path/to/project';
const client = new Client(
  { name: 'my-app', version: '1.0.0' },
  { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } },
);
client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' }));
await client.connect(
  new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@j0hanz/filesystem-mcp', dir],
    cwd: dir,
  }),
);

const result = await client.callTool({ name: 'search_text', arguments: { searchPattern: 'TODO' } });
const { matches } = (result.structuredContent ?? result._meta) as { matches: unknown[] };
console.log(matches);
await client.close(); // stops the server process; without it the script never exits
```

The basics:

- **Where the data is.** The text block is written for a model. The same data
  as JSON is in `_meta` for tools that write their own text (`list`,
  `search_text`, `edit`, ...) and in `structuredContent` for `stat`,
  `create`, and `list_roots`. `read` is the exception: the file's text is
  only in the text block, and `_meta` holds metadata about it.
- **Paths.** A relative path resolves against the server's working directory
  when that is inside a root, and against the root otherwise. With several
  roots, it must exist under exactly one of them. Absolute paths are never
  ambiguous. Search results are printed relative to the root, so a result
  can be passed straight back. A name that differs from the one on disk only
  in Unicode form (NFC or NFD) or in its space characters (U+00A0, U+202F)
  finds that entry.
- **Confirmations.** Overwrites, recursive deletes, and paths outside the
  roots are questions for the user. Declare the `elicitation` capability and
  answer them in a handler, or, on the 2026-07-28 protocol, take them as data
  (`input_required`) and answer later.
- **Protocol versions.** The server speaks the 2025 protocol and 2026-07-28,
  over stdio and Streamable HTTP. Over HTTP, 2025-era clients get no
  confirmations or change notifications.
- **Resources.** Read and subscribe to any file as
  `filesystem-mcp://file/{+path}`; `internal://instructions` and the
  `get-help` prompt hold the server's guide for models.

The [client guide](docs/client-guide.md) has the details, tested with the
TypeScript and Python SDKs, and [`examples/`](examples/) has six runnable
clients:

| Example                                    | What it is                                                          |
| :----------------------------------------- | :------------------------------------------------------------------ |
| [fsq](examples/clients/fsq/)               | Any tool from your shell, over stdio or HTTP; `--json` for scripts  |
| [browser](examples/clients/browser/)       | A local web UI where the server's questions appear in the page      |
| [tail](examples/clients/tail/)             | `tail -f` through file subscriptions, locally or on a remote server |
| [gatekeeper](examples/clients/gatekeeper/) | A coding agent that shows each change's diff and waits for your y/N |
| [hooks](examples/clients/hooks/)           | Runs a task through a model whenever the workspace changes          |
| [python](examples/clients/python/)         | A TODO report for a workspace, with the Python SDK                  |

## Privacy policy

Filesystem MCP runs entirely on your machine. This policy covers the npm
package, the Docker image, and the `.mcpb` desktop extension.

- **Data collection:** none. The server has no telemetry, analytics, or crash
  reporting, and makes no outbound network requests.
- **Use and storage:** the server reads and writes files only inside the
  folders you allow, and only when your MCP client calls a tool. Tool results go to that
  client and nowhere else. Short-lived result caches and the undo history
  (saved file contents) live in memory and disappear when the server exits.
- **Third-party sharing:** none by this server. Your MCP client may send tool
  results to its model provider under that client's own privacy policy.
- **Retention:** the server keeps nothing after the process exits. Diagnostic logs go to
  stderr on your machine; your MCP client may save them in its own log files.
- **Contact:** open an issue at
  <https://github.com/j0hanz/filesystem-mcp/issues>, or report security
  problems privately through
  [GitHub Security Advisories](https://github.com/j0hanz/filesystem-mcp/security/advisories).

## Contributing

Bug reports, ideas, and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md). It covers setup, running the server from
source, and the checks a pull request needs.

If Filesystem MCP is useful to you, a star on GitHub helps other people find it.

[![Contributors](https://contrib.rocks/image?repo=j0hanz/filesystem-mcp)](https://github.com/j0hanz/filesystem-mcp/graphs/contributors)

## License

[MIT](LICENSE)

# Configuration reference

This page lists everything you can configure in filesystem-mcp. If you only
want to get started, the [README quick start](../README.md#quick-start) is
enough: pass the folder you want the AI to work in, and you are done.

Run `filesystem-mcp --help` for the same list in your terminal, and
`filesystem-mcp --print-config <folders...>` to see the exact settings the
server would start with (roots, tools, limits, deny rules) without starting it.

- [Choosing folders](#choosing-folders)
- [Folders that are never added automatically](#folders-that-are-never-added-automatically)
- [Secret files](#secret-files)
- [Read-only mode](#read-only-mode)
- [Command-line flags](#command-line-flags)
- [Environment variables](#environment-variables)
- [Limits](#limits)
- [Running over HTTP](#running-over-http)
- [Running in Docker](#running-in-docker)
- [Troubleshooting](#troubleshooting)

## Choosing folders

The server only touches files inside its **allowed folders** (also called
roots). A folder can become allowed in five ways, and they all add up.

| Source                       | Example                                        | Notes                                                                                                                                                                                                                                                                                         |
| :--------------------------- | :--------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder arguments             | `filesystem-mcp ~/code/app ~/code/lib`         | Recommended. Each folder must exist, or the server exits with an error (see `--allow-missing-roots`).                                                                                                                                                                                         |
| `FS_ALLOWED_DIRS`            | `FS_ALLOWED_DIRS=/code/app:/code/lib`          | Separate folders with `:` on macOS and Linux, `;` on Windows. A missing folder logs a warning and is skipped.                                                                                                                                                                                 |
| `--allow-cwd` / `--walk-cwd` | `filesystem-mcp --allow-cwd`                   | Adds the folder the server was started from. `--walk-cwd` first walks up to the project root.                                                                                                                                                                                                 |
| Your client's workspace      | VS Code with a folder open                     | Over stdio only, from apps that support MCP roots and connect with the older, pre-2026 protocol (VS Code does). Their open folders are added when they connect and when the list changes. Other apps, 2026-07-28 clients, and HTTP connections add nothing this way: pass the folder instead. |
| Approving a request          | The AI asks for `~/notes/todo.md`, you say yes | When the AI asks for a path outside the allowed folders, a client that supports confirmations asks you first.                                                                                                                                                                                 |

Call the `list_roots` tool (or ask the AI "which folders can you access?") to
see the current list.

A folder argument that is exactly `${NAME}` is read from the environment
variable `NAME`, and dropped if that variable is unset or empty. Plugin hosts
use this to pass `${PWD}`.

`--walk-cwd` looks for `.git`, `package.json`, or `pyproject.toml` and stops
at your home folder or at `--root-boundary`. `--allow-cwd` is unreliable in
desktop apps: Claude Desktop, for example, does not start servers inside your
project, so pass the folder instead.

`--root-boundary <path>` (or `FS_ROOT_BOUNDARY`) is a fence for every other
source. The server skips a folder outside it at startup with a warning, and
refuses requests to add a folder outside it.

Approved folders last until the server stops. Removing a folder from your
editor does not remove access in the running session. Over HTTP, a folder
approved for one client is open to every client of that server.

## Folders that are never added automatically

`--allow-cwd`, a client's workspace folders, and approval requests can never
add these folders, even if you say yes:

- the filesystem root (`/`, `C:\`) and your home folder itself, or any folder
  that contains it (subfolders such as `~/code/app` are fine);
- system folders: `/usr`, `/etc`, `/bin`, `/sbin`, `/System`, and on Windows
  `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`;
- credential folders in your home: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.docker`, `~/.config/gcloud`.

Symlinks are resolved first, so a link that points at one of these folders is
refused too. The server uses folders you pass as arguments or in `FS_ALLOWED_DIRS` as
given, because you named them on purpose.

## Secret files

By default, the server blocks these names inside every allowed folder, for
reading, writing, searching, and listing:

| Kind                  | Patterns                                                                                                                                 |
| :-------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| Environment files     | `.env`, `.env.*`                                                                                                                         |
| Package and git creds | `.npmrc`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`                                                                   |
| Cloud and tools       | `.aws/credentials`, `.aws/config`, `.docker/config.json`, `.kube/config`, `application_default_credentials.json`, `.mcpregistry_*_token` |
| Keys and certificates | `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `*.cer`                                                                                     |
| SSH private keys      | `*id_rsa*`, `*id_dsa*`, `*id_ecdsa*`, `*id_ed25519*`                                                                                     |

Matching ignores case, so `.ENV` is blocked too. It also ignores Unicode
spelling: a pattern blocks a name stored decomposed (NFD) or with a
non-breaking space (U+00A0, U+202F) as it blocks the plain spelling.

Three switches change the list:

| You want to                      | Use                                                    |
| :------------------------------- | :----------------------------------------------------- |
| Block more paths                 | `--deny <pattern>` (repeatable) and/or `FS_DENYLIST`   |
| Unblock one built-in pattern     | `--allow <pattern>` (repeatable) and/or `FS_ALLOWLIST` |
| Turn off the whole built-in list | `--allow-sensitive` or `FS_ALLOW_SENSITIVE=true`       |

`--allow` only lifts built-in patterns. It never lifts your own `--deny`
rules, so `--deny` always wins.

In a pattern, `*` matches within one folder name, `**` matches any number of
folders, `?` matches one character, `[abc]` matches a set, and `{a,b}`
matches alternatives. Hidden names match like any other name:
`secrets/**` blocks `secrets/.env`. A pattern without `/` matches a file name
anywhere (`*.sqlite`); a pattern with `/` matches a path (`private/**`).

```bash
# Block a folder and a file type, and allow example env files
filesystem-mcp ~/code/app --deny 'private/**' --deny '*.sqlite' --allow '.env.example'
```

## Read-only mode

`--read-only` removes the seven tools that change files (`create`, `edit`,
`move`, `delete`, `patch`, `replace_text`, `undo`). The AI can still list, search,
read, compare, and inspect. Use it for code review, research, or any folder
you do not want changed.

Set `FS_READ_ONLY=true` to do the same from the environment, for example in a client that can only pass environment variables.

For the strongest setup in Docker, combine it with a read-only mount
(`-v /path:/workspace:ro`), so the operating system also refuses writes.

## Command-line flags

When a flag and its environment variable are both set, the flag wins, with two
exceptions:

- Lists add up. Folder arguments join `FS_ALLOWED_DIRS`, `--deny` joins
  `FS_DENYLIST`, and `--allow` joins `FS_ALLOWLIST`. So an `FS_ALLOWLIST`
  inherited from your shell still applies when you pass `--allow`.
- On/off flags only turn things on. `--read-only`, `--allow-sensitive`,
  `--walk-cwd`, and `--allow-missing-roots` cannot switch off their environment
  variable, so unset the variable instead.

| Flag                      | Default     | What it does                                                                                                                     |
| :------------------------ | :---------- | :------------------------------------------------------------------------------------------------------------------------------- |
| `[folders...]`            |             | Allowed folders. See [Choosing folders](#choosing-folders).                                                                      |
| `--read-only`             | off         | Remove the tools that change files. Env: `FS_READ_ONLY`.                                                                         |
| `--deny <pattern>`        |             | Block paths matching the pattern. Repeatable. Env: `FS_DENYLIST`.                                                                |
| `--allow <pattern>`       |             | Unblock a built-in secret-file pattern. Repeatable. Env: `FS_ALLOWLIST`.                                                         |
| `--allow-sensitive`       | off         | Turn off the built-in secret-file list. Env: `FS_ALLOW_SENSITIVE`.                                                               |
| `--allow-cwd`             | off         | Add the current working folder.                                                                                                  |
| `--walk-cwd`              | off         | Walk up from the current folder to the project root, then add it. Implies `--allow-cwd`.                                         |
| `--allow-missing-roots`   | off         | Start even if an allowed folder does not exist yet. Env: `FS_ALLOW_MISSING_ROOTS`.                                               |
| `--root-boundary <path>`  |             | Only allow folders inside this path. Env: `FS_ROOT_BOUNDARY`.                                                                    |
| `--max-file-size <bytes>` | 10485760    | Largest file `read` will load, and the total content of one `create` call. 1 MiB to 100 MiB. Env: `FS_MAX_FILE_SIZE`.            |
| `--tool-timeout <ms>`     | 5000        | Time limit for one listing, read, search, or `replace_text` call. 1000 to 600000. Env: `FS_TOOL_TIMEOUT_MS`.                     |
| `--port <n>`              |             | Serve over HTTP on this port instead of stdio. Env: `FS_PORT`.                                                                   |
| `--http-host <host>`      | `127.0.0.1` | Address to listen on over HTTP. Env: `FS_HTTP_HOST`.                                                                             |
| `--api-key <key>`         |             | Require `Authorization: Bearer <key>` over HTTP. Prefer `FS_API_KEY`: other users on the machine can see command-line arguments. |
| `--log-level <level>`     | `info`      | `debug`, `info`, `notice`, `warn`, `error`, `critical`, `alert`, or `emergency`. Env: `FS_LOG_LEVEL`.                            |
| `--print-config`          |             | Print the settings the server would use, as JSON, and exit.                                                                      |
| `-h`, `--help`            |             | Show help.                                                                                                                       |
| `-v`, `--version`         |             | Show the version.                                                                                                                |

## Environment variables

Boolean variables accept `true` or `1` to turn on, and `false`, `0`, or unset
to turn off. Any other value logs a warning and counts as off.

These variables control folders and access:

| Variable                 | What it does                                                              |
| :----------------------- | :------------------------------------------------------------------------ |
| `FS_ALLOWED_DIRS`        | Allowed folders, `:`-separated (macOS, Linux) or `;`-separated (Windows). |
| `FS_ALLOW_CWD_WALK`      | Same as `--walk-cwd`.                                                     |
| `FS_ALLOW_MISSING_ROOTS` | Same as `--allow-missing-roots`.                                          |
| `FS_ROOT_BOUNDARY`       | Same as `--root-boundary`.                                                |
| `FS_DENYLIST`            | Extra blocked patterns, comma-separated. Combined with `--deny`.          |
| `FS_ALLOWLIST`           | Built-in patterns to unblock, comma-separated. Combined with `--allow`.   |
| `FS_ALLOW_SENSITIVE`     | Same as `--allow-sensitive`.                                              |
| `FS_READ_ONLY`           | Same as `--read-only`.                                                    |

These variables control limits and logging:

| Variable             | What it does                                                          |
| :------------------- | :-------------------------------------------------------------------- |
| `FS_MAX_FILE_SIZE`   | Same as `--max-file-size`.                                            |
| `FS_TOOL_TIMEOUT_MS` | Same as `--tool-timeout`.                                             |
| `FS_MAX_WATCHERS`    | Most files watched for changes at once. Default 256, range 1 to 4096. |
| `FS_MAX_UNDO_BYTES`  | Memory kept for undo. Default 32 MiB, 0 turns undo off.               |
| `FS_LOG_LEVEL`       | Same as `--log-level`. Logs go to stderr.                             |
| `NO_COLOR`           | Any value turns off colored output.                                   |

These variables are for HTTP only:

| Variable                      | What it does                                                                                                                                                                                                                                                                                                                                    |
| :---------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FS_PORT`                     | Same as `--port`. Unset or empty means stdio.                                                                                                                                                                                                                                                                                                   |
| `FS_HTTP_HOST`                | Same as `--http-host`.                                                                                                                                                                                                                                                                                                                          |
| `FS_API_KEY`                  | Same as `--api-key`. At least 16 characters.                                                                                                                                                                                                                                                                                                    |
| `FS_ALLOWED_HOSTS`            | `Host` header values to accept, comma-separated. Required when listening on `0.0.0.0` or `::`.                                                                                                                                                                                                                                                  |
| `FS_ALLOW_UNRESTRICTED_HOSTS` | Listen on `0.0.0.0` or `::` without `FS_ALLOWED_HOSTS`. Only if you accept the risk.                                                                                                                                                                                                                                                            |
| `FS_ALLOWED_ORIGINS`          | Browser origins allowed to call `/mcp`, comma-separated hostnames. Replaces the localhost default, so list `localhost` again if you still need it. For browser extensions, list the extension ID, or a lowercase `<scheme>://*` entry such as `moz-extension://*` for all extensions of that kind. `http://*` and `https://*` are not accepted. |
| `FS_RATE_LIMIT_RPM`           | Requests per minute per client IP. Default 120 with an API key, 6000 without one (localhost only). Range 1 to 100000.                                                                                                                                                                                                                           |
| `FS_TRUST_PROXY`              | Express `trust proxy` setting (hop count or expression) when behind a reverse proxy. Unset means `X-Forwarded-*` headers are ignored.                                                                                                                                                                                                           |
| `FS_PUBLIC_URL`               | Public URL of the server, used in OAuth protected-resource metadata (RFC 9728).                                                                                                                                                                                                                                                                 |
| `FS_REQUEST_STATE_KEY`        | Secret (32+ bytes) used to sign confirmation round-trips. Optional: a random key is made at startup. Set it to keep pending confirmations valid across a restart.                                                                                                                                                                               |

## Limits

| Limit                                                   | Value                                                                              |
| :------------------------------------------------------ | :--------------------------------------------------------------------------------- |
| Largest file `read` loads                               | 10 MiB by default (`--max-file-size`, up to 100 MiB)                               |
| Total content of one `create` call                      | Same as the file size limit                                                        |
| Total text of one batched `read`                        | 512 KiB; files past the budget are reported as skipped                             |
| Files per `create`, `move` call                         | 100                                                                                |
| Paths per `read`, `stat`, `delete` call                 | 1000                                                                               |
| Files per `edit` call                                   | 5, with up to 100 edits per file                                                   |
| `find_files` / `search_text` results                    | Up to 10,000 per call, paged                                                       |
| `list` entries                                          | 1000 per page by default, up to 20,000                                             |
| `list`, `stat`, `read`, search tools and `replace_text` | Time out after 5 seconds by default (`--tool-timeout`); narrow the path or pattern |
| Cached results and page cursors                         | Expire after about 60 seconds                                                      |

`read` handles text files and returns images and audio as media. It refuses
other binary files unless the call passes `binary: true`, which returns them
whole as an embedded resource under the same `--max-file-size` cap; over
stdio, a file above about 7 MiB is too large once base64-encoded. It refuses
UTF-16 text files.

A stdio request ID may take at most 1024 bytes when JSON-encoded, counting
quotes and escapes. The server rejects a longer ID before running the request,
with JSON-RPC `InvalidRequest` (`-32600`) and no `id`, and does not echo the
oversized ID. Use a shorter ID and retry. A string `_meta.progressToken` has
the same limit, because every progress notification echoes it. The server
rejects a request with a longer token the same way, but that error carries the
request's `id`. The limit keeps room for IDs and tokens in responses, errors,
and progress notifications under the client's 10 MiB stdio buffer. It does not
apply over HTTP.

## Running over HTTP

By default the server talks to one client over stdio, which is what desktop
and editor apps expect. Use HTTP when a client connects by URL, or to share
one server between several clients.

```bash
filesystem-mcp --port 3000 ~/code/app
```

The endpoint is `http://127.0.0.1:3000/mcp`. `GET /healthz` answers `200`
when the server is up. Point your client at the endpoint, for example in VS
Code:

```json
{
  "servers": {
    "filesystem": { "type": "http", "url": "http://127.0.0.1:3000/mcp" }
  }
}
```

The server enforces these safety rules:

- It listens on `127.0.0.1` unless you set `--http-host`.
- Listening on any other address requires an API key of at least 16
  characters (`FS_API_KEY`). Clients send it as
  `Authorization: Bearer <key>`.
- Listening on every address (`0.0.0.0` or `::`) also requires
  `FS_ALLOWED_HOSTS`, the host names clients will use.
- Browsers can only call it from `localhost` pages unless you set
  `FS_ALLOWED_ORIGINS`.
- It rate-limits requests per client IP (`FS_RATE_LIMIT_RPM`).

```bash
# Reachable from your network, with a key
FS_API_KEY="$(openssl rand -hex 24)" \
FS_ALLOWED_HOSTS=myhost.local \
filesystem-mcp --port 3000 --http-host 0.0.0.0 ~/code/app
```

Over HTTP, clients that speak the newest MCP revision (2026-07-28) get every
feature. Older (2025-era) clients can use all tools, resources, and prompts,
but not confirmations or file change notifications. An overwrite, a recursive
delete, or a request for a new folder fails with an error that says so. For
those clients, use stdio, or `overwrite: true` where a tool offers it.

The server never picks up a client's workspace folders over HTTP, whatever
the client's version, so pass folders as arguments when you start it. All
clients of one server share its folders, including any folder one of them was
granted. A relative path resolves against the root unless the server was
started inside one, and with several roots it must exist under exactly one,
so clients are safest sending absolute paths. The
[client guide](client-guide.md) covers this and the rest of what a client
needs to know.

## Running in Docker

The image is `ghcr.io/j0hanz/filesystem-mcp`. It runs as a non-root user, and
it can only see the folders you mount.

```bash
# Read-only: the mount and the server both refuse writes
docker run -i --rm \
  -v /path/to/project:/workspace:ro \
  ghcr.io/j0hanz/filesystem-mcp:latest --read-only /workspace
```

In a client config, use `docker` as the command:

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

VS Code and Visual Studio use `"servers"` instead of `"mcpServers"`. Mount
more folders with more `-v` flags and pass each container path as an
argument.

Over HTTP, the container has to listen on every address, so the rules above
apply:

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e FS_API_KEY=change-me-to-a-long-random-key \
  -e FS_ALLOWED_HOSTS=localhost,127.0.0.1 \
  -v /path/to/project:/workspace \
  ghcr.io/j0hanz/filesystem-mcp:latest --port 3000 --http-host 0.0.0.0 /workspace
```

## Troubleshooting

**The AI says it cannot access my folder.** Ask it to call `list_roots`. If
the folder is missing, add it to the server's arguments and restart the
client. In clients without confirmations, the server refuses a path outside
the allowed folders instead of asking about it.

**`Sensitive file blocked`.** The file matches the [secret-file list](#secret-files)
or one of your `--deny` rules. Unblock that built-in pattern with
`--allow`, for example `--allow '.env.example'`. `--deny` rules cannot be
lifted this way; remove the rule instead.

**Nothing happens, or a syntax error at startup.** Check `node --version`.
The server needs Node.js 24 or later.

**Overwrite or delete fails with "needs a confirmation this client cannot
show".** Your client does not support MCP confirmations (elicitation). The
error says what to do instead, such as passing `overwrite: true`, deleting a
folder's files one by one, or using a path that does not exist yet.

**A search misses files.** By default, searches skip hidden files,
`.gitignore`d files, and folders like `node_modules`, `dist`, and `.git`. Ask
for `includeHidden` or `includeIgnored`.

**A search stops early with `scan stopped early: timeout`.** Narrow `path` or
`pattern` first. On a very large folder, raise the limit, for example
`--tool-timeout 30000`. Most clients give up on a call after 60 seconds, so stay
below that unless your client resets its timeout on progress.

**Windows paths in JSON.** Escape backslashes (`"C:\\Users\\me\\project"`)
or use forward slashes (`"C:/Users/me/project"`). A server on Linux or macOS,
for example in Docker, refuses a drive path with `Windows-style path received
on a POSIX host`. Pass a path on the server's own filesystem instead.

**See what the server is doing.** Start it with `--log-level debug`. Logs go
to stderr, which most clients show in their MCP output panel.

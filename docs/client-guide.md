# Building a client

This guide is for developers who connect to filesystem-mcp from their own code:
an agent, an IDE plugin, a web app, a CI job, or a script. It describes what
the server sends and expects on the wire, what differs between transports and
protocol versions, and the mistakes that are easy to make. If you only want to
use the server from an AI app, the [README](../README.md) is enough.

The behavior described here was checked against filesystem-mcp 2.7.5 with the
TypeScript SDK (`@modelcontextprotocol/client` 2.3.1) and the Python SDK
(`mcp` 2.2.0 and 2.3.0). Most of it also appears as running code in the
[example clients](../examples/).

- [Quick start](#quick-start)
- [Transports](#transports)
- [Protocol versions](#protocol-versions)
- [Folders and paths](#folders-and-paths)
- [Tools](#tools)
- [Reading tool results](#reading-tool-results)
- [Errors](#errors)
- [Pagination and cached results](#pagination-and-cached-results)
- [Progress, cancellation, and timeouts](#progress-cancellation-and-timeouts)
- [Confirmations](#confirmations)
- [Resources and file subscriptions](#resources-and-file-subscriptions)
- [Prompts and completions](#prompts-and-completions)
- [Using the tools from a model](#using-the-tools-from-a-model)
- [Security checklist](#security-checklist)
- [Examples](#examples)

## Quick start

TypeScript:

```ts
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const dir = '/path/to/project';
const client = new Client(
  { name: 'my-client', version: '1.0.0' },
  {
    capabilities: { elicitation: { form: {} } }, // lets the server ask before risky changes
    versionNegotiation: { mode: 'auto' }, // speak the newest protocol the server supports
  },
);
client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' })); // see Confirmations

await client.connect(
  new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@j0hanz/filesystem-mcp', dir],
    cwd: dir, // relative paths in tool calls resolve against this
  }),
);

const result = await client.callTool({
  name: 'search_text',
  arguments: { searchPattern: 'TODO', context: 1 },
});
console.log(result.content[0].type === 'text' ? result.content[0].text : '');
const data = result.structuredContent ?? result._meta; // see "Reading tool results"
await client.close();
```

Python:

```python
import asyncio

from mcp import Client, StdioServerParameters, types


async def decline(_context, _params):  # see Confirmations
    return types.ElicitResult(action="decline")


async def main():
    params = StdioServerParameters(
        command="npx",
        args=["-y", "@j0hanz/filesystem-mcp", "/path/to/project"],
        cwd="/path/to/project",
    )
    # mode="auto", the default, negotiates the newest protocol the server supports.
    async with Client(params, elicitation_callback=decline) as client:
        result = await client.call_tool("search_text", {"searchPattern": "TODO"})
        data = result.structured_content or result.meta
        print(data["matches"])


asyncio.run(main())
```

## Transports

### stdio

The client starts the server as a child process, with
`npx -y @j0hanz/filesystem-mcp <folders...>`, or with
`node dist/index.js <folders...>` from a checkout. Folder arguments become
the allowed roots; every flag in the
[configuration reference](configuration.md#command-line-flags) can go in the
argument list (for example `--read-only`).

- Set `cwd` to the workspace. Relative paths in tool calls resolve against the
  server process's working directory when that is inside a root, and against
  the root otherwise (see [Folders and paths](#folders-and-paths)).
- The server prints its allowed folders and its logs on stderr. Pipe stderr
  (`stderr: 'pipe'` in TypeScript, `errlog=` in Python) if it would mix with
  your own output, and keep the tail of it for error messages.
- One server process serves one client. A stdio connection keeps state for its
  lifetime: subscriptions, cached results, pagination snapshots, and access
  grants.

### Streamable HTTP

Start the server with `--port` and connect to `http://127.0.0.1:<port>/mcp`.
`GET /healthz` returns `200` once it is listening.

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp'), {
  authProvider: { token: async () => process.env.FS_API_KEY }, // when the server has an API key
});
```

In Python:

```python
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

headers = {"Authorization": f"Bearer {key}"}
transport = streamable_http_client(url, http_client=create_mcp_http_client(headers=headers))
async with Client(transport) as client: ...
```

- With `FS_API_KEY` set on the server, every request needs
  `Authorization: Bearer <key>`. Without it, connecting fails with HTTP 401
  (`SdkHttpError`, code `CLIENT_HTTP_AUTHENTICATION`, in TypeScript).
- The server is stateless per request, with no session ID. One server can
  serve many clients at once, and they share its allowed folders, including
  folders granted by any one of them.
- Prefer absolute paths. A relative path resolves against the root unless the
  server was started inside one, which a remote client cannot know.
- 2025-era clients get no confirmations and no change notifications over HTTP;
  see the table below.

## Protocol versions

The server speaks two protocol eras, and so do the SDKs:

- **2025** (`2025-11-25` and earlier): the `initialize` handshake; the server
  sends requests to the client (`elicitation/create`, `roots/list`) and
  unsolicited notifications.
- **2026-07-28**: discovery with `server/discover`, no handshake; the server
  asks for input by returning an `input_required` result, and notifications
  travel on an explicit `subscriptions/listen` stream.

Choosing one:

| SDK        | Default               | Newest when available                  | Exactly 2026-07-28                                    |
| :--------- | :-------------------- | :------------------------------------- | :---------------------------------------------------- |
| TypeScript | 2025 (no negotiation) | `versionNegotiation: { mode: 'auto' }` | `versionNegotiation: { mode: { pin: '2026-07-28' } }` |
| Python     | `mode="auto"`         | `mode="auto"`                          | `mode="2026-07-28"`                                   |

After connecting, `client.getProtocolEra()` returns `'modern'` or `'legacy'`
(Python: `client.protocol_version`). In TypeScript, `'auto'` over stdio probes
with one extra, short-lived server process before starting the real one.

What works where:

| Feature                                        | 2025 stdio            | 2025 HTTP                       | 2026-07-28 stdio and HTTP |
| :--------------------------------------------- | :-------------------- | :------------------------------ | :------------------------ |
| Tools, resources, prompts, completions         | yes                   | yes                             | yes                       |
| Progress notifications                         | yes                   | yes                             | yes                       |
| Confirmations (overwrite, delete, access)      | `elicitation/create`  | no: the call fails, and says so | `input_required`          |
| File change notifications                      | `resources/subscribe` | no (`Method not found`)         | `subscriptions/listen`    |
| Resource list changes                          | unsolicited           | no                              | on the listen stream      |
| Folders from the client (`roots/list`)         | yes                   | no                              | no: use access grants     |
| `ping`                                         | yes                   | yes                             | refused by the SDK        |
| Cache hints (`ttlMs`, `cacheScope`) on results | no                    | no                              | yes                       |

Two SDK details matter on 2026-07-28:

- `client.getDiscoverResult()` returns the discovery result. Store it and pass
  `{ prior: { kind: 'modern', discover } }` to `client.connect()` to reconnect
  without the probe.
- `ClientOptions.listChanged` opens a listen stream for list changes by
  itself; `client.autoOpenedSubscription` is its handle.

## Folders and paths

**Where roots come from.** Folder arguments, `FS_ALLOWED_DIRS`, and
`--allow-cwd` at startup; on 2025-era stdio connections, the folders a client
returns from `roots/list` (declare `capabilities: { roots: { listChanged: true } }`
and call `client.sendRootsListChanged()` when they change); and access grants
the user accepts. Call the `list_roots` tool for the current set:
`structuredContent.roots` is an array of absolute paths. With no roots at all
it also has a `hint` saying how to add one.

**Relative paths resolve against the server's working directory** while that
lands inside a root. Otherwise they resolve against the roots: against the
one root, or with several, against the one root the path exists under. Only
the roots you configured and the ones your client declared count here, not a
folder granted during the session, so approving a grant never changes what a
relative path names. A relative path that exists under several roots, or
under none of several, is refused with `INVALID_INPUT`, and the error names
the roots. When it is a subfolder of a root, as with `--walk-cwd`, relative
paths resolve against that subfolder, so send absolute paths. With no
configured or declared roots, a relative path still
resolves against the working directory, and so becomes a request to grant
access there, which a client that approves grants automatically would accept.
Absolute paths built from `list_roots` are never ambiguous. `~` expands to the
home directory of the user running the server.

**A name spelled differently from the disk in Unicode still resolves.** When a
name is not on disk as typed, the server compares it with the entries of its
folder after NFC normalization, reading every space character as a plain
space. `café` finds a folder stored decomposed (`cafe` plus U+0301), and
`shot PM.png` finds a macOS screenshot whose name holds U+202F. This works for
reads, writes, moves and deletes, below a root only: the root itself must be
spelled as configured. A write lands on the entry it finds, so `create` asks
before replacing it, as for any existing file. When two entries match, the
call fails with `INVALID_INPUT` (`Ambiguous Unicode path component`) and shows
each spelling with `\u` escapes; send the exact name. A match the denylist
covers is refused as that file is, and never shown. A name of plain ASCII
with no space is never matched this way.

**Result paths read back as given.** `search_text`, `find_files` and
`replace_text` print each path relative to the root that holds the folder
they searched, whatever that folder was, and name that root, as
`list_roots` shows it, in a `root` field. A search of `src` prints
`src/a.ts`, which `read` and `edit` take as it is. A path whose relative
spelling would not read back as the same file is printed absolute instead:
everything when the working directory is a subfolder of a root, everything
when there are several roots and the working directory is outside them (a
name two roots share would read back as ambiguous), everything under a
folder granted during the session, and a name such as `~` or a blank one. On
macOS and Linux a backslash in a name stays a backslash. `list` draws a tree
of names and keeps `relativePath` relative to its `path`; the tree's first
line names a listed subfolder the same way (`src/core`). With `includeSizes`,
each file's size rides its tree line and a `// N files, M directories, X total`
line closes the listing; `sortBy: 'size'` orders files largest-first within
each directory.

**Access grants.** A tool call with a path outside the roots does not touch
the filesystem. It asks the user first (see [Confirmations](#confirmations)),
and on approval the folder is added to the roots until the server stops. Over
HTTP, that is for every client of the server. Without a way to ask, the path
fails with `ACCESS_DENIED`. Some folders can never be granted: the filesystem
root, the home folder itself, system folders, and credential folders such as
`~/.ssh`. The [configuration reference](configuration.md#folders-that-are-never-added-automatically)
has the list.

**Secret files** (`.env`, keys, credentials) are refused by every tool and
resource, left out of listings, searches, and completions, and reported as not
found by `resources/read`.

## Tools

| Tool           | Changes files | `dryRun` | Several paths in one call       | Paged | Data in             |
| :------------- | :------------ | :------- | :------------------------------ | :---- | :------------------ |
| `list_roots`   |               |          |                                 |       | `structuredContent` |
| `list`         |               |          |                                 | yes   | `_meta`             |
| `find_files`   |               |          |                                 | yes   | `_meta`             |
| `search_text`  |               |          |                                 | yes   | `_meta`             |
| `stat`         |               |          | `paths` (1000)                  |       | `structuredContent` |
| `read`         |               |          | `paths` (1000, 512 KiB of text) |       | `_meta`             |
| `diff`         |               |          |                                 |       | `_meta`             |
| `create`       | yes           |          | `files` (100)                   |       | `structuredContent` |
| `edit`         | yes           | yes      | `files` (5)                     |       | `_meta`             |
| `patch`        | yes           | yes      |                                 |       | `_meta`             |
| `replace_text` | yes           | yes      | a folder and a glob             |       | `_meta`             |
| `move`         | yes           |          | `moves` (100)                   |       | `_meta`             |
| `delete`       | yes           |          | `paths` (1000)                  |       | `_meta`             |
| `undo`         | yes           | yes      |                                 |       | `_meta`             |

- Decide what to gate from the annotations, not from tool names: every tool
  that changes files has `destructiveHint: true` and `readOnlyHint: false`; the
  others have `readOnlyHint: true`. All have `openWorldHint: false`. A tool
  that takes a preview has a `dryRun` property in its `inputSchema`.
- `--read-only` removes the seven tools that change files from `tools/list`.
  Calling one anyway throws `Tool create not found`. Check the list rather
  than assuming.
- Input schemas are JSON Schema draft 2020-12 with no top-level `oneOf`,
  `anyOf`, or `allOf`, so they can go to the OpenAI and Anthropic APIs as they
  are. Rules that span fields (`path` or `paths`; `path` with `edits`, or
  `files`; `endLine` needs `startLine`) are checked when the tool runs and come
  back as `Input validation error: ...`.
- On 2026-07-28 the TypeScript SDK caches `tools/list` for the hour the
  server allows. The list only changes when the server restarts with other
  flags.

## Reading tool results

Every result has a `content` array whose first block is text written for a
model: a tree for `list`, grep-style lines for `search_text`, the file for
`read`, a diff for `edit`. Do not parse that text. Except for `read` (below),
the same data is available as JSON, in one of two places:

- Tools that write their own text keep their data in `_meta`: `list`,
  `find_files`, `search_text`, `read`, `diff`, `edit`, `patch`,
  `replace_text`, `move`, `delete`, `undo`. They have no `structuredContent`, because
  some clients show `structuredContent` to the model instead of the text.
- Tools without their own text (`list_roots`, `stat`, `create`) put the data
  in `structuredContent`, and the text block is the same JSON.
- Every call that changes files carries `undo` (the undo id) or
  `undoUnavailable` (the reason) in its `_meta`, or in `structuredContent` for
  `create`.

So read `result.structuredContent ?? result._meta` (Python:
`result.structured_content or result.meta`). On 2026-07-28 connections
`_meta` also carries `io.modelcontextprotocol/serverInfo`; skip keys under
`io.modelcontextprotocol/`. No tool declares an `outputSchema`.

What is where:

| Tool                             | Data                                                                                                                                                                                                    |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list`                           | `path`, `entries[]` (`name`, `relativePath`, `type`, `size` with `includeSizes`/`sortBy: 'size'`), `totalEntries`, `totalFiles`, `totalDirectories`, `totalBytes` (with the same options), `nextCursor` |
| `find_files`                     | `root`, `results[]` (`path`, relative to `root`), `totalMatches`, `filesScanned`, `nextCursor`                                                                                                          |
| `search_text`                    | `root`, `matches[]` (`file`, relative to `root`, `line`, `column`, `content`, `before`, `after`), `totalMatches`, `nextCursor`                                                                          |
| `stat`, `read`, `edit`, `delete` | `results[]`, each `{ path, value }` or `{ path, error }`, and `summary` (`total`, `succeeded`, `failed`)                                                                                                |
| `replace_text`                   | `root`, `results[]` (`path` relative to `root`), `summary`, `totalMatches`, `filesScanned`, and `diff` with `returnDiff: true`                                                                          |
| `create`                         | `files[]` (`path`, `size`, `lineCount`, `mimeType`, `resourceUri`, ...), `directories[]`, and `failures[]`                                                                                              |
| `move`                           | `moves[]` (`from`, `to`) and `failures[]`                                                                                                                                                               |
| `diff`, `patch`                  | `a`/`b` or `path`, `linesAdded`, `linesRemoved`; a `patch` dry run also has `diff`                                                                                                                      |

Notes on individual tools:

- `read` is the exception to the rule above: the file's text is only in the
  text block, and `_meta` holds metadata about it (line counts,
  `continuation`, `resourceUri`), not the text itself. With one `path` the
  text block is the file; with `paths` the files are joined under
  `// <path>` headers. For a file's exact text in code, read one `path` per
  call, or call `resources/read` on its `resourceUri`.
- A partial read ends with a `// truncated: ...` line, and its
  `_meta.results[].value.continuation` holds the arguments for the next
  chunk. `includeHash: true` adds `contentHash` (SHA-256). Images and audio
  come back as `image` and `audio` content blocks; other binary files fail
  with `Binary file detected.` unless the call passes `binary: true`. Then a
  full read returns the file as a `resource` block (`resource.blob` is base64,
  `resource.mimeType` the type), and `_meta.results[].value` holds `size` and
  `kind`. Line ranges are refused for binary files.
- `read` and `create` add a `resource_link` block per file, pointing at its
  `filesystem-mcp://file/...` resource.
- `stat` on a folder has no `size`; its `entryCount` is the number of entries
  directly inside it, hidden ones included and secret files left out. `0` means
  the folder is empty.
- A dry run of `edit` or `replace_text` returns a unified diff as its text.
  A dry run of `patch` returns the patched file as its text; the diff it
  applied is in `_meta.diff`.

## Errors

There are three kinds of failure:

1. **A tool failure** is a normal result with `isError: true`. The text says
   what went wrong; in a batch, each failed item also has a
   `{ code, message, path, suggestion }` error. Input that does not match the
   schema comes back this way too (`Input validation error: ...`), so a model
   can correct itself.
2. **A partial failure** is not `isError`. A call with several paths sets
   `isError` only when every item failed. Check `summary.failed` (`stat`,
   `read`, `edit`, `delete`, `replace_text`) or `failures` (`create`, `move`).
3. **A protocol error** is thrown: an unknown tool (`-32602`,
   `Tool <name> not found`), a malformed or out-of-root resource URI
   (`ResourceNotFoundError`, with `data.uri`), a forged or expired
   `requestState`, an SDK timeout or abort (`SdkError`).

Error codes in tool results: `ACCESS_DENIED`, `NOT_FOUND`, `NOT_FILE`,
`NOT_DIRECTORY`, `TOO_LARGE`, `TIMEOUT`, `CANCELLED`, `INVALID_PATTERN`,
`INVALID_INPUT`, `PERMISSION_DENIED`, `SYMLINK_NOT_ALLOWED`, `IO_ERROR`,
`UNKNOWN`. A declined confirmation is `CANCELLED`. The `suggestion` field and
the server's guide (below) say how to recover from each.

## Pagination and cached results

`list`, `find_files`, and `search_text` return one page at a time (sized by
`maxEntries` or `maxResults`). When more remain:

- `_meta.nextCursor` is set, and the text ends with
  `// showing 1-100 of 2300 matches. Next page: search_text {...}`.
- Repeat the call with the same arguments plus `cursor`. Every page is cut
  from one snapshot taken by the first call, so the pages are consistent with
  each other.
- The snapshot expires after about 60 seconds. If a cursor is rejected, start
  again without one.

The first page of a split result also carries `_meta.resourceUri` and a
`resource_link` to `filesystem-mcp://result/<id>`: the whole result as JSON,
readable with `resources/read` for about 60 seconds. These cached results
appear in `resources/list`, and each one added or expired sends
`notifications/resources/list_changed`.

A `find_files` or `search_text` scan that hit a limit ends with
`// scan stopped early: ...` and sets `_meta.stoppedReason` (`maxResults` or
`timeout`). The totals are then a floor, not a count. Narrow the path or the
pattern. The [limits table](configuration.md#limits) has the numbers.

## Progress, cancellation, and timeouts

- Pass a progress callback (`onprogress` in TypeScript, `progress_callback` in
  Python) and the SDK sends a `progressToken`; without one the server sends no
  progress at all. Each notification has `progress`, sometimes `total`, and a
  `message` such as `Read: 3 files · 2/3`.
- `resetTimeoutOnProgress: true` keeps a long call alive while it reports
  progress. The SDK's default request timeout is 60 seconds.
- Abort the call's `AbortSignal` to cancel it. The SDK sends
  `notifications/cancelled` and rejects with an `AbortError`.
- `list`, `stat` and `read` stop themselves after 5 seconds by default (the
  server's `--tool-timeout` or `FS_TOOL_TIMEOUT_MS` changes this) with a
  `TIMEOUT` error. `find_files` and `search_text` stop at the same
  deadline but return what they found so far, with
  `_meta.stoppedReason: 'timeout'` (see
  [Pagination](#pagination-and-cached-results)). `replace_text` stops at
  the same deadline too: in a live run the files it already rewrote stay
  rewritten, and the text names them. Run a wide replacement with
  `dryRun: true` first. `maxResults` does not shorten a scan; a narrower
  `path`, `pattern`, or `maxDepth` does.

## Confirmations

The server asks the user before:

| Action                                                                   | Form                                  |
| :----------------------------------------------------------------------- | :------------------------------------ |
| `create` over an existing file (unless that entry has `overwrite: true`) | `choice`: enum `overwrite`, `skip`    |
| `move` onto an existing path (a copy with `overwrite: true` skips it)    | `choice`: enum `overwrite`, `skip`    |
| `delete` with `recursive: true` on a non-empty folder                    | `choice`: enum `delete`, `skip`       |
| A path in one folder outside the roots                                   | `confirm`: boolean                    |
| Paths in several folders outside the roots                               | `choice`: array of enum (the folders) |

`edit`, `patch`, and `replace_text` never ask; preview them with `dryRun`.
`delete` of a non-empty folder without `recursive: true` fails without asking.

Every form is an `elicitation/create` request in form mode, with a `message`
and a `requestedSchema` that has exactly one property. Answer with
`{ action: 'accept', content: { <property>: <value> } }`, or with
`{ action: 'decline' }`. Declining fails that item with `CANCELLED`; for a
grant, the path then fails with `ACCESS_DENIED`. Accepting with `skip` is not
a failure, and nothing changes. `create` and `move` list the path under
`skipped` instead of `files` or `moves`, and `delete` reports
`deleted: false` with the text `SKIPPED`. A client that announces success
should check for those. A handler that understands
the three field shapes (boolean, enum, array of enum) handles every question
without knowing which one it is:

```ts
client.setRequestHandler('elicitation/create', async ({ params }) => {
  if (params.mode === 'url') return { action: 'decline' };
  const [[key, field]] = Object.entries(params.requestedSchema.properties);
  // Your UI. true, 'overwrite', or ['/a', '/b']; undefined when the user says no.
  const answer: boolean | string | string[] | undefined = await askUser(params.message, field);
  if (answer === undefined) return { action: 'decline' };
  return { action: 'accept', content: { [key]: answer } };
});
```

The client must declare `capabilities: { elicitation: { form: {} } }`. Without
it the server cannot ask, and the call fails with a message that names the
alternative (`overwrite: true`, deleting files one by one, a path inside the
roots).

**Two ways to answer on 2026-07-28.** By default the SDK fulfils the server's
`input_required` result through the same `elicitation/create` handler and
retries the call for you, so the handler above works in both eras. A web app
or a queue often cannot wait inside a handler; it can take the questions as
data instead:

```ts
import type { CallToolRequest } from '@modelcontextprotocol/client';

const client = new Client(info, {
  capabilities: { elicitation: { form: {} } },
  versionNegotiation: { mode: { pin: '2026-07-28' } },
  inputRequired: { autoFulfill: false },
});

const params = { name: 'create', arguments: { files: [{ path, content }] } };
let result: any = await client.callTool(params, { allowInputRequired: true });
while (result.resultType === 'input_required') {
  const inputResponses: Record<string, object> = {}; // keyed like result.inputRequests
  for (const [key, request] of Object.entries<any>(result.inputRequests)) {
    inputResponses[key] = await askUserLater(request.params); // { action, content }
  }
  // The retry fields are not in callTool()'s parameter type (SDK 2.3.1), hence the cast.
  const retry = { ...params, inputResponses, requestState: result.requestState };
  result = await client.callTool(retry as CallToolRequest['params'], { allowInputRequired: true });
}
```

`requestState` is opaque. Send it back unchanged with the same tool name and
arguments. The server signs it, binds it to the request, and lets it expire
after 10 minutes; a changed or expired one is rejected with
`Invalid or expired requestState`. It is signed with a key made at startup,
so a restart invalidates pending ones unless `FS_REQUEST_STATE_KEY` is set.
With `autoFulfill: false` and no `allowInputRequired`, the call throws
`SdkError` `UNSUPPORTED_RESULT_TYPE` instead.

## Resources and file subscriptions

| URI                             | What it is                                                              |
| :------------------------------ | :---------------------------------------------------------------------- |
| `internal://instructions`       | The server's usage guide for models, Markdown                           |
| `filesystem-mcp://file/{+path}` | Any file inside the roots; a template, not listed in `resources/list`   |
| `filesystem-mcp://result/{id}`  | A cached tool result (see [Pagination](#pagination-and-cached-results)) |

**File URIs.** The path is absolute, with `\` turned into `/`, then
percent-encoded with `/` kept:
`'filesystem-mcp://file/' + encodeURIComponent(path).replace(/%2F/gi, '/')`.
Unencoded, a `#` or `?` in a file name would cut the URI short. A Unix path
therefore gives a double slash: `filesystem-mcp://file//home/me/a.txt`.
Reading one returns `text` for text files and base64 `blob` for images and
other binaries, with a `mimeType`. `resources/read` does not ask for access.
A file outside the roots is not found, so call a tool (`stat`) first if the
user should be asked.

**Fresh reads.** On 2026-07-28, results carry cache hints, and the TypeScript
SDK honors them. File reads may be cached for 5 seconds, so a
`readResource()` right after a write (yours, or one announced by a change
notification) can return the old bytes. Pass `{ cacheMode: 'bypass' }` when
you need what is on disk.

**Subscriptions.** Subscribe to a file URI to hear when it changes:

```ts
client.setNotificationHandler('notifications/resources/updated', ({ params }) => {
  console.log('changed:', params.uri); // exactly the URI you subscribed to
});
if (client.getProtocolEra() === 'modern') {
  const sub = await client.listen({ resourceSubscriptions: [uri] });
  sub.honoredFilter; // the URIs the server is watching
  sub.closed.then((why) => why === 'remote' && reconnect()); // the stream dropped
} else {
  await client.subscribeResource({ uri }); // 2025 era, stdio only
}
```

- The notification only names the URI; read the resource again for the new
  contents.
- The file must exist when you subscribe. One that is deleted later stays
  watched, and a new file at the same path is reported.
- A folder URI watches the whole tree below it, and the notification still
  names the folder, not the file that changed. Diff a `find_files` and `stat`
  snapshot to find out what changed, as the
  [hooks](../examples/clients/hooks/) example does.
- The server watches at most `FS_MAX_WATCHERS` paths (256 by default).
- On 2026-07-28 nothing is resent after a dropped stream. Listen again, then
  re-read what you follow.

## Prompts and completions

- The `get-help` prompt returns the same guide as `internal://instructions`,
  or one section of it: `topic` is `guidelines`, `tools_overview`,
  `constraints`, or `error_recovery`. The server's `instructions` (from
  `client.getInstructions()`) are a one-line summary that points at both.
- `completion/complete` completes the file template's `path` and the prompt's
  `topic`:

  ```ts
  const { completion } = await client.complete({
    ref: { type: 'ref/resource', uri: 'filesystem-mcp://file/{+path}' },
    argument: { name: 'path', value: encoded }, // percent-encoded like a file URI
  });
  ```

  An empty value lists the roots. A relative value is completed inside the
  root when there is one root, or as `<root name>/...` when there are several.
  Folders inside a root end with `/`. Secret files are left out. Up to 100
  values are returned, with `total` and `hasMore`.

## Using the tools from a model

- Pass `tools/list` to the model as function definitions. The schemas need no
  rewriting, and the server validates every call.
- Use `internal://instructions` as, or in, the system prompt.
- Send the model the text blocks, including on `isError` (prefix them with
  `ERROR:` or similar). The server writes the messages so a model can recover.
- Gate the tools with `destructiveHint`, and show the `dryRun` diff before
  asking the user, as [gatekeeper](../examples/clients/gatekeeper/) does.

## Security checklist

- Start the server with `--read-only` for anything that only reads.
- Do not approve access grants automatically. Over HTTP, a grant one client
  accepts applies to every client of that server until it restarts.
- Prefer absolute paths, above all with several roots or no roots (see
  [Folders and paths](#folders-and-paths)).
- Treat `requestState` as opaque and keep it with the call it came from.
- Over HTTP, set an API key, keep the server on `127.0.0.1` unless clients
  need to reach it from elsewhere, and read [Running over HTTP](configuration.md#running-over-http).
- If your client exposes the server to a browser, check the `Host` header and
  accept only JSON `POST`s, as [browser](../examples/clients/browser/) does.

## Examples

| Example                                       | Shows                                                                                                                             |
| :-------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| [gatekeeper](../examples/clients/gatekeeper/) | A model agent: tools as OpenAI functions, a `dryRun` approval gate, confirmations in the terminal                                 |
| [hooks](../examples/clients/hooks/)           | Folder subscriptions with `listen()`, change detection with `find_files` + `stat`, a model per change                             |
| [fsq](../examples/clients/fsq/)               | Every tool from a shell: stdio or HTTP with an API key, `_meta` vs `structuredContent`, pagination, progress, Ctrl+C, completions |
| [browser](../examples/clients/browser/)       | A web UI: manual `input_required`, signed `requestState`, file resources and images, completions                                  |
| [tail](../examples/clients/tail/)             | File subscriptions in both eras, over stdio and HTTP, with reconnects and the read cache                                          |
| [python](../examples/clients/python/)         | The Python SDK: both eras, HTTP auth, `search_text` pagination, confirmations                                                     |

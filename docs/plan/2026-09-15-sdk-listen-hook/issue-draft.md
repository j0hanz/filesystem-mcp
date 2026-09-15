# Issue draft: server-side hook for `subscriptions/listen` resource subscriptions

> Drafted 2026-09-15 against `@modelcontextprotocol/server@2.0.0` (installed,
> confirmed via `node_modules/@modelcontextprotocol/server/package.json`).
> Not yet filed. See "Filed as" at the bottom of this file once it is.

Target: https://github.com/modelcontextprotocol/typescript-sdk/issues (new issue)

---

## Title

Server-side hook for subscriptions/listen resource subscriptions (attach/detach per URI)

## Problem

A server whose `notifications/resources/updated` events come from an external
source — a filesystem watcher, a database trigger, a message queue consumer —
has to start that source when a client stream subscribes to a URI and stop it
when the stream ends. Nothing in the SDK tells it when either happens.

`createMcpHandler` and `serveStdio` own the entire `subscriptions/listen`
lifecycle: they parse and validate the `resourceSubscriptions` filter, ack the
listen, stamp each outbound notification with a subscription id, and route it
onto the matching stream. That is the right owner for all of it — but it also
means the server-supplied resource logic is never told which URIs were
honoured, or when the stream that held them closes. A server that needs to
turn a physical watch on and off per URI has no seam to do it from.

The 2025-era protocol had exactly this seam: `resources/subscribe` and
`resources/unsubscribe` were requests the server itself handled, so
"a client just subscribed to URI X" and "a client just unsubscribed from URI
X" were ordinary request handlers with the URI in hand. 2026-07-28 replaced
both verbs with `subscriptions/listen`, moved the whole filter/ack/routing
job into the SDK, and removed the verb without adding an SDK-side
replacement for the one thing servers used the handler for: knowing when to
start and stop watching a resource.

## What servers do today

This repo (filesystem-mcp — an MCP server over a guarded filesystem, watching
files with `fs.watch`) is a worked example. To
recover the missing signal, it parses the wire protocol itself, ahead of and
underneath the SDK:

- **HTTP** (`src/transport/http.ts:164-237`): before handing the request to
  `toNodeHandler`, the route reads `req.body` itself, checks whether it is a
  structurally valid `subscriptions/listen` (`isStructurallyValidListen`),
  rejects it early if it would push watcher count over the configured cap,
  starts a watcher per requested URI, and releases those watchers on
  `res`'s `'close'` event — which is the only place `after this stream ends`
  is observable from outside the SDK.
- **stdio** (`src/transport/stdio.ts:221-333`): there is no request/response
  boundary to hook, so the code wraps the `onmessage` callback that
  `serveStdio` installs on a caller-supplied `StdioServerTransport`, and
  wraps `send` too (a `result`/`error` reply is the only externally visible
  signal that a listen was acknowledged or rejected, so lease release keys
  off it). Requests are queued and admitted in order so two listens naming
  the same URI cannot race the watcher registry's ref-count, and
  cancellation (`notifications/cancelled`) is matched back to the pending or
  active listen by JSON-RPC request id.
- **Shared parsing** (`src/transport/shared.ts:36-118`): both legs share
  `isStructurallyValidListen`, `listenSubscriptionUris`, and
  `prepareListenWatchers` — the parse-the-listen-body helpers neither leg can
  get from the SDK.
- **No subscription id at attach time** (`src/core/watcher-registry.ts:43`):
  the SDK stamps each outbound notification with a subscription id
  (`SUBSCRIPTION_ID_META_KEY` is exported), but a server never sees that id
  when a stream subscribes — only the URI. So the registry can only
  ref-count watchers by URI, not lease them per subscription; two listens on
  the same URI from two different streams share one `fs.watch` and one
  ref-count entry instead of two independent leases.

This is roughly 280 lines of code whose entire job is recovering a signal the
SDK already has internally (it must know which URIs a stream listens for, in
order to route notifications to it) and simply does not expose.

**The stdio approach is also fragile in a way that has nothing to do with
this server's design.** It works only because `serveStdio` happens to install
its own `onmessage` handler on the passed-in transport *synchronously*, and
only *then* calls `start()` on it — so wrapping `wire.onmessage` after the
`serveStdio(...)` call still sees every message. That ordering is not part of
any documented contract; it is inferred from behavior. The server asserts it
at runtime and throws rather than silently degrading if a future SDK release
changes it (`src/transport/stdio.ts:255-258`):

```ts
const deliver = wire.onmessage;
if (!deliver) {
  throw new Error(
    'serveStdio did not install a synchronous onmessage handler; the subscriptions/listen watcher gate cannot attach. This is an SDK contract change, not a configuration error.',
  );
}
```

An SDK-owned hook removes the need to guess at internal ordering at all.

## Proposed API

Either shape closes the gap; (a) is preferred because it mirrors the
`list`/`complete` callbacks `ResourceTemplate` already has, and it would let
the SDK serve the legacy `resources/subscribe`/`resources/unsubscribe` verbs
itself from the same two callbacks instead of requiring servers to hand-roll
a second implementation for pre-2026-07-28 clients.

```ts
// (a) on the template, per resource, matched by URI template
new ResourceTemplate('files://{+path}', {
  list: undefined,
  subscribe?: (uri: string, ctx: { subscriptionId: string }) => Promise<void> | void, // throw ⇒ listen rejected (-32602)
  unsubscribe?: (uri: string, ctx: { subscriptionId: string }) => void,
});

// (b) on the serving entries, global
createMcpHandler(factory, { subscriptions: { onSubscribe, onUnsubscribe } });
serveStdio(factory, { subscriptions: { onSubscribe, onUnsubscribe } });
```

Required semantics, either shape:

- `subscribe`/`onSubscribe` is called once per `(stream, URI)` pair, after
  the SDK has honoured the filter (validated it, checked it against
  whatever authorization the server layer applies) and before the listen is
  acknowledged.
- A thrown error (or rejected promise) from `subscribe`/`onSubscribe` rejects
  the whole listen, before the ack — **all-or-nothing**: a client must never
  be told a URI is being watched when the server-side attach for it failed.
  Partial success (three of five URIs watched, ack sent anyway) is worse than
  outright rejection, because the client has no way to discover which two
  silently aren't.
- `unsubscribe`/`onUnsubscribe` is called on stream close, on
  `notifications/cancelled` for that listen, and on `handler.close()` /
  server shutdown — every path that ends a stream, not just a graceful one.
- The subscription id is passed in `ctx`, so servers can key their own
  resources per *subscription* instead of per *URI* — today, two streams
  subscribing to the same URI are indistinguishable to the server, which
  forces ref-counting by URI as a workaround.

## Relation to #2569

[#2569](https://github.com/modelcontextprotocol/typescript-sdk/issues/2569)
("`subscriptions/listen` cannot carry extension notifications, blocks
`notifications/tasks`") is open against the same router, asking for the
filter schema and the notification event union to be extensible. This is a
complementary ask, not a duplicate: #2569 is about what a stream can *carry*;
this issue is about the server ever being told what a stream *subscribed to*
in the first place. If #2569's filter schema opens up to extensions, the
hook proposed here should receive the whole honoured filter object, not just
a bare URI string, so a server can see whatever else a client attached to
the subscription request.

## Minimal reproduction

A server that should start a `setInterval` producing fake file-change events
only while at least one client is subscribed to a URI — and stop it when
nobody is — cannot do so today. There is nothing to hang the start/stop on:

```ts
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const server = new McpServer({ name: 'demo', version: '1.0.0' });

server.registerResource(
  'demo',
  new ResourceTemplate('demo://{id}', {
    list: undefined,
    // No such option exists today — this is the ask.
    // subscribe: (uri) => { intervals.set(uri, setInterval(() => server.server.sendResourceUpdated({ uri }), 1000)); },
    // unsubscribe: (uri) => { clearInterval(intervals.get(uri)); intervals.delete(uri); },
  }),
  async (uri) => ({ contents: [{ uri: uri.href, text: 'demo' }] }),
);

serveStdio(() => server);
// A client sends subscriptions/listen for demo://1 and gets acked — but
// nothing in this file ever learns that "demo://1" was requested, so the
// interval that would produce the update notifications for it never starts.
```

Today the only way to learn "demo://1" was requested is to stop using
`serveStdio`'s transport convenience and read the wire protocol directly, the
way filesystem-mcp does.

---

Filed as: (not yet filed)

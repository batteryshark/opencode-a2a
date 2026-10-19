# opencode-a2a

<p><a href="assets/workstack-mark-full.png"><img src="assets/workstack-mark.png" alt="Two comic birds carrying a letter" width="160"></a></p>

An OpenCode V2 server plugin for agents that need to message other sessions,
locally or on a configured peer server. Send a task to an existing session,
continue your work, and collect its answer through the sender's reply runtime.
You can also create a worker session when the user requests one and creation
is enabled for that server.

The plugin uses OpenCode's session API and adds four model-facing tools.
OpenChamber is a client for OpenCode; it can display the sessions and their
parent-child relationships. OpenChamber isn't required to send messages. This
project's `a2a` envelope is specific to this plugin and OpenCode's API; it
doesn't implement a general cross-harness A2A protocol or an MCP transport.

## Requirements and setup

Use an OpenCode V2 server with `ctx.tool.transform`, caller session context,
session prompt/synthetic methods, and the `/api/*` routes described below.
The source targets the OpenCode 2.0.23-era API. Compatibility with other
versions needs verification; the public V2 API is experimental.

There are no npm dependencies, compilation steps, or registry-install commands.
The package is source-only (`private: true`). For development checks, use
Node **20.3 or later**, including `fetch`, `AbortSignal.timeout` and
`AbortSignal.any`.

From the checked-out source root:

```sh
pwd
node --check server.js
node --check src/plugin.js
```

Use that source directory's absolute path in your OpenCode `opencode.json(c)`.
Merge this fictional example into your configuration, preserving other settings:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/workspace/opencode-a2a"]
}
```

The directory contains `server.js`, which exports the plugin. Load it on each
server whose agents will send messages. A receiving server only needs the
compatible OpenCode HTTP API; it doesn't need this plugin to answer a request.
Loading the plugin starts its reply runtime and may restore pending work.

For local-only messaging, put this fictional configuration in
`~/.config/opencode/a2a-peers.json`:

```json
{
  "self": { "name": "sender", "allowCreate": false },
  "peers": []
}
```

Ask the agent to call `a2a_list`, then send to an existing session using the ID
it returns. These examples show tool inputs; they aren't shell commands:

```json
{"to":"local/title:Reviewer","text":"Review the parser changes and summarize any risks."}
```

Continue other work or end the turn after sending. Don't poll `a2a_read` for
the answer. The receiver should answer normally; sending a new message back
can create an unnecessary loop. Automatic reply admission depends on the
sender's plugin running and both servers' APIs remaining reachable.

## Tools and addressing

All four tools register with `codemode: false` to request direct model-tool
visibility. A harness still controls which tools it presents to a model. If
Code Mode reports an unknown tool, use the direct tool interface.

| Tool | Input and behavior |
| --- | --- |
| `a2a_list` | Optional `server` and `search`. Without `server`, shows configured servers and up to 25 recent local sessions. With it, lists sessions there. Adds running markers when the active-session query succeeds. |
| `a2a_send` | `to`, `text`, optional `expectReply` (default `true`) and `delivery` (default `"steer"`). Admits a prompt and returns without waiting for the target's answer. Requires the calling session's `context.sessionID`. |
| `a2a_read` | `to`, optional `limit` (default 5, clamped to 1-30). Reads a compact transcript, marked as untrusted content. It fetches a bounded page of records. Full-history reads aren't supported. |
| `a2a_create` | Required `server`; optional `title`, `directory`, `agent`, `model`, `nest`. Creates a session without prompting it. `model` uses `providerID/modelID`. Titles are trimmed; an omitted title is left to OpenCode. |

`a2a_send` also accepts `create: {title?, directory?, agent?, model?, nest?}`.
Then `to` names the server (default `local`) and the tool creates and prompts
the session in one call. Creation can succeed even if the subsequent send
fails; the error identifies the created session. There is no goal-mode or
fork-session tool in this plugin.

Addresses accept `local/<sessionId>`, `<peer>/<sessionId>`, and
`<peer>/title:<search>`. Bare IDs and bare titles mean local. `local` is a
reserved alias for this server. A title lookup searches up to 20 candidates;
one exact match wins, otherwise exactly one search result is required. Use an
ID to resolve ambiguity. A slash only introduces a peer when its prefix is
configured (an unknown prefix followed by a session ID produces an error).

Tool results contain readable `content` and `metadata.a2a.ok`. Send results
include message and trace IDs and whether a reply is pending. The caller
identity comes from OpenCode's tool context, with `self.name` as the server
label. The model can't choose a different caller ID through the send input.
Envelope labels and metadata are not cryptographic identity proofs.

### Session creation and nesting

Creation is disabled by default. `self.allowCreate: true` permits local
creation; a remote peer's `allowCreate: true` permits creation there. This is
a sender-side policy check. It provides neither credential scoping nor a
filesystem sandbox. It doesn't restrict messaging existing sessions.

On `local`, a caller ID and `nest: true` (the default) produce a child with
`parentID` set to the caller. The child uses its parent's directory. An
explicit different directory disables nesting; `nest: false` creates a root
session. Root creation chooses the explicit directory, then the peer's
`defaultDirectory`, then the local caller's directory. Without one, it fails.

Remote sessions are always roots. Their directory must be explicit or supplied
by that peer's `defaultDirectory`. Creation records
`metadata.a2a = {createdBy, parent, nested}`; cross-server parent labels are
traceability metadata. Without caller context, standalone `a2a_create` can
create only a root and records an `unknown` caller label. `a2a_send` refuses
to run without caller context.

OpenCode owns child lifecycle and permissions. Its documented removal operation
recursively deletes children, and children inherit permission rules at creation.
Check your host version before relying on restart or child-resumption behavior.

## Peer configuration

This fictional two-server example uses a documentation-only address. Supply
your own reachable URL and credential source outside the repository:

```json
{
  "self": { "name": "sender", "allowCreate": false },
  "peers": [
    {
      "name": "review",
      "url": "https://review.example.invalid",
      "username": "opencode",
      "passwordEnv": "A2A_REVIEW_PASSWORD",
      "allowCreate": false,
      "defaultDirectory": "/workspace/review",
      "replyTimeoutSec": 1800
    }
  ]
}
```

Peer names allow letters, numbers, dots, underscores and hyphens (1-64
characters, beginning with a letter or number). URLs must be HTTP(S), without
embedded credentials. `passwordEnv` takes precedence over `passwordFile`;
an unset or empty environment variable falls back to the file if configured.
Files are trimmed when read. Basic-auth username defaults to `opencode`. With
neither password source, the client sends no Authorization header.

The peers file is re-read on lookup after the five-second cache expires.
`self.name` defaults to `A2A_SELF_NAME`, then the configured name, then the
short hostname. Set a deliberate name to avoid exposing a host label in
messages. Protect peer files, credential files and pending state from other
users; keep passwords out of source control.

| Environment variable | Default / purpose |
| --- | --- |
| `OPENCODE_CONFIG_DIR` | Plugin configuration root; otherwise `~/.config/opencode`. This plugin doesn't use `XDG_CONFIG_HOME` directly. |
| `A2A_PEERS_FILE` | `<config>/a2a-peers.json` |
| `A2A_STATE_DIR` | `<config>/a2a`, containing `pending.json` |
| `A2A_SELF_NAME` | Overrides `self.name` |
| `A2A_LOCAL_URL` | Overrides `self.url` for local HTTP discovery |
| `A2A_POLL_MS` | Reply safety sweep interval, default 15000 ms |
| `A2A_REPLY_TIMEOUT_SEC` | Overrides the target peer's `replyTimeoutSec`, default 1800 seconds |

### Local HTTP discovery

Session listing, message reads and reply checks use HTTP. The local adapter
tries the configured URL, a service registration for this process under
`$XDG_STATE_HOME/opencode` (default `~/.local/state/opencode`), and this
process's `--hostname`/`--port` arguments. If those fail, it runs `lsof` to find
this process's listening TCP ports and probes `/api/session`. Discovery can
therefore execute a subprocess and make requests even for local-only use.

Local credentials come from `self.passwordEnv`/`passwordFile`, the matching
service registration, or `OPENCODE_SERVER_PASSWORD`/`OPENCODE_PASSWORD`,
depending on the candidate. Username can come from `self.username`,
`OPENCODE_SERVER_USERNAME` or `OPENCODE_USERNAME` (default `opencode`).
If HTTP discovery fails, get/create/prompt/synthetic operations can fall back
to the in-process plugin context. Listing and message reads cannot. Events
prefer `ctx.event.subscribe` when available.

## Delivery and replies

`delivery: "steer"` asks OpenCode to admit the prompt at a running target's next
step. `"queue"` asks it to wait until the current turn ends; the send call itself
doesn't wait. `expectReply: false` sends without creating a reply subscription.
Neither mode waits for all work a target might delegate after its own turn.

The sender records a pending entry before prompting, then watches execution
events and performs periodic checks. It waits for the target to be inactive
and for a new `idle` record. It selects the newest assistant text in the
matching turn. With the sent message absent from the last 50 records, matching
falls back to the first completed turn after the saved idle boundary. Long
turns, concurrent prompts or queue reordering can make that association
ambiguous; this isn't a durable job/result protocol.

Replies arrive through a synthetic message requesting `delivery: "steer"` and
`resume: true`. Their `metadata.a2a` carries the trace, sender, `replyTo`, and
state: `completed`, `error`, `cancelled`, `blocked` or `timeout`. A blocked notice
is sent once while the final reply remains pending until the deadline. Replies
are clipped at 50,000 characters. Pending entries are capped at 200; adding
more drops the oldest entries.

The runtime persists pending entries and delivery IDs with atomic renames and
mode 0600. It restores them when the plugin is loaded again, with retry/backoff
for failed checks. It treats HTTP 409 as an already-admitted message and drops
delivery to a deleted parent. Persistence and `resume: true` don't guarantee
that a host will restart a session or deliver an answer after a crash, timeout,
lost state or API change.

The flow diagram uses fictional server labels:

```text
sender session                 receiver session
  a2a_send --------------------> POST /api/session/<id>/prompt
  returns: reply pending         runs a turn
  watcher <--------------------- execution event + idle record
  checks active state/messages
  POST local synthetic
  receives <a2a-reply>            no reverse connection required
```

## Trust boundary

An OpenCode server credential can grant broad control over shell execution,
files and sessions. Only configure peers you trust with that authority. Basic
auth encodes credentials; use HTTPS or a separately secured encrypted channel.
Keep servers on loopback or a restricted interface and enforce access at the
host and network boundary. `allowCreate` doesn't narrow what a stolen password
can do through the API.

Requests, replies and transcripts are framed as untrusted agent content.
That framing doesn't enforce model behavior. The receiving agent's tools and
permissions determine what it can execute. Peers can read session content and
cause model/provider usage; review the data and cost implications before use.
The client avoids printing its Authorization header, but server error bodies
can appear in tool errors, so don't assume errors or transcripts are safe to
publish.

Loop guards refuse self-sends, a return to the trace origin, and hop 5 or
higher. A per-process rate limiter allows 10 sends per minute per sender/target
pair. These are coordination safeguards; they aren't access control.

## Development and API limits

From the source root, Node's built-in test runner needs no installation:

```sh
node --test test/address.test.js test/envelope.test.js test/extract.test.js test/guards.test.js
```

These are pure helper tests. The remaining tests use synthetic credentials,
temporary filesystem fixtures and in-memory server doubles. `create.test.js`
imports tool definitions without calling plugin setup. For a full suite, review
the tests first and isolate HOME, config, state and temporary directories. Don't
load the plugin against your real sessions as a substitute for a unit check.

`src/client.js` implements its own HTTP/SSE client; it doesn't import an OpenCode
SDK package. It expects `/api/session`, `/active`, session `/message`, `/prompt`,
`/synthetic`, `/permission`, `/form`, and `/api/event`, including V2 `idle`
outcomes and execution events. It unwraps `data` responses but doesn't follow
pagination cursors. Check both plugin and HTTP contracts when upgrading.
Offline unit checks don't establish live host, authentication or model behavior.

See OpenCode's [V2 plugin guide](https://opencode.ai/v2/docs/build/plugins),
[API reference](https://opencode.ai/v2/docs/api), and
[OpenAPI specification](https://opencode.ai/v2/openapi.json). For a bug report,
provide a minimal synthetic reproduction and host version. Don't attach peer
files, passwords, pending stores or private transcripts.

Source map: `src/plugin.js` defines the tools; `local.js` and `client.js` reach
servers; `runtime.js` and `pending.js` collect replies; `address.js`,
`envelope.js`, `extract.js`, `guards.js` and `ids.js` handle the message helpers.

## License

Owned source and documentation are [MIT licensed](LICENSE). The included
AI-generated comic artwork is offered under MIT to the extent applicable;
no exclusive copyright in AI-generated elements is asserted. See
[RIGHTS.md](RIGHTS.md) for scope and third-party terms.

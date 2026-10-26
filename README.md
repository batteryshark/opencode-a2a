# opencode-a2a

<img src="assets/workstack-mark.png" alt="Two birds carrying a letter" width="160">

opencode-a2a lets OpenCode agents message other sessions locally or on configured peer servers. Send a request, continue working and receive the target's answer asynchronously. It also supports reading recent messages and optional session creation. This is an OpenCode-specific messaging plugin, not a general cross-harness A2A protocol.

## Requirements

- OpenCode V2 with compatible plugin-context and session APIs; the source targets the 2.0.23-era API.
- Node.js 20.3+ for source checks.
- Trusted, reachable OpenCode servers for remote peers.

There are no npm dependencies or build steps. OpenChamber is optional.

## Install

```sh
git clone https://github.com/batteryshark/opencode-a2a.git
cd opencode-a2a
node --check server.js
```

Add the checkout's absolute path to `plugins` in your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-a2a"]
}
```

Load the plugin on sending servers. Receiving servers need a compatible OpenCode API but do not need the plugin merely to answer.

## Quick start

Create `~/.config/opencode/a2a-peers.json` for local messaging:

```json
{"self":{"name":"local-agent","allowCreate":false},"peers":[]}
```

Ask your agent to call `a2a_list`, then use an existing session ID in `a2a_send`:

```json
{"to":"local/ses_example","text":"Review the parser and summarize any risks."}
```

The send returns immediately. Continue work or end the turn; the reply arrives automatically when available. The receiver answers normally. Do not poll `a2a_read` to wait for a reply.

## Configuration

`A2A_PEERS_FILE` overrides the peers path; `A2A_STATE_DIR` selects private pending-reply storage. `A2A_SELF_NAME` overrides the local label. Peers support `url`, `passwordEnv` or `passwordFile`, optional `defaultDirectory` and `allowCreate`. Creation is disabled by default.

Server credentials grant broad session access. Use trusted peers, HTTPS or another encrypted transport, and private credential files. See [peer configuration and delivery limits](docs/reference.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `a2a_list` | List peers or sessions |
| `a2a_send` | Send a prompt, optionally requesting an asynchronous reply |
| `a2a_read` | Read recent messages, not full history |
| `a2a_create` | Create a session where enabled |

Addresses accept `local/ID`, `peer/ID` or `peer/title:search`. Reply delivery depends on the sender plugin and both servers remaining reachable. It is not a durable job-result guarantee.

## Documentation and license

See the [reference](docs/reference.md) for addressing, nesting, authentication, reply handling and API limits. Source and documentation are [MIT licensed](LICENSE); artwork scope and outside terms are in [RIGHTS.md](RIGHTS.md).

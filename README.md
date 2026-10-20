# ignis-agent-gateway

Ignis server plugin that lets browser plugins run ACP (Agent Client Protocol)
coding agents as **server-side** child processes. Browsers cannot spawn
processes — this gateway spawns `opencode acp` (cwd pinned to the vault
directory) per transport instance and relays NDJSON ACP frames verbatim
between the child's stdio and the plugin WebSocket channel
`plugin:ignis-agent-gateway`.

The browser companion of this plugin is **Copilot for Ignis** — a fork of
[obsidian-copilot](https://github.com/logancyang/obsidian-copilot) (AGPL-3.0,
same license as Ignis) whose `AcpIgnisGatewayProcess` replaces the desktop
spawn with this gateway. It gives you Copilot's full Agent Chat UI in the
Ignis sidebar, with the agent running on the server.

## Wire protocol (channel `plugin:ignis-agent-gateway`)

```
client -> server  { channel, type: "acp-open",  channelId, vault, backend }
                  { channel, type: "acp-stdin", channelId, line }
                  { channel, type: "acp-close", channelId }
server -> client  { channel, type: "acp-open-ok", payload: { channelId, pid, backend } }
                  { channel, type: "acp-stdout", payload: { channelId, line } }
                  { channel, type: "acp-stderr", payload: { channelId, line } }
                  { channel, type: "acp-exit",   payload: { channelId, code, signal?, error? } }
server -> vault   { channel, type: "gateway-status", payload: { children: [...] } }
```

One child per channelId (one per Copilot `AcpBackendProcess`); frames are
relayed without interpretation, so ACP protocol evolution stays between the
agent and the client.

## Configuration

Agent spawn plans merge built-in defaults with
`<dataRoot>/plugins/ignis-agent-gateway/agents.json`:

```json
{
  "opencode": { "command": "opencode", "args": ["acp", "--print-logs"] }
}
```

Children inherit the server process environment, so **agent credentials are
configured on the server** (`opencode` login / provider keys), never in the
browser. `cwd` is always the vault directory; there is no flag to widen it.

`GET /api/ext/ignis-agent-gateway/status` lists running children.

## Behind a reverse proxy

Plugin data files (Copilot settings + chat history) grow past 1 MB, and
nginx rejects larger request bodies by default (`413 Request Entity Too
Large`), which surfaces as "change could not be saved after repeated
retries" in the Ignis status bar. Raise the limit for the Ignis location:

```nginx
client_max_body_size 64m;
```

The Ignis server itself accepts up to 50 MB per write (`maxBodyBytes`,
configurable 1-500 MB via server settings).

## Security

The agent is a coding agent: it can run arbitrary commands on the server,
scoped in practice by running with the vault as cwd. Single-user self-hosted
deployments accept this; harden later by running agents in a container
(the git-sync `Dockerfile.git` pattern) before ever exposing Ignis to more
people.

## Smoke test

From the ignis repo root:

```
node apps/ignis-server/server/plugins/ignis-agent-gateway/smoke-test.mjs
```

Boots a real server on a temp vault, drives the relay with a fake agent
(open → initialize → session/new → session/prompt → permission request →
close → exit), and — when `opencode` is on PATH — probes `opencode acp`
with a real initialize handshake. All checks passed 2026-10-16, including
the real-opencode probe.

## Note on shutdown

`opencode acp` does not exit on SIGTERM within the 3s grace; the relay
escalates to SIGKILL. Harmless, but expect `signal=SIGKILL` in exit events.

## Fork source

`obsidian-copilot-fork` (branch `ignis-gateway`), built with `npm run build`;
`main.js`/`styles.css` are copied into `obsidian/dist/copilot-ignis.js|.css`.
Upstream rebase is expected whenever Copilot moves; the Ignis-specific
surface is three files (`ignisRuntime.ts`, `AcpIgnisGatewayProcess.ts`,
and small guarded branches), so conflicts stay contained.

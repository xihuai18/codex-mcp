# codex-mcp

[![npm version](https://img.shields.io/npm/v/@leo000001/codex-mcp.svg)](https://www.npmjs.com/package/@leo000001/codex-mcp)
[![license](https://img.shields.io/npm/l/@leo000001/codex-mcp.svg)](https://github.com/xihuai18/codex-mcp/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/@leo000001/codex-mcp.svg)](https://nodejs.org)

MCP server that wraps [OpenAI Codex](https://github.com/openai/codex) `app-server` — start coding agents, poll their progress, and manage permissions from any MCP client.

## Features

- **4 tools, full capability** — `codex`, `codex_reply`, `codex_session`, `codex_check`
- **Async non-blocking** — sessions run in background, poll for results
- **Complete permission management** — three-layer model: approval policy, sandbox isolation, async approval arbitration
- **Zero config** — inherits your local `~/.codex/config.toml` automatically
- **Session management** — list, inspect, cancel, interrupt, fork sessions
- **Event streaming** — cursor-based pagination with pin-protected event buffer
- **Static read-only resources** — `codex-mcp:///server-info`, `codex-mcp:///config`, `codex-mcp:///gotchas`

## Prerequisites

- [Node.js](https://nodejs.org) >= 18
- [OpenAI Codex CLI](https://github.com/openai/codex) installed and configured (`codex` in PATH)

## Quick Start

### npx (no install)

```bash
npx @leo000001/codex-mcp
```

### Global install

```bash
npm install -g @leo000001/codex-mcp
codex-mcp
```

### Windows shell wrapper (if needed)

```powershell
pwsh -NoProfile -Command "npx -y @leo000001/codex-mcp"
```

### MCP Client Configuration

Add to your MCP client config (e.g. Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "codex": {
      "command": "npx",
      "args": ["-y", "@leo000001/codex-mcp"]
    }
  }
}
```

### OpenAI Codex CLI

```bash
codex mcp add codex-mcp -- npx -y @leo000001/codex-mcp
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.codex-mcp]
command = "npx"
args = ["-y", "@leo000001/codex-mcp"]
```

## STDIO Guard Modes

`codex-mcp` includes a startup preflight guard for stdout contamination risk.

- `CODEX_MCP_STDIO_MODE=auto` (default): run with warnings when risk is elevated
- `CODEX_MCP_STDIO_MODE=strict`: fail fast on blocking risks (e.g. TTY stdio), keep heuristic risks as warnings
- `CODEX_MCP_STDIO_MODE=off`: disable the preflight guard

Examples:

```bash
CODEX_MCP_STDIO_MODE=strict npx -y @leo000001/codex-mcp
```

```powershell
$env:CODEX_MCP_STDIO_MODE = "strict"; npx -y @leo000001/codex-mcp
```

## Tools

### `codex` — Start a new session

Start a Codex agent session asynchronously. Returns immediately with `sessionId`.

| Parameter        | Type   | Required | Description                                                                                                            |
| ---------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `prompt`         | string | Yes      | Task or question for the Codex agent                                                                                   |
| `approvalPolicy` | string | Yes      | Approval policy: `untrusted`, `on-failure`, `on-request`, `never` — caller must set based on its own permission level  |
| `sandbox`        | string | Yes      | Sandbox mode: `read-only`, `workspace-write`, `danger-full-access` — caller must set based on its own permission level |
| `effort`         | string | No       | Reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Default: `low`; increase/decrease based on task complexity |
| `cwd`            | string | No       | Working directory. Default: server cwd                                                                                 |
| `model`          | string | No       | Model override. Default: from `~/.codex/config.toml`                                                                   |
| `profile`        | string | No       | `config.toml` profile name (passed as `codex app-server -p`)                                                           |
| `advanced`       | object | No       | Low-frequency options (see below)                                                                                      |

<details>
<summary><code>advanced</code> object parameters (9 low-frequency parameters)</summary>

| Parameter                        | Type     | Description                                                                                     |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `advanced.baseInstructions`      | string   | Replace default instructions (thread-level)                                                     |
| `advanced.developerInstructions` | string   | Developer instructions (thread-level)                                                           |
| `advanced.personality`           | string   | Personality: `none`, `friendly`, `pragmatic` (default: from `~/.codex/config.toml`)             |
| `advanced.summary`               | string   | Reasoning summary: `auto`, `concise`, `detailed`, `none` (default: from `~/.codex/config.toml`) |
| `advanced.config`                | object   | Override `config.toml` values (passed as `codex app-server -c key=value`)                       |
| `advanced.ephemeral`             | boolean  | Don't persist thread. Default: `false`                                                          |
| `advanced.outputSchema`          | object   | JSON Schema for structured output                                                               |
| `advanced.images`                | string[] | Local image paths (adds `localImage` inputs)                                                    |
| `advanced.approvalTimeoutMs`     | number   | Auto-decline timeout (ms) for pending approvals. Default: `60000`                               |

</details>

**Returns:** `{ sessionId, threadId, status: "running" | "idle", pollInterval }`

```json
{
  "prompt": "Fix the failing tests in src/",
  "approvalPolicy": "on-request",
  "sandbox": "workspace-write",
  "effort": "high",
  "cwd": "/path/to/project",
  "model": "o4-mini"
}
```

### Resources

If your MCP client supports resources, this server exposes a few **read-only** resources:

- `codex-mcp:///server-info` (JSON): static server metadata (version/platform/runtime)
- `codex-mcp:///config` (Markdown): config mapping guide, including how to use `codex.advanced.config`
- `codex-mcp:///gotchas` (Markdown): practical limits/gotchas

### `codex_reply` — Continue a session

Send a follow-up message to an existing session.

| Parameter        | Type   | Required | Description                                                                     |
| ---------------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `sessionId`      | string | Yes      | Session ID from `codex`                                                         |
| `prompt`         | string | Yes      | Follow-up message                                                               |
| `model`          | string | No       | Override model for this turn                                                    |
| `approvalPolicy` | string | No       | Override approval policy                                                        |
| `effort`         | string | No       | Override reasoning effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `summary`        | string | No       | Override reasoning summary (`auto`, `concise`, `detailed`, `none`)              |
| `personality`    | string | No       | Override personality (`none`, `friendly`, `pragmatic`)                          |
| `sandbox`        | string | No       | Override sandbox (`read-only`, `workspace-write`, `danger-full-access`)         |
| `cwd`            | string | No       | Override working directory                                                      |
| `outputSchema`   | object | No       | JSON Schema for structured output                                               |

**Returns:** `{ sessionId, threadId, status: "running" | "idle", pollInterval }`

```json
{
  "sessionId": "sess_abc123",
  "prompt": "Now add error handling for the edge cases"
}
```

### `codex_session` — Manage sessions

List, inspect, cancel, interrupt, or fork sessions.

| Parameter          | Type    | Required                      | Description                                                            |
| ------------------ | ------- | ----------------------------- | ---------------------------------------------------------------------- |
| `action`           | string  | Yes                           | `"list"`, `"get"`, `"cancel"`, `"interrupt"`, or `"fork"`              |
| `sessionId`        | string  | For get/cancel/interrupt/fork | Target session ID                                                      |
| `includeSensitive` | boolean | No                            | Include `cwd`/`profile`/`config`/`threadId` in `get`. Default: `false` |

**Returns:**
- `action="list"` → `{ sessions: PublicSessionInfo[] }`
- `action="get"` → `PublicSessionInfo` (or `SensitiveSessionInfo` when `includeSensitive=true`)
- `action="cancel"|"interrupt"` → `{ success: true, message }`
- `action="fork"` → `{ sessionId, threadId, status: "idle", pollInterval }`

```json
{ "action": "list" }
{ "action": "get", "sessionId": "sess_abc123", "includeSensitive": true }
{ "action": "cancel", "sessionId": "sess_abc123" }
{ "action": "interrupt", "sessionId": "sess_abc123" }
{ "action": "fork", "sessionId": "sess_abc123" }
```

### `codex_check` — Poll events & respond

Query a running session for events, respond to approval requests, or answer user input.

| Parameter             | Type     | Required                          | Description                                                                                                                                                                                      |
| --------------------- | -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `action`              | string   | Yes                               | `"poll"`, `"respond_approval"`, or `"respond_user_input"`                                                                                                                                        |
| `sessionId`           | string   | Yes                               | Target session ID                                                                                                                                                                                |
| `cursor`              | number   | No                                | Event cursor for incremental polling (`action="poll"`). For `respond_*`, codex-mcp applies monotonic cursor progression: `max(cursor, sessionLastCursor)`.                                   |
| `maxEvents`           | number   | No                                | Keep this small. `poll` default: `1` (minimum `1`; increase only for catch-up). `respond_*` default: `0` (recommended; compact ACK, no event replay).                                           |
| `requestId`           | string   | For respond_approval/user_input   | Request ID from `actions[]`                                                                                                                                                                      |
| `decision`            | string   | For respond_approval              | For command approvals: `"accept"`, `"acceptForSession"`, `"acceptWithExecpolicyAmendment"`, `"decline"`, `"cancel"`; for file changes: `"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"` |
| `execpolicyAmendment` | string[] | For acceptWithExecpolicyAmendment | Exec policy amendment list (required when `decision="acceptWithExecpolicyAmendment"`)                                                                                                            |
| `denyMessage`         | string   | No                                | Internal note on deny (not sent to app-server)                                                                                                                                                   |
| `answers`             | object   | For respond_user_input            | For `respond_user_input`: `questionId -> { answers: string[] }`                                                                                                                                  |

**Returns (poll and respond_*):** `{ sessionId, status, pollInterval?, cursorResetTo?, events, nextCursor, actions?, result? }`

```json
{ "action": "poll", "sessionId": "sess_abc123", "cursor": 0 }
{
  "action": "respond_approval",
  "sessionId": "sess_abc123",
  "requestId": "req_xyz",
  "decision": "accept"
}
{
  "action": "respond_user_input",
  "sessionId": "sess_abc123",
  "requestId": "req_abc",
  "answers": { "question_id": { "answers": ["choice_1"] } }
}
```

## Event Polling Semantics

`codex_check(action="poll")` returns an append-only event stream with cursor pagination:

- `cursor`: the first event id you want (use the previous `nextCursor`)
- `nextCursor`: pass this back on the next poll
- `cursorResetTo`: when present, older events were evicted; restart from this cursor to avoid gaps
- `maxEvents`: max events returned per call
- If `cursor` is omitted, codex-mcp continues from that session's last consumed cursor.
- `respond_*` defaults to compact ACK (`events: []`, no cursor advance) unless you explicitly pass `maxEvents`.
- `poll` defaults to `maxEvents=1` to keep payloads small; increase temporarily (for example `10-20`) when you need to catch up faster.
- If `poll` is called with `maxEvents=0`, codex-mcp treats it as `1` to avoid no-op polling loops.
- For `respond_*`, prefer `maxEvents=0` instead of `1`: `0` keeps approval ACK minimal and avoids consuming/replaying stream events in the same call. Use `1-5` only when you explicitly need immediate events.
- For `poll`, keep windows small to reduce payload spikes and context pressure.

Event types include `output`, `progress`, `approval_request`, `approval_result`, `result`, `error`.
Approvals/results/errors are pinned to reduce eviction risk.

## Approvals & User Input

When the agent requests approval or user input, `poll` includes an `actions[]` list. Respond with:

- `respond_approval`: `decision` is one of `accept`, `acceptForSession`, `decline`, `cancel`.
  - For command approvals, `acceptWithExecpolicyAmendment` is supported and requires `execpolicyAmendment`.
- `respond_user_input`: send `answers` keyed by `questionId`.

Pending approvals auto-decline after `advanced.approvalTimeoutMs`.

## Session Lifecycle & Cleanup

Sessions auto-clean up in the background:

- `idle` > 30 minutes → cancelled
- `running`/`waiting_approval` > 4 hours → cancelled
- `cancelled`/`error` > 5 minutes → removed from memory

## Error Model

Tools return errors as:

```json
{ "content": [{ "type": "text", "text": "Error [CODE]: message" }], "isError": true }
```

Common codes include `INVALID_ARGUMENT`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, `SESSION_NOT_RUNNING`, `REQUEST_NOT_FOUND`, `CANCELLED`, `INTERNAL`.

## Client compatibility notes

- Tool responses follow `@modelcontextprotocol/sdk`'s `CallToolResult` contract: `content` (JSON text for wide compatibility), optional `structuredContent` (the canonical object), and `isError`. `structuredContent` is always object-shaped; when a tool returns a scalar/array, codex-mcp wraps it as `{ "value": ... }`. Claude Desktop and other clients tend to surface the `content` text directly, which shows the raw JSON blob, so they should fall back to `structuredContent` when they want typed data (Cursor already does this automatically whenever structured output is available).
- When an operation fails we set `isError: true` and return `Error [CODE]: message` in the `content` array instead of raising an MCP transport error. This keeps the STDIO channel healthy so Claude, Cursor, and other MCP clients stay connected even when a tool reports a problem.
- `codex-mcp` uses the MCP stdio transport (`src/index.ts`), so stdout is reserved for newline-delimited JSON and all diagnostics go to stderr. Anything else on stdout—including shell/profile banners (e.g., PowerShell's oh-my-posh warning) or CLI wrappers that print prompts—will break the MCP handshake for Claude/Cursor. Run `pwsh -NoProfile`, disable profile banners, or wrap the command so stdout stays quiet before piping it into the client.
- Windows command execution inside `codex app-server` may still inherit PowerShell profile side effects in some environments. This cannot be filtered by codex-mcp once emitted on stdout; if command turns are noisy or fail with profile errors, clean your PowerShell profile and prefer `approvalPolicy="on-failure"` / `"never"` to reduce approval churn.
- If Windows command output shows mojibake, enforce UTF-8 in the shell (`chcp 65001` and `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`).
- Startup guard behavior is controlled by `CODEX_MCP_STDIO_MODE` (`auto`/`strict`/`off`). Use `strict` in CI or hardened environments to fail fast on blocking contamination risks (while still surfacing heuristic risk warnings).
- Retryable transport/API interruptions are emitted as `progress` events with `data.method="codex-mcp/reconnect"` and `willRetry=true`, so clients can surface reconnect state without treating it as terminal failure.
- Approval/user-input flows rely on the `actions[]` array returned by `codex_check(action="poll")`. Claude and Cursor render approval buttons from this payload, so they need to poll at `pollInterval`, honour `cursorResetTo`, and reply within `approvalTimeoutMs` to avoid automatic declines.

## Typical Workflow

```
1. codex(prompt="Fix bug X")           → { sessionId, threadId, status: "running" }
2. codex_check(action="poll", ...)      → events[], status, actions[]
3. codex_check(action="respond_approval", decision="accept")  (if needed)
4. codex_check(action="poll", ...)      → result when status="idle"
5. codex_reply(prompt="Also add tests") → new turn starts
6. codex_check(action="poll", ...)      → poll until done
```

## Permission Model

Three layers of protection:

| Layer | Mechanism       | Options                                                    |
| ----- | --------------- | ---------------------------------------------------------- |
| 0     | Approval Policy | `never`, `on-failure`, `on-request`, `untrusted`           |
| 1     | Sandbox         | `read-only`, `workspace-write`, `danger-full-access`       |
| 2     | Async Approval  | Command execution + file change approval via `codex_check` |

## Architecture

> **Same-platform assumption**: codex-mcp assumes the MCP client and server run on the same machine. All communication uses stdio (local IPC), child processes share the local filesystem and `~/.codex/config.toml`, and `cwd` paths refer to the local filesystem.

```
MCP Client ←stdio→ codex-mcp server ←stdio→ codex app-server ←→ Codex Agent
         (same machine, stdio transport)
```

Each session spawns an independent `codex app-server` child process. The MCP server translates between MCP tool calls and the app-server's JSON-RPC protocol.

## Development

```bash
git clone https://github.com/xihuai18/codex-mcp.git
cd codex-mcp
npm install
npm run build
npm run typecheck
npm test
npm run check:stdio
npm run check:stdio:strict
```

End-to-end local test plan (after installing/configuring in an MCP client):
- Full guide (LLM operator handbook): `docs/E2E_LOCAL_TEST_PLAN.md`
- Quick English checklist: run `codex` → poll with `codex_check(action="poll")` → respond via `respond_approval`/`respond_user_input` if `actions[]` appears → continue polling until `status` is `idle`/`error`/`cancelled`.

## Project Policies

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)

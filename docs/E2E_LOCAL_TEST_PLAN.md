# codex-mcp E2E Local Test Plan (For Third-Party MCP Client LLMs)

This document is written for a large model running inside a third-party MCP client, where `@leo000001/codex-mcp` and `codex` CLI are already installed on the host machine.

Your goal is to verify that `codex-mcp` works correctly as an MCP server in real tasks, not to modify `codex-mcp` source code.

## 0. Executor Contract (Read First)

When you execute this plan as an LLM test operator:

1. Treat MCP tool responses as ground truth. Do not rely on UI guesswork.
2. For each step, record:
   - tool name
   - input params
   - output payload
   - session `status`
   - `nextCursor`
   - `actions[]` (if present)
3. If `actions[]` is non-empty, respond before timeout using `codex_check`.
4. Keep testing in an isolated project workspace, not inside production code.

## 1. What You Must Prove

Minimum pass target:

1. The server exposes 4 tools and up to 6 resources correctly (minimum 3: `server-info`, `config`, `gotchas`).
2. `codex` and `codex_reply` are asynchronous (return immediately, then progress via polling).
3. Approval flow works (`respond_permission`, or deprecated `respond_approval`) and session state changes correctly.
4. A real coding task closes the loop: test fails -> agent fixes -> test passes.
5. Session management works (`list/get/cancel/interrupt/fork`).

Optional but recommended:

1. Structured output via `outputSchema`.
2. User input response flow via `respond_user_input`.
3. Cursor and event-buffer edge behavior (`cursorResetTo`).

## 2. Preconditions

Required:

1. Node.js >= 18
2. `codex` in PATH (`codex --version` works)
3. `@leo000001/codex-mcp` launchable from host machine
4. Network available for model calls

Recommended:

1. Ensure server stdout is clean (no banner/noise on stdout).
2. Keep server logs on stderr only.
3. Validate model/auth availability with a lightweight `codex` session before approval-heavy tests (recommended pair: `approvalPolicy=on-request`, `sandbox=read-only`).

Windows-specific:

1. **CRITICAL: Clean your PowerShell profile before testing.** Use `pwsh -NoProfile` or temporarily rename/empty your `$PROFILE` file. If your profile loads modules like oh-my-posh or custom PSReadLine configurations, their stdout output leaks into **every** `codex app-server` command execution — not just the MCP handshake. In practice this means ~15 lines of noise per command turn, causing significant token waste and context window pollution. The agent will self-correct after failed commands, but the first round of commands (typically 3-4) will all fail, wasting substantial tokens before recovery. This is not a minor inconvenience — it is the single largest source of wasted tokens in Windows E2E testing.
2. Paths with parentheses (e.g., `C:\Program Files (x86)`) can cause shell parsing failures. Prefer paths without special characters for `cwd`. **Note:** This also affects codex internally — on many Windows installations, codex defaults to `C:\Program Files (x86)\PowerShell\7\pwsh.exe` as its shell, which itself contains parentheses. This is a known codex-side issue that users cannot work around via `cwd` alone. If you observe shell parsing errors unrelated to your workspace path, this may be the cause.
3. Codex defaults to PowerShell as the shell on Windows. If bash-style commands fail (e.g., `ls -la`), this is expected. The agent will self-correct, but expect the first 1-4 commands to fail before it adapts to PowerShell syntax. Budget extra tokens and polling rounds for this Windows-specific warm-up.

## 2.1 Start codex-mcp (Required Before TC0)

Use one of these launch modes in your MCP client configuration:

1. Recommended installed package path:

```bash
npx -y @leo000001/codex-mcp
```

2. If globally installed:

```bash
codex-mcp
```

3. If you are testing this repository checkout directly:

```bash
npm install
npm run build
node dist/index.js
```

Do not continue to TC0 until the MCP client can start the server command successfully.

Source-only verification (skip if you installed via npm/npx):

If you are testing from a local repository checkout (option 3 above), these scripts can verify stdout cleanliness before connecting an MCP client. They are **not available** when using the published npm package.

```bash
npm run check:stdio        # basic stdout cleanliness check
npm run check:stdio:strict # strict mode (fails on any stdout contamination)
npm run smoke:mcp          # lightweight MCP handshake smoke test
```

## 3. Capability Gate (5-Minute Smoke)

Before deep E2E, verify basics.

## 3.1 Tool Discovery

Run `tools/list` from your MCP client.

Expected tool names:

1. `codex`
2. `codex_reply`
3. `codex_session`
4. `codex_check`

## 3.2 Resource Discovery

Run `resources/list`, then read each resource that appears.

The server source code registers 6 resources:

1. `codex-mcp:///server-info` — JSON metadata (server version, platform, capabilities)
2. `codex-mcp:///compat-report` — JSON metadata (feature flags, compatibility warnings)
3. `codex-mcp:///config` — markdown (parameter guide and config.toml mapping)
4. `codex-mcp:///gotchas` — markdown (practical limits and common issues)
5. `codex-mcp:///quickstart` — markdown (minimal end-to-end workflow)
6. `codex-mcp:///errors` — markdown (error code reference and recovery hints)

Expected:

1. Verify the count returned by `resources/list`. If fewer than 6 appear, you may be running an older server build. Run `npm run build` (if testing from source) or update the package to ensure all resources are registered.
2. The minimum required set is: `server-info`, `config`, `gotchas` (these 3 have been present since early versions).
3. `compat-report`, `quickstart`, `errors` were added after the npm `0.1.0` release. To get all 6 resources, either build from source (`master` branch) or use `@leo000001/codex-mcp@>=0.2.0` when published. If missing, note the gap in your report but do not block on it — proceed to TC1.
4. JSON resources should parse cleanly; markdown resources should return non-empty text.

Stop and troubleshoot only if `resources/list` itself fails or returns 0 resources.

## 4. Build a Minimal Repro Workspace (No `e2e/` Dependency)

Because this plan targets third-party environments, use an inline reproducible project.

Choose the setup script that matches your **shell**, not your OS:

- **Bash** (Linux, macOS, Windows MINGW/Git Bash, WSL): use section 4.1
- **PowerShell** (Windows native `pwsh` or `powershell`): use section 4.2

> **Windows users**: If your MCP client runs in MINGW/Git Bash (e.g., Claude Code on Windows defaults to bash), use the Bash setup even though you are on Windows. Only use the PowerShell setup if you are explicitly running in a PowerShell terminal.

## 4.1 Bash Setup (Linux / macOS / Windows MINGW / WSL)

```bash
dst="$HOME/codex-mcp-e2e/mean-bug"
mkdir -p "$dst"

cat > "$dst/package.json" <<'EOF'
{
  "name": "mean-bug",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
EOF

cat > "$dst/math.js" <<'EOF'
export function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum / (arr.length + 1); // BUG: should divide by arr.length
}
EOF

cat > "$dst/math.test.js" <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { mean } from "./math.js";

test("mean of [1,2,3] should be 2", () => {
  assert.equal(mean([1, 2, 3]), 2);
});

test("mean of [5,5] should be 5", () => {
  assert.equal(mean([5, 5]), 5);
});
EOF

cd "$dst"
npm test
```

## 4.2 PowerShell Setup (Windows native pwsh)

> **Warning**: If your PowerShell profile loads modules like oh-my-posh or custom PSReadLine configurations, their stdout output will leak into every `codex app-server` command execution. This causes token waste and occasional command parsing failures. Run `pwsh -NoProfile` or clean your profile before testing.

```powershell
$dst = "D:\Lab\codex-mcp-e2e\mean-bug"
New-Item -ItemType Directory -Force -Path $dst | Out-Null

@'
{
  "name": "mean-bug",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
'@ | Set-Content -Path (Join-Path $dst "package.json") -Encoding UTF8

@'
export function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum / (arr.length + 1); // BUG: should divide by arr.length
}
'@ | Set-Content -Path (Join-Path $dst "math.js") -Encoding UTF8

@'
import test from "node:test";
import assert from "node:assert/strict";
import { mean } from "./math.js";

test("mean of [1,2,3] should be 2", () => {
  assert.equal(mean([1, 2, 3]), 2);
});

test("mean of [5,5] should be 5", () => {
  assert.equal(mean([5, 5]), 5);
});
'@ | Set-Content -Path (Join-Path $dst "math.test.js") -Encoding UTF8

Set-Location $dst
npm test
```

Expected initial state: tests fail.

Define a reusable workspace placeholder now and keep it consistent in all tool calls:

- `REPRO_CWD = <the absolute path you created above>`
- Examples:
  - PowerShell: `D:\Lab\codex-mcp-e2e\mean-bug`
  - Bash: `/home/<user>/codex-mcp-e2e/mean-bug`

Important:

1. Put an expanded absolute path in MCP JSON payloads.
2. Do not pass shell variables like `$HOME` literally as `cwd`.
3. On Windows (including MINGW/Git Bash clients), pass Windows-style paths in MCP payloads (for example `D:\\Lab\\...`), not `/d/Lab/...`.

## 5. Protocol Ground Rules You Must Follow

## 5.1 Required Inputs

When starting a session with `codex`, these are required:

1. `prompt`
2. `approvalPolicy`: `untrusted|on-failure|on-request|never`
3. `sandbox`: `read-only|workspace-write|danger-full-access`
4. `effort` is optional: `none|minimal|low|medium|high|xhigh` (default: `low`). For complex tasks, explicitly set `medium`/`high`/`xhigh`.

For `codex_reply`, required:

1. `sessionId`
2. `prompt`

## 5.2 Polling Rules

After `codex` or `codex_reply`:

1. Poll with `codex_check(action="poll")`.
2. Persist `nextCursor` and pass it back next poll.
3. If `cursorResetTo` appears, your cursor is stale. For the next request, always use the returned `nextCursor` (in no-event cases it is typically equal to `cursorResetTo`).
4. Terminal statuses are `idle`, `error`, `cancelled`.
5. `respond_permission` / `respond_user_input` may return compact ACK by default (`events` can be empty). Continue polling for streamed events.
6. `maxEvents` per action type:
   - `poll`: defaults to `1`. You can increase to `10-20` to fetch more accumulated events per call. Sending `0` is normalized to `1` to avoid no-op loops.
   - `respond_*`: defaults to `0` (compact ACK, no event replay). Use `1-5` only when you need immediate events alongside the approval response.
   - `maxEvents` is a top-level `codex_check` field, not inside `pollOptions`.
7. `responseMode` defaults to `minimal`. Available modes:
   - `minimal`: smallest payload, key fields only.
   - `delta_compact`: compact delta-focused payload (larger than `minimal`, smaller than `full` in typical streaming turns).
   - `full`: raw complete event payloads for debugging.
8. `pollOptions.includeEvents/includeActions/includeResult` default to `true`.
9. When `pollOptions.maxBytes` is set and payload is too large, response can include `truncated=true`, `truncatedFields`, and `compatWarnings`; continue polling with returned `nextCursor`.
10. `pollOptions.includeTools` is currently a reserved compatibility field; when set to `true`, codex-mcp typically returns a `compatWarnings` note instead of tool metadata (the warning can be omitted under strict `maxBytes` budget).
11. In `respond_*` flows, if a stale `cursor` is provided, codex-mcp can auto-normalize to session cursor and include a `compatWarnings` notice.

Observed internal polling cadence (codex-mcp → app-server, NOT MCP client → codex-mcp):

These values describe how often codex-mcp internally checks the app-server subprocess for new events. They are **not** recommendations for how often MCP clients should call `codex_check`.

1. `running`: codex-mcp checks app-server every ~3000ms internally.
2. `waiting_approval`: codex-mcp checks every ~1000ms internally.
3. During long reasoning phases, no new events for 30-60+ seconds can still be normal.

Recommended MCP client polling strategy:

Codex tasks often take 2-10+ minutes. Do not poll every turn.

1. When `status` is `running`: wait at least 2 minutes between polls (never less). Estimate task duration and increase to 3-10+ minutes for larger tasks.
2. When `status` is `waiting_approval`: target ~1 second polling to respond to `actions[]` and unblock quickly.
3. When `status` is `idle`, `error`, or `cancelled`: stop polling. The session is done.
4. The tool descriptions for `codex`, `codex_reply`, and `codex_check` include this guidance so LLM callers see it directly.

## 5.3 Approval Rules

When `actions[]` is present:

1. Approval actions use `respond_permission` (the MCP tool schema also accepts the deprecated alias `respond_approval` — both work identically). Use whichever your client's tool schema exposes; if both appear, prefer `respond_permission`.
2. User-input actions use `respond_user_input`.
3. Do not guess request IDs; always copy the exact `requestId`.

Auto-approval behavior by policy:

Not all commands trigger an approval request. The codex CLI applies its own safety classification before surfacing approvals to the MCP layer:

- `untrusted`: Read-only commands (e.g., `ls`, `cat`, `dir`, `type`) are typically auto-approved by codex internally and will **not** generate an `actions[]` entry. Commands with side effects (e.g., `npm test`, `node`, write operations) require explicit approval.
- `on-request`: Similar to `untrusted` but with a broader set of auto-approved commands. Most read operations pass through; write operations and unknown commands require approval.
- `on-failure`: Commands are auto-approved on first attempt; approval is only requested if a command fails.
- `never`: All commands are auto-approved. No `actions[]` will appear for command approvals (file-change approvals may still appear depending on sandbox mode).

If you expect an approval request but none appears, the command was likely auto-approved by codex's internal policy. This is normal behavior, not a bug.

Decision constraints:

1. Command approvals accept:
   - `accept`
   - `acceptForSession`
   - `acceptWithExecpolicyAmendment` (requires `execpolicyAmendment`)
   - `decline`
   - `cancel`
2. File-change approvals accept:
   - `accept`
   - `acceptForSession`
   - `decline`
   - `cancel`

## 6. Core E2E Test Matrix (Generic for Any MCP Client)

## TC0: Discovery & Basic Connectivity

Purpose:

1. Verify baseline server capabilities.

Steps:

1. Call `tools/list`.
2. Call `resources/list`.
3. Read each resource returned in section 3.2.

Pass criteria:

1. 4 tools present.
2. At least 3 resources present and readable (`server-info`, `config`, `gotchas`). Up to 6 if running latest build.
3. No transport-level JSON-RPC corruption.

## TC1: Async Start + Poll (Read-Only Path)

Tool call (`codex`) suggested payload:

```json
{
  "prompt": "Read this workspace and summarize its structure. You may run read-only inspection commands only. Do not edit files.",
  "approvalPolicy": "on-request",
  "sandbox": "read-only",
  "effort": "low",
  "cwd": "<REPRO_CWD>"
}
```

Then poll (wait at least 2 minutes after starting the session before first poll):

```json
{
  "action": "poll",
  "sessionId": "<sessionId>",
  "cursor": 0
}
```

Pass criteria:

1. Start call returns quickly with `sessionId`.
2. Poll returns incremental events and increasing cursor.
3. Final status reaches `idle` (or `error` with explicit reason).
4. If `actions[]` appears, respond and verify session can return from `waiting_approval` to `running`.

## TC2: Approval Flow (Command + File Change)

Tool call (`codex`) suggested payload:

```json
{
  "prompt": "Run npm test, fix the bug, rerun tests, then summarize changes.",
  "approvalPolicy": "untrusted",
  "sandbox": "workspace-write",
  "effort": "medium",
  "cwd": "<REPRO_CWD>"
}
```

Expected behavior:

1. `status` switches to `waiting_approval` when approvals arrive.
2. `actions[]` contains pending requests.
3. After `respond_permission`, request disappears and status returns to `running` when queue empties.

Pass criteria:

1. At least one approval request handled successfully.
2. No stuck state after valid response.

## TC3: Real Bug-Fix Closed Loop

TC3 is the acceptance criteria for the TC2 session, not an independent test step. Since TC2's prompt already includes "fix the bug, rerun tests, then summarize changes", TC3 validates the end-to-end outcome of that same session.

Continue polling and approving the TC2 session until it reaches `idle`.

Pass criteria:

1. `math.js` is corrected (`sum / arr.length`).
2. Tests pass after fix.
3. Final result includes a coherent change summary.

## TC4: Multi-turn Context (`codex_reply`)

After session reaches `idle`, call:

```json
{
  "sessionId": "<sessionId>",
  "prompt": "Add two boundary tests for mean() and keep all tests passing.",
  "effort": "low"
}
```

Pass criteria:

1. Reply returns immediately.
2. Subsequent polling shows new turn events.
3. Model uses existing context without re-explaining repository basics.

## TC5: Session Management (`codex_session`)

Validate:

1. `action="list"` returns active sessions.
2. `action="get"` returns details.
3. `action="cancel"` moves to `cancelled`.
4. `action="interrupt"` works only while active turn is running.
5. `action="fork"` creates a new session/thread branch.

Interrupt trigger strategy:

The `interrupt` action requires the session to be in `running` status, but MCP client polling latency makes the window narrow. To reliably test it:

1. Start a new session with a deliberately slow prompt and high effort to create a long `running` window:

```json
{
  "prompt": "Read every file in this workspace carefully, then write a detailed 500-word analysis of the code structure, patterns used, and potential improvements. Take your time.",
  "approvalPolicy": "never",
  "sandbox": "read-only",
  "effort": "high",
  "cwd": "<REPRO_CWD>"
}
```

2. Using `approvalPolicy="never"` avoids `waiting_approval` interruptions, keeping the session in `running` longer.
3. Poll once to confirm `status="running"`, then immediately call `codex_session(action="interrupt", sessionId=...)`.
4. Poll again to verify the session transitions to `idle` (interrupted turns end as `idle`).
5. If the session reaches `idle` before you can interrupt, the prompt was too simple — retry with a more complex prompt or higher effort.

Pass criteria:

1. State changes match action semantics.
2. No transport crash on management operations.
3. `interrupt` successfully stops a running turn (or is documented as missed due to timing).

## TC6 (Optional): Structured Output

`outputSchema` location differs by tool:

1. In `codex`, put it under `advanced.outputSchema`.
2. In `codex_reply`, put it at top-level `outputSchema`.

Schema example:

```json
{
  "type": "object",
  "properties": {
    "changedFiles": { "type": "array", "items": { "type": "string" } },
    "commandsRun": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  },
  "required": ["changedFiles", "summary"],
  "additionalProperties": false
}
```

`codex` example with required fields:

```json
{
  "prompt": "Summarize what changed and output structured fields.",
  "approvalPolicy": "on-request",
  "sandbox": "workspace-write",
  "effort": "low",
  "cwd": "<REPRO_CWD>",
  "advanced": {
    "outputSchema": {
      "type": "object",
      "properties": {
        "changedFiles": { "type": "array", "items": { "type": "string" } },
        "commandsRun": { "type": "array", "items": { "type": "string" } },
        "summary": { "type": "string" }
      },
      "required": ["changedFiles", "summary"],
      "additionalProperties": false
    }
  }
}
```

`codex_reply` example:

```json
{
  "sessionId": "<sessionId>",
  "prompt": "Return structured summary for the previous turn.",
  "outputSchema": {
    "type": "object",
    "properties": {
      "changedFiles": { "type": "array", "items": { "type": "string" } },
      "commandsRun": { "type": "array", "items": { "type": "string" } },
      "summary": { "type": "string" }
    },
    "required": ["changedFiles", "summary"],
    "additionalProperties": false
  }
}
```

Pass criteria:

1. Result includes structured output or JSON-compatible text matching schema shape.

## 7. Advanced/Edge Tests (Implementation-Aware)

## 7.1 Approval Timeout

Use short timeout:

```json
{
  "prompt": "Run npm test and fix.",
  "approvalPolicy": "untrusted",
  "sandbox": "workspace-write",
  "effort": "low",
  "cwd": "<REPRO_CWD>",
  "advanced": { "approvalTimeoutMs": 3000 }
}
```

When an approval action appears, intentionally do not respond for >3 seconds.

Expected:

1. Request auto-declines.
2. Event stream includes an `approval_result` with `timeout: true`.

## 7.2 Invalid Decision Contract

Negative checks:

1. Respond with wrong decision type for `fileChange` -> expect `Error [INVALID_ARGUMENT]`.
2. Use `acceptWithExecpolicyAmendment` without amendment -> expect `Error [INVALID_ARGUMENT]`.
3. Reuse resolved `requestId` -> expect `Error [REQUEST_NOT_FOUND]`.

## 7.3 Cursor Staleness (`cursorResetTo`)

Stress sequence:

1. Generate many events (long task with frequent output/progress).
2. Keep polling with old small cursor after buffer churn.

Expected:

1. `cursorResetTo` appears.
2. Client continues from returned `nextCursor` and proceeds safely (this may be equal to `cursorResetTo`).

## 7.4 Poll Shaping Compatibility (`responseMode` + `pollOptions`)

Checks:

1. Generate a delta-heavy turn, then poll at the same cursor with `responseMode="minimal"`, `responseMode="delta_compact"`, and `responseMode="full"`.
2. Compare payload sizes; for this workload, expect `minimal < delta_compact < full`.
3. Poll once with `pollOptions.includeEvents=false`, then poll again with defaults; verify events were not consumed by the first poll.
4. Poll with `pollOptions.includeTools=true`; usually expect `compatWarnings` mentioning unsupported `includeTools` behavior (warning may be omitted under tight `maxBytes` limits).
5. Optional stress: combine very small `pollOptions.maxBytes` with deprecated alias path (`respond_approval`) and verify responses remain valid even if some compatibility warnings are omitted to stay under byte budget.
6. Optional stale-cursor check for `respond_*`: send a smaller stale cursor than current session progress and verify response remains monotonic (no replay), with compatibility warning when warning budget allows.

## 8. Generic Troubleshooting

## Symptom: MCP handshake fails / invalid JSON

Likely cause:

1. Server stdout polluted by shell/profile/banner text.

Fix:

1. Ensure server prints logs to stderr only.
2. On Windows, avoid profile output (`pwsh -NoProfile` if needed).
3. Set `CODEX_MCP_STDIO_MODE=strict` during verification to fail fast on blocking contamination risk (heuristic risk is still surfaced as warning).

## Symptom: Session stuck in `waiting_approval`

Likely cause:

1. `actions[]` exists but no response sent.
2. Wrong `requestId` or wrong response action.

Fix:

1. Poll again, copy exact `requestId`.
2. Use `respond_permission` (or deprecated `respond_approval`) / `respond_user_input` with valid payload.

## Symptom: Unexpected permission behavior

Likely cause:

1. Mismatch between intended trust model and actual `approvalPolicy`/`sandbox`.

Fix:

1. Re-run with explicit policy pair:
   - safe read path with controllable approvals: `on-request + read-only`
   - pure dialogue path (no workspace commands expected): `never + read-only`
   - strict review path: `untrusted + workspace-write`

## Symptom: Excessive token waste on Windows (PowerShell profile noise)

Likely cause:

1. PowerShell profile (`$PROFILE`) loads modules (oh-my-posh, PSReadLine, etc.) that emit stdout on every shell invocation. Codex spawns a new PowerShell process for each command, so profile output repeats on every turn — typically ~15 lines of noise per command execution.

Mitigation (code-level):

Since v0.2.0, codex-mcp includes a built-in shell noise filter that strips known PowerShell profile noise patterns (oh-my-posh, PSReadLine, module warnings, etc.) from `COMMAND_OUTPUT_DELTA` events before they enter the event buffer. This significantly reduces token waste without user intervention. The filter can be disabled with `CODEX_MCP_DISABLE_NOISE_FILTER=1` if it incorrectly strips legitimate output.

Additional fix (recommended):

1. For best results, also clean your PowerShell profile: run `pwsh -NoProfile` or temporarily rename your `$PROFILE` file. The code-level filter catches common patterns but cannot eliminate all possible profile noise.
2. Alternatively, consider setting codex's shell to `cmd.exe` or a clean PowerShell installation path without profile loading.

## Symptom: Too many polling round-trips / slow session progress

Likely cause:

1. The LLM caller polls `codex_check` every turn instead of waiting between polls. Codex tasks commonly take multiple minutes; polling every few seconds wastes tool calls.

Fix:

1. The tool descriptions for `codex`, `codex_reply`, and `codex_check` now include explicit polling frequency guidance: for `running`, wait at least 2 minutes and increase interval based on estimated task duration; only poll promptly when `status` is `waiting_approval`.
2. If your LLM still polls too frequently, add a system prompt instruction: "When using codex_check, while status is running, wait at least 2 minutes between polls and extend further for complex tasks; only poll sooner for waiting_approval."

## 9. Test Report Template (Use This in Final Report)

```markdown
# codex-mcp E2E Report

- Client:
- Client version:
- Host OS:
- Server launch command:
- Test workspace path:

## TC Results
- TC0 Discovery:
- TC1 Async Poll:
- TC2 Approval:
- TC3 Bug Fix Loop:
- TC4 Reply Context:
- TC5 Session Management:
- TC6 Structured Output (optional):

## Key Telemetry
- Session IDs:
- Status transitions observed:
- Cursor handling (`nextCursor`/`cursorResetTo`):
- Approval actions handled (count/type):
- Errors encountered (exact `Error [CODE]`):

## Verdict
- Pass / Partial / Fail
- Blocking issues:
- Suggested fixes:
```

## 10. How to Discuss Key Points with Claude Code

If you are unsure about any critical behavior, discuss it with Claude Code explicitly with concrete payloads.

Recommended prompts:

1. `I got cursorResetTo=123 while polling session <id>. Show the exact next poll payload I should send and why.`
2. `For request kind=fileChange, which decisions are legal? Validate this payload before I send respond_permission (or deprecated respond_approval).`
3. `I used acceptWithExecpolicyAmendment and got INVALID_ARGUMENT. Diagnose which field is missing from my payload.`
4. `Given this poll output, determine if session is terminal and whether I should continue polling.`
5. `Convert this content text JSON into a normalized report table with status transitions and approval decisions.`

Keep all discussion grounded in actual tool responses (copy the exact JSON payloads).

## Appendix A: Claude Code (Optional Client-Specific Notes)

This appendix is optional and does not replace the generic flow above.

1. In Claude Code MCP settings, prefer launch commands that avoid shell stdout noise.
2. On Windows, if command resolution needs it, use `npx.cmd` instead of `npx`.
3. In MCP payloads, keep `cwd` as Windows path format (for example `D:\\Lab\\repo`) even if your shell prompt is `/d/Lab/repo`.
4. Recommended order:
   - validate stdout cleanliness
   - validate tools/resources
   - then run TC1 -> TC5 in order
5. If Claude UI shows mostly `content[0].text`, parse JSON text and cross-check `structuredContent` when available.

End of document.

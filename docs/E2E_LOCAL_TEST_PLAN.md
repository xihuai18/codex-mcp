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

1. The server exposes 4 tools and 3 resources correctly.
2. `codex` and `codex_reply` are asynchronous (return immediately, then progress via polling).
3. Approval flow works (`respond_approval`), and session state changes correctly.
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
3. Validate model/auth availability with a lightweight read-only `codex` session before approval-heavy tests.

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

If you can run scripts in this repository, these quick checks are useful:

```bash
npm run check:stdio
npm run smoke:mcp
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

Run `resources/list`, then read:

1. `codex-mcp:///server-info`
2. `codex-mcp:///config`
3. `codex-mcp:///gotchas`

Expected:

1. All 3 exist.
2. `server-info` returns JSON metadata.
3. `config` and `gotchas` return markdown text.

Stop and troubleshoot if this gate fails.

## 4. Build a Minimal Repro Workspace (No `e2e/` Dependency)

Because this plan targets third-party environments, use an inline reproducible project.

## 4.1 PowerShell Setup

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

## 4.2 Bash Setup

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

Expected initial state: tests fail.

Define a reusable workspace placeholder now and keep it consistent in all tool calls:

- `REPRO_CWD = <the absolute path you created above>`
- Examples:
  - PowerShell: `D:\Lab\codex-mcp-e2e\mean-bug`
  - Bash: `/home/<user>/codex-mcp-e2e/mean-bug`

Important:

1. Put an expanded absolute path in MCP JSON payloads.
2. Do not pass shell variables like `$HOME` literally as `cwd`.

## 5. Protocol Ground Rules You Must Follow

## 5.1 Required Inputs

When starting a session with `codex`, these are required:

1. `prompt`
2. `approvalPolicy`: `untrusted|on-failure|on-request|never`
3. `sandbox`: `read-only|workspace-write|danger-full-access`
4. `effort`: `none|minimal|low|medium|high|xhigh`

For `codex_reply`, required:

1. `sessionId`
2. `prompt`

## 5.2 Polling Rules

After `codex` or `codex_reply`:

1. Poll with `codex_check(action="poll")`.
2. Persist `nextCursor` and pass it back next poll.
3. If `cursorResetTo` appears, your cursor is stale; continue from `cursorResetTo`.
4. Terminal statuses are `idle`, `error`, `cancelled`.

Observed default polling cadence in implementation:

1. `running`: around 3000ms
2. `waiting_approval`: around 1000ms

## 5.3 Approval Rules

When `actions[]` is present:

1. Approval actions use `respond_approval`.
2. User-input actions use `respond_user_input`.
3. Do not guess request IDs; always copy the exact `requestId`.

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
3. Read the 3 resources in section 3.2.

Pass criteria:

1. 4 tools present.
2. 3 resources present and readable.
3. No transport-level JSON-RPC corruption.

## TC1: Async Start + Poll (No Approval Path)

Tool call (`codex`) suggested payload:

```json
{
  "prompt": "Read this workspace and summarize structure only. Do not run commands. Do not edit files.",
  "approvalPolicy": "never",
  "sandbox": "read-only",
  "effort": "low",
  "cwd": "<REPRO_CWD>"
}
```

Then poll:

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
3. After `respond_approval`, request disappears and status returns to `running` when queue empties.

Pass criteria:

1. At least one approval request handled successfully.
2. No stuck state after valid response.

## TC3: Real Bug-Fix Closed Loop

Use the same session as TC2, continue polling and approving as needed.

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

Pass criteria:

1. State changes match action semantics.
2. No transport crash on management operations.

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
  "approvalPolicy": "never",
  "sandbox": "read-only",
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
2. Client restarts from `cursorResetTo` and continues safely.

## 8. Generic Troubleshooting

## Symptom: MCP handshake fails / invalid JSON

Likely cause:

1. Server stdout polluted by shell/profile/banner text.

Fix:

1. Ensure server prints logs to stderr only.
2. On Windows, avoid profile output (`pwsh -NoProfile` if needed).

## Symptom: Session stuck in `waiting_approval`

Likely cause:

1. `actions[]` exists but no response sent.
2. Wrong `requestId` or wrong response action.

Fix:

1. Poll again, copy exact `requestId`.
2. Use `respond_approval` or `respond_user_input` with valid payload.

## Symptom: Unexpected permission behavior

Likely cause:

1. Mismatch between intended trust model and actual `approvalPolicy`/`sandbox`.

Fix:

1. Re-run with explicit policy pair:
   - safest read path: `never + read-only`
   - strict review path: `untrusted + workspace-write`

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
2. `For request kind=fileChange, which decisions are legal? Validate this payload before I send respond_approval.`
3. `I used acceptWithExecpolicyAmendment and got INVALID_ARGUMENT. Diagnose which field is missing from my payload.`
4. `Given this poll output, determine if session is terminal and whether I should continue polling.`
5. `Convert this content text JSON into a normalized report table with status transitions and approval decisions.`

Keep all discussion grounded in actual tool responses (copy the exact JSON payloads).

## Appendix A: Claude Code (Optional Client-Specific Notes)

This appendix is optional and does not replace the generic flow above.

1. In Claude Code MCP settings, prefer launch commands that avoid shell stdout noise.
2. On Windows, if command resolution needs it, use `npx.cmd` instead of `npx`.
3. Recommended order:
   - validate stdout cleanliness
   - validate tools/resources
   - then run TC1 -> TC5 in order
4. If Claude UI shows mostly `content[0].text`, parse JSON text and cross-check `structuredContent` when available.

End of document.

# Repo Agent Instructions (codex-mcp)

This repository is a TypeScript (ESM) MCP server that wraps the OpenAI Codex `app-server` JSON-RPC protocol. It spawns `codex app-server` child processes and exposes their capabilities as MCP tools.

## Document Boundary (AGENTS vs DESIGN)

- `AGENTS.md` is the **execution handbook** for contributors and coding agents.
- `docs/DESIGN.md` is the **architecture/protocol source of truth**, including the full dependency-upgrade playbook.
- To avoid drift and duplication, this file intentionally keeps architecture details brief and links to `docs/DESIGN.md` for full protocol semantics.

## Project Philosophy & Scope

本项目的核心设计理念：**利用用户本地 Codex 配置，用最少工具和最少配置，实现最大的 Codex app-server 能力暴露，同时保证无阻塞执行与完善权限管理。**

> **同平台假设**：MCP 客户端与 codex-mcp 服务端运行在同一台机器上，通过 stdio（本地 IPC）通信；子进程共享本地文件系统与 `~/.codex/config.toml`。本项目不支持跨机器远程部署。

### Minimum Tools Snapshot

| Tool            | Responsibility                                            | Blocking           |
| --------------- | --------------------------------------------------------- | ------------------ |
| `codex`         | start new session                                         | wait init only     |
| `codex_reply`   | continue session                                          | return immediately |
| `codex_session` | list/get/cancel/interrupt/fork/clean background terminals | sync               |
| `codex_check`   | poll events + respond to approvals/user input             | sync               |

## Upgrade Execution Entry

When updating interfaces, SDKs, or protocol behavior, follow the full handbook in:

- `docs/DESIGN.md` → **依赖接口与 SDK 升级手册（Single Source of Truth）**

### One-Shot Update Commands

For a single end-to-end update pass, run:

1. `codex --version`
2. `codex app-server generate-json-schema --experimental --out codex-schema`
3. `git diff --name-only -- codex-schema`
4. `git diff -- codex-schema/metadata.json`

If step 3 shows changes, continue with the full checklist in `docs/DESIGN.md` and sync docs/tests in the same PR.

### Codex CLI And Schema Maintenance Rules

- Codex CLI upgrades are protocol upgrades: `codex-mcp` spawns `codex app-server` and speaks its JSON-RPC wire format.
- Any time `codex --version` changes (including pre-releases), re-run the One-Shot Update Commands to detect protocol/schema drift.
- If `codex-schema/` has diffs, treat it as the source of truth and follow the full upgrade playbook in `docs/DESIGN.md`.
- If there are no diffs, record the run (date + codex version + result) in `docs/DESIGN.md` so the repo stays auditable.

### Maintenance Runbook (Step-by-step)

This section is a practical execution checklist.
`docs/DESIGN.md` remains the source of truth for protocol semantics and compatibility policy.

1. Environment baseline
   - `node -v` and `npm -v`
   - `codex --version`
2. Update Codex CLI (target version)
   - Pick an explicit version for reproducibility (recommended), or use `@latest` only when intentionally upgrading.
   - Example (pinned): `npm install -g @openai/codex@0.106.0`
   - Example (moving): `npm install -g @openai/codex@latest`
   - Verify: `codex --version`
3. App-server schema baseline (Codex protocol)
   - Regenerate vendored schema: `codex app-server generate-json-schema --experimental --out codex-schema`
   - Inspect drift:
     - `git diff --name-only -- codex-schema`
     - `git diff -- codex-schema/metadata.json`
   - Decision gate:
     - If there are diffs: treat `codex-schema/` as the truth and follow the full upgrade playbook in `docs/DESIGN.md`.
     - If there are no diffs: update the "最近一次执行记录" in `docs/DESIGN.md` (date + codex version + result).
4. NPM dependency update check
   - Direct deps/devDeps: `npm outdated`
   - Full tree (incl. transitive): `npm outdated --all`
   - If applying updates, prefer staying within current semver ranges unless a major bump is explicitly planned.
5. Verification (required before merging interface/protocol changes)
   - `npm run typecheck && npm test && npm run build`
6. Closure
   - Ensure docs/tests are updated when protocol/schema changes.
   - Do not commit generated build output (`dist/`) or secrets.

### Upgrade Gate (Execution View)

- Use `docs/DESIGN.md` as the only full protocol/compatibility spec; do not duplicate detailed rules here.
- Before merging an interface update, complete the DESIGN checklist sections for diff analysis, implementation sync, and docs/tests closure.
- Enforce strict compatibility policy: do not introduce compatibility behavior outside the DESIGN whitelist.
- Run `npm run typecheck && npm test && npm run build` in the same change.

## Prerequisites

- Node.js >= 18
- `codex` CLI installed and available in PATH
- Verify with `codex --version`

## Quick Commands

- Install deps: `npm install`
- Build: `npm run build`
- Dev watch: `npm run dev`
- Start server: `npm start`
- Typecheck: `npm run typecheck`
- Test: `npm test`

## Project Layout

```
src/
├── index.ts
├── server.ts
├── types.ts
├── app-server/
│   ├── client.ts
│   ├── protocol.ts
│   └── lifecycle.ts
├── session/
│   └── manager.ts
├── tools/
│   ├── codex.ts
│   ├── codex-reply.ts
│   ├── codex-session.ts
│   └── codex-check.ts
└── resources/
    └── register-resources.ts
```

## Architecture Snapshot (Execution Context)

- Single MCP stdio server, per-session `codex app-server` subprocess.
- `codex` / `codex_reply` are non-blocking: they return early and rely on `codex_check(action="poll")`.
- Event buffering uses cursor pagination with pinning for critical events.
- Approval flow is asynchronous: app-server request -> buffered action -> client response via `codex_check`.
- Full protocol behavior, event mapping, and lifecycle diagrams live in `docs/DESIGN.md`.

## Code Style & Conventions

- ESM + TypeScript (`"type": "module"`).
- Local imports use `.js` suffix.
- Prefer `unknown` + narrowing over `any`.
- Keep validation in Zod schemas (`src/server.ts`).
- Keep tool responses MCP-safe: `{ content, structuredContent?, isError }`.
- Log with `console.error` only; do not write logs to stdout (reserved for MCP stdio).

## Security Defaults

- Preserve the "minimum tools, maximum capability" principle.
- `approvalPolicy` and `sandbox` are required in `codex`.
- Sensitive fields remain redacted by default; require explicit `includeSensitive=true`.
- Never expose environment variables in public session output.

## Key Implementation Patterns

These patterns are non-negotiable guardrails:

- Register app-server handlers before `client.start()` to avoid unhandled `error` event crashes.
- Wrap approval-timeout callbacks (`respondToServer`) in try-catch; client may already be destroyed.
- Keep `cancelSession` idempotent for already-cancelled sessions.
- On `TURN_COMPLETED`, capture `activeTurnId` before clearing it, or `lastResult.turnId` becomes empty.
- If `replyToSession` fails during `turnStart`, restore session state to `error`.
- Serialize `-c key=value` config values consistently: primitives via `String()`, objects/arrays via `JSON.stringify()`.
- Call `.unref()` on cleanup/shutdown/force-kill timers to avoid blocking Node.js exit.

## Testing Expectations

- Add or update Vitest coverage for schema validation, session behavior, and error handling.
- Keep tests deterministic and avoid real network calls.
- Mock `codex app-server` subprocess communication.
- Follow `describe/it` structure with fresh `SessionManager` in `beforeEach` and `manager.destroy()` in `afterEach`.

## Git / PR Workflow

- Branch names: `feat/<name>`, `fix/<name>`, `refactor/<name>`.
- Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Run `npm run build && npm test` before opening PR.
- Do not commit generated or sensitive artifacts (`dist/`, `node_modules/`, `.env`).

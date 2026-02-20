# Repo Agent Instructions (codex-mcp)

This repository is a TypeScript (ESM) MCP server that wraps the OpenAI Codex `app-server` JSON-RPC protocol. It spawns `codex app-server` child processes and exposes their capabilities as MCP tools.

## Project Philosophy & Design Goals

本项目的核心设计理念可以概括为：**利用用户本地 Codex 配置，用最少工具和最少配置，实现最大的 Codex app-server 能力暴露，同时保证完全无阻塞和完善的权限管理。**

> **同平台假设**：本项目假设 MCP 客户端和 codex-mcp 服务端运行在同一台机器上。所有通信使用 stdio（本地 IPC），子进程共享本地文件系统和 `~/.codex/config.toml`，`cwd` 路径指向本地文件系统。不支持跨机器远程部署。

### 1. 利用用户本地 Codex 配置（Zero-Config Local Integration）

与从零开始配置不同，本 MCP server 充分利用 Codex 原生配置机制：

- **`codex app-server` 原生加载 `~/.codex/config.toml`**：所有本地配置（模型、审批策略、沙箱模式等）自动生效
- **Profile 选择**：通过 `profile` 参数（对应 `-p` 标志）切换不同配置档案
- **工具参数覆盖**：工具参数通过 `-c` 标志覆盖 config.toml 中的值，实现按需定制
- **环境变量继承**：子进程继承父进程环境变量，无需重复配置

这意味着用户在本地 Codex CLI 中的所有配置都会被 MCP server 自动继承，实现真正的零配置启动。

### 2. 最少工具（Minimum Tools）

仅暴露 **4 个 MCP 工具**，覆盖完整的 agent 生命周期：

| 工具             | 职责                                          | 阻塞？               |
| ---------------- | --------------------------------------------- | -------------------- |
| `codex`          | 启动新 session                                | 仅等 init（~几百ms） |
| `codex_reply`    | 继续已有 session                              | 立即返回             |
| `codex_session`  | 管理 session（list/get/cancel/interrupt/fork/clean_background_terminals） | 同步                 |
| `codex_check`    | 轮询事件 + 处理审批/用户输入请求（poll/respond_permission/respond_user_input） | 同步                 |

不暴露额外的配置工具、不暴露内部工具代理、不暴露 prompts；保留 6 个静态只读 resources（`server-info`/`compat-report`/`config`/`gotchas`/`quickstart`/`errors`）用于文档与元信息。核心能力仍通过这 4 个工具的参数组合实现。

### 3. 最少配置（Minimum Configuration）

`codex` 的 `prompt`、`approvalPolicy`、`sandbox` 为必填参数；`effort` 默认为 `low`（但调用方应根据任务复杂度主动调整）。其余高频参数（`cwd`, `model`, `profile`）保留在顶层，低频参数折叠到 `advanced` 对象中：

- **审批策略**：必填，调用方根据自身权限选择（`untrusted`, `on-failure`, `on-request`, `never`）
- **沙箱模式**：必填，调用方根据自身权限选择（`read-only`, `workspace-write`, `danger-full-access`）
- **推理力度**：默认 `low`，建议根据任务复杂度调整（`none` ~ `xhigh`）
- **工作目录**：默认为 server 进程的 cwd
- **模型**：默认使用 config.toml 中配置的模型

调用方至少需要 `{ prompt: "Fix the bug", approvalPolicy: "on-request", sandbox: "workspace-write" }` 才能启动 Codex agent。复杂任务建议显式传 `effort: "medium" | "high" | "xhigh"`。

### 4. 最大能力暴露（Maximum Capability）

本项目基于 `codex app-server` 完整 JSON-RPC 协议（VSCode 扩展使用的底层协议），暴露其全部能力：

- **命令执行审批**：5 种决策（accept / acceptForSession / acceptWithExecpolicyAmendment / decline / cancel）
- **文件变更审批**：4 种决策（accept / acceptForSession / decline / cancel）
- **线程管理**：start / resume / fork
- **轮次管理**：start / interrupt
- **结构化输出**：支持 JSON Schema 约束输出格式
- **图片附件**：支持图片输入
- **丰富的流式事件**：AgentMessageDelta, ReasoningDelta, CommandOutputDelta 等

### 5. 完全无阻塞（Non-Blocking Async Execution）

传统 MCP 工具调用是同步阻塞的 — 调用方必须等待整个 agent 执行完毕才能收到响应。本项目通过异步架构彻底解决了这个问题：

- **启动即返回**：`codex` 和 `codex_reply` 启动后台子进程后立即返回 `{ sessionId, threadId, status: "running", pollInterval }`，不阻塞调用方
- **后台执行**：`codex app-server` 子进程在后台处理 agent 执行，通过 stdio JSON-RPC 通信
- **轮询获取**：调用方通过 `codex_check` 的 `action="poll"` 增量获取事件（cursor 分页），直到 status 变为 `idle`/`error`/`cancelled`
- **事件缓冲**：`EventBuffer` 使用 cursor 分页 + pin 策略（关键事件如审批请求/结果/错误不被淘汰），默认 maxSize=1000，hardMaxSize=2000

### 6. 完善的权限管理（Complete Permission Management）

本项目实现了三层权限防护 + 异步审批裁决流程：

**第零层 — 审批策略（`approvalPolicy` 参数）**：
- `never`：所有操作自动批准
- `on-failure`：失败时才请求审批
- `on-request`：需要时请求审批（默认）
- `untrusted`：所有操作都需审批

**第一层 — 沙箱隔离（`sandbox` 参数）**：
- `read-only`：只读访问
- `workspace-write`：工作区写入（默认）
- `danger-full-access`：完全访问

**第二层 — 异步审批裁决**：
- app-server 发送审批请求 → codex-mcp 缓冲 → 客户端通过 `codex_check` 发现待审批项 → 通过 `codex_check` 响应审批决策 → codex-mcp 转发回 app-server

**审批决策类型**：
- 命令执行：`accept` / `acceptForSession` / `acceptWithExecpolicyAmendment` / `decline` / `cancel`
- 文件变更：`accept` / `acceptForSession` / `decline` / `cancel`

**客户端权限配置提醒**：MCP 客户端应根据自身安全策略配置 `approvalPolicy` 和 `sandbox`。

### 7. 接口对齐与升级规范（本次约定）

- **权威来源优先级**：以 `codex app-server` 协议定义与 `codex-schema/` 为准；实现代码与文档必须追随协议。`CHANGELOG` 仅作辅助，不可替代接口对比。
- **参数同名策略（严格）**：MCP 对外参数名必须与所依赖接口字段名一致。上游是 `snake_case` 就保持 `snake_case`；上游是 `camelCase` 就保持 `camelCase`。
- **无兼容别名策略**：默认不保留旧参数别名（例如旧 camelCase 到新 snake_case 的双写兼容）。若必须兼容，需明确标注生命周期与移除计划。
- **Schema 更新策略**：`codex-schema` 可直接按最新 CLI 生成并提交，差异必须体现在 `git diff` 中；生成后需同步校验 `codex-schema/metadata.json`，作为协议基线的一部分。
- **变更闭环要求**：任何接口字段调整都必须同步到 `src/server.ts`（schema）、tool handler、`SessionManager`、类型定义、README、DESIGN、AGENTS、CHANGELOG、`docs/E2E_LOCAL_TEST_PLAN.md` 与相关测试。
- **审查方式**：优先并行多智能体探索关键路径；合并前建议做一次独立交叉验证（可通过 `claude-code-mcp` 进行二次审查）。

## Prerequisites

- **Node.js >= 18**
- **`codex` CLI**：需要安装 OpenAI Codex CLI（`npm install -g @openai/codex` 或从 [github.com/openai/codex](https://github.com/openai/codex) 获取）。`codex app-server` 子命令是本项目的核心后端。
- 确保 `codex` 在 PATH 中可用（运行 `codex --version` 验证）

## Quick Commands

- Install deps: `npm install`
- Build: `npm run build` (tsup)
- Dev watch: `npm run dev`
- Start server: `npm start`
- Typecheck: `npm run typecheck`
- Test: `npm test` (Vitest)
- Runtime: Node.js >= 18

## Project Layout

```
src/
├── index.ts              # 入口：stdio transport, 优雅关闭
├── server.ts             # MCP server：工具注册, Zod schemas
├── types.ts              # 共享类型、常量、枚举
├── app-server/
│   ├── client.ts         # app-server JSON-RPC 客户端（管理子进程）
│   ├── protocol.ts       # 协议类型定义
│   └── lifecycle.ts      # 子进程生命周期管理
├── session/
│   └── manager.ts        # SessionManager：会话生命周期、事件缓冲、审批管理
├── tools/
│   ├── codex.ts          # codex 工具（启动会话）
│   ├── codex-reply.ts    # codex_reply 工具（继续会话）
│   ├── codex-session.ts  # codex_session 工具（管理会话）
│   └── codex-check.ts    # codex_check 工具（轮询 + 审批）
└── utils/
    └── config.ts         # 配置辅助
tests/                            # 现有 Vitest 测试（持续扩展）
├── session-manager.test.ts
├── app-server-client.test.ts
├── codex.test.ts
├── codex-session.test.ts
├── lifecycle.test.ts
└── ...
```

## Key Dependencies

- **`@modelcontextprotocol/sdk`** — MCP 协议实现（`McpServer`, `StdioServerTransport`）
- **`zod`** — 输入验证
- **无需 `@openai/codex-sdk`** — 直接使用 `codex app-server` 子进程，通过 stdio JSON-RPC 通信

## Architecture

- **4 MCP tools**: `codex`, `codex_reply`, `codex_session`, `codex_check` — 全部注册在 `src/server.ts`
- **后端**：`codex app-server` 子进程（stdio transport），每个会话独立子进程
- **异步执行**：`codex` 和 `codex_reply` 启动后台子进程后立即返回 `{ sessionId, threadId, status: "running", pollInterval }`。使用 `codex_check` 轮询事件和获取最终结果
- **事件缓冲**：`EventBuffer` 使用 cursor 分页 + pin 策略（关键事件不被淘汰），默认 maxSize=1000, hardMaxSize=2000
- **会话生命周期**：`running` ↔ `waiting_approval` → `idle` | `error` | `cancelled`
- **审批流程**：app-server 发送审批请求 → codex-mcp 缓冲 → 客户端通过 `codex_check` 响应 → codex-mcp 转发回 app-server
- **配置**：`codex app-server` 原生加载 `~/.codex/config.toml`，工具参数通过 `-c` 标志覆盖
- **优雅关闭**：`index.ts` 注册 SIGINT/SIGTERM 处理器，终止所有 app-server 子进程
- **会话清理**：SessionManager 定期清理过期会话（idle 超过 30 分钟、running 超过 4 小时自动清理；cancelled/error 状态 5 分钟后清理）
- **日志**：使用 `console.error` — stdout 保留给 MCP stdio 通信
- **工具响应模式**：`{ content: [{ type: "text", text }], isError }` — 工具处理器捕获所有错误返回结构化响应，不抛出异常

## Types Pattern (`src/types.ts`)

- 共享常量使用 `as const` 元组（`APPROVAL_POLICIES`, `SANDBOX_MODES` 等），Zod schemas 和 TypeScript 类型从同一来源派生
- `ErrorCode` 枚举用于结构化错误消息：`Error [CODE]: message`
- 会话信息分层：`SessionInfo`（内部完整）、`PublicSessionInfo`（脱敏，默认返回）

## Code Style & Conventions

- **ESM + TS**：保持 `"type": "module"` 语义
- **Import paths**：本地导入使用 `.js` 扩展名（保持此模式不变）
- **Types**：优先 `unknown` + 类型收窄，避免 `any`
- **Schemas**：Zod 验证，schema 定义在 `src/server.ts`
- **Errors**：使用 `ErrorCode`，工具处理器捕获所有错误返回结构化响应 — 不抛出异常
- **Logging**：使用 `console.error`（stdout 保留给 MCP stdio 通信）
- **Tool response**：`{ content: [{ type: "text", text }], isError }` 模式
- **Exports**：遵循现有模式（命名导出；工具导出 `*Params` 类型和 `execute*` 函数）

## Security / Defaults

- 保持"最少工具，最大能力"原则（不添加额外 MCP 工具，除非必要）
- `approvalPolicy`、`sandbox` 为必填参数；`effort` 默认为 `low`，但调用方应根据任务复杂度显式调整
- 敏感信息（cwd, config）默认脱敏，使用 `includeSensitive=true` 查看完整信息
- 环境变量不暴露在公开会话信息中

## Key Implementation Patterns

以下模式经过多轮审查确立，修改时务必遵守：

- **Handler 注册顺序**：`registerHandlers()` 必须在 `client.start()` 之前调用。`AppServerClient` 继承 `EventEmitter`，未监听的 `"error"` 事件会导致进程崩溃。提前注册确保 spawn 错误被正确捕获。
- **超时回调中的 try-catch**：审批超时回调中的 `client.respondToServer()` 必须用 try-catch 包裹，因为 client 可能在超时触发前已被销毁。
- **cancelSession 幂等性**：对已取消的会话调用 `cancelSession` 应直接 return，避免重复推送错误事件。
- **TURN_COMPLETED 中的 turnId 保存**：必须先保存 `activeTurnId` 到局部变量，再清除为 `undefined`，否则 `lastResult.turnId` 永远为空字符串。
- **replyToSession 错误恢复**：`turnStart` 失败时必须将 session 状态恢复为 `error`（而非留在 `running`），并推送错误事件。
- **Config 值序列化**：`lifecycle.ts` 中 `-c key=value` 的值序列化：原始类型用 `String()`，对象/数组用 `JSON.stringify()`，与顶层参数（model, approvalPolicy 等）的处理保持一致。
- **Timer unref**：所有 `setInterval`/`setTimeout`（cleanup timer, shutdown timer, destroy 中的 force-kill timer）必须调用 `.unref()`，防止阻塞 Node.js 进程退出。

## Testing Expectations

- 在 `tests/` 中添加/调整 Vitest 测试，特别是工具参数验证、会话行为和错误处理
- 测试文件遵循 `<module-name>.test.ts` 命名约定
- 保持测试确定性，避免网络调用
- Mock `codex app-server` 子进程通信（避免真实子进程调用）
- 测试结构：`describe/it` 块，`beforeEach` 创建新的 `SessionManager`，`afterEach` 调用 `manager.destroy()`

## Git / PR Workflow

- 分支命名：`feat/<name>`, `fix/<name>`, `refactor/<name>`
- Commit message：使用 Conventional Commits（`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`）
- PR 前确保 `npm run build && npm test` 通过
- 不提交 `dist/`、`node_modules/`、`.env` 等生成/敏感文件

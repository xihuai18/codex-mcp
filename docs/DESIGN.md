# codex-mcp 设计文档

> English quick summary: `codex-mcp` is an MCP stdio server that exposes Codex `app-server` via 4 tools (`codex`, `codex_reply`, `codex_session`, `codex_check`) plus 6 read-only resources. Each session runs in an independent `codex app-server` subprocess and is polled asynchronously with cursor-based events.

## 概述
MCP server，基于 OpenAI Codex app-server JSON-RPC 协议，通过 4 个 MCP 工具和 6 个静态只读 Resources 暴露 Codex agent 能力。

## 接口对齐与升级规范（本次约定）

- 以 `codex app-server` 协议与 `codex-schema/` 为接口真值来源；实现与文档必须对齐该来源。
- 对依赖接口升级时，先阅读仓库内现有文档，再对照协议/类型定义逐项核对；`CHANGELOG` 只能辅助定位，不作为唯一依据。
- MCP 对外参数名与上游字段名保持严格同名：`snake_case` 不改成 `camelCase`，`camelCase` 不改成 `snake_case`。
- 默认不保留旧参数别名兼容层；采用“同名切换 + 文档/测试同步更新”的方式落地变更。
- `codex-schema` 可直接更新并提交；差异应在 `git diff` 中清晰可审计，并同步校验 `codex-schema/metadata.json`。
- 接口变更需要同步更新：工具输入 schema、handler、SessionManager、类型定义、README、AGENTS、CHANGELOG、E2E 测试计划与单元测试。
- 建议使用多智能体并行探索，并在收尾阶段进行一次独立交叉验证，降低漏改风险。

## 系统架构

> **同平台假设**：本项目假设 MCP 客户端和 codex-mcp 服务端运行在同一台机器上。所有通信使用 stdio（本地 IPC），子进程共享本地文件系统和 `~/.codex/config.toml`，`cwd` 路径指向本地文件系统。

```
MCP Client (Claude/Kiro/etc.)
    │
    │ MCP Protocol (stdio, same machine)
    ▼
codex-mcp server (Node.js)
    │
    │ JSON-RPC (stdio, per-session subprocess)
    ▼
codex app-server (Rust binary)
    │
    │ OpenAI Responses API
    ▼
Codex Agent (cloud)
```

### 为什么选择 app-server 而非 TypeScript SDK

| 维度 | TypeScript SDK (@openai/codex-sdk) | app-server 协议 |
|------|-----------------------------------|----------------|
| 审批系统 | 无逐项审批回调 | 完整：命令审批(5种决策) + 文件变更审批(4种决策) |
| 事件流 | 有限事件类型 | 丰富：AgentMessageDelta, ReasoningDelta, CommandOutputDelta 等 |
| 线程管理 | start/resume | start/resume/fork/archive/list/read/compact/rollback |
| 轮次管理 | 无 | start/interrupt/steer |
| 配置管理 | 需自行解析 config.toml | 原生 config.toml + read/write API |
| 协议稳定性 | 高层封装，API 可能变化 | VSCode 扩展使用的底层协议，有完整 JSON Schema |

## 工具设计

### 工具 1: `codex` — 启动新 Codex agent 会话

异步启动，立即返回 `{ sessionId, threadId, status: "running", pollInterval }`。

**参数设计原则**：prompt、approvalPolicy、sandbox 为必填参数；effort 默认为 `low`（调用方应根据任务复杂度主动调整），其余高频参数保留在顶层，低频参数折叠到 advanced。

```
顶层参数（高频）：
├── prompt: string          # 必填，任务描述
├── approvalPolicy: enum    # 必填，审批策略：untrusted | on-failure | on-request | never
├── sandbox: enum           # 必填，沙箱模式：read-only | workspace-write | danger-full-access
├── effort?: enum           # 默认 low；推理力度：none | minimal | low | medium | high | xhigh（应根据任务复杂度调整）
├── cwd?: string            # 工作目录，默认 server cwd
├── model?: string          # 模型，默认 config.toml
└── profile?: string        # config.toml profile 名

advanced 参数（低频）：
├── baseInstructions?: string        # 基础指令（替换默认）
├── developerInstructions?: string   # 开发者指令
├── personality?: enum               # 人格：none | friendly | pragmatic
├── summary?: enum                   # 推理摘要：auto | concise | detailed | none
├── config?: Record<string, unknown> # 覆盖 config.toml 的任意配置
├── ephemeral?: boolean              # 不持久化线程
├── outputSchema?: object            # JSON Schema 结构化输出
├── images?: string[]                # 图片路径
└── approvalTimeoutMs?: number       # 审批超时（默认 60000ms）
```

**返回值**：
```json
{
  "sessionId": "sess_abc123",
  "threadId": "thread_xyz789",
  "status": "running",
  "pollInterval": 120000
}
```

**工作流**：
1. 构建 codex app-server 启动参数（-c/-p 等）
2. 启动 app-server 子进程
3. 发送 `initialize` 请求（params: `{ clientInfo: { name: "codex-mcp", version }, capabilities? }`）
4. 发送 `thread/start` 请求创建线程（params 全部可选：cwd, model, modelProvider, approvalPolicy, sandbox, personality, ephemeral, baseInstructions, developerInstructions, config）
5. 发送 `turn/start` 请求开始第一轮（params: `{ threadId, input: [{ type: "text", text: prompt }] }`）
   - `images` 参数转换为 `{ type: "localImage", path }` 加入 input 数组
6. 注册事件监听（notification + server-initiated request）
7. 从 `turn/started` 通知中获取 `activeTurnId`（`turn/interrupt` 需要）
8. 立即返回 sessionId

### 工具 2: `codex_reply` — 继续已有会话

```
参数：
├── sessionId: string       # 必填
├── prompt: string          # 必填，后续消息
├── model?: string          # 可覆盖后续轮次的模型
├── approvalPolicy?: string # 可覆盖后续轮次的审批策略
├── effort?: string         # 可覆盖后续轮次的推理力度
├── summary?: string        # 可覆盖后续轮次的推理摘要
├── personality?: string    # 可覆盖后续轮次的人格
├── sandbox?: enum          # 可覆盖后续轮次的沙箱策略：read-only | workspace-write | danger-full-access（内部映射为 SandboxPolicy 对象）
├── cwd?: string            # 可覆盖后续轮次的工作目录
└── outputSchema?: object   # 本轮结构化输出
```

> 注：以上覆盖参数对应 `TurnStartParams` 中的同名字段，覆盖对当前轮次及后续轮次生效。

**工作流**：
1. 查找已有会话，验证状态为 idle 或 error（cancelled 返回专用错误码 CANCELLED）
2. 验证 threadId 存在
3. 清除上一轮的 result/error 事件
4. 通过已有 app-server 子进程发送 turn/start（失败时恢复状态为 error）
5. 立即返回

### 工具 3: `codex_session` — 管理会话

```
参数：
├── action: "list" | "get" | "cancel" | "interrupt" | "fork" | "clean_background_terminals"
├── sessionId?: string          # get/cancel/interrupt/fork/clean_background_terminals 必填
└── includeSensitive?: boolean  # get 时包含敏感信息
```

**action 详解**：
- `list`: 返回所有会话的公开信息（脱敏）
- `get`: 返回单个会话详情
- `cancel`: 终止会话（发送 abort 信号，终止子进程）
- `interrupt`: 中断当前轮次但保留会话（发送 `turn/interrupt`，需要 `threadId` + `activeTurnId`，由 SessionManager 自动跟踪）
- `fork`: 分叉会话（发送 thread/fork，创建新的 app-server 子进程，独立于原会话运行。常用于从某个节点尝试不同方案）
- `clean_background_terminals`: 请求 app-server 清理该线程关联的后台终端资源

### 工具 4: `codex_check` — 轮询事件 + 审批响应

```
参数：
├── action: "poll" | "respond_permission" | "respond_user_input"
├── sessionId: string
│
│ # poll 参数
├── cursor?: number          # 事件偏移量，默认使用会话上次消费的 cursor
├── maxEvents?: number       # 最大事件数，poll 默认 1，respond_* 默认 0
├── responseMode?: "minimal" | "delta_compact" | "full"  # 默认 minimal
├── pollOptions?: {
│     includeEvents?: boolean   # 默认 true
│     includeActions?: boolean  # 默认 true
│     includeResult?: boolean   # 默认 true
│     maxBytes?: number         # 默认 unlimited，超限时 best-effort 截断
│   }
│
│ # respond_permission 参数
├── requestId?: string       # 审批请求 ID
├── decision?: "accept" | "acceptForSession" | "acceptWithExecpolicyAmendment" | "decline" | "cancel"
├── execpolicy_amendment?: string[]  # 仅 acceptWithExecpolicyAmendment
├── denyMessage?: string     # 仅用于 codex-mcp 内部事件记录，不发送给 app-server
│
│ # respond_user_input 参数
├── requestId?: string       # 用户输入请求 ID
└── answers?: Record<string, { answers: string[] }>  # questionId → answers 映射
```

**poll 返回值**：
```json
{
  "sessionId": "sess_abc123",
  "status": "running",
  "events": [
    { "id": 0, "type": "output", "data": {}, "timestamp": "..." },
    { "id": 1, "type": "progress", "data": {}, "timestamp": "..." }
  ],
  "nextCursor": 2,
  "actions": [
    {
      "type": "approval",
      "requestId": "req_001",
      "kind": "command",
      "params": { "command": "npm install", "cwd": "/project", "reason": "Install dependencies" },
      "itemId": "item_xxx",
      "reason": "Install dependencies",
      "createdAt": "2026-02-15T..."
    }
  ],
  "result": null
}
```

### 静态 Resources（非工具）

本项目额外暴露 6 个静态只读 MCP Resources，用于元数据和使用指导，不参与 agent 生命周期控制：

- `codex-mcp:///server-info`（`application/json`）：服务端版本/运行时/平台信息
- `codex-mcp:///compat-report`（`application/json`）：跨后端兼容性能力报告
- `codex-mcp:///config`（`text/markdown`）：参数与 `codex app-server -c` 配置映射说明
- `codex-mcp:///gotchas`（`text/markdown`）：轮询、cursor、审批超时等常见注意事项
- `codex-mcp:///quickstart`（`text/markdown`）：最小端到端工作流示例
- `codex-mcp:///errors`（`text/markdown`）：错误码参考与恢复提示

约束：

- 仍保持 4 个 MCP tools，不新增额外工具
- 不暴露 prompts
- resources 内容为静态文档/元信息，不返回环境变量等敏感信息

## 会话生命周期

```
                    +---> waiting_approval ---+
                    |                         |
  (start) ---> running ---+---> idle ---+---> running (reply)
                    |                   |
                    +---> error         +---> cancelled
                    |
                    +---> cancelled
```

**状态说明**：
- `running`: agent 正在执行
- `idle`: 轮次完成，等待后续消息
- `waiting_approval`: agent 需要审批（命令执行或文件变更）
- `error`: 轮次失败
- `cancelled`: 会话被取消（终态）

**状态转换规则**：
- `running` → `idle`: 轮次正常完成（`turn/completed` 通知）
- `running` → `error`: 轮次失败（`error` 通知，含 `willRetry` 标记）
- `running` → `waiting_approval`: 收到审批请求（`item/commandExecution/requestApproval` 或 `item/fileChange/requestApproval`）
- `running` → `cancelled`: 用户取消
- `waiting_approval` → `running`: 审批响应后恢复
- `waiting_approval` → `cancelled`: 用户取消
- `idle` → `running`: codex_reply 发送新消息
- `error` → `running`: codex_reply 重试
- `cancelled` / `error` 状态收到晚到审批请求时：直接返回拒绝响应，不再创建 pending request（防止状态回跳）

## 事件缓冲策略

### EventBuffer 设计
```typescript
interface EventBuffer {
  events: SessionEvent[];
  maxSize: number;       // 1000（软限制）
  hardMaxSize: number;   // 2000（硬限制）
  nextId: number;        // 单调递增
}

interface SessionEvent {
  id: number;
  type: "output" | "progress" | "approval_request" | "approval_result" | "result" | "error";
  data: unknown;
  timestamp: string;
  pinned: boolean;
}
```

### 事件类型映射

> 左列为 app-server JSON-RPC 通知/请求的真实 `method` 名（来自 `codex app-server generate-json-schema`）。

| app-server method | codex-mcp 事件类型 | Pinned | 说明 |
|---|---|---|---|
| `item/agentMessage/delta` | output | No | agent 文本输出增量 |
| `item/completed` (ThreadItem) | output/progress | No | 根据 `item.type` 分类：`agentMessage`/`userMessage` → output；其他 → progress |
| `item/commandExecution/outputDelta` | progress | No | 命令输出增量 |
| `item/fileChange/outputDelta` | progress | No | 文件变更增量 |
| `item/reasoning/textDelta` | progress | No | 推理文本增量 |
| `item/reasoning/summaryTextDelta` | progress | No | 推理摘要增量 |
| `item/plan/delta` | progress | No | 计划增量（EXPERIMENTAL） |
| `item/mcpToolCall/progress` | progress | No | MCP 工具调用进度 |
| `turn/completed` | result | Yes | 轮次完成 |
| `error` | error | Yes | 错误（含 willRetry 标记） |
| `item/commandExecution/requestApproval` | approval_request | Yes | 命令审批请求（server-initiated request） |
| `item/fileChange/requestApproval` | approval_request | Yes | 文件变更审批请求（server-initiated request） |
| approval response（codex-mcp 内部） | approval_result | Yes | 审批响应 |
| `item/started` | progress | No | item 开始 |
| `turn/started` | progress | No | 轮次开始（用于跟踪 activeTurnId） |
| `turn/diff/updated` | progress | No | 轮次级别统一 diff |
| `turn/plan/updated` | progress | No | 轮次级别计划更新 |

### 淘汰策略
1. events.length > maxSize: 淘汰最旧的非 pinned 事件
2. 全部 pinned: 优先淘汰旧的 `approval_result` 事件
3. events.length > hardMaxSize: 强制淘汰最旧事件（`shift`，包括 pinned）

### Cursor 分页
- 客户端传 cursor（上次 nextCursor 值）
- 服务端返回 id >= cursor 的事件 + nextCursor
- 如果最早缓冲事件 id > cursor（事件被淘汰），返回 cursorResetTo

## 权限管理三层模型

### 第零层 — 审批策略（approvalPolicy）
控制 agent 何时需要人类审批：
- `never`: 所有操作自动批准，无交互
- `on-failure`: 自动批准，失败时重试
- `on-request`: 模型决定何时请求审批（推荐默认）
- `untrusted`: 最严格，所有操作都需审批

### 第一层 — 沙箱隔离（sandbox）
控制 agent 的文件系统和网络访问：
- `read-only`: 只读文件系统（在某些客户端/策略组合下可能无法执行 shell 命令；`read-only + never` 常见于纯对话分析场景）
- `workspace-write`: 工作区可写，网络受限（推荐默认）
- `danger-full-access`: 完全访问（危险）

### 第二层 — 异步审批裁决
当 approvalPolicy 触发审批时的完整流程：

1. app-server 发送 server-initiated request:
   - `item/commandExecution/requestApproval`: 命令执行审批
   - `item/fileChange/requestApproval`: 文件变更审批

2. codex-mcp 处理：
   - 创建 ApprovalRecord（requestId, command/changes, reason）
   - 推送 approval_request 事件到 EventBuffer
   - 会话状态转为 waiting_approval
   - 启动超时计时器（默认 60s）

3. MCP 客户端响应：
   - 通过 codex_check(action="respond_permission") 发送决策
   - 命令执行决策：accept / acceptForSession / acceptWithExecpolicyAmendment / decline / cancel
   - 文件变更决策：accept / acceptForSession / decline / cancel

4. codex-mcp 转发：
   - 将决策转发回 app-server（作为 server-initiated request 的 response）
   - 推送 approval_result 事件
   - 会话状态恢复为 running

5. 超时处理：
   - 超时自动 decline（不中断 agent）
   - 推送 approval_result 事件（标记为 timeout）

### 客户端权限配置指南

MCP 客户端（调用方）应根据自身的安全策略配置权限：

1. **approvalPolicy 选择**：
   - 完全自动化场景：`never`（仅在受信任环境中使用）
   - CI/CD 场景：`on-failure`
   - 交互式开发：`on-request`（推荐）
   - 高安全要求：`untrusted`

2. **sandbox 选择**：
   - 只读分析：`read-only`
   - 正常开发：`workspace-write`（推荐）
   - 需要完全访问：`danger-full-access`（谨慎使用）

3. **审批响应策略**：
   - 客户端可实现自动审批规则（如：只读命令自动 accept）
   - 或转发给人类用户决策
   - 建议实现 acceptForSession 以减少重复审批

## app-server 子进程管理

### 架构
每个 MCP 会话对应一个独立的 codex app-server 子进程（stdio transport）。

### 子进程启动
```
codex app-server [-c key=value]... [-p profile]
```
- `-c` 参数来自工具的 advanced.config + 顶层参数
- `-p` 参数来自工具的 profile
- 顶层参数映射：model → `-c model=gpt-5.2`, approvalPolicy → `-c approval_policy=on-request`, sandbox → `-c sandbox_mode=workspace-write`
- advanced.config 中的值：原始类型（string/number/boolean）使用 `String(value)`，对象/数组使用 `JSON.stringify(value)`

### JSON-RPC 通信
- 通过 stdin/stdout 进行消息收发
- 请求 ID 管理：Map<id, { resolve, reject, timeout }>
- 通知处理：注册 handler 按 method 分发
- Server-initiated request 处理：注册 handler，返回 response

### 生命周期
- 启动：spawn → initialize → ready
- 运行：处理 thread/turn 请求，转发事件
- 关闭：发送关闭信号 → 等待退出 → 强制 kill（超时后）
- 异常：子进程退出 → 标记会话为 error

### 优雅关闭流程

当 MCP server 收到 SIGINT/SIGTERM 时：
1. 停止接受新的工具调用
2. SessionManager.destroy()：清除所有 pending request 的超时计时器
3. 向所有 app-server 子进程发送 SIGTERM（stdin.end + kill）
4. 等待子进程退出（超时 5s 后 SIGKILL）
5. 清理所有会话资源，关闭 MCP transport

### 会话清理策略

SessionManager 运行定期清理任务（每 60s 检查一次）：
- idle 超过 30 分钟 → 自动终止子进程并清理
- running 超过 4 小时 → 自动终止（防止僵尸会话）
- cancelled/error 状态超过 5 分钟 → 清理内存中的会话记录
- 清理触发 `cancelSession` 时会推送 `progress` + `result(status=cancelled)`；不会额外推送 `error` 事件

## 配置解析流程

```
用户调用 codex({ prompt, model, profile, advanced: { config } })
    │
    ▼
构建 app-server 启动参数：
  codex app-server
    -c model=gpt-5.2               ← 来自 model 参数
    -c approval_policy=on-request ← 来自 approvalPolicy 参数
    -c sandbox_mode=workspace-write ← 来自 sandbox 参数
    -c custom.key=value           ← 来自 advanced.config
    -p my-profile                 ← 来自 profile 参数
    │
    ▼
codex app-server 内部：
  1. 加载 ~/.codex/config.toml 默认值
  2. 应用 profile 覆盖
  3. 应用 -c 参数覆盖
  4. 最终配置生效
```

## 错误处理策略

### 错误分类
- `INVALID_ARGUMENT`: 参数验证失败
- `SESSION_NOT_FOUND`: 会话不存在
- `SESSION_BUSY`: 会话正在运行，无法接受新消息
- `REQUEST_NOT_FOUND`: 审批/用户输入请求不存在或已解决
- `TIMEOUT`: 操作超时
- `CANCELLED`: 会话已取消
- `INTERNAL`: 内部错误

### 错误响应格式
```json
{
  "content": [{ "type": "text", "text": "Error [SESSION_NOT_FOUND]: Session 'sess_abc' not found" }],
  "isError": true
}
```

### 子进程错误处理
- 子进程意外退出：标记会话为 error，推送 error 事件
- JSON-RPC 超时：返回 TIMEOUT 错误
- 初始化失败：返回 INTERNAL 错误，清理子进程

## 依赖
- `@modelcontextprotocol/sdk` — MCP 协议实现（McpServer, StdioServerTransport）
- `zod` — 输入验证
- Node.js child_process — 管理 codex app-server 子进程
- 无需 `@openai/codex-sdk` — 直接使用 codex app-server 子进程通信

## 协议实现要点（来自 Codex 交叉审查）

> 本仓库将 `codex app-server` 的 JSON Schema bundle 固定在 `codex-schema/` 中（版本化提交），用于协议对齐与回归测试基线。
> 如需更新，使用：`codex app-server generate-json-schema --experimental --out codex-schema`，并同步更新 `codex-schema/metadata.json`。

### 审批 response 格式（必须严格匹配 schema）

命令审批 response（`CommandExecutionRequestApprovalResponse`）：
- `accept` → `{ decision: "accept" }`
- `acceptForSession` → `{ decision: "acceptForSession" }`
- `acceptWithExecpolicyAmendment` → `{ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } }`
- `decline` → `{ decision: "decline" }`
- `cancel` → `{ decision: "cancel" }`

文件变更审批 response（`FileChangeRequestApprovalResponse`）：
- `accept` / `acceptForSession` / `decline` / `cancel` → `{ decision: "..." }`

注意：`denyMessage` 不是协议字段，只能作为 codex-mcp 内部 `approval_result` 事件的附加信息。

### 审批请求 params 关键字段

`CommandExecutionRequestApprovalParams`：
- required: `itemId`, `threadId`, `turnId`
- optional: `command?` (string | null), `cwd?`, `reason?`, `commandActions?` (array | null), `proposedExecpolicyAmendment?` (string[] | null)

`FileChangeRequestApprovalParams`：
- required: `itemId`, `threadId`, `turnId`
- optional: `grantRoot?` (UNSTABLE), `reason?`
- 注意：不包含 `changes[]`，文件变更详情需从 `item/fileChange/outputDelta` 按 `itemId` 聚合

### 额外的 server-initiated requests（必须处理）

除审批外，app-server 还会发送以下 server-initiated requests，codex-mcp 必须响应（否则 turn 会挂起）：

1. `item/tool/requestUserInput` — 工具请求用户输入
   - params: `{ itemId, threadId, turnId, questions: [{ id, header, question, options? }] }`
   - response: `{ answers: Record<questionId, { answers: string[] }> }`
   - 处理策略：缓冲为 `approval_request` 事件（subtype: "user_input"），由 MCP 客户端通过 `codex_check(action="respond_user_input")` 响应

2. `item/tool/call` — 动态工具调用
   - params: `{ threadId, turnId, callId, tool, arguments }`
   - response: `{ success: boolean, contentItems: [...] }`
   - 处理策略：自动拒绝（`{ success: false, contentItems: [{ type: "inputText", text: "Not supported by codex-mcp" }] }`）

3. `account/chatgptAuthTokens/refresh` — 认证令牌刷新
   - params: `{ reason: "unauthorized", previousAccountId? }`
   - response: `{ accessToken, chatgptAccountId, chatgptPlanType? }`
   - 处理策略：返回 JSON-RPC error（codex-mcp 不管理认证）

4. `applyPatchApproval` / `execCommandApproval` — legacy 审批（已废弃）
   - 处理策略：返回 `{ decision: "denied" }` 并记录警告日志

### turn/start 输入格式

`prompt: string` 必须转换为 `UserInput[]` 格式：
```
input: [{ type: "text", text: prompt }]
```
`images: string[]`（本地路径）转换为：
```
input: [..., { type: "localImage", path: imagePath }]
```

### SessionManager 必须跟踪的状态

- `threadId`：从 `thread/start` response 获取（兼容 v1 `{threadId}` 与 v2 `{thread: {id}}`）
- `activeTurnId`：从 `turn/started` 通知获取（兼容 v1 顶层 `turnId` 与 v2 `turn.id`，`turn/interrupt` 需要）
- `pendingRequests`：审批/用户输入请求的 requestId → 记录（用于 `codex_check` 返回 actions 以及响应 server-initiated requests）

## 安全考量

### 输入验证
- 所有工具参数通过 Zod schema 严格验证
- `cwd` 参数默认为 server cwd，由 app-server 进一步验证
- `advanced.config` 的值按类型序列化后传递给 app-server

### 子进程隔离
- 每个会话独立子进程，互不影响
- 子进程继承父进程环境变量，但不暴露在公开会话信息中
- 子进程异常退出不影响 MCP server 主进程

### 敏感信息保护
- `codex_session(action="get")` 默认返回脱敏信息
- `includeSensitive=true` 才返回 cwd、config 等敏感字段
- 审批请求中的命令内容原样展示（由客户端决定是否展示给用户）

### 审批超时
- 默认 60s 超时自动 decline，防止会话无限挂起
- 超时不中断 agent，仅拒绝当前操作

## 客户端轮询指南

### 推荐轮询策略

服务端在 `codex_check` 返回值中包含 `pollInterval` 字段。该值表示**最小建议间隔**，客户端可以根据任务预计耗时继续拉长：

```
status = "waiting_approval" → pollInterval: 1000ms（需要快速响应审批）
status = "running"          → pollInterval: 120000ms（至少 2 分钟，不得更快；复杂任务建议 3-10+ 分钟）
status = "idle"/"error"/"cancelled" → pollInterval: undefined（终态，无需继续轮询）
```

说明：`running` 状态下长时间无新事件在模型推理阶段是可能的，不应直接判定失败。调用方应结合任务复杂度判断轮询节奏，`pollInterval` 仅是下限。

客户端也可以实现自己的退避策略：无新事件时间隔 × 1.5，有新事件时重置。

### 典型轮询流程

```
1. 调用 codex({ prompt }) → 获得 sessionId
2. 循环:
   a. 调用 codex_check({ action: "poll", sessionId, cursor })
   b. 处理返回的 events（展示给用户）
   c. 检查 actions 中是否有待审批项
      - 有: 展示给用户，收集决策，调用 codex_check({ action: "respond_permission", ... })
   d. 检查 status:
      - "idle": agent 完成当前轮次，可以 codex_reply 继续或结束
      - "error": 查看错误信息，决定是否 codex_reply 重试
      - "cancelled": 会话已终止，退出循环
      - "running" / "waiting_approval": 继续轮询
   e. 更新 cursor = nextCursor
   f. 至少等待 pollInterval 后继续（running 状态可按任务复杂度继续延长）
3. 结束: 可选调用 codex_session({ action: "cancel" }) 清理
```

### 注意事项
- 始终使用 nextCursor 避免重复获取事件
- 如果收到 cursorResetTo，说明旧事件已被淘汰，从新 cursor 开始
- 审批请求有超时限制，及时响应避免自动 decline

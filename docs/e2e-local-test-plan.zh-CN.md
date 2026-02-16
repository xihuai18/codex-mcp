# codex-mcp 端到端（E2E）本地测试方案（第三方 MCP Client/CLI）

本文档用于**在你把 `codex-mcp` 作为一个第三方 MCP Server 安装/配置到某个 MCP Client（CLI/IDE/桌面端）之后**，对其进行端到端本地验证，确保它能在**真实编程任务**里正确工作：会话启动、异步轮询、权限审批、文件修改、命令执行、取消/中断/分叉、多轮对话、结构化输出等。

> 关键背景：`codex-mcp` 通过 stdio 暴露 4 个 MCP tools：`codex` / `codex_reply` / `codex_session` / `codex_check`，内部每个 session 都会 spawn 一个 `codex app-server` 子进程。

---

## 1. 测试目标与成功标准

### 覆盖能力（你要“证明”的东西）

- **工具发现**：Client 能看到 4 个工具，并能正确发起调用。
- **异步非阻塞**：`codex` / `codex_reply` 立即返回 `sessionId`，后续通过 `codex_check(poll)` 拉取事件与最终结果。
- **权限与审批**：
  - 能看到 `actions[]`（命令审批/文件变更审批/用户输入请求）。
  - 能通过 `codex_check(respond_approval / respond_user_input)` 正确响应，且 session 状态/事件流符合预期。
- **真实编程任务**：在一个可重复的本地代码工作区里完成“跑测试 → 修 bug → 复跑测试通过 → 总结变更”。
- **会话管理**：`list/get/cancel/interrupt/fork` 可用；敏感信息默认脱敏，`includeSensitive=true` 可查看完整信息。
- **鲁棒性**：错误（找不到 `codex`、无权限、超时、子进程退出）不崩溃 MCP 连接，错误以工具返回值体现。

### 通过标准（建议）

- 至少完成：TC0/TC1/TC2/TC3/TC4/TC5（见第 5 节），并且能在一个真实代码任务上成功闭环。
- 额外加分：完成 TC6（结构化输出）+ TC7/TC8（取消/中断）+ TC9（fork）。

---

## 2. 前置条件与环境

### 必需

- Node.js >= 18
- `codex` CLI 已安装且可执行（`codex` 在 PATH）
- 本机 `~/.codex/config.toml` 已配置（至少包含可用的模型/认证；具体由你的 Codex CLI 配置决定）
- 本机能访问 Codex 所需的网络（E2E 编程任务需要调用云端模型；若无网络可只做 TC0/TC1）

### 强烈建议

- 准备一个**隔离的测试工作区**（避免污染 `codex-mcp` 自己的仓库）：把本仓库自带的 fixture 复制出去再测（见第 4 节）。
- 对 Windows：确保 MCP Client 启动 server 时不会在 **stdout** 打印 banner/提示信息（见第 7 节排障）。

---

## 3. 安装与启动方式（按“像用户一样”的方式测）

你至少选择其中一种方式来模拟“第三方安装后”的真实使用：

### 3.1 方式 A：npx（最接近真实用户，不污染全局）

Client 启动命令（建议）：

```bash
npx -y @leo000001/codex-mcp
```

### 3.2 方式 B：全局安装

```bash
npm install -g @leo000001/codex-mcp
codex-mcp
```

### 3.3 方式 C：本地开发版（回归测试你当前代码）

```bash
npm install
npm run build
node dist/index.js
```

> 注意：很多 MCP Client 会直接 spawn `command`，不经过 shell；但也有客户端会通过 shell 启动。无论哪种，**server stdout 必须保持纯净**（只能输出 JSON-RPC），日志请走 stderr。

---

## 4. 准备可重复的“真实代码任务”测试工作区

本仓库提供一个最小可复现 fixture：`e2e/fixtures/node-bug/`（Node 18 自带 `node --test`，无需额外依赖）。

### 4.1 复制 fixture 到隔离目录（推荐）

PowerShell 示例：

```powershell
$dst = "D:\Lab\codex-mcp-e2e\case1"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force "D:\Lab\codex-mcp\e2e\fixtures\node-bug\*" $dst
```

然后你将把 `codex` 工具的 `cwd` 指向这个 `$dst`。

### 4.2 预期初始状态

- 在该目录执行 `npm test`（或 `node --test`）应当失败（因为内置了一个“平均数 mean 计算” bug）。
- E2E 任务的目标是：让 agent 修复 bug，使测试通过。

---

## 5. E2E 测试用例（方法 + 预期效果）

下述用例默认你能在 MCP Client 中发起 tool call（手动或由客户端内置模型代你调用均可）。

> 术语提示：`codex` / `codex_reply` 返回后，你必须用 `codex_check(action="poll")` 轮询事件流，直到 `status` 变为 `idle`/`error`/`cancelled`。当 `actions[]` 不为空时，要在超时前用 `respond_approval` 或 `respond_user_input` 回复。

### TC0：Smoke — tools/list 与基本连通性

**方法**
- 在 Client 中连接/启动 `codex-mcp`。
- 执行 `tools/list`（大多数 Client 都会在 UI 中显示工具列表；或使用第 6 节脚本）。

**预期**
- 能看到 4 个工具：`codex`, `codex_reply`, `codex_session`, `codex_check`。
- 每个工具在元数据里包含 `inputSchema` / `outputSchema` / `annotations`。

### TC1：Resources — 资源列表与读取

**方法**
- 执行 `resources/list` 并读取：
  - `codex-mcp:///server-info`
  - `codex-mcp:///config`
  - `codex-mcp:///gotchas`

**预期**
- `server-info` 返回 JSON（包含版本、平台、资源 URI 列表）。
- `config` / `gotchas` 返回 markdown 文本。

### TC2：Session start + poll（无审批路径，验证“异步非阻塞”）

**方法**
- 调用 `codex`：
  - `prompt`: “在不修改任何文件的前提下，快速概览当前 cwd 下项目结构（只输出要点）。”
  - `approvalPolicy`: `never`
  - `sandbox`: `read-only`
  - `effort`: `low`
  - `cwd`: 指向你在第 4 节准备的测试工作区
- 立即调用 `codex_check(action="poll")`，并按 `pollInterval` 继续轮询直到终态。

**预期**
- `codex` 立即返回 `sessionId`（并可能包含 `threadId` / `pollInterval`）。
- `poll` 返回：
  - `events[]` 持续追加（包含 `output`/`progress` 等）
  - `nextCursor` 单调递增
  - `status` 最终变为 `idle`（或在配置/网络问题时为 `error`）
- 过程中通常不出现 `actions[]`（因为不需要运行命令/改文件）。

### TC3：命令审批（command approval）路径

**方法**
- 调用 `codex`：
  - `prompt`: “请先运行测试（npm test），根据失败信息修复代码并复跑测试，最后总结改动。”
  - `approvalPolicy`: `untrusted`（确保触发审批）
  - `sandbox`: `workspace-write`
  - `effort`: `medium`
  - `cwd`: 测试工作区
- 轮询 `codex_check(poll)`，当出现 `actions[]` 且 `type="approval"`、`kind="command"` 时：
  - 选择一个 requestId，调用 `codex_check(action="respond_approval", decision="accept")`

**预期**
- `status` 会在 `running` 与 `waiting_approval` 之间切换。
- `actions[]` 中会出现待审批项（command），并且在你 accept 后：
  - 对应审批从 `actions[]` 消失
  - `pendingRequestCount` 下降（可用 `codex_session(get)` 佐证）
  - agent 继续执行并产生更多 `output/progress`

### TC4：文件变更审批（fileChange approval）路径

**方法**
- 延续 TC3（或新开 session），继续轮询直到出现 `kind="fileChange"` 的审批动作，然后 accept。
- 让 agent 实际修改文件（例如修复 `src/math.js` 中的 mean 逻辑）。

**预期**
- 看到 `actions[]` 中出现 `kind="fileChange"`（某些配置下可能更常见）。
- accept 后工作区文件发生变更：`src/math.js` 被修改。
- agent 复跑测试后通过，并在最终输出中说明修复内容。

> 如果你的 Codex 配置/策略下不触发 fileChange approval（只触发命令审批），这条用例可以标记为“在当前配置下不适用”，但建议在另一个 profile 或更严格策略下再验证一次。

### TC5：多轮对话（codex_reply）与上下文保留

**方法**
- 在 TC3/TC4 的 session 结束（`status="idle"`）后调用 `codex_reply`：
  - `sessionId`: 上一个 sessionId
  - `prompt`: “请为 mean 再补充 2 个边界测试用例，并确保 npm test 通过。”
  - 可选覆盖：`effort="low"` 或 `summary="concise"`
- 轮询 `codex_check(poll)` 直到 `idle`。

**预期**
- `codex_reply` 立即返回（异步），随后通过 `poll` 获取事件流。
- agent 不需要你重复描述项目背景（说明上下文保留正常）。
- 新增/修改测试文件后，测试通过。

### TC6：结构化输出（outputSchema）

**方法**
- 调用 `codex` 或 `codex_reply`，传入 `outputSchema`（JSON Schema），例如要求输出：
  - `changedFiles: string[]`
  - `commandsRun: string[]`
  - `summary: string`
- 轮询直到 `idle`，观察 `result.structuredOutput`（或工具返回的 structuredContent）。

**预期**
- 最终结果中包含结构化字段（若模型/配置支持）。
- 即使 Client 只显示 `content[0].text` 的 JSON 字符串，也能解析出结构化对象。

### TC7：取消（cancel）

**方法**
- 启动一个相对耗时的任务（例如让 agent 先跑测试再做额外重构）。
- 在 `running` 状态下执行 `codex_session(action="cancel", sessionId=...)`。
- 继续 `codex_check(poll)`。

**预期**
- session 进入 `cancelled`，事件流中出现 `error` 或 `result`（含取消信息）。
- 子进程被终止；后续 poll 不再推进。

### TC8：中断（interrupt）

**方法**
- 在 session `running` 且有 `activeTurnId` 的情况下执行 `codex_session(action="interrupt")`。
- 继续轮询。

**预期**
- 当前 turn 被中断，session 最终回到 `idle` 或 `error`（取决于 app-server 行为）。
- 连接保持健康；可继续 `codex_reply` 开新 turn。

### TC9：分叉（fork）

**方法**
- 在一个已完成的 session（`idle`）上执行 `codex_session(action="fork")`。
- 对原 session 与新 session 分别 `codex_reply` 提交不同修改方向，比较隔离性。

**预期**
- `fork` 返回新的 `{ sessionId, threadId }`。
- 两个 session 的后续对话互不影响（各自保留 fork 时刻的上下文）。

### TC10：事件缓冲与 cursorResetTo（压力/回归测试，可选）

**方法（思路）**
- 让 agent 运行一个会产生大量输出的命令（例如打印很多行），使事件数量接近/超过 1000。
- 使用一个很旧的 `cursor` 去 poll（例如固定 cursor=0），观察是否出现 `cursorResetTo`。

**预期**
- 当 buffer 淘汰旧事件后，`poll` 返回 `cursorResetTo`，提示客户端需要从新的 cursor 重放。
- approval/result/error 类型事件在压力下更不容易被淘汰（pinned）。

---

## 6.（强烈推荐）用脚本做“可重复的 MCP 连通性回归”

为了不依赖某个具体第三方客户端是否正确实现轮询/工具调用，你可以用本仓库自带脚本做基础回归：

```bash
node scripts/mcp-smoke.mjs
```

它会：
- spawn `codex-mcp`（默认 `node dist/index.js`；也支持 `--npx`）
- 连接 MCP
- `tools/list` 断言 4 个工具存在
- `resources/list` 并读取 `server-info` / `gotchas`

这能快速定位是“server 启不起来/握手坏了”，还是“第三方 Client 集成有问题”。

### 6.1 Claude Code 专用：先做 stdout 纯净性检查（Windows 重中之重）

很多“Claude Code 里连不上 / invalid JSON / unexpected output”最终都指向 **server stdout 被污染**（stdio transport 只能在 stdout 传 JSON-RPC）。

在把 server 配进 Claude Code 前，先跑：

```bash
npm run build
npm run check:stdio
```

预期：
- 输出 `OK: stdout is clean.`
- stderr 允许有日志（比如启动提示、shell/profile 警告），但 **stdout 必须为空**。

---

## 7. 常见问题与排障要点

### 7.1 MCP 握手失败 / Client 报“invalid JSON / unexpected output”

最常见原因：**server 的 stdout 被污染**（stdio transport 要求 stdout 只能输出 JSON-RPC）。

排查与建议：
- 确保 `codex-mcp` 进程没有任何 banner/提示打印到 stdout。
- Windows 下避免用会在启动时打印内容的 shell/profile 包装 server（例如 PowerShell profile、oh-my-posh）。
- 优先让 Client 直接 spawn `npx`/`node`（`shell:false`），不要经由 shell。
- 用 `npm run check:stdio` 先做硬验证（见 6.1）。

---

## 9. Claude Code（作为 MCP Client）实操补充

> Claude Code 的配置文件位置/命令在不同版本可能略有差异。下面提供“尽量通用”的做法；如果你不确定具体入口，优先在 Claude Code 里寻找 **MCP Servers**/`/mcp` 相关命令或设置面板。

### 9.1 配置原则（Windows 优先）

- **不要经由 PowerShell profile** 启动 server：优先用 `node`（本地构建）或 `npx -y`（安装版）直接作为 command。
- 如果 Claude Code 只能执行 `.cmd`：把 `command` 写成 `npx.cmd`（并确保 `args` 包含 `-y`，避免交互提示）。
- 路径建议用 `/`（例如 `C:/Users/you/.../dist/index.js`），避免 JSON 里反斜杠转义出错。
- 先跑 `npm run check:stdio`，再配进 Claude Code。

### 9.2 最小配置示例（示意）

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "node",
      "args": ["C:/absolute/path/to/codex-mcp/dist/index.js"]
    }
  }
}
```

如果用 npx（无需本地 clone/build）：

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "npx",
      "args": ["-y", "@leo000001/codex-mcp"]
    }
  }
}
```

### 9.3 在 Claude Code 里验证（建议顺序）

1. 重启/重新加载 Claude Code 的 MCP servers（取决于你的版本）。
2. 在 Claude Code 中查看 MCP server 状态（通常是 `/mcp` 或设置面板）：
   - 预期看到 `codex-mcp` 为 connected/available。
3. 先在 Claude Code 的终端里跑 `npm run smoke:mcp`（或在系统终端跑也行）：
   - 预期输出 `OK: MCP handshake, tools, and resources look good.`
4. 再按第 5 节用例（TC2–TC5）做完整“真实代码任务”闭环：
   - 重点观察：`codex_check(poll)` 的 `status`、`nextCursor`、以及出现 `actions[]` 时能否及时 `respond_approval`。


### 7.2 `codex` 找不到 / 启动 app-server 失败

- 在同一环境里手动验证 `codex --version`。
- 确保 PATH/全局 npm 安装对 MCP Client 进程可见（有些桌面端从 GUI 启动时 PATH 不同）。

### 7.3 一直 `waiting_approval`

- `approvalTimeoutMs` 默认 60 秒超时自动 decline；你需要在 `actions[]` 出现后及时 `respond_approval`。
- 如果第三方 Client 不会自动轮询或不呈现审批 UI，使用脚本或换支持完整 tool-calling 的 Client。

### 7.4 读写权限不符合预期

- `sandbox=read-only`：期望“不能改文件”，用于只读分析/审查类任务。
- `sandbox=workspace-write`：期望“可改 cwd 下工作区文件”；真实编程任务建议用这个。
- `danger-full-access`：只在你明确接受风险时使用。

---

## 8. 建议的“Client 兼容性记录表”（建议你每次回归都填）

| Client | 版本 | 启动方式（npx/global/local） | TC0 | TC2 | TC3 | TC4 | TC5 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| （填写） | （填写） | （填写） | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | （例如是否支持 actions 审批 UI） |

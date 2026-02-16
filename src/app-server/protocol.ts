/**
 * codex app-server JSON-RPC protocol types
 *
 * Derived from `codex app-server generate-json-schema`.
 * Wire format for stdio communication with codex app-server subprocess.
 */

// ── JSON-RPC Base ──────────────────────────────────────────────────

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── Initialize ─────────────────────────────────────────────────────

export interface InitializeParams {
  clientInfo: { name: string; version: string; title?: string };
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
}

export interface InitializeResult {
  userAgent: string;
}

// ── Thread Management ──────────────────────────────────────────────

/** thread/start — all fields optional */
export interface ThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  approvalPolicy?: string | null;
  /**
   * v2 schema: sandbox mode string enum ("read-only" | "workspace-write" | "danger-full-access")
   * (Not the SandboxPolicy object used by turn/start's sandboxPolicy.)
   */
  sandbox?: string | null;
  personality?: string | null;
  ephemeral?: boolean | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  config?: Record<string, unknown> | null;
}

export interface ThreadStartResultV1 {
  threadId: string;
}
export interface ThreadStartResultV2 {
  thread: { id: string };
}
export type ThreadStartResult = ThreadStartResultV1 | ThreadStartResultV2;

export interface ThreadForkParams {
  threadId: string;
}

export interface ThreadForkResultV1 {
  threadId: string;
}
export interface ThreadForkResultV2 {
  thread: { id: string };
}
export type ThreadForkResult = ThreadForkResultV1 | ThreadForkResultV2;

export interface ThreadResumeParams {
  threadId: string;
}

export interface ThreadResumeResultV1 {
  threadId: string;
}
export interface ThreadResumeResultV2 {
  thread: { id: string };
}
export type ThreadResumeResult = ThreadResumeResultV1 | ThreadResumeResultV2;

// ── SandboxPolicy ──────────────────────────────────────────────────

export type SandboxPolicy =
  | { type: "readOnly" }
  | { type: "workspaceWrite" }
  | { type: "dangerFullAccess" }
  | { type: "externalSandbox" };

/** Map user-facing sandbox mode string to protocol SandboxPolicy */
export function toSandboxPolicy(mode: string): SandboxPolicy | undefined {
  switch (mode) {
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return undefined;
  }
}

// ── Turn Management ────────────────────────────────────────────────

export interface UserInput {
  type: "text" | "image" | "localImage" | "skill" | "mention";
  text?: string;
  url?: string;
  path?: string;
  name?: string;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string | null;
  approvalPolicy?: string | null;
  sandboxPolicy?: SandboxPolicy | null;
  personality?: string | null;
  effort?: string | null;
  summary?: string | null;
  cwd?: string | null;
  outputSchema?: Record<string, unknown>;
}

export interface TurnStartResultV1 {
  turnId: string;
}
export interface TurnStartResultV2 {
  turn: { id: string };
}
export type TurnStartResult = TurnStartResultV1 | TurnStartResultV2;

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ── Approval Requests (server → client) ────────────────────────────

export interface CommandApprovalParams {
  itemId: string;
  threadId: string;
  turnId: string;
  command?: string | null;
  cwd?: string;
  reason?: string | null;
  commandActions?: unknown[] | null;
  proposedExecpolicyAmendment?: string[] | null;
}

export type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | "decline"
  | "cancel";

export interface CommandApprovalResponse {
  decision: CommandApprovalDecision;
}

export interface FileChangeApprovalParams {
  itemId: string;
  threadId: string;
  turnId: string;
  grantRoot?: string | null;
  reason?: string | null;
}

export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface FileChangeApprovalResponse {
  decision: FileChangeApprovalDecision;
}

// ── User Input Request (server → client) ───────────────────────────

export interface UserInputRequestParams {
  itemId: string;
  threadId: string;
  turnId: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options?: Array<{ label: string; description?: string }> | null;
  }>;
}

export interface UserInputRequestResponse {
  answers: Record<string, { answers: string[] }>;
}

// ── Dynamic Tool Call (server → client) ────────────────────────────

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolCallResponse {
  success: boolean;
  contentItems: Array<
    { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
  >;
}

// ── Event Notification Params ──────────────────────────────────────

export interface DeltaNotificationParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ReasoningDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  contentIndex: number;
  delta: string;
}

export interface ItemNotificationParams {
  threadId: string;
  turnId: string;
  item: unknown;
}

export interface TurnNotificationParams {
  threadId: string;
  turn: unknown;
}

export interface ErrorNotificationParams {
  threadId: string;
  turnId: string;
  error: unknown;
  willRetry: boolean;
}

// ── Legacy Approval (deprecated) ───────────────────────────────────

export interface LegacyApprovalResponse {
  decision:
    | "approved"
    | "approved_for_session"
    | "denied"
    | "abort"
    | { approved_execpolicy_amendment: { proposed_execpolicy_amendment: string[] } };
}

// ── Protocol Method Constants ──────────────────────────────────────

export const Methods = {
  // Client → Server
  INITIALIZE: "initialize",
  THREAD_START: "thread/start",
  THREAD_RESUME: "thread/resume",
  THREAD_FORK: "thread/fork",
  TURN_START: "turn/start",
  TURN_INTERRUPT: "turn/interrupt",
  TURN_STEER: "turn/steer",

  // Server → Client requests
  COMMAND_APPROVAL: "item/commandExecution/requestApproval",
  FILE_CHANGE_APPROVAL: "item/fileChange/requestApproval",
  USER_INPUT_REQUEST: "item/tool/requestUserInput",
  DYNAMIC_TOOL_CALL: "item/tool/call",
  AUTH_TOKEN_REFRESH: "account/chatgptAuthTokens/refresh",
  LEGACY_PATCH_APPROVAL: "applyPatchApproval",
  LEGACY_EXEC_APPROVAL: "execCommandApproval",

  // Server → Client notifications
  ERROR: "error",
  THREAD_STARTED: "thread/started",
  TURN_STARTED: "turn/started",
  TURN_COMPLETED: "turn/completed",
  TURN_DIFF_UPDATED: "turn/diff/updated",
  TURN_PLAN_UPDATED: "turn/plan/updated",
  ITEM_STARTED: "item/started",
  ITEM_COMPLETED: "item/completed",
  AGENT_MESSAGE_DELTA: "item/agentMessage/delta",
  COMMAND_OUTPUT_DELTA: "item/commandExecution/outputDelta",
  FILE_CHANGE_OUTPUT_DELTA: "item/fileChange/outputDelta",
  REASONING_TEXT_DELTA: "item/reasoning/textDelta",
  REASONING_SUMMARY_DELTA: "item/reasoning/summaryTextDelta",
  PLAN_DELTA: "item/plan/delta",
  MCP_TOOL_PROGRESS: "item/mcpToolCall/progress",
  SESSION_CONFIGURED: "sessionConfigured",
} as const;

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

// ── Shared enums / aliases ─────────────────────────────────────────

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type Personality = "none" | "friendly" | "pragmatic";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

// ── Thread Management ──────────────────────────────────────────────

export interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** thread/start — all fields optional */
export interface ThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  approvalPolicy?: ApprovalPolicy | null;
  /**
   * v2 schema: sandbox mode string enum ("read-only" | "workspace-write" | "danger-full-access")
   * (Not the SandboxPolicy object used by turn/start's sandboxPolicy.)
   */
  sandbox?: SandboxMode | null;
  personality?: Personality | null;
  ephemeral?: boolean | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  config?: Record<string, unknown> | null;
  dynamicTools?: DynamicToolSpec[] | null;
  experimentalRawEvents?: boolean;
  mockExperimentalField?: string | null;
  persistExtendedHistory?: boolean;
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
  approvalPolicy?: ApprovalPolicy | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  sandbox?: SandboxMode | null;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
  path?: string | null;
  persistExtendedHistory?: boolean;
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
  approvalPolicy?: ApprovalPolicy | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  sandbox?: SandboxMode | null;
  personality?: Personality | null;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
  path?: string | null;
  history?: unknown[] | null;
  persistExtendedHistory?: boolean;
}

export interface ThreadResumeResultV1 {
  threadId: string;
}
export interface ThreadResumeResultV2 {
  thread: { id: string };
}
export type ThreadResumeResult = ThreadResumeResultV1 | ThreadResumeResultV2;

export interface ThreadBackgroundTerminalsCleanParams {
  threadId: string;
}

// ── SandboxPolicy ──────────────────────────────────────────────────

export type ReadOnlyAccess =
  | {
      type: "restricted";
      includePlatformDefaults?: boolean;
      readableRoots?: string[];
    }
  | { type: "fullAccess" };

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; access?: ReadOnlyAccess }
  | { type: "externalSandbox"; networkAccess?: "restricted" | "enabled" }
  | {
      type: "workspaceWrite";
      writableRoots?: string[];
      readOnlyAccess?: ReadOnlyAccess;
      networkAccess?: boolean;
      excludeSlashTmp?: boolean;
      excludeTmpdirEnvVar?: boolean;
    };

/** Map user-facing sandbox mode string to protocol SandboxPolicy */
export function toSandboxPolicy(mode: SandboxMode | string): SandboxPolicy | undefined {
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

export interface TextElement {
  byteRange: { start: number; end: number };
  placeholder?: string | null;
}

export type UserInput =
  | { type: "text"; text: string; text_elements?: TextElement[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface CollaborationMode {
  mode: "plan" | "default";
  settings: {
    model: string;
    developer_instructions?: string | null;
    reasoning_effort?: ReasoningEffort | null;
  };
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string | null;
  approvalPolicy?: ApprovalPolicy | null;
  sandboxPolicy?: SandboxPolicy | null;
  personality?: Personality | null;
  effort?: ReasoningEffort | null;
  summary?: ReasoningSummary | null;
  cwd?: string | null;
  outputSchema?: Record<string, unknown>;
  collaborationMode?: CollaborationMode | null;
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

export interface TurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: UserInput[];
}

// ── Approval Requests (server → client) ────────────────────────────

export interface CommandApprovalParams {
  /**
   * Optional per-callback approval id.
   * Present for subcommand approvals (execve intercept), null/absent for regular approvals.
   */
  approvalId?: string | null;
  itemId: string;
  threadId: string;
  turnId: string;
  command?: string | null;
  cwd?: string | null;
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
    isOther?: boolean;
    isSecret?: boolean;
    options?: Array<{ label: string; description: string }> | null;
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

// ── Auth Refresh Request (server → client) ─────────────────────────

export interface ChatgptAuthTokensRefreshParams {
  reason: "unauthorized";
  previousAccountId?: string | null;
}

export interface ChatgptAuthTokensRefreshResponse {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string | null;
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

export interface ThreadStateNotificationParams {
  threadId: string;
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
  THREAD_BACKGROUND_TERMINALS_CLEAN: "thread/backgroundTerminals/clean",
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
  THREAD_ARCHIVED: "thread/archived",
  THREAD_UNARCHIVED: "thread/unarchived",
  THREAD_NAME_UPDATED: "thread/name/updated",
  THREAD_TOKEN_USAGE_UPDATED: "thread/tokenUsage/updated",
  TURN_STARTED: "turn/started",
  TURN_COMPLETED: "turn/completed",
  TURN_DIFF_UPDATED: "turn/diff/updated",
  TURN_PLAN_UPDATED: "turn/plan/updated",
  ITEM_STARTED: "item/started",
  ITEM_COMPLETED: "item/completed",
  RAW_RESPONSE_ITEM_COMPLETED: "rawResponseItem/completed",
  AGENT_MESSAGE_DELTA: "item/agentMessage/delta",
  COMMAND_OUTPUT_DELTA: "item/commandExecution/outputDelta",
  COMMAND_TERMINAL_INTERACTION: "item/commandExecution/terminalInteraction",
  FILE_CHANGE_OUTPUT_DELTA: "item/fileChange/outputDelta",
  REASONING_TEXT_DELTA: "item/reasoning/textDelta",
  REASONING_SUMMARY_DELTA: "item/reasoning/summaryTextDelta",
  REASONING_SUMMARY_PART_ADDED: "item/reasoning/summaryPartAdded",
  PLAN_DELTA: "item/plan/delta",
  MCP_TOOL_PROGRESS: "item/mcpToolCall/progress",
  MODEL_REROUTED: "model/rerouted",
  FUZZY_FILE_SEARCH_SESSION_UPDATED: "fuzzyFileSearch/sessionUpdated",
  FUZZY_FILE_SEARCH_SESSION_COMPLETED: "fuzzyFileSearch/sessionCompleted",
  WINDOWS_WORLD_WRITABLE_WARNING: "windows/worldWritableWarning",
  ACCOUNT_LOGIN_COMPLETED: "account/login/completed",
  SESSION_CONFIGURED: "sessionConfigured",
} as const;

/**
 * Type definitions for codex-mcp
 *
 * Shared constants are defined as tuples so both Zod schemas and
 * TypeScript types can derive from the same source of truth.
 */

// ── Constants ──────────────────────────────────────────────────────

export const APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const PERSONALITIES = ["none", "friendly", "pragmatic"] as const;
export type Personality = (typeof PERSONALITIES)[number];

export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const SUMMARY_MODES = ["auto", "concise", "detailed", "none"] as const;
export type SummaryMode = (typeof SUMMARY_MODES)[number];

export const SESSION_ACTIONS = ["list", "get", "cancel", "interrupt", "fork"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const CHECK_ACTIONS = ["poll", "respond_approval", "respond_user_input"] as const;
export type CheckAction = (typeof CHECK_ACTIONS)[number];

export const APPROVAL_TYPES = ["command", "fileChange"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const COMMAND_DECISIONS = [
  "accept",
  "acceptForSession",
  "acceptWithExecpolicyAmendment",
  "decline",
  "cancel",
] as const;
export type CommandDecision = (typeof COMMAND_DECISIONS)[number];

export const FILE_CHANGE_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"] as const;
export type FileChangeDecision = (typeof FILE_CHANGE_DECISIONS)[number];

export const ALL_DECISIONS = [
  "accept",
  "acceptForSession",
  "acceptWithExecpolicyAmendment",
  "decline",
  "cancel",
] as const;
export type ApprovalDecision = (typeof ALL_DECISIONS)[number];

// ── Session Types ──────────────────────────────────────────────────

export type SessionStatus = "running" | "idle" | "waiting_approval" | "error" | "cancelled";

export type SessionEventType =
  | "output"
  | "progress"
  | "approval_request"
  | "approval_result"
  | "result"
  | "error";

export interface SessionEvent {
  id: number;
  type: SessionEventType;
  data: unknown;
  timestamp: string;
  pinned: boolean;
}

export interface EventBuffer {
  events: SessionEvent[];
  maxSize: number;
  hardMaxSize: number;
  nextId: number;
}

/** Pending approval/user-input request */
export interface PendingRequest {
  requestId: string;
  /** "command" | "fileChange" | "user_input" */
  kind: ApprovalType | "user_input";
  /** Raw params from app-server */
  params: unknown;
  /** itemId from app-server (for correlation) */
  itemId: string;
  threadId: string;
  turnId: string;
  reason?: string;
  createdAt: string;
  resolved: boolean;
  decision?: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** JSON-RPC response resolver */
  respond?: (result: unknown) => void;
}

/** Internal session info (full) */
export interface SessionInfo {
  sessionId: string;
  threadId?: string;
  activeTurnId?: string;
  /** Most recent poll cursor consumed by this session. */
  lastEventCursor: number;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
  approvalTimeoutMs?: number;
  cwd: string;
  model?: string;
  profile?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  config?: Record<string, unknown>;
  eventBuffer: EventBuffer;
  pendingRequests: Map<string, PendingRequest>;
  lastResult?: TurnResult;
}

/** Public session info (redacted) */
export interface PublicSessionInfo {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  pendingRequestCount: number;
}

/** Sensitive session info */
export interface SensitiveSessionInfo extends PublicSessionInfo {
  threadId?: string;
  cwd: string;
  profile?: string;
  config?: Record<string, unknown>;
}

// ── Result Types ───────────────────────────────────────────────────

export interface TurnResult {
  turnId: string;
  output?: string;
  structuredOutput?: unknown;
  /** Raw turn object from app-server notifications/responses (shape depends on schema version). */
  turn?: unknown;
  /** Turn status string if available (e.g. "completed" | "failed" | "interrupted"). */
  status?: string;
  /** Raw turn error object if available. */
  turnError?: unknown;
  error?: string;
  completedAt: string;
}

export interface SessionStartResult {
  sessionId: string;
  threadId: string;
  status: "running" | "idle";
  pollInterval: number;
}

export interface CheckResult {
  sessionId: string;
  status: SessionStatus;
  pollInterval?: number;
  events: Array<{
    id: number;
    type: SessionEventType;
    data: unknown;
    timestamp: string;
  }>;
  nextCursor: number;
  cursorResetTo?: number;
  actions?: Array<{
    type: "approval" | "user_input";
    requestId: string;
    kind: string;
    params: unknown;
    itemId: string;
    reason?: string;
    createdAt: string;
  }>;
  result?: TurnResult;
}

// ── Error Types ────────────────────────────────────────────────────

export enum ErrorCode {
  INVALID_ARGUMENT = "INVALID_ARGUMENT",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_BUSY = "SESSION_BUSY",
  SESSION_NOT_RUNNING = "SESSION_NOT_RUNNING",
  REQUEST_NOT_FOUND = "REQUEST_NOT_FOUND",
  TIMEOUT = "TIMEOUT",
  CANCELLED = "CANCELLED",
  INTERNAL = "INTERNAL",
}

// ── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_POLL_INTERVAL = 3000;
export const DEFAULT_MAX_EVENTS = 200;
export const DEFAULT_EVENT_BUFFER_SIZE = 1000;
export const DEFAULT_EVENT_BUFFER_HARD_SIZE = 2000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_CLEANUP_MS = 30 * 60 * 1000;
export const DEFAULT_RUNNING_CLEANUP_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_CLEANUP_MS = 5 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 60_000;

/**
 * SessionManager — manages Codex session lifecycle, event buffering, and approval flow.
 */
import { randomUUID } from "crypto";
import { AppServerClient } from "../app-server/client.js";
import type { AppServerSpawnOptions } from "../app-server/lifecycle.js";
import { resolveAndValidateCwd } from "../utils/cwd.js";
import { redactPaths } from "../utils/redact.js";
import { resolveAndValidateFilePath } from "../utils/files.js";
import {
  type RequestId,
  type CommandApprovalResponse,
  type FileChangeApprovalResponse,
  type UserInputRequestResponse,
  type DynamicToolCallResponse,
  type LegacyApprovalResponse,
  type TurnStartParams,
  type UserInput,
  Methods,
  toSandboxPolicy,
} from "../app-server/protocol.js";
import {
  type ApprovalPolicy,
  type SessionInfo,
  type SessionStatus,
  type SandboxMode,
  type PublicSessionInfo,
  type SensitiveSessionInfo,
  type SessionEventType,
  type EventBuffer,
  type PendingRequest,
  type SessionStartResult,
  type CheckResult,
  ErrorCode,
  COMMAND_DECISIONS,
  FILE_CHANGE_DECISIONS,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_MAX_EVENTS,
  DEFAULT_EVENT_BUFFER_SIZE,
  DEFAULT_EVENT_BUFFER_HARD_SIZE,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_IDLE_CLEANUP_MS,
  DEFAULT_RUNNING_CLEANUP_MS,
  DEFAULT_TERMINAL_CLEANUP_MS,
  CLEANUP_INTERVAL_MS,
} from "../types.js";

const COALESCED_PROGRESS_DELTA_METHODS = new Set<string>([
  Methods.COMMAND_OUTPUT_DELTA,
  Methods.FILE_CHANGE_OUTPUT_DELTA,
  Methods.REASONING_SUMMARY_DELTA,
]);
const MAX_COALESCED_DELTA_CHARS = 4096;

export interface SessionManagerOptions {
  /** Inject AppServerClient factory (for tests). */
  createClient?: () => AppServerClient;
  /** Disable background cleanup timer (useful for tests). */
  disableCleanup?: boolean;
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private clients = new Map<string, AppServerClient>();
  private cancellationInFlight = new Map<string, Promise<void>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private createClient: () => AppServerClient;

  constructor(options: SessionManagerOptions = {}) {
    this.createClient = options.createClient ?? (() => new AppServerClient());

    if (!options.disableCleanup) {
      this.cleanupTimer = setInterval(() => this.cleanupSessions(), CLEANUP_INTERVAL_MS);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  // ── Session Creation ─────────────────────────────────────────────

  async createSession(
    prompt: string,
    cwd: string,
    spawnOpts: AppServerSpawnOptions,
    effort: string,
    advanced?: {
      baseInstructions?: string;
      developerInstructions?: string;
      personality?: string;
      ephemeral?: boolean;
      config?: Record<string, unknown>;
      images?: string[];
      outputSchema?: Record<string, unknown>;
      summary?: string;
      approvalTimeoutMs?: number;
    }
  ): Promise<SessionStartResult> {
    const sessionId = `sess_${randomUUID().slice(0, 12)}`;
    const client = this.createClient();

    // Create session record
    const now = new Date().toISOString();
    const approvalTimeoutMs = advanced?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

    const resolvedImages = advanced?.images
      ? advanced.images.map((p) => resolveAndValidateFilePath(p, cwd, "image"))
      : undefined;
    const session: SessionInfo = {
      sessionId,
      status: "running",
      lastEventCursor: 0,
      createdAt: now,
      lastActiveAt: now,
      approvalTimeoutMs,
      cwd,
      model: spawnOpts.model,
      profile: spawnOpts.profile,
      approvalPolicy: spawnOpts.approvalPolicy,
      sandbox: spawnOpts.sandbox,
      config: spawnOpts.config,
      eventBuffer: createEventBuffer(),
      pendingRequests: new Map(),
    };

    this.sessions.set(sessionId, session);
    this.clients.set(sessionId, client);

    try {
      // Register event handlers before start to prevent unhandled "error" events
      this.registerHandlers(sessionId, client, approvalTimeoutMs);

      // Start app-server subprocess
      await client.start(spawnOpts);

      // Start thread
      const threadStartResult = await client.threadStart({
        cwd,
        model: spawnOpts.model,
        approvalPolicy: spawnOpts.approvalPolicy,
        sandbox: spawnOpts.sandbox,
        personality: advanced?.personality,
        ephemeral: advanced?.ephemeral,
        baseInstructions: advanced?.baseInstructions,
        developerInstructions: advanced?.developerInstructions,
        config: advanced?.config,
      });
      const threadId = extractThreadId(threadStartResult);
      session.threadId = threadId;

      // Build input array
      const input: UserInput[] = [{ type: "text", text: prompt }];
      if (resolvedImages) {
        for (const imagePath of resolvedImages) {
          input.push({ type: "localImage", path: imagePath });
        }
      }

      // Start first turn
      const turnStartResult = await client.turnStart({
        threadId,
        input,
        effort,
        summary: advanced?.summary,
        outputSchema: advanced?.outputSchema,
      });

      // Best-effort: seed activeTurnId from response if present (notifications are authoritative)
      const startedTurnId = extractTurnId(turnStartResult);
      if (startedTurnId) session.activeTurnId = startedTurnId;

      return {
        sessionId,
        threadId,
        status: "running",
        pollInterval: DEFAULT_POLL_INTERVAL,
      };
    } catch (err) {
      session.status = "error";
      pushEvent(session.eventBuffer, "error", {
        message: redactPaths(err instanceof Error ? err.message : String(err)),
      });
      await client.destroy();
      this.clients.delete(sessionId);
      this.sessions.delete(sessionId);
      throw err;
    }
  }

  // ── Session Reply ────────────────────────────────────────────────

  async replyToSession(
    sessionId: string,
    prompt: string,
    overrides?: {
      model?: string;
      approvalPolicy?: string;
      effort?: string;
      summary?: string;
      personality?: string;
      sandbox?: string;
      cwd?: string;
      outputSchema?: Record<string, unknown>;
    }
  ): Promise<SessionStartResult> {
    const session = this.getSessionOrThrow(sessionId);
    const client = this.getClientOrThrow(sessionId);

    if (session.status === "cancelled") {
      throw new Error(
        `Error [${ErrorCode.CANCELLED}]: Session '${sessionId}' has been cancelled and cannot be resumed`
      );
    }
    if (session.status !== "idle" && session.status !== "error") {
      throw new Error(
        `Error [${ErrorCode.SESSION_BUSY}]: Session '${sessionId}' is ${session.status}, expected idle or error`
      );
    }
    if (!session.threadId) {
      throw new Error(
        `Error [${ErrorCode.INTERNAL}]: Session '${sessionId}' has no threadId, cannot reply`
      );
    }

    // Clear stale result/error events so the new turn starts clean
    clearTerminalEvents(session.eventBuffer);

    session.status = "running";
    session.lastActiveAt = new Date().toISOString();

    const input: UserInput[] = [{ type: "text", text: prompt }];

    const resolvedCwd = overrides?.cwd
      ? resolveAndValidateCwd(overrides.cwd, session.cwd)
      : undefined;

    const turnParams: TurnStartParams = {
      threadId: session.threadId,
      input,
      model: overrides?.model,
      approvalPolicy: overrides?.approvalPolicy,
      effort: overrides?.effort,
      summary: overrides?.summary,
      personality: overrides?.personality,
      cwd: resolvedCwd,
      outputSchema: overrides?.outputSchema,
    };

    // Map sandbox string to protocol object
    if (overrides?.sandbox) {
      turnParams.sandboxPolicy = toSandboxPolicy(overrides.sandbox);
    }

    try {
      const turnStartResult = await client.turnStart(turnParams);
      const startedTurnId = extractTurnId(turnStartResult);
      if (startedTurnId) session.activeTurnId = startedTurnId;
      if (resolvedCwd) session.cwd = resolvedCwd;
      if (overrides?.model) session.model = overrides.model;
      if (overrides?.approvalPolicy) {
        session.approvalPolicy = overrides.approvalPolicy as ApprovalPolicy;
      }
      if (overrides?.sandbox) {
        session.sandbox = overrides.sandbox as SandboxMode;
      }
    } catch (err) {
      session.status = "error";
      pushEvent(session.eventBuffer, "error", {
        message: redactPaths(
          `Failed to start turn: ${err instanceof Error ? err.message : String(err)}`
        ),
      });
      throw err;
    }

    return {
      sessionId,
      threadId: session.threadId,
      status: "running",
      pollInterval: DEFAULT_POLL_INTERVAL,
    };
  }

  // ── Session Management ───────────────────────────────────────────

  listSessions(): PublicSessionInfo[] {
    return Array.from(this.sessions.values()).map(toPublicInfo);
  }

  getSession(
    sessionId: string,
    includeSensitive = false
  ): PublicSessionInfo | SensitiveSessionInfo {
    const session = this.getSessionOrThrow(sessionId);
    return includeSensitive ? toSensitiveInfo(session) : toPublicInfo(session);
  }

  async cancelSession(sessionId: string, reason?: string): Promise<void> {
    const existing = this.cancellationInFlight.get(sessionId);
    if (existing) {
      await existing;
      return;
    }

    const cancellation = this.performCancelSession(sessionId, reason);
    this.cancellationInFlight.set(sessionId, cancellation);
    try {
      await cancellation;
    } finally {
      this.cancellationInFlight.delete(sessionId);
    }
  }

  private async performCancelSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);

    // Idempotent: already cancelled
    if (session.status === "cancelled") return;

    const client = this.clients.get(sessionId);

    session.status = "cancelled";
    const now = new Date().toISOString();
    session.cancelledAt = now;
    session.lastActiveAt = now;
    session.cancelledReason = reason ?? "Cancelled by user";

    // Resolve and clear all pending requests (avoid leaving hanging server-initiated requests)
    for (const [reqId, req] of session.pendingRequests) {
      if (req.timeoutHandle) clearTimeout(req.timeoutHandle);
      if (!req.resolved && req.respond) {
        req.resolved = true;
        try {
          if (req.kind === "command") req.respond({ decision: "cancel" });
          else if (req.kind === "fileChange") req.respond({ decision: "cancel" });
          else if (req.kind === "user_input") req.respond({ answers: {} });
        } catch {
          // Ignore respond errors during cancel
        }
      }
      session.pendingRequests.delete(reqId);
    }

    pushEvent(
      session.eventBuffer,
      "progress",
      { message: "Session cancelled", cancelledReason: session.cancelledReason },
      true
    );

    const cancelledTurnId = session.activeTurnId ?? "";
    session.activeTurnId = undefined;
    session.lastResult = {
      turnId: cancelledTurnId,
      status: "cancelled",
      error: session.cancelledReason,
      completedAt: new Date().toISOString(),
    };
    pushEvent(
      session.eventBuffer,
      "result",
      { status: "cancelled", reason: session.cancelledReason, turnId: cancelledTurnId },
      true
    );

    if (client) {
      await client.destroy();
      this.clients.delete(sessionId);
    }
  }

  async interruptSession(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    const client = this.getClientOrThrow(sessionId);

    if (session.status !== "running" && session.status !== "waiting_approval") {
      throw new Error(
        `Error [${ErrorCode.SESSION_BUSY}]: Cannot interrupt session in ${session.status} state`
      );
    }

    if (!session.threadId || !session.activeTurnId) {
      throw new Error(
        `Error [${ErrorCode.INTERNAL}]: Missing threadId or activeTurnId for interrupt`
      );
    }

    await client.turnInterrupt({
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });
  }

  async forkSession(sessionId: string): Promise<SessionStartResult> {
    const session = this.getSessionOrThrow(sessionId);
    const originalClient = this.getClientOrThrow(sessionId);

    if (!session.threadId) {
      throw new Error(`Error [${ErrorCode.INTERNAL}]: No threadId to fork`);
    }

    // Fork the thread on the ORIGINAL client (which holds the thread state)
    const forkResult = await originalClient.threadFork({ threadId: session.threadId });
    const forkedThreadId = extractThreadId(forkResult);

    // Create new session with its own app-server process
    const newSessionId = `sess_${randomUUID().slice(0, 12)}`;
    const newClient = this.createClient();
    const now = new Date().toISOString();

    const newSession: SessionInfo = {
      sessionId: newSessionId,
      status: "idle",
      lastEventCursor: 0,
      createdAt: now,
      lastActiveAt: now,
      approvalTimeoutMs: session.approvalTimeoutMs,
      cwd: session.cwd,
      model: session.model,
      profile: session.profile,
      approvalPolicy: session.approvalPolicy,
      sandbox: session.sandbox,
      config: session.config,
      eventBuffer: createEventBuffer(),
      pendingRequests: new Map(),
    };

    this.sessions.set(newSessionId, newSession);
    this.clients.set(newSessionId, newClient);

    try {
      // Register handlers before start to prevent unhandled "error" events
      this.registerHandlers(newSessionId, newClient, newSession.approvalTimeoutMs);

      // Start new app-server subprocess
      await newClient.start({
        profile: session.profile,
        model: session.model,
        approvalPolicy: session.approvalPolicy,
        sandbox: session.sandbox,
        config: session.config,
      });

      // Resume the forked thread on the new process
      await newClient.threadResume({ threadId: forkedThreadId });
      newSession.threadId = forkedThreadId;

      return {
        sessionId: newSessionId,
        threadId: forkedThreadId,
        status: "idle" as const,
        pollInterval: DEFAULT_POLL_INTERVAL,
      };
    } catch (err) {
      newSession.status = "error";
      await newClient.destroy();
      this.clients.delete(newSessionId);
      throw err;
    }
  }

  // ── Event Polling ────────────────────────────────────────────────

  pollEvents(sessionId: string, cursor?: number, maxEvents = DEFAULT_MAX_EVENTS): CheckResult {
    const session = this.getSessionOrThrow(sessionId);
    const buf = session.eventBuffer;
    const effectiveCursor = cursor ?? session.lastEventCursor;

    // Find events with id >= cursor
    let events = buf.events.filter((e) => e.id >= effectiveCursor);
    let cursorResetTo: number | undefined;

    // Check if cursor is stale (events were evicted)
    if (buf.events.length > 0) {
      const earliest = buf.events[0].id;
      if (earliest > effectiveCursor) {
        cursorResetTo = earliest;
        events = buf.events;
      }
    }

    // Limit events
    if (events.length > maxEvents) {
      events = events.slice(0, maxEvents);
    }

    const nextCursor = events.length > 0 ? events[events.length - 1].id + 1 : effectiveCursor;
    session.lastEventCursor = nextCursor;

    // Collect pending actions
    const actions: CheckResult["actions"] = [];
    for (const [, req] of session.pendingRequests) {
      if (!req.resolved) {
        actions.push({
          type: req.kind === "user_input" ? "user_input" : "approval",
          requestId: req.requestId,
          kind: req.kind,
          params: req.params,
          itemId: req.itemId,
          reason: req.reason,
          createdAt: req.createdAt,
        });
      }
    }

    return {
      sessionId,
      status: session.status,
      pollInterval: pollIntervalForStatus(session.status),
      events: events.map(({ id, type, data, timestamp }) => ({ id, type, data, timestamp })),
      nextCursor,
      cursorResetTo,
      actions: actions.length > 0 ? actions : undefined,
      result:
        session.status === "idle" || session.status === "error" || session.status === "cancelled"
          ? session.lastResult
          : undefined,
    };
  }

  // ── Approval Response ────────────────────────────────────────────

  resolveApproval(
    sessionId: string,
    requestId: string,
    decision: string,
    extra?: { execpolicyAmendment?: string[]; denyMessage?: string }
  ): void {
    const session = this.getSessionOrThrow(sessionId);
    const req = session.pendingRequests.get(requestId);

    if (!req || req.resolved) {
      throw new Error(
        `Error [${ErrorCode.REQUEST_NOT_FOUND}]: Request '${requestId}' not found or already resolved`
      );
    }

    // Validate decision by kind (avoid sending invalid protocol payloads)
    if (req.kind === "command") {
      if (!COMMAND_DECISIONS.includes(decision as (typeof COMMAND_DECISIONS)[number])) {
        throw new Error(
          `Error [${ErrorCode.INVALID_ARGUMENT}]: Invalid command decision '${decision}'`
        );
      }
      if (
        decision === "acceptWithExecpolicyAmendment" &&
        (!extra?.execpolicyAmendment || extra.execpolicyAmendment.length === 0)
      ) {
        throw new Error(
          `Error [${ErrorCode.INVALID_ARGUMENT}]: execpolicyAmendment required for acceptWithExecpolicyAmendment`
        );
      }
    } else if (req.kind === "fileChange") {
      if (!FILE_CHANGE_DECISIONS.includes(decision as (typeof FILE_CHANGE_DECISIONS)[number])) {
        throw new Error(
          `Error [${ErrorCode.INVALID_ARGUMENT}]: Invalid fileChange decision '${decision}'`
        );
      }
    } else {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: Request '${requestId}' is not an approval request`
      );
    }

    req.resolved = true;
    req.decision = decision;
    if (req.timeoutHandle) clearTimeout(req.timeoutHandle);

    // Build protocol response
    let response: unknown;
    if (req.kind === "command") {
      response = buildCommandApprovalResponse(decision, extra?.execpolicyAmendment);
    } else if (req.kind === "fileChange") {
      response = { decision } as FileChangeApprovalResponse;
    }

    if (req.respond && response) {
      try {
        req.respond(response);
      } catch {
        /* ignore send errors */
      }
    }

    // Push approval_result event
    pushEvent(
      session.eventBuffer,
      "approval_result",
      {
        requestId,
        kind: req.kind,
        decision,
        denyMessage: extra?.denyMessage,
      },
      true
    );

    // Remove resolved request to prevent unbounded growth
    session.pendingRequests.delete(requestId);

    // Restore status if no more pending requests
    if (session.pendingRequests.size === 0 && session.status === "waiting_approval") {
      session.status = "running";
    }
  }

  // ── User Input Response ──────────────────────────────────────────

  resolveUserInput(
    sessionId: string,
    requestId: string,
    answers: Record<string, { answers: string[] }>
  ): void {
    const session = this.getSessionOrThrow(sessionId);
    const req = session.pendingRequests.get(requestId);

    if (!req || req.resolved || req.kind !== "user_input") {
      throw new Error(
        `Error [${ErrorCode.REQUEST_NOT_FOUND}]: User input request '${requestId}' not found`
      );
    }

    req.resolved = true;
    if (req.timeoutHandle) clearTimeout(req.timeoutHandle);

    if (req.respond) {
      try {
        req.respond({ answers } as UserInputRequestResponse);
      } catch {
        /* ignore send errors */
      }
    }

    pushEvent(
      session.eventBuffer,
      "approval_result",
      {
        requestId,
        kind: "user_input",
        answers,
      },
      true
    );

    session.pendingRequests.delete(requestId);

    if (session.pendingRequests.size === 0 && session.status === "waiting_approval") {
      session.status = "running";
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cancellationInFlight.clear();

    // Clear all pending request timers
    for (const [, session] of this.sessions) {
      clearSessionPendingRequests(session);
    }

    for (const [id, client] of this.clients) {
      client.destroy().catch(() => {});
      this.clients.delete(id);
    }
    this.sessions.clear();
  }

  // ── Private ──────────────────────────────────────────────────────

  private getSessionOrThrow(sessionId: string): SessionInfo {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${sessionId}' not found`);
    }
    return session;
  }

  private getClientOrThrow(sessionId: string): AppServerClient {
    const client = this.clients.get(sessionId);
    if (!client) {
      throw new Error(
        `Error [${ErrorCode.SESSION_NOT_FOUND}]: No client for session '${sessionId}'`
      );
    }
    return client;
  }

  private registerHandlers(
    sessionId: string,
    client: AppServerClient,
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS
  ): void {
    const session = this.sessions.get(sessionId)!;

    // Handle notifications
    client.onNotification((method, params) => {
      session.lastActiveAt = new Date().toISOString();
      const p = params as Record<string, unknown>;

      switch (method) {
        case Methods.TURN_STARTED:
          if (session.status === "cancelled") break;
          session.activeTurnId =
            ((p.turn as Record<string, unknown>)?.id as string | undefined) ??
            (typeof p.turnId === "string" ? p.turnId : undefined);
          pushEvent(session.eventBuffer, "progress", { method, ...p });
          break;

        case Methods.TURN_COMPLETED: {
          if (session.status === "cancelled") break;
          const turnObj = p.turn as Record<string, unknown> | undefined;
          const completedTurnId =
            (typeof p.turnId === "string" ? p.turnId : undefined) ??
            (turnObj?.id as string | undefined) ??
            session.activeTurnId ??
            "";
          session.status = "idle";
          session.activeTurnId = undefined;
          session.lastResult = {
            turnId: completedTurnId,
            output: turnObj?.output as string | undefined,
            structuredOutput: turnObj?.structuredOutput,
            turn: p.turn,
            status: turnObj?.status as string | undefined,
            turnError: turnObj?.error,
            completedAt: new Date().toISOString(),
          };
          pushEvent(session.eventBuffer, "result", { method, ...p }, true);
          break;
        }

        case Methods.ERROR:
          if (session.status === "cancelled") break;
          if (!(p.willRetry as boolean)) {
            session.status = "error";
          }
          {
            const data: Record<string, unknown> = { method, ...p };
            if (typeof data.message === "string") data.message = redactPaths(data.message);
            if (typeof data.error === "string") data.error = redactPaths(data.error);
            pushEvent(session.eventBuffer, "error", data, true);
          }
          break;

        case Methods.AGENT_MESSAGE_DELTA:
          pushEvent(session.eventBuffer, "output", { method, delta: p.delta, itemId: p.itemId });
          break;

        case Methods.ITEM_COMPLETED:
          {
            const item = p.item as Record<string, unknown> | undefined;
            const itemType = item && typeof item.type === "string" ? item.type : undefined;
            // Keep user/agent message-like items as output; everything else is progress.
            const eventType: SessionEventType =
              itemType === "agentMessage" || itemType === "userMessage" ? "output" : "progress";
            pushEvent(session.eventBuffer, eventType, { method, item: p.item });
          }
          break;

        case Methods.COMMAND_OUTPUT_DELTA:
        case Methods.FILE_CHANGE_OUTPUT_DELTA:
        case Methods.REASONING_TEXT_DELTA:
        case Methods.REASONING_SUMMARY_DELTA:
        case Methods.PLAN_DELTA:
        case Methods.MCP_TOOL_PROGRESS:
        case Methods.ITEM_STARTED:
        case Methods.TURN_DIFF_UPDATED:
        case Methods.TURN_PLAN_UPDATED:
          pushEvent(session.eventBuffer, "progress", { method, ...p });
          break;

        default:
          // Ignore other notifications (account, config, etc.)
          break;
      }
    });

    // Handle server-initiated requests
    client.onServerRequest((id: RequestId, method: string, params: unknown) => {
      // Do not transition terminal sessions back to waiting_approval.
      if (session.status === "cancelled" || session.status === "error") {
        respondToTerminalSessionRequest(client, id, method);
        return;
      }

      session.lastActiveAt = new Date().toISOString();
      const p = params as Record<string, unknown>;

      switch (method) {
        case Methods.COMMAND_APPROVAL: {
          const requestId = `req_${randomUUID().slice(0, 8)}`;
          const reason = normalizeOptionalString(p.reason);
          const pending: PendingRequest = {
            requestId,
            kind: "command",
            params,
            itemId: p.itemId as string,
            threadId: p.threadId as string,
            turnId: p.turnId as string,
            reason,
            createdAt: new Date().toISOString(),
            resolved: false,
            respond: (result) => client.respondToServer(id, result),
          };

          // Timeout
          pending.timeoutHandle = createUnrefTimeout(() => {
            if (!pending.resolved) {
              pending.resolved = true;
              pending.decision = "decline";
              try {
                client.respondToServer(id, { decision: "decline" } as CommandApprovalResponse);
              } catch {
                /* client may be destroyed */
              }
              pushEvent(
                session.eventBuffer,
                "approval_result",
                {
                  requestId,
                  kind: "command",
                  decision: "decline",
                  timeout: true,
                },
                true
              );
              session.pendingRequests.delete(requestId);
              if (session.pendingRequests.size === 0 && session.status === "waiting_approval") {
                session.status = "running";
              }
            }
          }, approvalTimeoutMs);

          session.pendingRequests.set(requestId, pending);
          session.status = "waiting_approval";
          pushEvent(
            session.eventBuffer,
            "approval_request",
            {
              requestId,
              kind: "command",
              command: p.command,
              cwd: p.cwd,
              reason,
            },
            true
          );
          break;
        }

        case Methods.FILE_CHANGE_APPROVAL: {
          const requestId = `req_${randomUUID().slice(0, 8)}`;
          const reason = normalizeOptionalString(p.reason);
          const pending: PendingRequest = {
            requestId,
            kind: "fileChange",
            params,
            itemId: p.itemId as string,
            threadId: p.threadId as string,
            turnId: p.turnId as string,
            reason,
            createdAt: new Date().toISOString(),
            resolved: false,
            respond: (result) => client.respondToServer(id, result),
          };

          pending.timeoutHandle = createUnrefTimeout(() => {
            if (!pending.resolved) {
              pending.resolved = true;
              pending.decision = "decline";
              try {
                client.respondToServer(id, { decision: "decline" } as FileChangeApprovalResponse);
              } catch {
                /* client may be destroyed */
              }
              pushEvent(
                session.eventBuffer,
                "approval_result",
                {
                  requestId,
                  kind: "fileChange",
                  decision: "decline",
                  timeout: true,
                },
                true
              );
              session.pendingRequests.delete(requestId);
              if (session.pendingRequests.size === 0 && session.status === "waiting_approval") {
                session.status = "running";
              }
            }
          }, approvalTimeoutMs);

          session.pendingRequests.set(requestId, pending);
          session.status = "waiting_approval";
          pushEvent(
            session.eventBuffer,
            "approval_request",
            {
              requestId,
              kind: "fileChange",
              itemId: p.itemId,
              reason,
            },
            true
          );
          break;
        }

        case Methods.USER_INPUT_REQUEST: {
          const requestId = `req_${randomUUID().slice(0, 8)}`;
          const pending: PendingRequest = {
            requestId,
            kind: "user_input",
            params,
            itemId: p.itemId as string,
            threadId: p.threadId as string,
            turnId: p.turnId as string,
            createdAt: new Date().toISOString(),
            resolved: false,
            respond: (result) => client.respondToServer(id, result),
          };

          pending.timeoutHandle = createUnrefTimeout(() => {
            if (!pending.resolved) {
              pending.resolved = true;
              try {
                client.respondToServer(id, { answers: {} } as UserInputRequestResponse);
              } catch {
                /* client may be destroyed */
              }
              pushEvent(
                session.eventBuffer,
                "approval_result",
                {
                  requestId,
                  kind: "user_input",
                  timeout: true,
                },
                true
              );
              session.pendingRequests.delete(requestId);
              if (session.pendingRequests.size === 0 && session.status === "waiting_approval") {
                session.status = "running";
              }
            }
          }, approvalTimeoutMs);

          session.pendingRequests.set(requestId, pending);
          session.status = "waiting_approval";
          pushEvent(
            session.eventBuffer,
            "approval_request",
            {
              requestId,
              kind: "user_input",
              questions: p.questions,
            },
            true
          );
          break;
        }

        case Methods.DYNAMIC_TOOL_CALL:
          // Auto-reject: codex-mcp doesn't support dynamic tool calls
          client.respondToServer(id, {
            success: false,
            contentItems: [{ type: "inputText", text: "Not supported by codex-mcp" }],
          } as DynamicToolCallResponse);
          break;

        case Methods.AUTH_TOKEN_REFRESH:
          client.respondErrorToServer(id, -32601, "Auth token refresh not supported by codex-mcp");
          break;

        case Methods.LEGACY_PATCH_APPROVAL:
        case Methods.LEGACY_EXEC_APPROVAL:
          client.respondToServer(id, { decision: "denied" } as LegacyApprovalResponse);
          console.error(`[codex-mcp] Legacy approval request received: ${method}`);
          break;

        default:
          client.respondErrorToServer(id, -32601, `Unhandled server request: ${method}`);
          break;
      }
    });

    // Handle subprocess exit
    client.on("exit", (code: number | null) => {
      clearSessionPendingRequests(session);
      if (session.status === "running" || session.status === "waiting_approval") {
        session.status = "error";
        const message = `app-server exited unexpectedly (code: ${code})`;
        setTerminalErrorResult(session, message);
        pushEvent(
          session.eventBuffer,
          "error",
          {
            message,
          },
          true
        );
      }
    });

    // Handle subprocess spawn errors (must listen to prevent uncaught exception)
    client.on("error", (err: Error) => {
      clearSessionPendingRequests(session);
      if (session.status === "running" || session.status === "waiting_approval") {
        session.status = "error";
        const message = redactPaths(`app-server error: ${err.message}`);
        setTerminalErrorResult(session, message);
        pushEvent(
          session.eventBuffer,
          "error",
          {
            message,
          },
          true
        );
      }
    });
  }

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const lastActive = new Date(session.lastActiveAt).getTime();
      if (Number.isNaN(lastActive)) {
        // Invalid timestamp — clean up immediately
        this.requestCancellation(id, "Invalid timestamp");
        continue;
      }
      const age = now - lastActive;

      if (session.status === "idle" && age > DEFAULT_IDLE_CLEANUP_MS) {
        this.requestCancellation(id, "Idle timeout");
      } else if (session.status === "waiting_approval" && age > DEFAULT_RUNNING_CLEANUP_MS) {
        this.requestCancellation(id, "Approval timeout");
      } else if (session.status === "running" && age > DEFAULT_RUNNING_CLEANUP_MS) {
        this.requestCancellation(id, "Running timeout");
      } else if (
        (session.status === "cancelled" || session.status === "error") &&
        age > DEFAULT_TERMINAL_CLEANUP_MS
      ) {
        this.clients
          .get(id)
          ?.destroy()
          .catch(() => {});
        this.clients.delete(id);
        this.sessions.delete(id);
      }
    }
  }

  private requestCancellation(sessionId: string, reason: string): void {
    if (this.cancellationInFlight.has(sessionId)) return;
    this.cancelSession(sessionId, reason).catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function pollIntervalForStatus(status: SessionStatus): number | undefined {
  if (status === "waiting_approval") return 1000;
  if (status === "running") return DEFAULT_POLL_INTERVAL;
  return undefined; // terminal states don't need polling
}

function createEventBuffer(): EventBuffer {
  return {
    events: [],
    maxSize: DEFAULT_EVENT_BUFFER_SIZE,
    hardMaxSize: DEFAULT_EVENT_BUFFER_HARD_SIZE,
    nextId: 0,
  };
}

/** Clear stale result/error events when transitioning idle/error → running */
function clearTerminalEvents(buf: EventBuffer): void {
  buf.events = buf.events.filter((e) => e.type !== "result" && e.type !== "error");
}

function clearSessionPendingRequests(session: SessionInfo): void {
  const entries = Array.from(session.pendingRequests.entries());
  session.pendingRequests.clear();
  for (const [, req] of entries) {
    if (req.timeoutHandle) clearTimeout(req.timeoutHandle);
    req.resolved = true;
  }
}

function setTerminalErrorResult(session: SessionInfo, message: string): void {
  const completedAt = new Date().toISOString();
  const failedTurnId = session.activeTurnId ?? "";
  session.activeTurnId = undefined;
  session.lastResult = {
    turnId: failedTurnId,
    status: "error",
    error: message,
    completedAt,
  };
  pushEvent(
    session.eventBuffer,
    "result",
    {
      status: "error",
      turnId: failedTurnId,
      error: message,
      completedAt,
    },
    true
  );
}

function createUnrefTimeout(handler: () => void, timeoutMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(handler, timeoutMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return timer;
}

function respondToTerminalSessionRequest(
  client: AppServerClient,
  id: RequestId,
  method: string
): void {
  switch (method) {
    case Methods.COMMAND_APPROVAL:
    case Methods.FILE_CHANGE_APPROVAL:
      client.respondToServer(id, { decision: "cancel" });
      break;
    case Methods.USER_INPUT_REQUEST:
      client.respondToServer(id, { answers: {} } as UserInputRequestResponse);
      break;
    case Methods.DYNAMIC_TOOL_CALL:
      client.respondToServer(id, {
        success: false,
        contentItems: [{ type: "inputText", text: "Session is terminal" }],
      } as DynamicToolCallResponse);
      break;
    case Methods.AUTH_TOKEN_REFRESH:
      client.respondErrorToServer(id, -32601, "Session is terminal");
      break;
    case Methods.LEGACY_PATCH_APPROVAL:
    case Methods.LEGACY_EXEC_APPROVAL:
      client.respondToServer(id, { decision: "denied" } as LegacyApprovalResponse);
      break;
    default:
      client.respondErrorToServer(id, -32601, `Unhandled server request: ${method}`);
      break;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pushEvent(buf: EventBuffer, type: SessionEventType, data: unknown, pinned = false): void {
  if (tryCoalesceProgressDelta(buf, type, data, pinned)) return;

  buf.events.push({
    id: buf.nextId++,
    type,
    data,
    timestamp: new Date().toISOString(),
    pinned,
  });
  evictEvents(buf);
}

function tryCoalesceProgressDelta(
  buf: EventBuffer,
  type: SessionEventType,
  data: unknown,
  pinned: boolean
): boolean {
  if (type !== "progress" || pinned || buf.events.length === 0) return false;
  if (!isRecord(data)) return false;

  const method = data.method;
  const delta = data.delta;
  const itemId = data.itemId;
  const turnId = data.turnId;
  if (
    typeof method !== "string" ||
    !COALESCED_PROGRESS_DELTA_METHODS.has(method) ||
    typeof delta !== "string" ||
    typeof itemId !== "string"
  ) {
    return false;
  }

  const last = buf.events[buf.events.length - 1];
  if (last.type !== "progress" || last.pinned || !isRecord(last.data)) return false;

  const lastMethod = last.data.method;
  const lastItemId = last.data.itemId;
  const lastTurnId = last.data.turnId;
  const lastDelta = last.data.delta;
  if (
    lastMethod !== method ||
    lastItemId !== itemId ||
    lastTurnId !== turnId ||
    typeof lastDelta !== "string"
  ) {
    return false;
  }

  if (lastDelta.length + delta.length > MAX_COALESCED_DELTA_CHARS) return false;

  last.data = {
    ...last.data,
    delta: `${lastDelta}${delta}`,
  };
  last.timestamp = new Date().toISOString();
  return true;
}

function evictEvents(buf: EventBuffer): void {
  // Soft limit: evict oldest unpinned
  while (buf.events.length > buf.maxSize) {
    const idx = buf.events.findIndex((e) => !e.pinned);
    if (idx === -1) break;
    buf.events.splice(idx, 1);
  }

  // If still over soft limit (all pinned): evict old approval_result events first.
  while (buf.events.length > buf.maxSize) {
    const idx = buf.events.findIndex((e) => e.type === "approval_result");
    if (idx === -1) break;
    buf.events.splice(idx, 1);
  }

  // Hard limit: force evict
  while (buf.events.length > buf.hardMaxSize) {
    buf.events.shift();
  }
}

function toPublicInfo(session: SessionInfo): PublicSessionInfo {
  return {
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    cancelledAt: session.cancelledAt,
    cancelledReason: session.cancelledReason,
    model: session.model,
    approvalPolicy: session.approvalPolicy,
    sandbox: session.sandbox,
    pendingRequestCount: Array.from(session.pendingRequests.values()).filter((r) => !r.resolved)
      .length,
  };
}

function toSensitiveInfo(session: SessionInfo): SensitiveSessionInfo {
  return {
    ...toPublicInfo(session),
    threadId: session.threadId,
    cwd: session.cwd,
    profile: session.profile,
    config: session.config,
  };
}

function buildCommandApprovalResponse(
  decision: string,
  execpolicyAmendment?: string[]
): CommandApprovalResponse {
  if (decision === "acceptWithExecpolicyAmendment") {
    if (!execpolicyAmendment || execpolicyAmendment.length === 0) {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: execpolicyAmendment required for acceptWithExecpolicyAmendment`
      );
    }
    return {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: execpolicyAmendment,
        },
      },
    };
  }
  return { decision: decision as "accept" | "acceptForSession" | "decline" | "cancel" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract thread id from either v1 ({threadId}) or v2 ({thread:{id}}) responses. */
function extractThreadId(result: unknown): string {
  if (!isRecord(result)) {
    throw new Error(`Error [${ErrorCode.INTERNAL}]: Invalid thread response: expected object`);
  }

  const direct = result.threadId;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const thread = result.thread;
  if (isRecord(thread) && typeof thread.id === "string" && thread.id.length > 0) return thread.id;

  throw new Error(`Error [${ErrorCode.INTERNAL}]: Invalid thread response: missing thread id`);
}

/** Extract turn id from either v1 ({turnId}) or v2 ({turn:{id}}) responses. */
function extractTurnId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;

  const direct = result.turnId;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const turn = result.turn;
  if (isRecord(turn) && typeof turn.id === "string" && turn.id.length > 0) return turn.id;

  return undefined;
}

/**
 * MCP Server definition — registers tools and handles requests.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager, type SessionManagerOptions } from "./session/manager.js";
import { executeCodex } from "./tools/codex.js";
import { executeCodexReply } from "./tools/codex-reply.js";
import { executeCodexSession } from "./tools/codex-session.js";
import { executeCodexCheck } from "./tools/codex-check.js";
import { registerResources } from "./resources/register-resources.js";
import {
  APPROVAL_POLICIES,
  SANDBOX_MODES,
  PERSONALITIES,
  EFFORT_LEVELS,
  SUMMARY_MODES,
  SESSION_ACTIONS,
  CHECK_ACTIONS,
  RESPONSE_MODES,
  ALL_DECISIONS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  POLL_DEFAULT_MAX_EVENTS,
  POLL_MIN_MAX_EVENTS,
  RESPOND_DEFAULT_MAX_EVENTS,
  DEFAULT_EFFORT_LEVEL,
  ErrorCode,
} from "./types.js";
import { redactPaths } from "./utils/redact.js";

declare const __PKG_VERSION__: string;
const SERVER_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

function formatErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const m = /^Error \[([A-Z_]+)\]:\s*(.*)$/.exec(message);
  if (m) {
    const [, code, rest] = m;
    if (code === ErrorCode.INTERNAL) {
      return `Error [${ErrorCode.INTERNAL}]: ${redactPaths(rest)}`;
    }
    return message;
  }
  return `Error [${ErrorCode.INTERNAL}]: ${redactPaths(message)}`;
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  // MCP structuredContent is object-shaped; wrap non-object payloads for compatibility.
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

export function createServer(
  serverCwd: string,
  options?: SessionManagerOptions & { clientMode?: string }
): McpServer {
  const sessionManager = new SessionManager(options);

  const server = new McpServer({
    name: "codex-mcp",
    version: SERVER_VERSION,
  });

  // Read-only MCP resources (helpful docs / metadata)
  registerResources(server, {
    version: SERVER_VERSION,
    sessionManager,
    clientMode: options?.clientMode,
  });

  const publicSessionInfoSchema = z.object({
    sessionId: z.string(),
    status: z.enum(["running", "idle", "waiting_approval", "error", "cancelled"]),
    createdAt: z.string(),
    lastActiveAt: z.string(),
    cancelledAt: z.string().optional(),
    cancelledReason: z.string().optional(),
    model: z.string().optional(),
    approvalPolicy: z.enum(APPROVAL_POLICIES).optional(),
    sandbox: z.enum(SANDBOX_MODES).optional(),
    pendingRequestCount: z.number().int(),
  });

  const errorOutputShape = {
    error: z.string().optional(),
    isError: z.boolean().optional(),
  };

  const sessionStartOutputShape = {
    sessionId: z.string().optional(),
    threadId: z.string().optional(),
    status: z.enum(["running", "idle"]).optional(),
    pollInterval: z
      .number()
      .int()
      .optional()
      .describe(
        "Recommended minimum delay before next poll (ms): running >=120000, waiting_approval ~=1000."
      ),
    ...errorOutputShape,
  };

  const codexCheckPollOptionsSchema = z
    .object({
      includeEvents: z
        .boolean()
        .optional()
        .describe("Default: true. Include events[] in response."),
      includeActions: z
        .boolean()
        .optional()
        .describe("Default: true. Include actions[] in response."),
      includeResult: z.boolean().optional().describe("Default: true. Include result in response."),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Default: unlimited. Best-effort response payload cap in bytes."),
    })
    .optional()
    .describe("Optional poll shaping controls.");

  const codexCheckInputSchema = z
    .object({
      action: z.enum(CHECK_ACTIONS),
      sessionId: z.string().describe("Target session ID"),
      cursor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Event cursor (default: session last consumed cursor)."),
      maxEvents: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          `Max events. Default: poll=${POLL_DEFAULT_MAX_EVENTS} (min ${POLL_MIN_MAX_EVENTS}), respond_*=${RESPOND_DEFAULT_MAX_EVENTS}.`
        ),
      responseMode: z
        .enum(RESPONSE_MODES)
        .optional()
        .describe("Response mode. Default: minimal. Options: minimal/delta_compact/full."),
      pollOptions: codexCheckPollOptionsSchema,
      // respond_permission
      requestId: z.string().optional().describe("Request ID from actions[]"),
      decision: z
        .enum(ALL_DECISIONS)
        .optional()
        .describe(
          "Approval decision for respond_permission. acceptWithExecpolicyAmendment requires execpolicy_amendment; applyNetworkPolicyAmendment requires network_policy_amendment."
        ),
      execpolicy_amendment: z
        .array(z.string())
        .optional()
        .describe("For acceptWithExecpolicyAmendment only"),
      network_policy_amendment: z
        .object({
          action: z.enum(["allow", "deny"]),
          host: z.string().min(1),
        })
        .optional()
        .describe("For applyNetworkPolicyAmendment only"),
      denyMessage: z.string().optional().describe("Deny reason (not sent to agent)"),
      // respond_user_input
      answers: z
        .record(
          z.string(),
          z.object({
            answers: z.array(z.string()),
          })
        )
        .optional()
        .describe("question-id -> answers map (id from actions[] user_input request)."),
    })
    .superRefine((value, ctx) => {
      const addIssue = (path: string, message: string) => {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message,
        });
      };

      switch (value.action) {
        case "poll": {
          if (value.maxEvents !== undefined && value.maxEvents < POLL_MIN_MAX_EVENTS) {
            addIssue(
              "maxEvents",
              `poll requires maxEvents >= ${POLL_MIN_MAX_EVENTS} to avoid no-op loops.`
            );
          }
          if (value.requestId !== undefined) {
            addIssue("requestId", "requestId is only allowed for respond_* actions.");
          }
          if (value.decision !== undefined) {
            addIssue("decision", "decision is only allowed for action='respond_permission'.");
          }
          if (value.execpolicy_amendment !== undefined) {
            addIssue(
              "execpolicy_amendment",
              "execpolicy_amendment is only allowed for action='respond_permission'."
            );
          }
          if (value.network_policy_amendment !== undefined) {
            addIssue(
              "network_policy_amendment",
              "network_policy_amendment is only allowed for action='respond_permission'."
            );
          }
          if (value.denyMessage !== undefined) {
            addIssue("denyMessage", "denyMessage is only allowed for action='respond_permission'.");
          }
          if (value.answers !== undefined) {
            addIssue("answers", "answers is only allowed for action='respond_user_input'.");
          }
          break;
        }
        case "respond_permission": {
          if (!value.requestId) {
            addIssue("requestId", "requestId is required for action='respond_permission'.");
          }
          if (!value.decision) {
            addIssue("decision", "decision is required for action='respond_permission'.");
          }
          if (value.answers !== undefined) {
            addIssue("answers", "answers is only allowed for action='respond_user_input'.");
          }
          const needsExecpolicy = value.decision === "acceptWithExecpolicyAmendment";
          const needsNetworkPolicy = value.decision === "applyNetworkPolicyAmendment";
          if (
            needsExecpolicy &&
            (!value.execpolicy_amendment || value.execpolicy_amendment.length === 0)
          ) {
            addIssue(
              "execpolicy_amendment",
              "execpolicy_amendment is required and must be non-empty when decision='acceptWithExecpolicyAmendment'."
            );
          }
          if (!needsExecpolicy && value.execpolicy_amendment !== undefined) {
            addIssue(
              "execpolicy_amendment",
              "execpolicy_amendment is only allowed when decision='acceptWithExecpolicyAmendment'."
            );
          }

          if (needsNetworkPolicy && !value.network_policy_amendment) {
            addIssue(
              "network_policy_amendment",
              "network_policy_amendment is required when decision='applyNetworkPolicyAmendment'."
            );
          }
          if (!needsNetworkPolicy && value.network_policy_amendment !== undefined) {
            addIssue(
              "network_policy_amendment",
              "network_policy_amendment is only allowed when decision='applyNetworkPolicyAmendment'."
            );
          }
          break;
        }
        case "respond_user_input": {
          if (!value.requestId) {
            addIssue("requestId", "requestId is required for action='respond_user_input'.");
          }
          if (!value.answers) {
            addIssue("answers", "answers is required for action='respond_user_input'.");
          }
          if (value.decision !== undefined) {
            addIssue("decision", "decision is only allowed for action='respond_permission'.");
          }
          if (value.execpolicy_amendment !== undefined) {
            addIssue(
              "execpolicy_amendment",
              "execpolicy_amendment is only allowed for action='respond_permission'."
            );
          }
          if (value.network_policy_amendment !== undefined) {
            addIssue(
              "network_policy_amendment",
              "network_policy_amendment is only allowed for action='respond_permission'."
            );
          }
          if (value.denyMessage !== undefined) {
            addIssue("denyMessage", "denyMessage is only allowed for action='respond_permission'.");
          }
          break;
        }
      }
    });

  // ── Tool 1: codex — Start a new Codex agent session ──────────────

  server.registerTool(
    "codex",
    {
      title: "Start Codex Session",
      description:
        "Start session asynchronously and return `{ sessionId, threadId, status, pollInterval }`. Use `pollInterval` as a minimum hint: `running` >=120000ms (increase for long tasks), `waiting_approval` ~=1000ms.",
      inputSchema: {
        prompt: z.string().describe("Task or question"),
        approvalPolicy: z
          .enum(APPROVAL_POLICIES)
          .describe("Required enum: untrusted/on-failure/on-request/never."),
        sandbox: z
          .enum(SANDBOX_MODES)
          .describe("Required enum: read-only/workspace-write/danger-full-access."),
        effort: z
          .enum(EFFORT_LEVELS)
          .default(DEFAULT_EFFORT_LEVEL)
          .describe("Reasoning effort (default: low)."),
        cwd: z.string().optional().describe("Working directory (default: server cwd)."),
        model: z.string().optional().describe("Model override (default: config.toml)"),
        profile: z.string().optional().describe("Profile name (default: CLI default profile)."),
        advanced: z
          .object({
            baseInstructions: z.string().optional().describe("Replace system instructions."),
            developerInstructions: z.string().optional().describe("Extra developer instructions."),
            personality: z
              .enum(PERSONALITIES)
              .optional()
              .describe("Personality (default: config.toml)."),
            summary: z
              .enum(SUMMARY_MODES)
              .optional()
              .describe("Summary mode (default: config.toml)."),
            config: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("Override config values."),
            ephemeral: z.boolean().optional().describe("Do not persist thread (default: false)."),
            outputSchema: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("Structured output schema."),
            images: z.array(z.string()).optional().describe("Local image paths."),
            approvalTimeoutMs: z
              .number()
              .int()
              .positive()
              .default(DEFAULT_APPROVAL_TIMEOUT_MS)
              .optional()
              .describe(`Auto-decline timeout in ms (default: ${DEFAULT_APPROVAL_TIMEOUT_MS})`),
          })
          .optional()
          .describe("Advanced settings."),
      },
      outputSchema: sessionStartOutputShape,
      annotations: {
        title: "Start Codex Session",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await executeCodex(args, sessionManager, serverCwd);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: toStructuredContent(result),
          isError: false,
        };
      } catch (err: unknown) {
        const message = formatErrorMessage(err);
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: { error: message, isError: true },
          isError: true,
        };
      }
    }
  );

  // ── Tool 2: codex_reply — Continue an existing session ───────────

  server.registerTool(
    "codex_reply",
    {
      title: "Continue Codex Session",
      description:
        "Continue existing session. Allowed in `idle`/`error`; otherwise `SESSION_BUSY`. Returns immediately. Use `pollInterval` as a minimum hint: `running` >=120000ms, `waiting_approval` ~=1000ms.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from codex tool"),
        prompt: z.string().describe("Follow-up message"),
        model: z.string().optional().describe("Override model."),
        approvalPolicy: z.enum(APPROVAL_POLICIES).optional().describe("Override approval policy."),
        effort: z.enum(EFFORT_LEVELS).optional().describe("Override effort."),
        summary: z.enum(SUMMARY_MODES).optional().describe("Override summary."),
        personality: z.enum(PERSONALITIES).optional().describe("Override personality."),
        sandbox: z.enum(SANDBOX_MODES).optional().describe("Override sandbox."),
        cwd: z.string().optional().describe("Override cwd."),
        outputSchema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Structured output schema override (top-level in codex_reply)."),
      },
      outputSchema: sessionStartOutputShape,
      annotations: {
        title: "Continue Codex Session",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await executeCodexReply(args, sessionManager);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: toStructuredContent(result),
          isError: false,
        };
      } catch (err: unknown) {
        const message = formatErrorMessage(err);
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: { error: message, isError: true },
          isError: true,
        };
      }
    }
  );

  // ── Tool 3: codex_session — Manage sessions ──────────────────────

  server.registerTool(
    "codex_session",
    {
      title: "Manage Sessions",
      description: `Session actions: list, get, cancel, interrupt, fork, clean_background_terminals.

- list: sessions in memory.
- get: details. includeSensitive defaults to false; true adds threadId/cwd/profile/config.
- cancel: terminal.
- interrupt: stop current turn.
- fork: clone current thread into a new session; source remains unchanged.
- clean_background_terminals: ask app-server to clean stale background terminals for this thread.`,
      inputSchema: {
        action: z.enum(SESSION_ACTIONS),
        sessionId: z
          .string()
          .optional()
          .describe("Required for get/cancel/interrupt/fork/clean_background_terminals"),
        includeSensitive: z
          .boolean()
          .default(false)
          .optional()
          .describe("Include cwd/config/threadId/profile in get (default: false)"),
      },
      outputSchema: {
        sessions: z.array(publicSessionInfoSchema).optional(),
        sessionId: z.string().optional(),
        status: z.enum(["running", "idle", "waiting_approval", "error", "cancelled"]).optional(),
        createdAt: z.string().optional(),
        lastActiveAt: z.string().optional(),
        cancelledAt: z.string().optional(),
        cancelledReason: z.string().optional(),
        model: z.string().optional(),
        approvalPolicy: z.enum(APPROVAL_POLICIES).optional(),
        sandbox: z.enum(SANDBOX_MODES).optional(),
        pendingRequestCount: z.number().int().optional(),
        threadId: z.string().optional(),
        cwd: z.string().optional(),
        profile: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        pollInterval: z
          .number()
          .int()
          .optional()
          .describe(
            "Recommended minimum delay before next poll (ms): running >=120000, waiting_approval ~=1000."
          ),
        success: z.boolean().optional(),
        message: z.string().optional(),
        ...errorOutputShape,
      },
      annotations: {
        title: "Manage Sessions",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = await executeCodexSession(args, sessionManager);
        const isError =
          typeof (result as { isError?: boolean }).isError === "boolean"
            ? (result as { isError: boolean }).isError
            : false;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: toStructuredContent(result),
          isError,
        };
      } catch (err: unknown) {
        const message = formatErrorMessage(err);
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: { error: message, isError: true },
          isError: true,
        };
      }
    }
  );

  // ── Tool 4: codex_check — Poll events + respond to requests ──────

  server.registerTool(
    "codex_check",
    {
      title: "Poll & Respond",
      description: `Poll session for events or respond to approval/input requests.

POLLING FREQUENCY: Do NOT poll every turn. Codex tasks take minutes, not seconds.
- Treat pollInterval as a minimum hint, not a fixed schedule.
- "running": sleep at least 2 minutes between polls; increase for complex tasks. Do NOT high-frequency poll — it wastes tokens and provides no benefit.
- "waiting_approval": poll about every 1000ms and respond quickly to actions[].
- When status is "idle"/"error"/"cancelled": stop polling, the session is done.
- Adapt interval based on task complexity and whether the previous poll returned new events.

poll: events since cursor. Default maxEvents=${POLL_DEFAULT_MAX_EVENTS}.

respond_permission: approval decision. Default maxEvents=${RESPOND_DEFAULT_MAX_EVENTS} (compact ACK).

respond_user_input: user-input answers. Default maxEvents=${RESPOND_DEFAULT_MAX_EVENTS} (compact ACK).

events[].type is coarse-grained; details are in events[].data.method.
cursor omitted => use session last cursor. cursorResetTo => reset and continue.`,
      inputSchema: codexCheckInputSchema,
      outputSchema: {
        sessionId: z.string().optional(),
        status: z.enum(["running", "idle", "waiting_approval", "error", "cancelled"]).optional(),
        pollInterval: z
          .number()
          .int()
          .optional()
          .describe(
            "Recommended minimum delay before next poll (ms): running >=120000, waiting_approval ~=1000."
          ),
        events: z
          .array(
            z.object({
              id: z.number().int(),
              type: z.enum([
                "output",
                "progress",
                "approval_request",
                "approval_result",
                "result",
                "error",
              ]),
              data: z.unknown(),
              timestamp: z.string(),
            })
          )
          .optional(),
        nextCursor: z.number().int().optional(),
        cursorResetTo: z.number().int().optional(),
        actions: z
          .array(
            z.object({
              type: z.enum(["approval", "user_input"]),
              requestId: z.string(),
              kind: z.enum(["command", "fileChange", "user_input"]),
              params: z.unknown(),
              itemId: z.string(),
              reason: z.string().optional(),
              approvalId: z.string().optional(),
              commandActions: z.array(z.unknown()).nullable().optional(),
              proposedExecpolicyAmendment: z.array(z.string()).nullable().optional(),
              createdAt: z.string(),
            })
          )
          .optional(),
        result: z
          .object({
            turnId: z.string(),
            output: z.string().optional(),
            structuredOutput: z.unknown().optional(),
            turn: z.unknown().optional(),
            status: z.string().optional(),
            turnError: z.unknown().optional(),
            error: z.string().optional(),
            completedAt: z.string(),
          })
          .optional(),
        compatWarnings: z.array(z.string()).optional(),
        truncated: z.boolean().optional(),
        truncatedFields: z.array(z.string()).optional(),
        ...errorOutputShape,
      },
      annotations: {
        title: "Poll & Respond",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = executeCodexCheck(args, sessionManager);
        const isError =
          typeof (result as { isError?: boolean }).isError === "boolean"
            ? (result as { isError: boolean }).isError
            : false;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: toStructuredContent(result),
          isError,
        };
      } catch (err: unknown) {
        const message = formatErrorMessage(err);
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: { error: message, isError: true },
          isError: true,
        };
      }
    }
  );

  // Cleanup on server close
  const originalClose = server.close.bind(server);
  server.close = async () => {
    sessionManager.destroy();
    await originalClose();
  };

  return server;
}

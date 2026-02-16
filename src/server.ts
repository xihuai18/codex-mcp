/**
 * MCP Server definition — registers tools and handles requests.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager } from "./session/manager.js";
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
  ALL_DECISIONS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_MAX_EVENTS,
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

export function createServer(serverCwd: string): McpServer {
  const sessionManager = new SessionManager();

  const server = new McpServer({
    name: "codex-mcp",
    version: SERVER_VERSION,
  });

  // Read-only MCP resources (helpful docs / metadata)
  registerResources(server, { version: SERVER_VERSION });

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
    pollInterval: z.number().int().optional(),
    ...errorOutputShape,
  };

  // ── Tool 1: codex — Start a new Codex agent session ──────────────

  server.registerTool(
    "codex",
    {
      title: "Start Codex Session",
      description:
        "Start a Codex agent session. Returns sessionId — poll codex_check for results. Async subprocess, inherits ~/.codex/config.toml. approvalPolicy, sandbox, and effort are required — caller must set based on its permission level and task complexity.",
      inputSchema: {
        prompt: z.string().describe("Task or question"),
        approvalPolicy: z
          .enum(APPROVAL_POLICIES)
          .describe("Command approval policy — set based on caller's permission level"),
        sandbox: z
          .enum(SANDBOX_MODES)
          .describe("Sandbox mode — set based on caller's permission level"),
        effort: z
          .enum(EFFORT_LEVELS)
          .describe("Reasoning effort: low/medium for simple tasks, high/xhigh for complex ones"),
        cwd: z.string().optional().describe("Working directory (default: server cwd)"),
        model: z.string().optional().describe("Model override (default: config.toml)"),
        profile: z.string().optional().describe("config.toml profile name"),
        advanced: z
          .object({
            baseInstructions: z.string().optional().describe("Replace default system instructions"),
            developerInstructions: z
              .string()
              .optional()
              .describe("Additional developer instructions"),
            personality: z
              .enum(PERSONALITIES)
              .optional()
              .describe("Personality (default: config.toml)"),
            summary: z
              .enum(SUMMARY_MODES)
              .optional()
              .describe("Summary mode (default: config.toml)"),
            config: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("Override config.toml values"),
            ephemeral: z.boolean().optional().describe("Don't persist thread (default: false)"),
            outputSchema: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("JSON Schema for structured output"),
            images: z.array(z.string()).optional().describe("Local image file paths"),
            approvalTimeoutMs: z
              .number()
              .int()
              .positive()
              .default(DEFAULT_APPROVAL_TIMEOUT_MS)
              .optional()
              .describe("Auto-decline timeout in ms"),
          })
          .optional()
          .describe("Low-frequency settings"),
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
          structuredContent: result as unknown as Record<string, unknown>,
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
        "Follow-up to existing session. Retains full context. Returns immediately — poll codex_check. Overrides apply to this and subsequent turns.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from codex tool"),
        prompt: z.string().describe("Follow-up message"),
        model: z.string().optional().describe("Override model"),
        approvalPolicy: z.enum(APPROVAL_POLICIES).optional().describe("Override approval policy"),
        effort: z.enum(EFFORT_LEVELS).optional().describe("Override effort"),
        summary: z.enum(SUMMARY_MODES).optional().describe("Override summary"),
        personality: z.enum(PERSONALITIES).optional().describe("Override personality"),
        sandbox: z.enum(SANDBOX_MODES).optional().describe("Override sandbox"),
        cwd: z.string().optional().describe("Override cwd"),
        outputSchema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON Schema for structured output"),
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
          structuredContent: result as unknown as Record<string, unknown>,
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
      description: `Manage sessions: list, inspect, interrupt, fork, or cancel.

- action="list": All sessions with status/settings.
- action="get": Session details. includeSensitive=true for cwd/config.
- action="cancel": Stop session immediately.
- action="interrupt": Interrupt current turn, keep session alive.
- action="fork": Branch new session from current thread state.`,
      inputSchema: {
        action: z.enum(SESSION_ACTIONS),
        sessionId: z.string().optional().describe("Required for get/cancel/interrupt/fork"),
        includeSensitive: z
          .boolean()
          .default(false)
          .optional()
          .describe("Include cwd/config in get"),
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
        pollInterval: z.number().int().optional(),
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
          structuredContent: result as unknown as Record<string, unknown>,
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

poll: Events since cursor (output, progress, approvals, errors, result). Returns nextCursor + actions[] if awaiting response.

respond_approval: Respond to approval. Pass requestId + decision.

respond_user_input: Answer input request. Pass requestId + answers.`,
      inputSchema: {
        action: z.enum(CHECK_ACTIONS),
        sessionId: z.string().describe("Target session ID"),
        cursor: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Event offset; omit to continue from session's last consumed cursor"),
        maxEvents: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_MAX_EVENTS)
          .optional()
          .describe("Max events per poll"),
        // respond_approval
        requestId: z.string().optional().describe("Request ID from actions[]"),
        decision: z
          .enum(ALL_DECISIONS)
          .optional()
          .describe(
            "Approval decision: accept / acceptForSession / acceptWithExecpolicyAmendment / decline / cancel"
          ),
        execpolicyAmendment: z
          .array(z.string())
          .optional()
          .describe("For acceptWithExecpolicyAmendment only"),
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
          .describe("questionId → answers map"),
      },
      outputSchema: {
        sessionId: z.string().optional(),
        status: z.enum(["running", "idle", "waiting_approval", "error", "cancelled"]).optional(),
        pollInterval: z.number().int().optional(),
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
              kind: z.string(),
              params: z.unknown(),
              itemId: z.string(),
              reason: z.string().optional(),
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
          structuredContent: result as unknown as Record<string, unknown>,
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

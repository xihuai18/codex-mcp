/**
 * ExecClient — codex exec --json based client.
 *
 * Fallback for codex variants that don't support app-server.
 * Spawns `codex exec "<prompt>" --json --skip-git-repo-check` per turn
 * and transforms JSONL stdout events into the app-server notification format
 * that SessionManager expects.
 */
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import type { ICodexClient } from "./client-interface.js";
import type { AppServerSpawnOptions } from "./lifecycle.js";
import {
  type RequestId,
  type InitializeResult,
  type ThreadStartParams,
  type ThreadStartResult,
  type ThreadForkParams,
  type ThreadForkResult,
  type ThreadResumeParams,
  type ThreadResumeResult,
  type ThreadBackgroundTerminalsCleanParams,
  type TurnStartParams,
  type TurnStartResult,
  type TurnInterruptParams,
  type SandboxPolicy,
  Methods,
} from "./protocol.js";
import { resolveCodexInvocation } from "./codex-bin.js";
import { ErrorCode } from "../types.js";

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (id: RequestId, method: string, params: unknown) => void;

const FORCE_KILL_TIMEOUT_MS = 5_000;

/**
 * Convert snake_case item type from exec JSONL to camelCase used by app-server protocol.
 */
function camelCaseItemType(snakeType: string): string {
  return snakeType.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Deep-transform item object: convert `type` field from snake_case to camelCase.
 */
function transformItem(item: Record<string, unknown>): Record<string, unknown> {
  const result = { ...item };
  if (typeof result.type === "string") {
    result.type = camelCaseItemType(result.type);
  }
  return result;
}

/**
 * Detect whether an exec `{"type":"error"}` event is a transient/retryable error
 * (e.g. "Reconnecting... n/5") vs a terminal failure.
 */
function isRetryableError(event: Record<string, unknown>): boolean {
  const msg = typeof event.message === "string" ? event.message : "";
  return /reconnect/i.test(msg) || /\d+\/\d+/.test(msg);
}

/**
 * Reverse-map SandboxPolicy object back to sandbox mode string for -s flag.
 */
function sandboxPolicyToMode(policy: SandboxPolicy): string | undefined {
  switch (policy.type) {
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
      return "workspace-write";
    case "dangerFullAccess":
      return "danger-full-access";
    case "externalSandbox":
      // externalSandbox has no direct CLI equivalent; log and return undefined
      // so the caller falls back to thread/spawn-level sandbox.
      console.error(
        `[exec-client] SandboxPolicy type "externalSandbox" cannot be mapped to exec -s flag; using thread-level sandbox`
      );
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Map exec JSONL event type (snake_case) to app-server notification method.
 * Covers all events from codex-schema/EventMsg.json that have corresponding
 * app-server notification methods in SessionManager.registerHandlers().
 */
const EXEC_EVENT_TO_METHOD: Record<string, string> = {
  // Agent message deltas
  agent_message_delta: Methods.AGENT_MESSAGE_DELTA,
  agent_message_content_delta: Methods.AGENT_MESSAGE_DELTA,

  // Command execution
  exec_command_output_delta: Methods.COMMAND_OUTPUT_DELTA,
  command_output_delta: Methods.COMMAND_OUTPUT_DELTA,
  terminal_interaction: Methods.COMMAND_TERMINAL_INTERACTION,

  // File changes
  file_change_output_delta: Methods.FILE_CHANGE_OUTPUT_DELTA,

  // Reasoning
  reasoning_content_delta: Methods.REASONING_TEXT_DELTA,
  reasoning_raw_content_delta: Methods.REASONING_TEXT_DELTA,
  agent_reasoning_delta: Methods.REASONING_TEXT_DELTA,
  agent_reasoning_raw_content_delta: Methods.REASONING_TEXT_DELTA,
  reasoning_summary_delta: Methods.REASONING_SUMMARY_DELTA,
  agent_reasoning_section_break: Methods.REASONING_SUMMARY_PART_ADDED,

  // Plan
  plan_delta: Methods.PLAN_DELTA,
  plan_update: Methods.TURN_PLAN_UPDATED,

  // Turn-level
  turn_diff: Methods.TURN_DIFF_UPDATED,
  diff_update: Methods.TURN_DIFF_UPDATED,

  // MCP
  mcp_tool_call_begin: Methods.MCP_TOOL_PROGRESS,
  mcp_tool_call_end: Methods.MCP_TOOL_PROGRESS,
  mcp_startup_update: Methods.MCP_TOOL_PROGRESS,
  mcp_startup_complete: Methods.MCP_TOOL_PROGRESS,

  // Model routing
  model_reroute: Methods.MODEL_REROUTED,

  // Thread/session events
  thread_name_updated: Methods.THREAD_NAME_UPDATED,
  token_count: Methods.THREAD_TOKEN_USAGE_UPDATED,
  session_configured: Methods.SESSION_CONFIGURED,

  // Item lifecycle (in case exec emits these outside the dot-notation variants)
  item_started: Methods.ITEM_STARTED,
  item_completed: Methods.ITEM_COMPLETED,
  raw_response_item: Methods.RAW_RESPONSE_ITEM_COMPLETED,

  // Stream errors — map to error method so retryable detection can handle it
  stream_error: Methods.ERROR,

  // Legacy turn lifecycle (v1 wire format used by older CLIs)
  // These are critical for exec fallback since it targets CLIs without app-server.
  task_started: Methods.TURN_STARTED,
  task_complete: Methods.TURN_COMPLETED,
  turn_aborted: Methods.TURN_COMPLETED,
};

export class ExecClient extends EventEmitter implements ICodexClient {
  private _destroyed = false;
  private process: ChildProcess | null = null;
  private spawnOpts: AppServerSpawnOptions | null = null;

  // Thread/turn state
  private threadId: string | null = null;
  /** Real thread ID from CLI (received via thread.started event). Used for exec resume. */
  private realThreadId: string | null = null;
  private turnId: string | null = null;
  private turnCount = 0;
  private threadStartParams: ThreadStartParams | null = null;
  private lastAgentMessageText = "";
  private turnCompleted = false;

  // Handlers
  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;

  // Stdout buffer for JSONL parsing
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  get destroyed(): boolean {
    return this._destroyed;
  }

  get supportsTurnOverrides(): boolean {
    // After the first turn, exec resume does not support -s/-p/-C overrides
    return this.turnCount <= 1 || this.realThreadId == null;
  }

  async start(opts: AppServerSpawnOptions): Promise<InitializeResult> {
    if (this._destroyed) throw new Error("Client destroyed");
    this.spawnOpts = opts;
    return { userAgent: "codex-exec" };
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResult> {
    if (this._destroyed) throw new Error("Client destroyed");
    this.threadStartParams = params;
    this.threadId = `exec_thread_${randomUUID().slice(0, 12)}`;
    return { thread: { id: this.threadId } };
  }

  async threadFork(_params: ThreadForkParams): Promise<ThreadForkResult> {
    throw new Error(
      `Error [${ErrorCode.EXEC_NOT_SUPPORTED}]: threadFork is not supported in exec mode`
    );
  }

  async threadResume(_params: ThreadResumeParams): Promise<ThreadResumeResult> {
    throw new Error(
      `Error [${ErrorCode.EXEC_NOT_SUPPORTED}]: threadResume is not supported in exec mode`
    );
  }

  async threadBackgroundTerminalsClean(
    _params: ThreadBackgroundTerminalsCleanParams
  ): Promise<Record<string, never>> {
    return {};
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    if (this._destroyed) throw new Error("Client destroyed");
    if (!this.threadId) throw new Error("No thread started");

    // Kill any previous turn subprocess
    this.killProcess();

    this.turnCount++;
    this.turnId = `exec_turn_${randomUUID().slice(0, 12)}`;
    this.lastAgentMessageText = "";
    this.turnCompleted = false;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");

    // Extract prompt text from input array
    const prompt = params.input
      .filter((i): i is { type: "text"; text: string } => i.type === "text")
      .map((i) => i.text)
      .join("\n");

    // Extract image paths
    const images = params.input
      .filter((i): i is { type: "localImage"; path: string } => i.type === "localImage")
      .map((i) => i.path);

    // First turn: codex exec "<prompt>" ...
    // Subsequent turns: codex exec resume <threadId> "<prompt>" ... (multi-turn context)
    const isResume = this.turnCount > 1 && this.realThreadId != null;
    if (this.turnCount > 1 && !this.realThreadId) {
      // CLI didn't provide a thread ID (e.g. older CLI without thread.started event).
      // Fall back to fresh exec but warn — multi-turn context will be lost.
      console.error(
        "[exec-client] No realThreadId available for resume; falling back to fresh exec (context will be lost)"
      );
      this.emitNotification(Methods.ERROR, {
        threadId: this.threadId,
        turnId: this.turnId,
        error:
          "exec mode: multi-turn context unavailable (CLI did not provide thread ID). This turn runs without prior context.",
        willRetry: true, // non-terminal: session continues, just without context
      });
    }
    const args = isResume
      ? this.buildResumeArgs(prompt, params, images)
      : this.buildExecArgs(prompt, params, images);
    const invocation = resolveCodexInvocation(args);

    const proc = spawn(invocation.cmd, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
    });
    this.process = proc;

    // Close stdin immediately — exec reads prompt from args
    proc.stdin?.end();

    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[exec-client stderr] ${chunk.toString().trimEnd()}`);
    });

    proc.on("error", (err) => {
      if (!this._destroyed) {
        this.emit("error", err);
      }
    });

    proc.on("exit", (code, signal) => {
      // If turn wasn't completed via JSONL event, synthesize completion
      if (this.turnId && !this._destroyed && !this.turnCompleted) {
        if (code !== 0 && code !== null) {
          this.emitNotification(Methods.ERROR, {
            threadId: this.threadId,
            turnId: this.turnId,
            error: { message: `exec process exited with code ${code}` },
            willRetry: false,
          });
        }
      }
      if (!this._destroyed) {
        this.emit("exit", code, signal);
      }
      this.process = null;
    });

    const turnId = this.turnId;
    return { turn: { id: turnId } };
  }

  async turnInterrupt(_params: TurnInterruptParams): Promise<void> {
    this.killProcess();
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  respondToServer(_id: RequestId, _result: unknown): void {
    // No-op: exec mode has no server-initiated requests
  }

  respondErrorToServer(_id: RequestId, _code: number, _message: string): void {
    // No-op: exec mode has no server-initiated requests
  }

  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;

    const proc = this.process;
    if (proc && !proc.killed) {
      const alreadyExited = proc.exitCode !== null;
      proc.stdin?.end();
      this.killProcess();

      // Force kill after timeout (matches AppServerClient behavior)
      const forceKill = setTimeout(() => {
        if (proc && !proc.killed && proc.exitCode === null) {
          if (process.platform === "win32" && proc.pid) {
            try {
              spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
              });
            } catch {
              // ignore
            }
          } else {
            try {
              if (proc.pid) process.kill(-proc.pid, "SIGKILL");
              else proc.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }
      }, FORCE_KILL_TIMEOUT_MS);
      forceKill.unref();

      if (!alreadyExited) {
        await new Promise<void>((resolve) => {
          proc.on("exit", () => {
            clearTimeout(forceKill);
            resolve();
          });
          const fallback = setTimeout(resolve, FORCE_KILL_TIMEOUT_MS + 1000);
          fallback.unref();
        });
      }
    }

    this.process = null;
    this.removeAllListeners();
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Build args for the first turn: `codex exec "<prompt>" --json --skip-git-repo-check [flags]`.
   * No --ephemeral so the session persists for subsequent resume turns.
   */
  private buildExecArgs(prompt: string, params: TurnStartParams, images: string[]): string[] {
    const args: string[] = ["exec", prompt, "--json", "--skip-git-repo-check"];

    // Model
    const model = params.model ?? this.threadStartParams?.model ?? this.spawnOpts?.model;
    if (model) args.push("-m", model);

    // Sandbox (first turn only — exec resume does not support -s)
    let effectiveSandbox: string | undefined;
    if (params.sandboxPolicy) {
      effectiveSandbox = sandboxPolicyToMode(params.sandboxPolicy);
    }
    if (!effectiveSandbox) {
      effectiveSandbox = this.threadStartParams?.sandbox ?? this.spawnOpts?.sandbox;
    }
    if (effectiveSandbox) args.push("-s", effectiveSandbox);

    // Profile (first turn only — exec resume does not support -p)
    if (this.spawnOpts?.profile) args.push("-p", this.spawnOpts.profile);

    // CWD (first turn only — exec resume does not support -C)
    const cwd = params.cwd ?? this.threadStartParams?.cwd;
    if (cwd) args.push("-C", cwd);

    // Images
    for (const img of images) args.push("-i", img);

    // Approval policy via config override (precise, doesn't affect sandbox)
    const approvalPolicy =
      params.approvalPolicy ??
      this.threadStartParams?.approvalPolicy ??
      this.spawnOpts?.approvalPolicy;
    if (approvalPolicy) args.push("-c", `approval_policy=${approvalPolicy}`);

    // Output schema (exec supports --output-schema <file>; write to temp file)
    if (params.outputSchema && Object.keys(params.outputSchema).length > 0) {
      try {
        const tmpDir = mkdtempSync(join(tmpdir(), "codex-mcp-schema-"));
        const schemaPath = join(tmpDir, "output-schema.json");
        writeFileSync(schemaPath, JSON.stringify(params.outputSchema));
        args.push("--output-schema", schemaPath);
      } catch (err) {
        console.error(
          `[exec-client] Failed to write output schema to temp file: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Config overrides
    const configs: Record<string, unknown> = {
      ...this.spawnOpts?.config,
      ...this.threadStartParams?.config,
    };
    for (const [key, value] of Object.entries(configs)) {
      const serialized =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      args.push("-c", `${key}=${serialized}`);
    }

    return args;
  }

  /**
   * Build args for subsequent turns: `codex exec resume <threadId> "<prompt>" --json [flags]`.
   * Resumes the persisted session for multi-turn context continuity.
   * Note: exec resume only supports -m, -c, -i, --json, --skip-git-repo-check.
   *       -s, -p, -C are NOT supported and inherit from the first turn's session.
   */
  private buildResumeArgs(prompt: string, params: TurnStartParams, images: string[]): string[] {
    const args: string[] = [
      "exec",
      "resume",
      this.realThreadId!,
      prompt,
      "--json",
      "--skip-git-repo-check",
    ];

    // Warn about unsupported overrides in resume mode
    if (params.sandboxPolicy) {
      console.error(
        "[exec-client] sandbox override ignored in resume mode (exec resume does not support -s)"
      );
    }
    if (params.cwd) {
      console.error(
        "[exec-client] cwd override ignored in resume mode (exec resume does not support -C)"
      );
    }
    if (params.outputSchema && Object.keys(params.outputSchema).length > 0) {
      console.error(
        "[exec-client] outputSchema ignored in resume mode (exec resume does not support --output-schema)"
      );
    }

    // Model override (supported in resume)
    const model = params.model ?? this.threadStartParams?.model ?? this.spawnOpts?.model;
    if (model) args.push("-m", model);

    // Images (supported in resume)
    for (const img of images) args.push("-i", img);

    // Approval policy via config override (supported in resume via -c)
    const approvalPolicy =
      params.approvalPolicy ??
      this.threadStartParams?.approvalPolicy ??
      this.spawnOpts?.approvalPolicy;
    if (approvalPolicy) args.push("-c", `approval_policy=${approvalPolicy}`);

    // Config overrides (supported in resume via -c)
    const configs: Record<string, unknown> = {
      ...this.spawnOpts?.config,
      ...this.threadStartParams?.config,
    };
    for (const [key, value] of Object.entries(configs)) {
      const serialized =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      args.push("-c", `${key}=${serialized}`);
    }

    return args;
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;

      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        this.handleExecEvent(event);
      } catch {
        console.error(`[exec-client] Failed to parse JSONL: ${trimmed.slice(0, 200)}`);
      }
    }
  }

  /**
   * Transform exec JSONL event into app-server notification and dispatch.
   */
  private handleExecEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    // Handle structured lifecycle events first (dot-notation from exec --json)
    switch (type) {
      case "thread.started": {
        const cliThreadId = event.thread_id as string | undefined;
        if (cliThreadId) {
          this.threadId = cliThreadId;
          this.realThreadId = cliThreadId;
        }
        this.emitNotification(Methods.THREAD_STARTED, {
          thread: { id: this.threadId },
        });
        return;
      }

      case "turn.started":
        this.emitNotification(Methods.TURN_STARTED, {
          turn: { id: this.turnId, status: "inProgress" },
        });
        return;

      case "item.started": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item) {
          this.emitNotification(Methods.ITEM_STARTED, {
            threadId: this.threadId,
            turnId: this.turnId,
            item: transformItem(item),
          });
        }
        return;
      }

      case "item.completed": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item) {
          const transformed = transformItem(item);
          if (transformed.type === "agentMessage" && typeof transformed.text === "string") {
            this.lastAgentMessageText = transformed.text;
          }
          this.emitNotification(Methods.ITEM_COMPLETED, {
            threadId: this.threadId,
            turnId: this.turnId,
            item: transformed,
          });
        }
        return;
      }

      case "turn.completed": {
        const turnId = this.turnId ?? "";
        this.turnCompleted = true;
        this.emitNotification(Methods.TURN_COMPLETED, {
          threadId: this.threadId,
          turn: {
            id: turnId,
            status: "completed",
            output: this.lastAgentMessageText || undefined,
            usage: event.usage,
          },
        });
        this.turnId = null;
        return;
      }

      case "turn.failed": {
        const turnId = this.turnId ?? "";
        const error = event.error as Record<string, unknown> | undefined;
        this.turnCompleted = true;
        this.emitNotification(Methods.TURN_COMPLETED, {
          threadId: this.threadId,
          turn: {
            id: turnId,
            status: "failed",
            error: error ?? { message: "Turn failed" },
          },
        });
        this.turnId = null;
        return;
      }

      case "error": {
        const willRetry = isRetryableError(event);
        this.emitNotification(Methods.ERROR, {
          threadId: this.threadId,
          turnId: this.turnId,
          error: event.message ?? event.error,
          willRetry,
        });
        return;
      }

      default:
        break;
    }

    // Map snake_case event types to app-server notification methods
    const mappedMethod = EXEC_EVENT_TO_METHOD[type];
    if (mappedMethod) {
      // Legacy turn lifecycle events need turn object synthesis
      if (type === "task_started") {
        const turnId = (event.turn_id as string) ?? this.turnId;
        if (turnId) this.turnId = turnId;
        this.emitNotification(Methods.TURN_STARTED, {
          turn: { id: this.turnId, status: "inProgress" },
        });
      } else if (type === "task_complete") {
        const turnId = this.turnId ?? "";
        this.turnCompleted = true;
        this.emitNotification(Methods.TURN_COMPLETED, {
          threadId: this.threadId,
          turn: {
            id: turnId,
            status: "completed",
            output: this.lastAgentMessageText || undefined,
          },
        });
        this.turnId = null;
      } else if (type === "turn_aborted") {
        const turnId = this.turnId ?? "";
        this.turnCompleted = true;
        this.emitNotification(Methods.TURN_COMPLETED, {
          threadId: this.threadId,
          turn: {
            id: turnId,
            status: "cancelled",
            error: event.reason ?? { message: "Turn aborted" },
          },
        });
        this.turnId = null;
      } else if (mappedMethod === Methods.ERROR) {
        // For stream_error, apply retryable detection
        this.emitNotification(Methods.ERROR, {
          threadId: this.threadId,
          turnId: this.turnId,
          error: event.message ?? event.error ?? type,
          willRetry: isRetryableError(event),
        });
      } else {
        this.emitNotification(mappedMethod, {
          threadId: this.threadId,
          turnId: this.turnId,
          ...event,
        });
      }
      return;
    }

    // Unmapped events: log but don't emit to avoid silent drops in manager.
    // The manager's default branch ignores unknown methods, so emitting them
    // would be misleading. Logging ensures visibility during debugging.
    console.error(`[exec-client] Unmapped exec event type: ${type}`);
  }

  private emitNotification(method: string, params: unknown): void {
    if (this.notificationHandler) {
      this.notificationHandler(method, params);
    }
  }

  private killProcess(): void {
    if (!this.process || this.process.killed) return;

    if (process.platform !== "win32" && this.process.pid) {
      try {
        process.kill(-this.process.pid, "SIGTERM");
        return;
      } catch {
        // Fall through to direct kill
      }
    }

    try {
      this.process.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

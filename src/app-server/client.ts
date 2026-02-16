/**
 * AppServerClient — JSON-RPC client for codex app-server subprocess.
 *
 * Manages a single codex app-server child process via stdio.
 * Handles request/response correlation, notifications, and server-initiated requests.
 */
import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
import {
  type RequestId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcMessage,
  type InitializeParams,
  type InitializeResult,
  type ThreadStartParams,
  type ThreadStartResult,
  type ThreadForkParams,
  type ThreadForkResult,
  type ThreadResumeParams,
  type ThreadResumeResult,
  type TurnStartParams,
  type TurnStartResult,
  type TurnInterruptParams,
  Methods,
} from "./protocol.js";
import { buildAppServerArgs, type AppServerSpawnOptions } from "./lifecycle.js";
import { resolveCodexInvocation } from "./codex-bin.js";

declare const __PKG_VERSION__: string;
const CLIENT_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

const DEFAULT_REQUEST_TIMEOUT = 30_000;
const STARTUP_REQUEST_TIMEOUT = 90_000;
const MAX_WRITE_QUEUE_BYTES = 5 * 1024 * 1024; // 5MB

interface PendingRpcRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (id: RequestId, method: string, params: unknown) => void;

export class AppServerClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<RequestId, PendingRpcRequest>();
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private _destroyed = false;
  private lastFailure: Error | null = null;
  private backpressure = false;
  private writeQueue: string[] = [];
  private queuedBytes = 0;
  private spawnedViaCmd = false;
  private spawnedDetached = false;

  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;

  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Spawn codex app-server and perform initialization handshake.
   */
  async start(opts: AppServerSpawnOptions): Promise<InitializeResult> {
    const args = buildAppServerArgs(opts);
    const env = { ...process.env };
    const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

    const invocation = resolveCodexInvocation(args);
    this.spawnedViaCmd = invocation.spawnedViaCmd;
    this.spawnedDetached = process.platform !== "win32";

    const proc = spawn(invocation.cmd, invocation.args, {
      stdio,
      env,
      detached: this.spawnedDetached,
      windowsHide: process.platform === "win32",
    });
    this.process = proc;

    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[app-server stderr] ${chunk.toString().trimEnd()}`);
    });
    proc.stdin?.on("drain", () => this.flushWriteQueue());
    proc.stdin?.on("error", (err) => {
      this.lastFailure = err instanceof Error ? err : new Error(String(err));
      this.failAllPending(this.lastFailure);
    });
    proc.stdin?.on("close", () => {
      this.lastFailure ??= new Error("app-server stdin closed");
      this.failAllPending(this.lastFailure);
    });
    proc.on("exit", (code, signal) => {
      this.lastFailure ??= new Error(
        `app-server exited (code: ${code}, signal: ${signal ?? "null"})`
      );
      this.failAllPending(this.lastFailure);
      if (!this._destroyed) {
        this.emit("exit", code, signal);
      }
    });
    proc.on("error", (err) => {
      this.lastFailure = err instanceof Error ? err : new Error(String(err));
      this.failAllPending(this.lastFailure);
      this.emit("error", err);
    });

    // Initialize handshake
    const result = await this.request<InitializeResult>(Methods.INITIALIZE, {
      clientInfo: { name: "codex-mcp", version: CLIENT_VERSION },
    } satisfies InitializeParams);

    return result;
  }

  /**
   * Register handler for server notifications.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Register handler for server-initiated requests (approvals, user input, etc.).
   */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * Send a JSON-RPC response to a server-initiated request.
   */
  respondToServer(id: RequestId, result: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", id, result } as JsonRpcResponse);
    } catch {
      // Ignore send failures (process may have exited)
    }
  }

  /**
   * Send a JSON-RPC error response to a server-initiated request.
   */
  respondErrorToServer(id: RequestId, code: number, message: string): void {
    try {
      this.send({ jsonrpc: "2.0", id, error: { code, message } } as JsonRpcResponse);
    } catch {
      // Ignore send failures (process may have exited)
    }
  }

  // ── High-level protocol methods ────────────────────────────────

  async threadStart(
    params: ThreadStartParams,
    timeout = STARTUP_REQUEST_TIMEOUT
  ): Promise<ThreadStartResult> {
    return this.request<ThreadStartResult>(Methods.THREAD_START, params, timeout);
  }

  async threadFork(params: ThreadForkParams): Promise<ThreadForkResult> {
    return this.request<ThreadForkResult>(Methods.THREAD_FORK, params);
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResult> {
    return this.request<ThreadResumeResult>(Methods.THREAD_RESUME, params);
  }

  async turnStart(
    params: TurnStartParams,
    timeout = STARTUP_REQUEST_TIMEOUT
  ): Promise<TurnStartResult> {
    return this.request<TurnStartResult>(Methods.TURN_START, params, timeout);
  }

  async turnInterrupt(params: TurnInterruptParams): Promise<void> {
    await this.request<void>(Methods.TURN_INTERRUPT, params);
  }

  // ── Low-level JSON-RPC ─────────────────────────────────────────

  private request<T>(
    method: string,
    params?: unknown,
    timeout = DEFAULT_REQUEST_TIMEOUT
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this._destroyed) {
        reject(new Error("Client destroyed"));
        return;
      }
      if (!this.process?.stdin?.writable) {
        reject(this.lastFailure ?? new Error("app-server is not running (stdin not writable)"));
        return;
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeout}ms`));
      }, timeout);
      if (timer.unref) timer.unref();

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      try {
        this.send({ jsonrpc: "2.0", id, method, params } as JsonRpcRequest);
      } catch (err) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.process?.stdin) throw new Error("app-server process not started");
    if (!this.process.stdin.writable) throw new Error("app-server stdin not writable");
    const payload = JSON.stringify(msg) + "\n";
    this.enqueueWrite(payload);
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Fast path: app-server should emit JSON per line; ignore any non-JSON noise safely.
      if (trimmed[0] !== "{" && trimmed[0] !== "[") {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === "object") {
              this.handleMessage(item as JsonRpcMessage);
            }
          }
        } else if (parsed && typeof parsed === "object") {
          this.handleMessage(parsed as JsonRpcMessage);
        }
      } catch {
        const error = new Error(
          `app-server protocol error: failed to parse JSON line: ${trimmed.slice(0, 200)}`
        );
        console.error(`[app-server] ${error.message}`);
        this.lastFailure ??= error;
        this.failAllPending(error);
        try {
          this.terminate("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
  }

  private enqueueWrite(payload: string): void {
    if (!this.process?.stdin?.writable) throw new Error("app-server stdin not writable");

    if (this.backpressure || this.writeQueue.length > 0) {
      if (this.queuedBytes + payload.length > MAX_WRITE_QUEUE_BYTES) {
        const error = new Error("app-server stdin backpressure: write queue exceeded limit");
        this.lastFailure = error;
        this.failAllPending(error);
        this.writeQueue = [];
        this.queuedBytes = 0;
        try {
          this.terminate("SIGTERM");
        } catch {
          /* ignore */
        }
        throw error;
      }
      this.writeQueue.push(payload);
      this.queuedBytes += payload.length;
      return;
    }

    try {
      const ok = this.process.stdin.write(payload);
      if (!ok) this.backpressure = true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.lastFailure = error;
      this.failAllPending(error);
      throw error;
    }
  }

  private flushWriteQueue(): void {
    if (!this.process?.stdin?.writable) return;
    this.backpressure = false;
    while (this.writeQueue.length > 0 && !this.backpressure) {
      const next = this.writeQueue.shift()!;
      this.queuedBytes -= next.length;
      try {
        const ok = this.process.stdin.write(next);
        if (!ok) this.backpressure = true;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.lastFailure = error;
        this.failAllPending(error);
        this.writeQueue = [];
        this.queuedBytes = 0;
        return;
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to our request
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pending.get(resp.id);
      if (pending) {
        this.pending.delete(resp.id);
        clearTimeout(pending.timer);
        if (resp.error) {
          pending.reject(new Error(`RPC error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    // Server-initiated request (has id + method, no result/error)
    if ("id" in msg && "method" in msg) {
      const req = msg as JsonRpcRequest;
      if (this.serverRequestHandler) {
        this.serverRequestHandler(req.id, req.method, req.params);
      } else {
        // No handler — respond with error to avoid hanging
        this.respondErrorToServer(req.id, -32601, `Method not handled: ${req.method}`);
      }
      return;
    }

    // Notification (no id)
    if ("method" in msg && !("id" in msg)) {
      const notif = msg as JsonRpcNotification;
      if (this.notificationHandler) {
        this.notificationHandler(notif.method, notif.params);
      }
      return;
    }
  }

  private failAllPending(error: Error): void {
    if (this.pending.size === 0) return;
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /**
   * Gracefully destroy the client and kill the subprocess.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;

    // Reject all pending requests
    this.failAllPending(new Error("Client destroyed"));

    // Kill subprocess
    if (this.process && !this.process.killed) {
      const alreadyExited = this.process.exitCode !== null;
      this.process.stdin?.end();
      this.terminate("SIGTERM");

      // Force kill after 5s
      const forceKill = setTimeout(() => {
        if (this.process && !this.process.killed) {
          if (process.platform === "win32" && this.process.pid) {
            try {
              spawn("taskkill", ["/PID", String(this.process.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
              });
            } catch {
              // ignore
            }
          } else {
            this.terminate("SIGKILL");
          }
        }
      }, 5000);
      forceKill.unref();

      if (!alreadyExited) {
        await new Promise<void>((resolve) => {
          this.process!.on("exit", () => {
            clearTimeout(forceKill);
            resolve();
          });
          // Resolve anyway after timeout
          const fallback = setTimeout(resolve, 6000);
          fallback.unref();
        });
      }
    }

    this.process = null;
    this.removeAllListeners();
  }

  private terminate(signal: NodeJS.Signals): void {
    if (!this.process) return;

    // On POSIX, kill the whole process group when detached to avoid orphan children.
    if (process.platform !== "win32" && this.spawnedDetached && this.process.pid) {
      try {
        process.kill(-this.process.pid, signal);
        return;
      } catch {
        // fall back to direct kill
      }
    }

    try {
      this.process.kill(signal);
    } catch {
      // ignore
    }
  }
}

/**
 * Detect whether the codex binary supports app-server mode.
 *
 * Falls back to exec mode when app-server is unavailable.
 * Can be overridden via CODEX_MCP_MODE env var.
 */
import { spawn } from "child_process";
import { resolveCodexInvocation } from "./codex-bin.js";

export type ClientMode = "app-server" | "exec";

const DETECTION_TIMEOUT_MS = 5_000;

/**
 * Detect whether the codex binary supports app-server mode.
 *
 * 1. If CODEX_MCP_MODE is set, use it directly.
 * 2. Otherwise probe `<binary> app-server --help` with a timeout.
 */
export async function detectClientMode(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ClientMode> {
  const override = env.CODEX_MCP_MODE;
  if (override === "app-server" || override === "exec") {
    return override;
  }

  try {
    const supported = await probeAppServer(binaryName, env);
    return supported ? "app-server" : "exec";
  } catch {
    return "exec";
  }
}

/**
 * Probe whether `<binary> app-server --help` succeeds.
 */
function probeAppServer(binaryName: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const spawnEnv = { ...env, CODEX_MCP_BINARY: binaryName };
    const invocation = resolveCodexInvocation(["app-server", "--help"], {
      env: spawnEnv,
    });

    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let stdout = "";
    let stderr = "";

    const proc = spawn(invocation.cmd, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
      windowsHide: true,
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", () => {
      // ENOENT or other spawn failure
      settle(false);
    });

    proc.on("exit", (code) => {
      if (code === 0) {
        settle(true);
      } else {
        // Check if stderr/stdout suggests "unknown subcommand"
        const combined = (stdout + stderr).toLowerCase();
        const isUnknown =
          combined.includes("unknown") ||
          combined.includes("unrecognized") ||
          combined.includes("not found") ||
          combined.includes("no such subcommand");
        settle(!isUnknown && combined.includes("app-server"));
      }
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      settle(false);
    }, DETECTION_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
}

import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { SessionManager } from "../src/session/manager.js";
import { executeCodex } from "../src/tools/codex.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("executeCodex", () => {
  it("defaults effort to low when omitted", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-tool-"));
    tempDirs.push(cwd);

    const createSession = vi.fn(async () => ({
      sessionId: "sess_1",
      threadId: "thread_1",
      status: "running" as const,
      pollInterval: 120000,
    }));
    const sessionManager = { createSession } as unknown as SessionManager;

    await executeCodex(
      {
        prompt: "hello",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      sessionManager,
      cwd
    );

    expect(createSession).toHaveBeenCalledWith(
      "hello",
      cwd,
      {
        profile: undefined,
        model: undefined,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        config: undefined,
      },
      "low",
      undefined
    );
  });

  it("passes explicit effort through to SessionManager", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-tool-"));
    tempDirs.push(cwd);

    const createSession = vi.fn(async () => ({
      sessionId: "sess_2",
      threadId: "thread_2",
      status: "running" as const,
      pollInterval: 120000,
    }));
    const sessionManager = { createSession } as unknown as SessionManager;

    await executeCodex(
      {
        prompt: "hello",
        approvalPolicy: "never",
        sandbox: "read-only",
        effort: "xhigh",
      },
      sessionManager,
      cwd
    );

    expect(createSession).toHaveBeenCalledWith(
      "hello",
      cwd,
      {
        profile: undefined,
        model: undefined,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: undefined,
      },
      "xhigh",
      undefined
    );
  });
});

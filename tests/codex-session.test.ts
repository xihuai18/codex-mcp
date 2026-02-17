import { describe, it, expect, vi } from "vitest";
import type { SessionManager } from "../src/session/manager.js";
import { executeCodexSession } from "../src/tools/codex-session.js";

describe("executeCodexSession", () => {
  it("returns list output", async () => {
    const listSessions = vi.fn(() => [{ sessionId: "sess_1", status: "idle" }]);
    const sessionManager = { listSessions } as unknown as SessionManager;

    const result = await executeCodexSession({ action: "list" }, sessionManager);
    expect(result).toEqual({ sessions: [{ sessionId: "sess_1", status: "idle" }] });
  });

  it("returns INVALID_ARGUMENT when sessionId is missing for required actions", async () => {
    const sessionManager = {} as SessionManager;

    await expect(executeCodexSession({ action: "get" }, sessionManager)).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
    await expect(executeCodexSession({ action: "cancel" }, sessionManager)).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
    await expect(executeCodexSession({ action: "interrupt" }, sessionManager)).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
    await expect(executeCodexSession({ action: "fork" }, sessionManager)).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
  });

  it("delegates get/cancel/interrupt/fork actions to SessionManager", async () => {
    const getSession = vi.fn(() => ({ sessionId: "sess_2", status: "running" }));
    const cancelSession = vi.fn(async () => {});
    const interruptSession = vi.fn(async () => {});
    const forkSession = vi.fn(async () => ({
      sessionId: "sess_fork",
      threadId: "thread_fork",
      status: "idle" as const,
      pollInterval: 3000,
    }));
    const sessionManager = {
      getSession,
      cancelSession,
      interruptSession,
      forkSession,
    } as unknown as SessionManager;

    await expect(
      executeCodexSession(
        { action: "get", sessionId: "sess_2", includeSensitive: true },
        sessionManager
      )
    ).resolves.toEqual({ sessionId: "sess_2", status: "running" });
    expect(getSession).toHaveBeenCalledWith("sess_2", true);

    await expect(
      executeCodexSession({ action: "cancel", sessionId: "sess_2" }, sessionManager)
    ).resolves.toEqual({ success: true, message: "Session sess_2 cancelled" });
    expect(cancelSession).toHaveBeenCalledWith("sess_2");

    await expect(
      executeCodexSession({ action: "interrupt", sessionId: "sess_2" }, sessionManager)
    ).resolves.toEqual({ success: true, message: "Session sess_2 interrupted" });
    expect(interruptSession).toHaveBeenCalledWith("sess_2");

    await expect(
      executeCodexSession({ action: "fork", sessionId: "sess_2" }, sessionManager)
    ).resolves.toEqual({
      sessionId: "sess_fork",
      threadId: "thread_fork",
      status: "idle",
      pollInterval: 3000,
    });
    expect(forkSession).toHaveBeenCalledWith("sess_2");
  });
});

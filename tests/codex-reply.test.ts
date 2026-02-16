import { describe, expect, it, vi } from "vitest";
import { executeCodexReply } from "../src/tools/codex-reply.js";

describe("executeCodexReply", () => {
  it("forwards sandbox override using the sandbox field", async () => {
    const replyToSession = vi.fn(async () => ({
      sessionId: "sess_123",
      threadId: "thread_123",
      status: "running" as const,
      pollInterval: 3000,
    }));
    const sessionManager = { replyToSession } as {
      replyToSession: (
        sessionId: string,
        prompt: string,
        overrides: Record<string, unknown>
      ) => Promise<unknown>;
    };

    await executeCodexReply(
      {
        sessionId: "sess_123",
        prompt: "continue",
        sandbox: "workspace-write",
      },
      sessionManager as never
    );

    expect(replyToSession).toHaveBeenCalledWith("sess_123", "continue", {
      model: undefined,
      approvalPolicy: undefined,
      effort: undefined,
      summary: undefined,
      personality: undefined,
      sandbox: "workspace-write",
      cwd: undefined,
      outputSchema: undefined,
    });
  });

  it("forwards all supported overrides", async () => {
    const replyToSession = vi.fn(async () => ({
      sessionId: "sess_456",
      threadId: "thread_456",
      status: "running" as const,
      pollInterval: 3000,
    }));
    const sessionManager = { replyToSession } as {
      replyToSession: (
        sessionId: string,
        prompt: string,
        overrides: Record<string, unknown>
      ) => Promise<unknown>;
    };

    const outputSchema = { type: "object", properties: { ok: { type: "boolean" } } };
    await executeCodexReply(
      {
        sessionId: "sess_456",
        prompt: "continue with overrides",
        model: "o4",
        approvalPolicy: "on-request",
        effort: "high",
        summary: "concise",
        personality: "pragmatic",
        sandbox: "danger-full-access",
        cwd: "D:/Lab/codex-mcp",
        outputSchema,
      },
      sessionManager as never
    );

    expect(replyToSession).toHaveBeenCalledWith("sess_456", "continue with overrides", {
      model: "o4",
      approvalPolicy: "on-request",
      effort: "high",
      summary: "concise",
      personality: "pragmatic",
      sandbox: "danger-full-access",
      cwd: "D:/Lab/codex-mcp",
      outputSchema,
    });
  });

  it("propagates replyToSession errors", async () => {
    const replyToSession = vi.fn(async () => {
      throw new Error("boom");
    });
    const sessionManager = { replyToSession } as {
      replyToSession: (
        sessionId: string,
        prompt: string,
        overrides: Record<string, unknown>
      ) => Promise<unknown>;
    };

    await expect(
      executeCodexReply(
        {
          sessionId: "sess_err",
          prompt: "continue",
        },
        sessionManager as never
      )
    ).rejects.toThrow("boom");
  });
});

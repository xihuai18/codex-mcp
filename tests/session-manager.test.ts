import { EventEmitter } from "events";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { SessionManager } from "../src/session/manager.js";
import { executeCodexCheck } from "../src/tools/codex-check.js";

class MockAppServerClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  threadStartResult: unknown = { thread: { id: "thread_mock" } };
  turnStartResult: unknown = { turn: { id: "turn_mock" } };
  threadForkResult: unknown = { thread: { id: "thread_forked" } };
  threadResumeResult: unknown = { thread: { id: "thread_forked" } };

  start = vi.fn(async () => ({ userAgent: "mock" }));
  threadStart = vi.fn(async () => this.threadStartResult);
  threadFork = vi.fn(async () => this.threadForkResult);
  threadResume = vi.fn(async () => this.threadResumeResult);
  turnStart = vi.fn(async () => this.turnStartResult);
  turnInterrupt = vi.fn(async () => {});

  respondToServer = vi.fn((_id: number, _result: unknown) => {});
  respondErrorToServer = vi.fn((_id: number, _code: number, _message: string) => {});
  destroy = vi.fn(async () => {});

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: (id: number, method: string, params: unknown) => void): void {
    this.serverRequestHandler = handler;
  }

  emitNotification(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }

  emitServerRequest(id: number, method: string, params: unknown): void {
    this.serverRequestHandler?.(id, method, params);
  }
}

describe("SessionManager protocol compatibility + approvals", () => {
  let manager: SessionManager;
  let client: MockAppServerClient;
  const workspace = path.resolve(os.tmpdir(), "codex-mcp-tests");

  beforeEach(() => {
    client = new MockAppServerClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
  });

  it("extracts threadId from v2 thread/start response shape", async () => {
    client.threadStartResult = { thread: { id: "thread_v2" } };
    const res = await manager.createSession("hi", workspace, {}, "medium");
    expect(res.threadId).toBe("thread_v2");
  });

  it("extracts threadId from legacy v1 thread/start response shape", async () => {
    client.threadStartResult = { threadId: "thread_v1" };
    const res = await manager.createSession("hi", workspace, {}, "medium");
    expect(res.threadId).toBe("thread_v1");
  });

  it("extracts threadId from legacy v1 thread/fork response shape", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.threadForkResult = { threadId: "thread_fork_v1" };
    const forked = await manager.forkSession(sessionId);
    expect(forked.threadId).toBe("thread_fork_v1");
    // original threadId still present
    expect(threadId).toBeDefined();
  });

  it("responds to command approval and clears pending request", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(1, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
      reason: "test",
    });

    const poll1 = manager.pollEvents(sessionId);
    expect(poll1.status).toBe("waiting_approval");
    expect(poll1.actions?.length).toBe(1);

    const requestId = poll1.actions![0].requestId;
    const poll2 = executeCodexCheck(
      {
        action: "respond_approval",
        sessionId,
        requestId,
        decision: "accept",
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    expect(client.respondToServer).toHaveBeenCalledWith(1, { decision: "accept" });

    const info = manager.getSession(sessionId);
    expect(info.pendingRequestCount).toBe(0);
    expect(manager.pollEvents(sessionId).actions).toBeUndefined();
  });

  it("responds to user input request and clears pending request", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(12, Methods.USER_INPUT_REQUEST, {
      itemId: "item_ui_1",
      threadId,
      turnId: "turn_1",
      questions: [{ questionId: "q1", question: "Pick one" }],
    });

    const poll1 = manager.pollEvents(sessionId);
    expect(poll1.status).toBe("waiting_approval");
    expect(poll1.actions?.length).toBe(1);
    expect(poll1.actions?.[0]?.type).toBe("user_input");

    const requestId = poll1.actions![0].requestId;
    const answers = { q1: { answers: ["A"] } };
    const poll2 = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId,
        answers,
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    expect(client.respondToServer).toHaveBeenCalledWith(12, { answers });
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("rejects invalid decision for fileChange approval via tool wrapper", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(2, Methods.FILE_CHANGE_APPROVAL, {
      itemId: "item_fc_1",
      threadId,
      turnId: "turn_1",
      reason: "test",
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions![0].requestId;
    const out = executeCodexCheck(
      {
        action: "respond_approval",
        sessionId,
        requestId,
        decision: "acceptWithExecpolicyAmendment",
        execpolicyAmendment: ["allow:rm"],
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain("INVALID_ARGUMENT");
  });

  it("requires execpolicyAmendment for acceptWithExecpolicyAmendment", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(3, Methods.COMMAND_APPROVAL, {
      itemId: "item_cmd_2",
      threadId,
      turnId: "turn_1",
      command: "rm -rf /",
      cwd: workspace,
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions![0].requestId;
    const out = executeCodexCheck(
      {
        action: "respond_approval",
        sessionId,
        requestId,
        decision: "acceptWithExecpolicyAmendment",
        // missing execpolicyAmendment
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain("execpolicyAmendment required");
  });

  it("auto-declines approvals after approvalTimeoutMs and clears pending", async () => {
    vi.useFakeTimers();
    try {
      const { sessionId, threadId } = await manager.createSession(
        "hi",
        workspace,
        {},
        "medium",
        { approvalTimeoutMs: 5 }
      );
      client.emitServerRequest(11, Methods.COMMAND_APPROVAL, {
        itemId: "item_timeout_1",
        threadId,
        turnId: "turn_1",
        command: "echo hi",
        cwd: workspace,
      });
      expect(manager.pollEvents(sessionId).actions?.length).toBe(1);

      await vi.advanceTimersByTimeAsync(10);

      expect(client.respondToServer).toHaveBeenCalledWith(11, { decision: "decline" });
      expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-answers user input with empty answers on timeout", async () => {
    vi.useFakeTimers();
    try {
      const { sessionId, threadId } = await manager.createSession(
        "hi",
        workspace,
        {},
        "medium",
        { approvalTimeoutMs: 5 }
      );
      client.emitServerRequest(13, Methods.USER_INPUT_REQUEST, {
        itemId: "item_ui_timeout_1",
        threadId,
        turnId: "turn_1",
        questions: [{ questionId: "q1", question: "Pick one" }],
      });

      expect(manager.pollEvents(sessionId).actions?.length).toBe(1);
      await vi.advanceTimersByTimeAsync(10);

      expect(client.respondToServer).toHaveBeenCalledWith(13, { answers: {} });
      const poll = manager.pollEvents(sessionId, 0, 200);
      expect(
        poll.events.some(
          (event) =>
            event.type === "approval_result" &&
            (event.data as { timeout?: boolean; kind?: string }).timeout === true &&
            (event.data as { timeout?: boolean; kind?: string }).kind === "user_input"
        )
      ).toBe(true);
      expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets cursorResetTo when buffer has evicted earlier events", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    for (let i = 0; i < 1105; i++) {
      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        threadId,
        turnId: "turn_1",
        itemId: `item_${i}`,
        delta: "x",
      });
    }

    const poll = manager.pollEvents(sessionId, 0, 2000);
    expect(poll.cursorResetTo).toBe(105);
    expect(poll.events.length).toBe(1000);
  });

  it("classifies item/completed based on item.type", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId,
      turnId: "turn_1",
      item: { id: "m1", type: "agentMessage", text: "hello" },
    });
    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId,
      turnId: "turn_1",
      item: { id: "c1", type: "commandExecution", command: "echo hi" },
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    const types = poll.events.map((e) => e.type);
    expect(types).toContain("output");
    expect(types).toContain("progress");
  });

  it("clears pending requests when app-server exits", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(9, Methods.COMMAND_APPROVAL, {
      itemId: "item_exit_1",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    expect(manager.pollEvents(sessionId).actions?.length).toBe(1);

    client.emit("exit", 1, null);
    const poll = manager.pollEvents(sessionId);
    expect(poll.status).toBe("error");
    expect(poll.actions).toBeUndefined();
    expect(poll.result?.status).toBe("error");
    expect(poll.result?.error).toContain("app-server exited unexpectedly");
    expect(poll.events.some((event) => event.type === "result")).toBe(true);
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("produces a terminal result when cancelled", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    await manager.cancelSession(sessionId, "Cancelled by test");

    const poll = manager.pollEvents(sessionId);
    expect(poll.status).toBe("cancelled");
    expect(poll.pollInterval).toBeUndefined();
    expect(poll.actions).toBeUndefined();
    expect(poll.result?.status).toBe("cancelled");
    expect(poll.result?.error).toContain("Cancelled by test");
  });

  it("validates localImage paths before starting the turn", async () => {
    await expect(
      manager.createSession("hi", workspace, {}, "medium", { images: ["./nope.png"] })
    ).rejects.toThrow("INVALID_ARGUMENT");
    expect(client.start).not.toHaveBeenCalled();
  });

  it("supports v1-style turn/started notification with top-level turnId", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_STARTED, {
      threadId,
      turnId: "turn_v1_started",
    });

    await manager.interruptSession(sessionId);
    expect(client.turnInterrupt).toHaveBeenCalledWith({
      threadId,
      turnId: "turn_v1_started",
    });
  });

  it("supports v1-style turn/completed notification with top-level turnId", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_STARTED, { threadId, turnId: "turn_v1" });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_v1",
      turn: { status: "completed" },
    });

    const poll = manager.pollEvents(sessionId, 0, 200);
    expect(poll.status).toBe("idle");
    expect(poll.result?.turnId).toBe("turn_v1");
  });

  it("can interrupt immediately after codex_reply using turnStart response id (before turn/started notification)", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    // Put session into idle so reply is allowed.
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_done",
      turn: { status: "completed" },
    });
    expect(manager.pollEvents(sessionId).status).toBe("idle");

    await manager.replyToSession(sessionId, "next");
    await manager.interruptSession(sessionId);

    expect(client.turnInterrupt).toHaveBeenCalledWith({
      threadId,
      turnId: "turn_mock",
    });
  });

  it("persists reply overrides to session metadata", async () => {
    const { sessionId, threadId } = await manager.createSession(
      "hi",
      workspace,
      {
        model: "o4-mini",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      "medium"
    );

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_done",
      turn: { status: "completed" },
    });

    await manager.replyToSession(sessionId, "next", {
      model: "o4",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      cwd: os.tmpdir(),
    });

    const info = manager.getSession(sessionId, true) as {
      model?: string;
      approvalPolicy?: string;
      sandbox?: string;
      cwd: string;
    };
    expect(info.model).toBe("o4");
    expect(info.approvalPolicy).toBe("never");
    expect(info.sandbox).toBe("danger-full-access");
    expect(info.cwd).toBe(os.tmpdir());
    expect(client.turnStart).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "o4",
        approvalPolicy: "never",
        cwd: os.tmpdir(),
        sandboxPolicy: { type: "dangerFullAccess" },
      })
    );
  });
});

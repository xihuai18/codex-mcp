import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

describe("tools/list metadata", () => {
  it("advertises outputSchema + annotations for all tools", async () => {
    const server = createServer(process.cwd());
    try {
      const internal = server as unknown as {
        server: {
          _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
        };
      };
      const handler = internal.server._requestHandlers.get("tools/list");
      expect(handler).toBeTypeOf("function");

      const resp = (await handler!(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        {}
      )) as { tools: Array<Record<string, unknown>> };

      const byName = new Map(resp.tools.map((t) => [String(t.name), t]));
      for (const name of ["codex", "codex_reply", "codex_session", "codex_check"]) {
        const tool = byName.get(name);
        expect(tool, `missing tool in tools/list: ${name}`).toBeTruthy();
        expect(tool).toHaveProperty("inputSchema");
        expect(tool).toHaveProperty("outputSchema");
        expect(tool).toHaveProperty("annotations");

        const outputSchema = tool!.outputSchema as Record<string, unknown>;
        expect(outputSchema).toHaveProperty("type", "object");
      }

      const codex = byName.get("codex") as { description?: string };
      expect(codex.description).toContain("pollInterval");
      expect(codex.description).toContain("asynchronously");

      const codexReplyDesc = byName.get("codex_reply") as { description?: string };
      expect(codexReplyDesc.description).toContain("idle");
      expect(codexReplyDesc.description).toContain("SESSION_BUSY");

      const codexSessionDesc = byName.get("codex_session") as { description?: string };
      expect(codexSessionDesc.description).toContain("includeSensitive defaults to false");
      expect(codexSessionDesc.description).toContain("source remains unchanged");
      expect(codexSessionDesc.description).toContain("clean_background_terminals");

      const codexCheckDesc = byName.get("codex_check") as { description?: string };
      expect(codexCheckDesc.description).toContain("Default maxEvents=1");
      expect(codexCheckDesc.description).toContain("cursorResetTo");

      const codexReply = byName.get("codex_reply") as {
        inputSchema?: { properties?: Record<string, unknown> };
      };
      const codexReplyProps = codexReply.inputSchema?.properties ?? {};
      expect(codexReplyProps).toHaveProperty("sandbox");
      expect(codexReplyProps).not.toHaveProperty("sandboxPolicy");

      const codexCheck = byName.get("codex_check") as {
        inputSchema?: { properties?: Record<string, unknown> };
      };
      const codexCheckProps = codexCheck.inputSchema?.properties ?? {};
      const actionSchema = codexCheckProps.action as { enum?: unknown[] } | undefined;
      expect(actionSchema?.enum).toContain("respond_permission");
      expect(actionSchema?.enum).not.toContain("respond_approval");
      expect(codexCheckProps).toHaveProperty("execpolicy_amendment");
      expect(codexCheckProps).not.toHaveProperty("execpolicyAmendment");
      const cursorSchema = codexCheckProps.cursor as Record<string, unknown> | undefined;
      expect(cursorSchema).toBeTruthy();
      expect(cursorSchema).not.toHaveProperty("default");
      const maxEventsSchema = codexCheckProps.maxEvents as Record<string, unknown> | undefined;
      expect(maxEventsSchema).toBeTruthy();
      expect(maxEventsSchema).not.toHaveProperty("default");
      const pollOptionsSchema = codexCheckProps.pollOptions as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(pollOptionsSchema?.properties).not.toHaveProperty("includeTools");
    } finally {
      await server.close();
    }
  });
});

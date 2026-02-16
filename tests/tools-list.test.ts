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

      const codexReply = byName.get("codex_reply") as {
        inputSchema?: { properties?: Record<string, unknown> };
      };
      const codexReplyProps = codexReply.inputSchema?.properties ?? {};
      expect(codexReplyProps).toHaveProperty("sandbox");
      expect(codexReplyProps).not.toHaveProperty("sandboxPolicy");
    } finally {
      await server.close();
    }
  });
});

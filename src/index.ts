/**
 * codex-mcp — MCP server entry point
 *
 * Starts the MCP server with stdio transport.
 * Spawns codex app-server child processes for each session.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { runStdioPreflight } from "./utils/stdio-guard.js";

async function main(): Promise<void> {
  const preflight = runStdioPreflight();
  for (const note of preflight.notes) {
    console.error(`[stdio] ${note}`);
  }
  if (preflight.riskLevel === "elevated") {
    console.error(`[stdio] Elevated stdout contamination risk detected (mode=${preflight.mode}).`);
    for (const reason of preflight.riskReasons) {
      console.error(`[stdio] Reason: ${reason}`);
    }
    for (const suggestion of preflight.suggestions) {
      console.error(`[stdio] Suggestion: ${suggestion}`);
    }
  }
  if (preflight.shouldBlock) {
    throw new Error(
      "STDIO preflight failed in strict mode due to blocking stdout contamination risk"
    );
  }

  const serverCwd = process.cwd();
  const server = createServer(serverCwd);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch {
      // Ignore close errors during shutdown
    }
    process.exitCode = 0;
    const exitTimer = setTimeout(() => process.exit(0), 100);
    exitTimer.unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Windows commonly emits SIGBREAK (Ctrl+Break / console close scenarios).
  process.on("SIGBREAK", shutdown);

  await server.connect(transport);
  console.error(`codex-mcp server started (cwd: ${serverCwd})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

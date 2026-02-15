/**
 * codex-mcp — MCP server entry point
 *
 * Starts the MCP server with stdio transport.
 * Spawns codex app-server child processes for each session.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
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

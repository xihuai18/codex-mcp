import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveStdioMode } from "../utils/stdio-guard.js";

const RESOURCE_SCHEME = "codex-mcp";

export const RESOURCE_URIS = {
  serverInfo: `${RESOURCE_SCHEME}:///server-info`,
  config: `${RESOURCE_SCHEME}:///config`,
  gotchas: `${RESOURCE_SCHEME}:///gotchas`,
} as const;

function asTextResource(uri: URL, text: string, mimeType: string): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.toString(),
        text,
        mimeType,
      },
    ],
  };
}

export function registerResources(
  server: Pick<McpServer, "registerResource">,
  deps: { version: string }
): void {
  const serverInfoUri = new URL(RESOURCE_URIS.serverInfo);
  server.registerResource(
    "server_info",
    serverInfoUri.toString(),
    {
      title: "Server Info",
      description: "Server metadata: version, platform, runtime",
      mimeType: "application/json",
    },
    () =>
      asTextResource(
        serverInfoUri,
        JSON.stringify(
          {
            name: "codex-mcp",
            version: deps.version,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            stdioMode: resolveStdioMode().mode,
            resources: Object.values(RESOURCE_URIS),
          },
          null,
          2
        ),
        "application/json"
      )
  );

  const configUri = new URL(RESOURCE_URIS.config);
  server.registerResource(
    "config",
    configUri.toString(),
    {
      title: "Config Guide",
      description: "How tool params map to config.toml and app-server flags",
      mimeType: "text/markdown",
    },
    () =>
      asTextResource(
        configUri,
        [
          "## `advanced.config`",
          "",
          "Forwarded as `-c key=value` flags to `codex app-server`.",
          "Primitives: `String(value)`, objects/arrays: `JSON.stringify(value)`.",
          "",
          "Prefer dedicated top-level params:",
          "",
          "- `codex.model` -> `-c model=...`",
          "- `codex.approvalPolicy` -> `-c approval_policy=...`",
          "- `codex.sandbox` -> `-c sandbox_mode=...`",
          "- `codex.profile` -> `-p ...`",
          "",
          "### Example",
          "",
          "```json",
          "{",
          '  "prompt": "Do the task",',
          '  "advanced": {',
          '    "config": {',
          '      "tool_timeout_sec": 120,',
          '      "enabled_tools": ["bash", "read", "edit"]',
          "    }",
          "  }",
          "}",
          "```",
          "",
          "Keys depend on Codex CLI version.",
          "",
        ].join("\n"),
        "text/markdown"
      )
  );

  const gotchasUri = new URL(RESOURCE_URIS.gotchas);
  server.registerResource(
    "gotchas",
    gotchasUri.toString(),
    {
      title: "Gotchas",
      description: "Practical limits and common issues",
      mimeType: "text/markdown",
    },
    () =>
      asTextResource(
        gotchasUri,
        [
          '- Sessions are async — poll `codex_check(action="poll")` until status is `idle`/`error`/`cancelled`.',
          "- Store `nextCursor` and pass it back to avoid replaying events.",
          "- `poll` defaults to `maxEvents=1` for lightweight incremental updates. Increase temporarily (for example `10-20`) only when you need faster catch-up.",
          "- If `poll` is sent with `maxEvents=0`, codex-mcp treats it as `1` to avoid no-op loops.",
          "- For `respond_approval` / `respond_user_input`, cursor handling is monotonic (`max(cursor, sessionLastCursor)`) to avoid stale replay.",
          "- `respond_approval` / `respond_user_input` default to compact ACK (`maxEvents=0`) and this is usually better than `1`; use `1-5` only when you explicitly need immediate events in the same response.",
          "- If you omit `cursor`, codex-mcp continues from the session's last consumed cursor.",
          "- If `cursorResetTo` is present, cursor was stale; restart from `cursorResetTo`.",
          "- Approvals auto-decline after `approvalTimeoutMs`. Respond to `actions[]` promptly.",
          "- `advanced.images` must exist on server host; sent as `localImage` inputs.",
          "- `CODEX_MCP_STDIO_MODE` controls startup guard behavior: `auto` (default), `strict` (block on high-confidence contamination risks), `off`.",
          "- On Windows PowerShell wrappers, prefer `pwsh -NoProfile` to avoid profile banner output.",
          "- Profile/banner stdout emitted before MCP handshake cannot be filtered by codex-mcp (stdout is protocol channel).",
          '- If Windows command turns still fail with profile noise, this is usually inside `codex app-server` shell execution; clean your PowerShell profile and prefer `approvalPolicy="on-failure"` / `"never"`.',
          "- If Windows output contains mojibake, enforce UTF-8 shell output (`chcp 65001`, `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`).",
          '- Retryable transport/API interruptions are surfaced as progress event `method="codex-mcp/reconnect"`.',
          "",
        ].join("\n"),
        "text/markdown"
      )
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

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
          "- If `cursorResetTo` is present, cursor was stale; restart from `cursorResetTo`.",
          "- Approvals auto-decline after `approvalTimeoutMs`. Respond to `actions[]` promptly.",
          "- `advanced.images` must exist on server host; sent as `localImage` inputs.",
          "",
        ].join("\n"),
        "text/markdown"
      )
  );
}

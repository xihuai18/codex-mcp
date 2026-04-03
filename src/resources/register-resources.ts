import { spawnSync } from "child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session/manager.js";
import {
  APPROVAL_POLICIES,
  SANDBOX_MODES,
  EFFORT_LEVELS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  POLL_DEFAULT_MAX_EVENTS,
  POLL_MIN_MAX_EVENTS,
  RESPOND_DEFAULT_MAX_EVENTS,
  DEFAULT_IDLE_CLEANUP_MS,
  DEFAULT_RUNNING_CLEANUP_MS,
  DEFAULT_TERMINAL_CLEANUP_MS,
  ErrorCode,
} from "../types.js";
import { resolveStdioMode } from "../utils/stdio-guard.js";

const RESOURCE_SCHEME = "codex-mcp";

export const RESOURCE_URIS = {
  serverInfo: `${RESOURCE_SCHEME}:///server-info`,
  compatReport: `${RESOURCE_SCHEME}:///compat-report`,
  config: `${RESOURCE_SCHEME}:///config`,
  gotchas: `${RESOURCE_SCHEME}:///gotchas`,
  quickstart: `${RESOURCE_SCHEME}:///quickstart`,
  errors: `${RESOURCE_SCHEME}:///errors`,
} as const;

type RuntimeMetadataProvider = Pick<
  SessionManager,
  "getActiveSessionCount" | "getObservedDefaultModel"
>;

interface ResourceCatalogEntry {
  key: keyof typeof RESOURCE_URIS;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

const RESOURCE_CATALOG: ResourceCatalogEntry[] = [
  {
    key: "serverInfo",
    name: "server_info",
    title: "Server Info",
    description: "Server metadata and runtime capabilities",
    mimeType: "application/json",
  },
  {
    key: "compatReport",
    name: "compat_report",
    title: "Compat Report",
    description: "Cross-backend compatibility capability report",
    mimeType: "application/json",
  },
  {
    key: "config",
    name: "config",
    title: "Config Guide",
    description: "Parameter guide and config.toml mapping",
    mimeType: "text/markdown",
  },
  {
    key: "gotchas",
    name: "gotchas",
    title: "Gotchas",
    description: "Practical limits and common issues",
    mimeType: "text/markdown",
  },
  {
    key: "quickstart",
    name: "quickstart",
    title: "Quickstart",
    description: "Minimal end-to-end workflow",
    mimeType: "text/markdown",
  },
  {
    key: "errors",
    name: "errors",
    title: "Errors",
    description: "Error code reference and recovery hints",
    mimeType: "text/markdown",
  },
];

const ERROR_CODE_HINTS: Record<ErrorCode, string> = {
  [ErrorCode.INVALID_ARGUMENT]: "Input shape/value mismatch. Fix payload and retry.",
  [ErrorCode.SESSION_NOT_FOUND]: "Unknown sessionId or already cleaned up.",
  [ErrorCode.SESSION_BUSY]: "Session is running or waiting approval. Poll until idle/error.",
  [ErrorCode.SESSION_NOT_RUNNING]: "Action requires running/waiting_approval session.",
  [ErrorCode.REQUEST_NOT_FOUND]: "requestId was resolved, stale, or never existed.",
  [ErrorCode.TIMEOUT]: "Operation timed out. Retry or use a longer timeout where supported.",
  [ErrorCode.CANCELLED]: "Session was cancelled and cannot be resumed.",
  [ErrorCode.APP_SERVER_START_FAILED]: "codex app-server failed to boot. Check CLI install/path.",
  [ErrorCode.THREAD_FORK_RESUME_FAILED]:
    "Forked thread could not resume in new process. Retry fork from current source session.",
  [ErrorCode.PROTOCOL_PARSE_ERROR]:
    "Non-JSON or malformed app-server line. Check shell/profile noise and transport health.",
  [ErrorCode.WRITE_QUEUE_DROPPED]:
    "stdin backpressure overflow. Reduce burst size and re-run in smaller turns.",
  [ErrorCode.EXEC_NOT_SUPPORTED]:
    "Operation not supported in exec mode. Features like threadFork and threadResume require app-server mode.",
  [ErrorCode.INTERNAL]: "Unexpected server-side failure. Inspect logs and retry safely.",
};

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

function detectCodexCliVersion(timeoutMs = 1500): string | null {
  try {
    const run = spawnSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
    if (!combined) return null;
    const versionToken = combined.match(/v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    if (!versionToken) return combined.split(/\s+/)[0] ?? null;
    return versionToken[0].replace(/^v/, "");
  } catch {
    return null;
  }
}

function msToMinutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

function buildConfigGuideText(): string {
  return [
    "## Top-level parameters (`codex`)",
    "",
    "- Required: `prompt`, `approvalPolicy`, `sandbox`.",
    "- Optional: `effort` (default `low`), `cwd` (default server cwd), `model` (default config.toml), `profile` (default CLI profile), `advanced`.",
    "- Prefer passing `cwd` explicitly to avoid accidental server-cwd execution.",
    "",
    "## `advanced.*` guide",
    "",
    "- `advanced.baseInstructions`: replace default system instructions for this session (default: unchanged).",
    "- `advanced.developerInstructions`: append extra developer instructions (default: none).",
    "- `advanced.personality`: optional personality preset (default: config.toml).",
    "- `advanced.summary`: summary verbosity preset for turn output (default: config.toml).",
    "- `advanced.ephemeral`: do not persist thread state remotely (default `false`).",
    "- `advanced.images`: local image file paths on the same host as codex-mcp (default: none).",
    `- \`advanced.approvalTimeoutMs\`: auto-decline timeout for approval/user-input requests (default \`${DEFAULT_APPROVAL_TIMEOUT_MS}\` ms).`,
    "- `advanced.outputSchema`: JSON Schema for structured output from `codex` turns (default: none).",
    "",
    "## `advanced.config` mapping",
    "",
    "Forwarded as `-c key=value` flags to `codex app-server`.",
    "Primitives use `String(value)`; objects/arrays use `JSON.stringify(value)`.",
    "",
    "Prefer dedicated top-level params when available:",
    "",
    "- `codex.model` -> `-c model=...`",
    "- `codex.approvalPolicy` -> `-c approval_policy=...`",
    "- `codex.sandbox` -> `-c sandbox_mode=...`",
    "- `codex.effort` -> turn-level reasoning effort (do not encode in `advanced.config`)",
    "- `codex.profile` -> `-p ...`",
    "",
    "## `codex_reply` differences",
    "",
    "- `codex_reply.outputSchema` is top-level.",
    "- `codex.outputSchema` lives under `advanced.outputSchema`.",
    "- `codex_reply` can override `model`, `approvalPolicy`, `sandbox`, `effort`, `summary`, `personality`, and `cwd`.",
    "- `codex_reply` only works when session state is `idle` or `error`; otherwise returns `SESSION_BUSY`.",
    "- All `codex_reply` override fields default to no override when omitted.",
    "",
    "## Override persistence (`codex_reply`)",
    "",
    "- `model`, `approvalPolicy`, `sandbox`, and `cwd` update in-memory session defaults for later turns.",
    "- `effort`, `summary`, `personality`, and `outputSchema` apply to the submitted turn payload.",
    "",
    "## Version compatibility note",
    "",
    "Available `advanced.config` keys depend on installed Codex CLI version.",
    "To inspect your local CLI version, read `codex-mcp:///server-info` (`codexCliVersion`).",
    "",
    "## Other tool defaults (quick reference)",
    "",
    "- `codex_session.includeSensitive`: default `false`.",
    `- \`codex_check.poll.maxEvents\`: default \`${POLL_DEFAULT_MAX_EVENTS}\` (minimum \`${POLL_MIN_MAX_EVENTS}\`).`,
    `- \`codex_check.respond_*.maxEvents\`: default \`${RESPOND_DEFAULT_MAX_EVENTS}\`.`,
    "- `codex_check.responseMode`: default `minimal` (`minimal` / `delta_compact` / `full`).",
    "- `codex_check.pollOptions.includeEvents`: default `true`.",
    "- `codex_check.pollOptions.includeActions`: default `true`.",
    "- `codex_check.pollOptions.includeResult`: default `true`.",
    "- `codex_check.pollOptions.maxBytes`: default unlimited.",
    "- `codex_check.cursor`: default is session last consumed cursor when omitted.",
    "",
  ].join("\n");
}

function buildGotchasText(): string {
  return [
    "## Polling and cursors",
    "",
    '- Sessions are async. Poll `codex_check(action="poll")` until status is `idle`/`error`/`cancelled`.',
    "- Store `nextCursor` and pass it back to avoid replay.",
    `- Poll default is \`maxEvents=${POLL_DEFAULT_MAX_EVENTS}\` (authoritative: tool schema / constants).`,
    `- Poll enforces minimum \`maxEvents=${POLL_MIN_MAX_EVENTS}\`; sending \`0\` is normalized to \`${POLL_MIN_MAX_EVENTS}\`.`,
    `- \`respond_permission\` and \`respond_user_input\` default to compact ACK with \`maxEvents=${RESPOND_DEFAULT_MAX_EVENTS}\`.`,
    "- Default response mode is `minimal`; use `full` if you need full raw event payloads.",
    "- respond_* uses monotonic cursor handling: `max(cursor, sessionLastCursor)`.",
    "- If `cursorResetTo` is present, your cursor is stale (old events were evicted); restart from that value.",
    "- **Poll frequency guidance**: Adapt poll interval to task complexity and previous poll results. For `running` sessions, start at 2 minutes and increase for long tasks. Only poll frequently (~1s) when `waiting_approval`. Do NOT high-frequency poll — it wastes tokens and provides no benefit.",
    "",
    "## Approval behavior",
    "",
    `- Pending approvals/user-input auto-decline after \`approvalTimeoutMs\` (default ${DEFAULT_APPROVAL_TIMEOUT_MS} ms).`,
    "- `untrusted` behavior is enforced by Codex CLI backend and may auto-allow some low-risk commands.",
    "- Do not assume every read-only command will always require approval across CLI versions.",
    `- **Timeout vs polling conflict**: The recommended polling interval for \`running\` status is >=120 seconds, but the default approval timeout is ${DEFAULT_APPROVAL_TIMEOUT_MS / 1000} seconds. If a session transitions to \`waiting_approval\` between polls, the approval will auto-decline before the client can respond. Set \`advanced.approvalTimeoutMs\` to at least 300000 (5 minutes) when using \`untrusted\` or \`on-request\` policies.`,
    "",
    "## Event model",
    "",
    "- Top-level `events[].type` is one of: `output`, `progress`, `approval_request`, `approval_result`, `result`, `error`.",
    "- Fine-grained stream semantics are in `events[].data.method` (for example command output delta, reasoning delta, turn updates).",
    '- Retryable interruptions surface as `progress` with `method="codex-mcp/reconnect"` and include retry fields.',
    "- During reconnect/retry, continue polling normally; if retries stop (`willRetry=false`), session transitions to error path.",
    "",
    "## Windows shell/profile issues",
    "",
    "- On Windows wrappers, prefer `pwsh -NoProfile` to avoid profile/banner stdout noise.",
    "- Profile noise can affect both MCP handshake and agent-internal command turns.",
    "- For mojibake, enforce UTF-8 shell output (`chcp 65001`, `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`).",
    "- Prefer host-native absolute paths for `cwd` and file args (Windows example: `D:\\\\Lab\\\\codex-mcp`).",
    "",
    "## Lifecycle and cleanup",
    "",
    `- Idle sessions are auto-cleaned after ${msToMinutes(DEFAULT_IDLE_CLEANUP_MS)} minutes.`,
    `- Running/waiting sessions are auto-cleaned after ${msToMinutes(DEFAULT_RUNNING_CLEANUP_MS)} minutes.`,
    `- Error/cancelled sessions are retained for about ${msToMinutes(DEFAULT_TERMINAL_CLEANUP_MS)} minutes, then removed.`,
    "- Session state is in-memory. Restarting codex-mcp drops all existing sessions.",
    "",
    "## Capacity",
    "",
    "- codex-mcp does not hard-code a strict concurrent-session cap.",
    "- Practical limit depends on machine resources and child-process load.",
    "",
    "## Exec fallback mode",
    "",
    "- When the codex binary does not support `app-server`, codex-mcp falls back to `exec` mode (`codex exec --json`).",
    "- Check `codex-mcp:///server-info` `clientMode` field to detect which mode is active.",
    "- **Exec mode supports multi-turn**: first turn uses `codex exec`, subsequent turns use `codex exec resume <threadId>` for context continuity.",
    "- **Exec mode limitations**: no approval/user-input interactions, `threadFork`/`threadResume` throw `EXEC_NOT_SUPPORTED`. `sandbox`/`profile`/`cwd`/`outputSchema` overrides only apply on the first turn (exec resume does not support `-s`/`-p`/`-C`/`--output-schema`).",
    "",
  ].join("\n");
}

function buildQuickstartText(): string {
  return [
    "## Minimal flow",
    "",
    "1. Start session (`codex`)",
    "",
    "```json",
    "{",
    '  "prompt": "List files and summarize repository purpose.",',
    '  "approvalPolicy": "on-request",',
    '  "sandbox": "workspace-write",',
    '  "effort": "low",',
    '  "cwd": "D:\\\\Lab\\\\codex-mcp"',
    "}",
    "```",
    "",
    "Typical start result:",
    "",
    "```json",
    "{",
    '  "sessionId": "sess_abc123",',
    '  "threadId": "thread_xyz",',
    '  "status": "running",',
    '  "pollInterval": 120000',
    "}",
    "```",
    "",
    "2. Poll incrementally (`codex_check`)",
    "",
    "```json",
    "{",
    '  "action": "poll",',
    '  "sessionId": "sess_abc123",',
    '  "cursor": 0,',
    '  "maxEvents": 10',
    "}",
    "```",
    "",
    "- Use `pollInterval` as a minimum delay: `running` >=120000ms (and usually longer for big tasks).",
    "- `waiting_approval` is the exception: poll/answer around 1000ms to avoid timeout.",
    `- When using \`untrusted\` or \`on-request\` policies, set \`advanced.approvalTimeoutMs\` to at least 300000 to prevent approvals from expiring between polling intervals.`,
    "",
    "3. If `actions[]` contains an approval request, respond:",
    "",
    "```json",
    "{",
    '  "action": "respond_permission",',
    '  "sessionId": "sess_abc123",',
    '  "requestId": "req_123",',
    '  "decision": "acceptForSession"',
    "}",
    "```",
    "",
    "4. If `actions[]` contains a user-input request, respond:",
    "",
    "```json",
    "{",
    '  "action": "respond_user_input",',
    '  "sessionId": "sess_abc123",',
    '  "requestId": "req_456",',
    '  "answers": {',
    '    "question-id": {',
    '      "answers": ["Option A"]',
    "    }",
    "  }",
    "}",
    "```",
    "",
    "5. Continue polling until terminal status (`idle`, `error`, or `cancelled`), respecting the >=2 minute interval while `running`.",
    "",
    "## Cursor notes",
    "",
    "- Omit `cursor` to continue from session last consumed cursor.",
    `- Omit \`maxEvents\`: defaults are poll=${POLL_DEFAULT_MAX_EVENTS}, respond_*=${RESPOND_DEFAULT_MAX_EVENTS}.`,
    "- Omit `responseMode`: default is `minimal`.",
    "- Use returned `nextCursor` for the next call.",
    "- If `cursorResetTo` appears, reset to that value and continue.",
    "",
  ].join("\n");
}

function buildErrorsText(): string {
  const lines: string[] = [
    "## Error format",
    "",
    "Tool failures use: `Error [CODE]: message`",
    "",
    "## Codes",
    "",
  ];

  for (const code of Object.values(ErrorCode)) {
    lines.push(`- \`${code}\`: ${ERROR_CODE_HINTS[code]}`);
  }

  lines.push("");
  lines.push("## Recovery basics");
  lines.push("");
  lines.push("- `INVALID_ARGUMENT`: fix payload fields/enums and retry.");
  lines.push("- `SESSION_BUSY`: poll until terminal/idle before issuing incompatible action.");
  lines.push("- `REQUEST_NOT_FOUND`: re-poll and use latest `actions[].requestId`.");
  lines.push("- `PROTOCOL_PARSE_ERROR`: remove shell/profile stdout noise and restart session.");
  lines.push("");

  return lines.join("\n");
}

function buildCompatReport(
  deps: { version: string; sessionManager: RuntimeMetadataProvider },
  codexCliVersion: string | null
): string {
  const runtimeWarnings: string[] = [];
  if (!codexCliVersion) {
    runtimeWarnings.push("Unable to detect local codex CLI version from PATH.");
  }
  return JSON.stringify(
    {
      schemaVersion: "1.0.0",
      features: {
        respondPermission: true,
        respondApprovalAlias: false,
        respondUserInput: true,
        sessionInterrupt: true,
        responseModeMinimal: true,
        responseModeDeltaCompact: true,
        responseModeFull: true,
        pollOptionsBase: true,
        maxBytesTruncation: true,
        compatWarnings: true,
        diskResume: false,
        dynamicTools: false,
        toolPermissionControl: false,
      },
      recommendedSettings: {
        codexCheck: {
          responseMode: "minimal",
          pollOptions: {
            includeEvents: true,
            includeActions: true,
            includeResult: true,
          },
        },
      },
      toolCounts: {
        core: 4,
      },
      runtimeWarnings,
      detectedMismatches: [],
      runtime: {
        codexMcpVersion: deps.version,
        codexCliVersion,
        activeSessions: deps.sessionManager.getActiveSessionCount(),
      },
    },
    null,
    2
  );
}

export function registerResources(
  server: Pick<McpServer, "registerResource">,
  deps: { version: string; sessionManager: RuntimeMetadataProvider; clientMode?: string }
): void {
  let codexCliVersionCache: string | null | undefined;
  const getCodexCliVersion = (): string | null => {
    if (codexCliVersionCache !== undefined) return codexCliVersionCache;
    codexCliVersionCache = detectCodexCliVersion();
    return codexCliVersionCache;
  };

  const byKey = new Map(RESOURCE_CATALOG.map((entry) => [entry.key, entry]));

  const serverInfoMeta = byKey.get("serverInfo")!;
  const serverInfoUri = new URL(RESOURCE_URIS.serverInfo);
  server.registerResource(
    serverInfoMeta.name,
    serverInfoUri.toString(),
    {
      title: serverInfoMeta.title,
      description: serverInfoMeta.description,
      mimeType: serverInfoMeta.mimeType,
    },
    () => {
      const observedModel = deps.sessionManager.getObservedDefaultModel();
      return asTextResource(
        serverInfoUri,
        JSON.stringify(
          {
            name: "codex-mcp",
            version: deps.version,
            codexCliVersion: getCodexCliVersion(),
            clientMode: deps.clientMode ?? "app-server",
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            stdioMode: resolveStdioMode().mode,
            supportedApprovalPolicies: APPROVAL_POLICIES,
            supportedSandboxModes: SANDBOX_MODES,
            supportedEffortLevels: EFFORT_LEVELS,
            activeSessions: deps.sessionManager.getActiveSessionCount(),
            defaultModel: observedModel,
            defaultModelSource: observedModel ? "session-default" : "unknown",
            resources: RESOURCE_CATALOG.map((entry) => ({
              uri: RESOURCE_URIS[entry.key],
              title: entry.title,
              mimeType: entry.mimeType,
              description: entry.description,
            })),
          },
          null,
          2
        ),
        "application/json"
      );
    }
  );

  const compatReportMeta = byKey.get("compatReport")!;
  const compatReportUri = new URL(RESOURCE_URIS.compatReport);
  server.registerResource(
    compatReportMeta.name,
    compatReportUri.toString(),
    {
      title: compatReportMeta.title,
      description: compatReportMeta.description,
      mimeType: compatReportMeta.mimeType,
    },
    () =>
      asTextResource(
        compatReportUri,
        buildCompatReport(deps, getCodexCliVersion()),
        "application/json"
      )
  );

  const configMeta = byKey.get("config")!;
  const configUri = new URL(RESOURCE_URIS.config);
  server.registerResource(
    configMeta.name,
    configUri.toString(),
    {
      title: configMeta.title,
      description: configMeta.description,
      mimeType: configMeta.mimeType,
    },
    () => asTextResource(configUri, buildConfigGuideText(), "text/markdown")
  );

  const gotchasMeta = byKey.get("gotchas")!;
  const gotchasUri = new URL(RESOURCE_URIS.gotchas);
  server.registerResource(
    gotchasMeta.name,
    gotchasUri.toString(),
    {
      title: gotchasMeta.title,
      description: gotchasMeta.description,
      mimeType: gotchasMeta.mimeType,
    },
    () => asTextResource(gotchasUri, buildGotchasText(), "text/markdown")
  );

  const quickstartMeta = byKey.get("quickstart")!;
  const quickstartUri = new URL(RESOURCE_URIS.quickstart);
  server.registerResource(
    quickstartMeta.name,
    quickstartUri.toString(),
    {
      title: quickstartMeta.title,
      description: quickstartMeta.description,
      mimeType: quickstartMeta.mimeType,
    },
    () => asTextResource(quickstartUri, buildQuickstartText(), "text/markdown")
  );

  const errorsMeta = byKey.get("errors")!;
  const errorsUri = new URL(RESOURCE_URIS.errors);
  server.registerResource(
    errorsMeta.name,
    errorsUri.toString(),
    {
      title: errorsMeta.title,
      description: errorsMeta.description,
      mimeType: errorsMeta.mimeType,
    },
    () => asTextResource(errorsUri, buildErrorsText(), "text/markdown")
  );
}

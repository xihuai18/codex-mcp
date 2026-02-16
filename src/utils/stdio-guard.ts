/**
 * STDIO preflight guard.
 *
 * Purpose:
 * - Detect elevated risk of stdout contamination before MCP stdio handshake.
 * - Support caller-selected behavior via CODEX_MCP_STDIO_MODE.
 */

export const STDIO_MODES = ["auto", "strict", "off"] as const;
export type StdioMode = (typeof STDIO_MODES)[number];

export interface StdioModeResolution {
  mode: StdioMode;
  source: "default" | "env" | "env_invalid";
  invalidRaw?: string;
}

export interface StdioPreflightOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export interface StdioPreflightResult {
  mode: StdioMode;
  modeSource: StdioModeResolution["source"];
  invalidMode?: string;
  riskLevel: "low" | "elevated";
  riskReasons: string[];
  notes: string[];
  suggestions: string[];
  shouldBlock: boolean;
}

export function resolveStdioMode(env: NodeJS.ProcessEnv = process.env): StdioModeResolution {
  const raw = env.CODEX_MCP_STDIO_MODE;
  if (raw === undefined) {
    return { mode: "auto", source: "default" };
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "") {
    return { mode: "auto", source: "default" };
  }

  if ((STDIO_MODES as readonly string[]).includes(normalized)) {
    return { mode: normalized as StdioMode, source: "env" };
  }

  return { mode: "auto", source: "env_invalid", invalidRaw: raw };
}

export function runStdioPreflight(opts: StdioPreflightOptions = {}): StdioPreflightResult {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const stdinIsTTY = opts.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = opts.stdoutIsTTY ?? Boolean(process.stdout.isTTY);

  const modeResolution = resolveStdioMode(env);
  const notes: string[] = [];
  const riskReasons: string[] = [];

  if (modeResolution.source === "env_invalid" && modeResolution.invalidRaw) {
    notes.push(
      `Invalid CODEX_MCP_STDIO_MODE='${modeResolution.invalidRaw}'. Falling back to 'auto'.`
    );
  }

  // In "off" mode, guard is intentionally disabled.
  if (modeResolution.mode === "off") {
    return {
      mode: modeResolution.mode,
      modeSource: modeResolution.source,
      invalidMode: modeResolution.invalidRaw,
      riskLevel: "low",
      riskReasons: [],
      notes,
      suggestions: [],
      shouldBlock: false,
    };
  }

  if (platform === "win32" && looksLikePowerShell(env)) {
    riskReasons.push(
      "PowerShell environment detected on Windows; shell profiles can print banner text to stdout."
    );
  }

  if (stdinIsTTY || stdoutIsTTY) {
    notes.push(
      "STDIO appears attached to a terminal (TTY). MCP clients should launch codex-mcp with piped stdio."
    );
  }

  const riskLevel: StdioPreflightResult["riskLevel"] = riskReasons.length > 0 ? "elevated" : "low";
  const shouldBlock = modeResolution.mode === "strict" && riskReasons.length > 0;

  return {
    mode: modeResolution.mode,
    modeSource: modeResolution.source,
    invalidMode: modeResolution.invalidRaw,
    riskLevel,
    riskReasons,
    notes,
    suggestions: riskReasons.length > 0 ? buildFixSuggestions(platform) : [],
    shouldBlock,
  };
}

function looksLikePowerShell(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.POWERSHELL_DISTRIBUTION_CHANNEL ||
    env.PSModulePath ||
    env.PSExecutionPolicyPreference ||
    env.PSModuleAnalysisCachePath
  );
}

function buildFixSuggestions(platform: NodeJS.Platform): string[] {
  const generic = [
    "Prefer direct MCP config launch: command='npx', args=['-y', '@leo000001/codex-mcp']",
    "Keep server stdout strictly JSON-RPC; route diagnostics to stderr only.",
    "codex-mcp cannot sanitize shell/profile stdout once emitted before MCP handshake.",
  ];

  if (platform === "win32") {
    return [
      'If shell wrapping is required, use: pwsh -NoProfile -Command "npx -y @leo000001/codex-mcp"',
      "Disable noisy PowerShell profile output (oh-my-posh banners, startup prompts, etc.).",
      ...generic,
    ];
  }

  return generic;
}

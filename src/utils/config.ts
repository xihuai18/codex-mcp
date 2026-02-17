/**
 * Configuration helpers for codex-mcp.
 */
import type { AppServerSpawnOptions } from "../app-server/lifecycle.js";
import type { ApprovalPolicy, EffortLevel, SandboxMode } from "../types.js";

export interface CodexToolParams {
  prompt: string;
  cwd?: string;
  model?: string;
  profile?: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  effort?: EffortLevel;
  advanced?: {
    baseInstructions?: string;
    developerInstructions?: string;
    personality?: string;
    summary?: string;
    config?: Record<string, unknown>;
    ephemeral?: boolean;
    outputSchema?: Record<string, unknown>;
    images?: string[];
    approvalTimeoutMs?: number;
  };
}

export function extractSpawnOptions(params: CodexToolParams): AppServerSpawnOptions {
  return {
    profile: params.profile,
    model: params.model,
    approvalPolicy: params.approvalPolicy,
    sandbox: params.sandbox,
    config: params.advanced?.config,
  };
}

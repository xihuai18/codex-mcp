/**
 * Build codex app-server spawn arguments from tool parameters.
 */
import type { ApprovalPolicy, SandboxMode } from "../types.js";

export interface AppServerSpawnOptions {
  profile?: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  config?: Record<string, unknown>;
}

export function buildAppServerArgs(opts: AppServerSpawnOptions): string[] {
  const args: string[] = ["app-server"];

  if (opts.profile) {
    args.push("-p", opts.profile);
  }
  if (opts.model) {
    args.push("-c", `model=${opts.model}`);
  }
  if (opts.approvalPolicy) {
    args.push("-c", `approval_policy=${opts.approvalPolicy}`);
  }
  if (opts.sandbox) {
    args.push("-c", `sandbox_mode=${opts.sandbox}`);
  }
  if (opts.config) {
    for (const [key, value] of Object.entries(opts.config)) {
      // Use raw value for primitives, JSON for objects/arrays
      const serialized =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      args.push("-c", `${key}=${serialized}`);
    }
  }

  return args;
}

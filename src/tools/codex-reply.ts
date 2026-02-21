/**
 * codex_reply tool — continue an existing session.
 */
import type { SessionManager } from "../session/manager.js";
import type {
  ApprovalPolicy,
  EffortLevel,
  Personality,
  SandboxMode,
  SessionStartResult,
  SummaryMode,
} from "../types.js";

export interface CodexReplyParams {
  sessionId: string;
  prompt: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  effort?: EffortLevel;
  summary?: SummaryMode;
  personality?: Personality;
  sandbox?: SandboxMode;
  cwd?: string;
  outputSchema?: Record<string, unknown>;
}

export async function executeCodexReply(
  args: CodexReplyParams,
  sessionManager: SessionManager
): Promise<SessionStartResult> {
  return sessionManager.replyToSession(args.sessionId, args.prompt, {
    model: args.model,
    approvalPolicy: args.approvalPolicy,
    effort: args.effort,
    summary: args.summary,
    personality: args.personality,
    sandbox: args.sandbox,
    cwd: args.cwd,
    outputSchema: args.outputSchema,
  });
}

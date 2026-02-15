/**
 * codex_check tool — poll events + respond to approvals/user input.
 */
import type { SessionManager } from "../session/manager.js";
import { ErrorCode, type CheckAction, type CheckResult } from "../types.js";

export interface CodexCheckParams {
  action: CheckAction;
  sessionId: string;
  // poll params
  cursor?: number;
  maxEvents?: number;
  // respond_approval params
  requestId?: string;
  decision?: string;
  execpolicyAmendment?: string[];
  denyMessage?: string;
  // respond_user_input params
  answers?: Record<string, { answers: string[] }>;
}

export function executeCodexCheck(
  args: CodexCheckParams,
  sessionManager: SessionManager
): CheckResult | { error: string; isError: true } {
  switch (args.action) {
    case "poll":
      return sessionManager.pollEvents(args.sessionId, args.cursor, args.maxEvents);

    case "respond_approval": {
      if (!args.requestId || !args.decision) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: requestId and decision required for respond_approval`,
          isError: true,
        };
      }
      try {
        sessionManager.resolveApproval(args.sessionId, args.requestId, args.decision, {
          execpolicyAmendment: args.execpolicyAmendment,
          denyMessage: args.denyMessage,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message, isError: true };
      }
      // Return current poll state after responding
      return sessionManager.pollEvents(args.sessionId, args.cursor, args.maxEvents);
    }

    case "respond_user_input": {
      if (!args.requestId || !args.answers) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: requestId and answers required for respond_user_input`,
          isError: true,
        };
      }
      try {
        sessionManager.resolveUserInput(args.sessionId, args.requestId, args.answers);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message, isError: true };
      }
      return sessionManager.pollEvents(args.sessionId, args.cursor, args.maxEvents);
    }

    default:
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${args.action}'`,
        isError: true,
      };
  }
}

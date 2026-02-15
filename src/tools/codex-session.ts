/**
 * codex_session tool — manage sessions (list/get/cancel/interrupt/fork).
 */
import type { SessionManager } from "../session/manager.js";
import { ErrorCode, type SessionAction } from "../types.js";

export interface CodexSessionParams {
  action: SessionAction;
  sessionId?: string;
  includeSensitive?: boolean;
}

export async function executeCodexSession(
  args: CodexSessionParams,
  sessionManager: SessionManager
): Promise<unknown> {
  switch (args.action) {
    case "list":
      return { sessions: sessionManager.listSessions() };

    case "get":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'get'`,
          isError: true,
        };
      }
      return sessionManager.getSession(args.sessionId, args.includeSensitive);

    case "cancel":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'cancel'`,
          isError: true,
        };
      }
      await sessionManager.cancelSession(args.sessionId);
      return { success: true, message: `Session ${args.sessionId} cancelled` };

    case "interrupt":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'interrupt'`,
          isError: true,
        };
      }
      await sessionManager.interruptSession(args.sessionId);
      return { success: true, message: `Session ${args.sessionId} interrupted` };

    case "fork":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'fork'`,
          isError: true,
        };
      }
      return await sessionManager.forkSession(args.sessionId);

    default:
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${args.action}'`,
        isError: true,
      };
  }
}

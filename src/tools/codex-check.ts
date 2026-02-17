/**
 * codex_check tool — poll events + respond to approvals/user input.
 */
import type { SessionManager } from "../session/manager.js";
import {
  ErrorCode,
  POLL_DEFAULT_MAX_EVENTS,
  POLL_MIN_MAX_EVENTS,
  RESPOND_DEFAULT_MAX_EVENTS,
  type CheckAction,
  type CheckResult,
} from "../types.js";

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
    case "poll": {
      // Default to a single incremental event for lightweight polling.
      // Polling with maxEvents=0 can cause no-op loops in some clients, so
      // enforce a minimum of 1 for poll.
      const maxEvents =
        typeof args.maxEvents === "number"
          ? Math.max(POLL_MIN_MAX_EVENTS, args.maxEvents)
          : POLL_DEFAULT_MAX_EVENTS;
      return sessionManager.pollEvents(args.sessionId, args.cursor, maxEvents);
    }

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
      // For respond_* actions:
      // - use monotonic cursor progression to avoid replay when some MCP hosts
      //   send stale/default cursor values.
      // - default to compact ACK (maxEvents=0) to avoid returning large event
      //   payloads on approval/user-input responses.
      const maxEvents = args.maxEvents ?? RESPOND_DEFAULT_MAX_EVENTS;
      return sessionManager.pollEventsMonotonic(args.sessionId, args.cursor, maxEvents);
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
      // For respond_* actions:
      // - use monotonic cursor progression to avoid replay when some MCP hosts
      //   send stale/default cursor values.
      // - default to compact ACK (maxEvents=0) to avoid returning large event
      //   payloads on approval/user-input responses.
      const maxEvents = args.maxEvents ?? RESPOND_DEFAULT_MAX_EVENTS;
      return sessionManager.pollEventsMonotonic(args.sessionId, args.cursor, maxEvents);
    }

    default:
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${args.action}'`,
        isError: true,
      };
  }
}

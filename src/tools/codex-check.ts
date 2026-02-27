/**
 * codex_check tool — poll events + respond to approvals/user input.
 */
import type { SessionManager } from "../session/manager.js";
import {
  ALL_DECISIONS,
  ErrorCode,
  POLL_DEFAULT_MAX_EVENTS,
  POLL_MIN_MAX_EVENTS,
  RESPOND_DEFAULT_MAX_EVENTS,
  type NetworkPolicyAmendment,
  type ApprovalDecision,
  type CheckAction,
  type CheckResult,
  type PollOptions,
  type ResponseMode,
} from "../types.js";

export interface CodexCheckParams {
  action: CheckAction;
  sessionId: string;
  // poll params
  cursor?: number;
  maxEvents?: number;
  // respond_permission params
  requestId?: string;
  decision?: ApprovalDecision;
  execpolicy_amendment?: string[];
  network_policy_amendment?: NetworkPolicyAmendment;
  denyMessage?: string;
  // respond_user_input params
  answers?: Record<string, { answers: string[] }>;
  responseMode?: ResponseMode;
  pollOptions?: PollOptions;
}

export function executeCodexCheck(
  args: CodexCheckParams,
  sessionManager: SessionManager
): CheckResult | { error: string; isError: true } {
  const responseMode = args.responseMode ?? "minimal";
  const pollOptions = args.pollOptions;

  switch (args.action) {
    case "poll": {
      if (
        args.requestId !== undefined ||
        args.decision !== undefined ||
        args.execpolicy_amendment !== undefined ||
        args.network_policy_amendment !== undefined ||
        args.denyMessage !== undefined ||
        args.answers !== undefined
      ) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: requestId/decision/execpolicy_amendment/network_policy_amendment/denyMessage/answers are only valid for respond_* actions`,
          isError: true,
        };
      }
      // Default to a single incremental event for lightweight polling.
      // Polling with maxEvents=0 can cause no-op loops in some clients, so
      // enforce a minimum of 1 for poll.
      const maxEvents =
        typeof args.maxEvents === "number"
          ? Math.max(POLL_MIN_MAX_EVENTS, Math.floor(args.maxEvents))
          : POLL_DEFAULT_MAX_EVENTS;
      return sessionManager.pollEvents(args.sessionId, args.cursor, maxEvents, {
        responseMode,
        pollOptions,
      });
    }

    case "respond_permission": {
      if (!args.requestId || !args.decision) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: requestId and decision required for respond_permission`,
          isError: true,
        };
      }
      if (args.answers !== undefined) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: answers is only valid for respond_user_input`,
          isError: true,
        };
      }
      if (args.decision === "acceptWithExecpolicyAmendment") {
        if (!args.execpolicy_amendment || args.execpolicy_amendment.length === 0) {
          return {
            error: `Error [${ErrorCode.INVALID_ARGUMENT}]: execpolicy_amendment required for acceptWithExecpolicyAmendment`,
            isError: true,
          };
        }
      } else if (args.execpolicy_amendment !== undefined) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: execpolicy_amendment is only valid with decision='acceptWithExecpolicyAmendment'`,
          isError: true,
        };
      }

      if (args.decision === "applyNetworkPolicyAmendment") {
        if (!args.network_policy_amendment) {
          return {
            error: `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment required for applyNetworkPolicyAmendment`,
            isError: true,
          };
        }
        if (
          args.network_policy_amendment.action !== "allow" &&
          args.network_policy_amendment.action !== "deny"
        ) {
          return {
            error: `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment.action must be 'allow' or 'deny'`,
            isError: true,
          };
        }
        if (!args.network_policy_amendment.host) {
          return {
            error: `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment.host required for applyNetworkPolicyAmendment`,
            isError: true,
          };
        }
      } else if (args.network_policy_amendment !== undefined) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment is only valid with decision='applyNetworkPolicyAmendment'`,
          isError: true,
        };
      }
      if (!ALL_DECISIONS.includes(args.decision)) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown decision '${args.decision}'`,
          isError: true,
        };
      }
      try {
        sessionManager.resolveApproval(args.sessionId, args.requestId, args.decision, {
          execpolicy_amendment: args.execpolicy_amendment,
          network_policy_amendment: args.network_policy_amendment,
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
      const maxEvents =
        typeof args.maxEvents === "number"
          ? Math.max(0, Math.floor(args.maxEvents))
          : RESPOND_DEFAULT_MAX_EVENTS;
      return sessionManager.pollEventsMonotonic(args.sessionId, args.cursor, maxEvents, {
        responseMode,
        pollOptions,
      });
    }

    case "respond_user_input": {
      if (!args.requestId || !args.answers) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: requestId and answers required for respond_user_input`,
          isError: true,
        };
      }
      if (
        args.decision !== undefined ||
        args.execpolicy_amendment !== undefined ||
        args.network_policy_amendment !== undefined ||
        args.denyMessage !== undefined
      ) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: decision/execpolicy_amendment/network_policy_amendment/denyMessage are only valid for respond_permission`,
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
      const maxEvents =
        typeof args.maxEvents === "number"
          ? Math.max(0, Math.floor(args.maxEvents))
          : RESPOND_DEFAULT_MAX_EVENTS;
      return sessionManager.pollEventsMonotonic(args.sessionId, args.cursor, maxEvents, {
        responseMode,
        pollOptions,
      });
    }

    default:
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${args.action}'`,
        isError: true,
      };
  }
}

/**
 * codex tool — start a new Codex agent session.
 */
import type { SessionManager } from "../session/manager.js";
import { DEFAULT_EFFORT_LEVEL, type SessionStartResult } from "../types.js";
import type { CodexToolParams } from "../utils/config.js";
import { extractSpawnOptions } from "../utils/config.js";
import { resolveAndValidateCwd } from "../utils/cwd.js";

export async function executeCodex(
  args: CodexToolParams,
  sessionManager: SessionManager,
  serverCwd: string
): Promise<SessionStartResult> {
  const cwd = resolveAndValidateCwd(args.cwd, serverCwd);
  const spawnOpts = extractSpawnOptions(args);
  const effort = args.effort ?? DEFAULT_EFFORT_LEVEL;

  return sessionManager.createSession(args.prompt, cwd, spawnOpts, effort, args.advanced);
}

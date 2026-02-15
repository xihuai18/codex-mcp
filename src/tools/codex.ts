/**
 * codex tool — start a new Codex agent session.
 */
import type { SessionManager } from "../session/manager.js";
import type { SessionStartResult } from "../types.js";
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

  return sessionManager.createSession(args.prompt, cwd, spawnOpts, args.effort, args.advanced);
}

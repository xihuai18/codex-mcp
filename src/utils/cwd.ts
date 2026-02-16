/**
 * cwd resolution + validation helpers.
 *
 * - Resolves relative paths against a provided base (not process.cwd()).
 * - Ensures the resolved path exists and is a directory.
 */
import { existsSync, statSync } from "fs";
import path from "path";
import { ErrorCode } from "../types.js";

export function resolveAndValidateCwd(inputCwd: string | undefined, baseCwd: string): string {
  const candidate = inputCwd ?? baseCwd;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(baseCwd, candidate);

  if (!existsSync(resolved)) {
    throw new Error(`Error [${ErrorCode.INVALID_ARGUMENT}]: cwd does not exist: ${resolved}`);
  }

  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Error [${ErrorCode.INVALID_ARGUMENT}]: cwd is not a directory: ${resolved}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes(`Error [${ErrorCode.INVALID_ARGUMENT}]`)) {
      throw err;
    }
    throw new Error(`Error [${ErrorCode.INVALID_ARGUMENT}]: cannot access cwd: ${resolved}`);
  }

  return resolved;
}

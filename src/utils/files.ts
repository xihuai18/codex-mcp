/**
 * File path resolution + validation helpers.
 */
import { existsSync, statSync } from "fs";
import path from "path";
import { ErrorCode } from "../types.js";

export function resolveAndValidateFilePath(
  inputPath: string,
  baseDir: string,
  label = "path"
): string {
  const resolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(baseDir, inputPath);

  if (!existsSync(resolved)) {
    throw new Error(`Error [${ErrorCode.INVALID_ARGUMENT}]: ${label} does not exist: ${resolved}`);
  }

  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`Error [${ErrorCode.INVALID_ARGUMENT}]: ${label} is not a file: ${resolved}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes(`Error [${ErrorCode.INVALID_ARGUMENT}]`)) {
      throw err;
    }
    throw new Error(`Error [${ErrorCode.INVALID_ARGUMENT}]: cannot access ${label}: ${resolved}`);
  }

  return resolved;
}

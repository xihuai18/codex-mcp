import { describe, it, expect } from "vitest";
import { redactPaths } from "../src/utils/redact.js";

describe("redactPaths", () => {
  it("redacts Windows drive-letter paths", () => {
    const out = redactPaths("failed at C:\\Users\\alice\\repo\\src\\index.ts");
    expect(out).toBe("failed at <path>");
  });

  it("redacts POSIX absolute paths", () => {
    const out = redactPaths('open "/home/alice/repo/src/index.ts" failed');
    expect(out).toBe('open "<path>" failed');
  });

  it("redacts UNC paths", () => {
    const out = redactPaths("cannot access \\\\server\\share\\repo\\src\\index.ts");
    expect(out).toBe("cannot access <path>");
  });
});

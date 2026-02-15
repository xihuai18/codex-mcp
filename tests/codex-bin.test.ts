import { describe, expect, it } from "vitest";
import { resolveCodexInvocation } from "../src/app-server/codex-bin.js";

describe("resolveCodexInvocation", () => {
  it("returns plain codex invocation on non-Windows", () => {
    const out = resolveCodexInvocation(["app-server"], { platform: "linux", env: {} });
    expect(out).toEqual({ cmd: "codex", args: ["app-server"], spawnedViaCmd: false });
  });

  it("uses node + resolved npm shim script on Windows when available", () => {
    const shim = "C:\\bin\\codex.cmd";
    const script = "C:\\node_modules\\@openai\\codex\\bin\\codex.js";

    const out = resolveCodexInvocation(["app-server", "-c", "model=gpt-5"], {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (p) => p === shim || p === script,
      readFile: () =>
        [
          "@ECHO OFF",
          "SETLOCAL",
          'SET "_prog=node"',
          `"%%_prog%%"  "%~dp0\\..\\node_modules\\@openai\\codex\\bin\\codex.js" %*`,
        ].join("\r\n"),
    });

    expect(out.cmd).toBe(process.execPath);
    expect(out.spawnedViaCmd).toBe(false);
    expect(out.args[0]).toBe(script);
    expect(out.args.slice(1)).toEqual(["app-server", "-c", "model=gpt-5"]);
  });

  it("falls back to cmd.exe invocation on Windows when shim cannot be resolved", () => {
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { PATH: "" },
      exists: () => false,
      readFile: () => "",
    });

    expect(out.spawnedViaCmd).toBe(true);
    expect(out.args.slice(0, 5)).toEqual(["/d", "/s", "/c", "codex", "app-server"]);
  });
});

#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function usage(exitCode = 0) {
  // eslint-disable-next-line no-console
  console.error(
    [
      "Usage:",
      "  node scripts/check-stdio.mjs [--npx] [--cwd <path>] [--timeout-ms <n>] [-- <command> <...args>]",
      "",
      "Checks that the MCP server does NOT write anything to stdout before a client connects.",
      "Any non-empty stdout output is treated as a failure (stdio transport requires stdout to be JSON-RPC only).",
      "",
      "Defaults:",
      "  (no args) -> spawns: node dist/index.js",
      "  --npx     -> spawns: npx -y @leo000001/codex-mcp",
      "",
    ].join("\n")
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    useNpx: false,
    cwd: process.cwd(),
    timeoutMs: 2000,
    overrideCommand: null,
    overrideArgs: [],
  };

  const dd = argv.indexOf("--");
  const main = dd === -1 ? argv : argv.slice(0, dd);
  const tail = dd === -1 ? [] : argv.slice(dd + 1);

  for (let i = 0; i < main.length; i++) {
    const a = main[i];
    if (a === "--help" || a === "-h") usage(0);
    if (a === "--npx") {
      out.useNpx = true;
      continue;
    }
    if (a === "--cwd") {
      const v = main[i + 1];
      if (!v) usage(2);
      out.cwd = v;
      i++;
      continue;
    }
    if (a === "--timeout-ms") {
      const v = main[i + 1];
      if (!v) usage(2);
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) usage(2);
      out.timeoutMs = Math.floor(n);
      i++;
      continue;
    }
    usage(2);
  }

  if (tail.length > 0) {
    out.overrideCommand = tail[0] ?? null;
    out.overrideArgs = tail.slice(1);
  }

  return out;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const command = args.overrideCommand
    ? args.overrideCommand
    : args.useNpx
      ? "npx"
      : "node";
  const cmdArgs = args.overrideCommand
    ? args.overrideArgs
    : args.useNpx
      ? ["-y", "@leo000001/codex-mcp"]
      : ["dist/index.js"];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-stdio-"));
  const stdoutPath = path.join(tmpDir, "stdout.log");
  const stderrPath = path.join(tmpDir, "stderr.log");

  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  const child = spawn(command, cmdArgs, {
    cwd: args.cwd,
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
    shell: false,
    env: process.env,
  });

  await wait(args.timeoutMs);

  // Best-effort terminate; if it already died, ignore.
  try {
    child.kill();
  } catch {
    // ignore
  }

  // Give the process a moment to flush output.
  await wait(200);

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const stdout = fs.readFileSync(stdoutPath, "utf8");
  const stderr = fs.readFileSync(stderrPath, "utf8");

  const stdoutNonEmpty = stdout.trim().length > 0;
  if (stdoutNonEmpty) {
    // eslint-disable-next-line no-console
    console.error("FAIL: stdout is not clean. First 400 chars:\n");
    // eslint-disable-next-line no-console
    console.error(stdout.slice(0, 400));
    // eslint-disable-next-line no-console
    console.error("\n---\nHint: anything printed to stdout will break MCP stdio handshake.");
    // eslint-disable-next-line no-console
    console.error(`Captured logs: ${stdoutPath} (stdout), ${stderrPath} (stderr)`);
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.error("OK: stdout is clean.");
  if (stderr.trim().length > 0) {
    // eslint-disable-next-line no-console
    console.error("(Note) server wrote to stderr (this is fine).");
  }
  // eslint-disable-next-line no-console
  console.error(`Captured logs: ${stdoutPath} (stdout), ${stderrPath} (stderr)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("FAILED:", err?.stack || String(err));
  process.exitCode = 1;
});


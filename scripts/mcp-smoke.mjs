#!/usr/bin/env node
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function usage(exitCode = 0) {
  const msg = [
    "Usage:",
    "  node scripts/mcp-smoke.mjs [--npx] [--cwd <path>] [--verbose] [-- <command> <...args>]",
    "",
    "Defaults:",
    "  (no args) -> spawns: node dist/index.js",
    "  --npx     -> spawns: npx -y @leo000001/codex-mcp",
    "  --        -> overrides command/args explicitly",
    "",
  ].join("\n");
  // eslint-disable-next-line no-console
  console.error(msg);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    useNpx: false,
    cwd: process.cwd(),
    verbose: false,
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
    if (a === "--verbose") {
      out.verbose = true;
      continue;
    }
    if (a === "--cwd") {
      const v = main[i + 1];
      if (!v) usage(2);
      out.cwd = v;
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

  const transport = new StdioClientTransport({
    command,
    args: cmdArgs,
    cwd: args.cwd,
    stderr: "pipe",
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }

  const client = new Client(
    { name: "codex-mcp-smoke", version: "0.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  const tools = await client.listTools();
  const names = new Set(tools.tools.map((t) => t.name));

  for (const required of ["codex", "codex_reply", "codex_session", "codex_check"]) {
    assert(names.has(required), `missing tool from tools/list: ${required}`);
  }

  if (args.verbose) {
    // eslint-disable-next-line no-console
    console.error("tools/list:", JSON.stringify(tools.tools.map((t) => t.name), null, 2));
  }

  const resources = await client.listResources();
  const uris = new Set(resources.resources.map((r) => r.uri));
  for (const uri of ["codex-mcp:///server-info", "codex-mcp:///config", "codex-mcp:///gotchas"]) {
    assert(uris.has(uri), `missing resource uri: ${uri}`);
  }

  await client.readResource({ uri: "codex-mcp:///server-info" });
  await client.readResource({ uri: "codex-mcp:///gotchas" });

  await client.close();
  // eslint-disable-next-line no-console
  console.error("OK: MCP handshake, tools, and resources look good.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("FAILED:", err?.stack || String(err));
  process.exitCode = 1;
});


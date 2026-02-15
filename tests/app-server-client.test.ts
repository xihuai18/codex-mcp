import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, spawn: spawnMock };
});

function createMockProcess() {
  const proc = new EventEmitter() as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough & { write: PassThrough["write"] };
    killed: boolean;
    exitCode: number | null;
    pid: number;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    on: EventEmitter["on"];
    emit: EventEmitter["emit"];
  };

  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough() as typeof proc.stdin;
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = 4242;
  proc.kill = () => {
    proc.killed = true;
    proc.exitCode = 0;
    proc.emit("exit", 0, null);
    return true;
  };

  let buffered = "";
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    buffered += str;

    let nl = buffered.indexOf("\n");
    while (nl !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      nl = buffered.indexOf("\n");

      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.id && msg.method === "initialize") {
        const resp = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "mock" } });
        proc.stdout.write(Buffer.from(resp + "\n", "utf8"));
      }
    }

    return origWrite(chunk as never, encoding as never, cb as never);
  }) as typeof proc.stdin.write;

  return proc;
}

describe("AppServerClient spawn behavior", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("spawns codex app-server in a Windows-compatible way", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const mod = await import("../src/app-server/client.js");
    const client = new mod.AppServerClient();
    const out = await client.start({ approvalPolicy: "never", sandbox: "read-only" });
    expect(out.userAgent).toBe("mock");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, spawnOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { detached?: boolean; windowsHide?: boolean }
    ];

    if (process.platform === "win32") {
      expect(spawnOpts?.detached).toBe(false);
      expect(spawnOpts?.windowsHide).toBe(true);

      const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
      if (cmd === process.execPath) {
        expect(args[1]).toBe("app-server");
      } else {
        expect(cmd).toBe(comspec);
        expect(args.slice(0, 5)).toEqual(["/d", "/s", "/c", "codex", "app-server"]);
      }
    } else {
      expect(cmd).toBe("codex");
      expect(args[0]).toBe("app-server");
      expect(spawnOpts?.detached).toBe(true);
    }
  });
});

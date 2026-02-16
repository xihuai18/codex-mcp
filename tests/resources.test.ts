import { describe, it, expect } from "vitest";
import { registerResources, RESOURCE_URIS } from "../src/resources/register-resources.js";

describe("resources", () => {
  it("registers expected URIs and includes advanced.config guidance", () => {
    const registered: Array<{
      name: string;
      uri: string;
      title?: string;
      mimeType?: string;
      read: () => unknown;
    }> = [];

    const fakeServer = {
      registerResource: (
        name: string,
        uriOrTemplate: string,
        config: { title?: string; mimeType?: string },
        readCallback: () => unknown
      ) => {
        registered.push({
          name,
          uri: uriOrTemplate,
          title: config.title,
          mimeType: config.mimeType,
          read: readCallback,
        });
        return {};
      },
    };

    registerResources(fakeServer as never, { version: "0.0.0-test" });

    const uris = registered.map((r) => r.uri);
    expect(uris).toContain(RESOURCE_URIS.serverInfo);
    expect(uris).toContain(RESOURCE_URIS.config);
    expect(uris).toContain(RESOURCE_URIS.gotchas);

    const config = registered.find((r) => r.uri === RESOURCE_URIS.config);
    expect(config?.mimeType).toBe("text/markdown");

    const readResult = config?.read() as { contents?: Array<{ text?: string }> };
    const text = readResult.contents?.[0]?.text ?? "";
    expect(text).toContain("advanced.config");
    expect(text).toContain("-c key=value");

    const serverInfo = registered.find((r) => r.uri === RESOURCE_URIS.serverInfo);
    expect(serverInfo?.mimeType).toBe("application/json");
    const serverInfoResult = serverInfo?.read() as { contents?: Array<{ text?: string }> };
    const payload = JSON.parse(serverInfoResult.contents?.[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;
    expect(payload.version).toBe("0.0.0-test");
    expect(typeof payload.platform).toBe("string");
    expect(typeof payload.node).toBe("string");
    expect(typeof payload.stdioMode).toBe("string");

    const gotchas = registered.find((r) => r.uri === RESOURCE_URIS.gotchas);
    expect(gotchas?.mimeType).toBe("text/markdown");
    const gotchasResult = gotchas?.read() as { contents?: Array<{ text?: string }> };
    const gotchasText = gotchasResult.contents?.[0]?.text ?? "";
    expect(gotchasText).toContain("monotonic");
    expect(gotchasText).toContain("codex-mcp/reconnect");
  });
});

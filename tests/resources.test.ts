import { describe, it, expect } from "vitest";
import { registerResources, RESOURCE_URIS } from "../src/resources/register-resources.js";

describe("resources", () => {
  it("registers expected URIs and exposes richer runtime/docs metadata", () => {
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

    registerResources(fakeServer as never, {
      version: "0.0.0-test",
      sessionManager: {
        getActiveSessionCount: () => 3,
        getObservedDefaultModel: () => "o4-mini",
      },
    });

    const uris = registered.map((r) => r.uri);
    expect(uris).toContain(RESOURCE_URIS.serverInfo);
    expect(uris).toContain(RESOURCE_URIS.config);
    expect(uris).toContain(RESOURCE_URIS.gotchas);
    expect(uris).toContain(RESOURCE_URIS.quickstart);
    expect(uris).toContain(RESOURCE_URIS.errors);

    const config = registered.find((r) => r.uri === RESOURCE_URIS.config);
    expect(config?.mimeType).toBe("text/markdown");

    const readResult = config?.read() as { contents?: Array<{ text?: string }> };
    const text = readResult.contents?.[0]?.text ?? "";
    expect(text).toContain("advanced.config");
    expect(text).toContain("`codex_reply` differences");
    expect(text).toContain("approvalTimeoutMs");
    expect(text).toContain("Override persistence");

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
    expect(Array.isArray(payload.supportedApprovalPolicies)).toBe(true);
    expect(Array.isArray(payload.supportedSandboxModes)).toBe(true);
    expect(Array.isArray(payload.supportedEffortLevels)).toBe(true);
    expect(payload.activeSessions).toBe(3);
    expect(payload.defaultModel).toBe("o4-mini");
    expect(payload.defaultModelSource).toBe("session-default");
    expect(Array.isArray(payload.resources)).toBe(true);

    const gotchas = registered.find((r) => r.uri === RESOURCE_URIS.gotchas);
    expect(gotchas?.mimeType).toBe("text/markdown");
    const gotchasResult = gotchas?.read() as { contents?: Array<{ text?: string }> };
    const gotchasText = gotchasResult.contents?.[0]?.text ?? "";
    expect(gotchasText).toContain("monotonic");
    expect(gotchasText).toContain("codex-mcp/reconnect");
    expect(gotchasText).toContain("untrusted");
    expect(gotchasText).toContain("Idle sessions are auto-cleaned");

    const quickstart = registered.find((r) => r.uri === RESOURCE_URIS.quickstart);
    expect(quickstart?.mimeType).toBe("text/markdown");
    const quickstartResult = quickstart?.read() as { contents?: Array<{ text?: string }> };
    const quickstartText = quickstartResult.contents?.[0]?.text ?? "";
    expect(quickstartText).toContain("Minimal flow");
    expect(quickstartText).toContain("\"action\": \"respond_approval\"");

    const errors = registered.find((r) => r.uri === RESOURCE_URIS.errors);
    expect(errors?.mimeType).toBe("text/markdown");
    const errorsResult = errors?.read() as { contents?: Array<{ text?: string }> };
    const errorsText = errorsResult.contents?.[0]?.text ?? "";
    expect(errorsText).toContain("Error [CODE]");
    expect(errorsText).toContain("REQUEST_NOT_FOUND");
  });
});

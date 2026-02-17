import { describe, it, expect } from "vitest";
import { extractSpawnOptions } from "../src/utils/config.js";

describe("extractSpawnOptions", () => {
  it("maps top-level and advanced.config fields to spawn options", () => {
    const opts = extractSpawnOptions({
      prompt: "hello",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      effort: "medium",
      model: "o4-mini",
      profile: "default",
      advanced: {
        config: {
          retries: 2,
        },
      },
    });

    expect(opts).toEqual({
      profile: "default",
      model: "o4-mini",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      config: { retries: 2 },
    });
  });
});

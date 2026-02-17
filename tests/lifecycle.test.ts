import { describe, it, expect } from "vitest";
import { buildAppServerArgs } from "../src/app-server/lifecycle.js";

describe("buildAppServerArgs", () => {
  it("serializes primitive config values with String()", () => {
    const args = buildAppServerArgs({
      config: {
        retries: 3,
        enabled: true,
        mode: "fast",
        nullable: null,
      },
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "app-server",
        "-c",
        "retries=3",
        "-c",
        "enabled=true",
        "-c",
        "mode=fast",
        "-c",
        "nullable=null",
      ])
    );
  });

  it("serializes object/array config values with JSON.stringify()", () => {
    const args = buildAppServerArgs({
      config: {
        sandbox: { mode: "workspace-write", paths: ["src", "tests"] },
        tools: ["bash", "read", "edit"],
      },
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "-c",
        'sandbox={"mode":"workspace-write","paths":["src","tests"]}',
        "-c",
        'tools=["bash","read","edit"]',
      ])
    );
  });
});

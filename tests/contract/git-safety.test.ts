import { describe, expect, it } from "vitest";
import { gitSafeEnvironment } from "../../packages/worker/src/git.js";

describe("AgentCore Git mount safety", () => {
  it("scopes safe.directory to the repository being operated on", () => {
    const environment = gitSafeEnvironment("/mnt/workspace/repo/example");
    expect(environment).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/mnt/workspace/repo/example",
    });
    expect(environment.GIT_CONFIG_VALUE_0).not.toBe("*");
  });
});

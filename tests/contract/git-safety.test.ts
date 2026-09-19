import { describe, expect, it } from "vitest";
import { gitSafeEnvironment } from "../../packages/worker/src/git.js";
import {
  assertCredentialFreeRemote,
  assertNonForceGitArguments,
  runGitWithCredential,
} from "../../packages/worker/src/git-auth.js";

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

describe("credential-safe Git execution", () => {
  it("rejects credential-bearing remotes", () => {
    expect(() => assertCredentialFreeRemote("https://token@github.com/example/repo.git")).toThrow(
      /must not contain credentials/,
    );
  });

  it("does not require credentials for local Git commands", async () => {
    const result = await runGitWithCredential({
      directory: process.cwd(),
      args: ["--version"],
    });
    expect(result.stdout).toMatch(/^git version /);
  });

  it("rejects incomplete HTTP credentials before invoking Git", async () => {
    await expect(runGitWithCredential({
      directory: process.cwd(),
      args: ["--version"],
      credential: { username: "x-access-token" },
    })).rejects.toThrow(/both username and password/);
  });

  it("rejects every force-like push argument and refspec", () => {
    for (const args of [
      ["push", "--force", "origin", "HEAD:refs/heads/agentx/example"],
      ["push", "--force-with-lease", "origin", "HEAD:refs/heads/agentx/example"],
      ["push", "-f", "origin", "HEAD:refs/heads/agentx/example"],
      ["push", "origin", "+HEAD:refs/heads/agentx/example"],
      ["push", "origin", "HEAD:+refs/heads/agentx/example"],
      ["-C", "/mnt/workspace/repo/example", "push", "--force", "origin", "HEAD:refs/heads/agentx/example"],
    ]) {
      expect(() => assertNonForceGitArguments(args)).toThrow(/force push/i);
    }
    expect(() => assertNonForceGitArguments([
      "push",
      "--porcelain",
      "origin",
      "HEAD:refs/heads/agentx/example",
    ])).not.toThrow();
  });
});

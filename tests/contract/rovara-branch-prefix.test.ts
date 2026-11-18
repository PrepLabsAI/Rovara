// Naming phase 1: Rovara's pull request branches are `rovara/<uuid>` from now on, and every reader still
// recognises the older `agentx/<uuid>` branches that staging may hold. Anything else is refused as before.
import { describe, expect, it, vi } from "vitest";
import { PullRequestResultSchema } from "../../packages/contracts/src/operation.js";
import { SpecPullRequestSchema } from "../../packages/broker/src/core/spec/state.js";
import { specBranchName } from "../../packages/broker/src/core/spec/state.js";
import { headBranchOf } from "../../packages/broker/src/core/build-step/publish.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";

const ID = "0f0e0d0c-0b0a-4908-a706-050403020100";

describe("branch names Rovara writes", () => {
  it("a publication branch is rovara/<operation id>", () => {
    expect(headBranchOf(ID)).toBe(`rovara/${ID}`);
  });
  it("a spec pull request branch is rovara/<uuid-shaped hash> and passes the stored-state schema", () => {
    const branch = specBranchName("task-1", 1);
    expect(branch).toMatch(/^rovara\/[0-9a-f-]{36}$/);
    expect(SpecPullRequestSchema.shape.headBranch.safeParse(branch).success).toBe(true);
    // The hash seed is a stored identity: the same task and attempt keep their hash part.
    expect(branch.slice("rovara/".length)).toBe(specBranchName("task-1", 1).slice("rovara/".length));
    expect(specBranchName("task-1", 2)).not.toBe(branch);
  });
});

describe("branch names Rovara recognises", () => {
  it.each([
    [`rovara/${ID}`, true],
    [`agentx/${ID}`, true],
    [`other/${ID}`, false],
    ["rovara/not-a-uuid", false],
    [`rovara/${ID}x`, false],
    [`xrovara/${ID}`, false],
    [`rovara//${ID}`, false],
    ["main", false],
  ])("the publication result schema: %s -> %s", (branch, ok) => {
    expect(PullRequestResultSchema.shape.headBranch.safeParse(branch).success).toBe(ok);
  });

  it.each([
    [`rovara/${ID}`, true],
    [`agentx/${ID}`, true],
    [`other/${ID}`, false],
    [`rovara/../x`, false],
    [`agentx/%2e%2e`, false],
  ])("the stored spec pull request schema: %s -> %s", (branch, ok) => {
    expect(SpecPullRequestSchema.shape.headBranch.safeParse(branch).success).toBe(ok);
  });

  const provider = () => new GitHubAppCredentialProvider({
    credentialRef: "github-app", appId: "1", getPrivateKey: async () => "unused",
    fetchImplementation: vi.fn(async (): Promise<Response> => { throw new Error("no network in this test"); }),
  });
  it.each([`rovara/${ID}`, `agentx/${ID}`])("the GitHub client passes the branch-name check for %s (and fails later, on the missing network)", async (branch) => {
    const error = await provider().getBranchHead("https://github.com/acme/web", branch, { orgId: "o" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("branch name is invalid");
  });
  it.each([`other/${ID}`, "rovara/../x", "agentx/x", `feature/${ID}`])("the GitHub client refuses %s before any request", async (branch) => {
    await expect(provider().getBranchHead("https://github.com/acme/web", branch, { orgId: "o" })).rejects.toThrow("branch name is invalid");
  });
});

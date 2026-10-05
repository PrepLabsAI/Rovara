// Spec 051 Ruling X, D-15, #299: a cd target the agent's shell knows (the container or host folder) reads as the
// workspace-relative folder, for every cd in a command rather than only a leading `cd … &&`.
import { describe, expect, it } from "vitest";
import { workspaceRelativeCdTarget } from "../../packages/worker/src/devcontainer.js";
import { testbedRelativeCdTarget } from "../../packages/worker/src/swebench/agent.js";

describe("workspaceRelativeCdTarget", () => {
  const paths = { hostFolder: "/work/root/repo", containerFolder: "/workspaces/repo" };
  const root = "/work/root";

  it.each([
    ["/workspaces/repo", "repo"],
    ["/workspaces/repo/", "repo/"],
    ["/workspaces/repo/pkg/a", "repo/pkg/a"],
    ["/work/root/repo", "repo"],
    ["/work/root/repo/pkg", "repo/pkg"],
  ])("maps %j to %j", (target, mapped) => {
    expect(workspaceRelativeCdTarget(target, paths, root)).toBe(mapped);
  });

  it.each(["/workspaces/repoX", "/workspaces", "/etc", "repo", "pkg", "/work/root", "~"])("leaves %j unmapped", (target) => {
    expect(workspaceRelativeCdTarget(target, paths, root)).toBeUndefined();
  });

  it("maps the folder to the root as an empty path when the repository is the root", () => {
    expect(workspaceRelativeCdTarget("/workspaces/repo", { hostFolder: root, containerFolder: "/workspaces/repo" }, root)).toBe("");
    expect(workspaceRelativeCdTarget("/workspaces/repo/x", { hostFolder: root, containerFolder: "/workspaces/repo" }, root)).toBe("x");
  });

  it("maps nothing when the host folder is outside the root", () => {
    expect(workspaceRelativeCdTarget("/workspaces/repo", { hostFolder: "/elsewhere/repo", containerFolder: "/workspaces/repo" }, root)).toBeUndefined();
  });
});

describe("testbedRelativeCdTarget", () => {
  const paths = { hostFolder: "/runs/r1/testbed", containerFolder: "/testbed" };

  it.each([
    ["/testbed", "testbed"],
    ["/testbed/astropy/io", "testbed/astropy/io"],
  ])("maps %j to %j", (target, mapped) => {
    expect(testbedRelativeCdTarget(target, paths)).toBe(mapped);
  });

  it.each(["/testbedX", "/app", "testbed"])("leaves %j unmapped", (target) => {
    expect(testbedRelativeCdTarget(target, paths)).toBeUndefined();
  });
});

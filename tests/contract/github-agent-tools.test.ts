import { AgentXError } from "@agentx/contracts";
import { agentGitHubGuard, GuardRejection, type GuardInput } from "../../packages/gateway/src/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_AGENT_REFUSED_TOOLS,
  GITHUB_AGENT_TOOL_PERMISSIONS,
  checkAgentTokenPermissions,
  githubAgentToolPermissions,
  isGitHubAgentToolRefused,
} from "../../packages/broker/src/agents/github-agent-tools.js";

const REFUSAL = "Pushes and merges happen only through Rovara Code's pull request flow.";

function refusal(call: () => unknown): AgentXError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentXError);
    return error as AgentXError;
  }
  throw new Error("expected a refusal");
}

describe("GitHub agent tool catalog", () => {

  it("never grants contents write, workflows, administration or actions in any tool", () => {
    for (const [tool, permissions] of Object.entries(GITHUB_AGENT_TOOL_PERMISSIONS)) {
      expect(() => checkAgentTokenPermissions(githubAgentToolPermissions(tool)), tool).not.toThrow();
      expect(Object.keys(permissions).every((key) => ["issues", "pull_requests", "contents"].includes(key)), tool).toBe(true);
      expect(permissions.contents === undefined || permissions.contents === "read", tool).toBe(true);
      expect(isGitHubAgentToolRefused(tool), tool).toBe(false);
    }
  });

  it.each([
    "push_files",
  ])("refuses %s with the exact text", (tool) => {
    expect(isGitHubAgentToolRefused(tool)).toBe(true);
    const error = refusal(() => githubAgentToolPermissions(tool));
    expect(error.code).toBe("AGENT_TOOL_NOT_GRANTED");
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(`AGENT_TOOL_NOT_GRANTED: ${REFUSAL}`);
  });

  it("lists the refused tools and globs", () => {
    expect(GITHUB_AGENT_REFUSED_TOOLS).toEqual([
      "push_files", "create_or_update_file", "delete_file", "create_branch", "create_repository", "fork_repository", "create_pull_request",
      "update_pull_request_branch", "merge_pull_request", "enable_pull_request_auto_merge", "*workflow*", "*secret*",
    ]);
  });

});

describe("checkAgentTokenPermissions", () => {
  it.each([
    [{ contents: "write", metadata: "read" }],
    [{ workflows: "write" }],
    [{ issues: true }],
  ])("throws for %j", (permissions) => {
    const error = refusal(() => checkAgentTokenPermissions(permissions));
    expect(error.code).toBe("FORBIDDEN");
  });

  it("throws for permissions that are not a plain object", () => {
    for (const permissions of [undefined, null, "issues", 4, ["issues"]]) expect(() => checkAgentTokenPermissions(permissions as never)).toThrow(AgentXError);
  });

});

const GUARD_BOUND = { owner: "acme", repo: "app" };

function guardInput(tool: string, args: Record<string, unknown>, call: GuardInput["connection"]["call"] = vi.fn()): GuardInput {
  return { tool, arguments: args, bound: GUARD_BOUND, scope: { name: "app", url: "https://github.com/acme/app.git", credentialRef: "github-app" }, connection: { call } };
}

const issueResult = (number: number, extra: Record<string, unknown> = {}) => ({
  isError: false,
  content: [{ type: "text", text: JSON.stringify({ number, html_url: `https://github.com/acme/app/issues/${number}`, ...extra }) }],
});

describe("agentGitHubGuard", () => {
  const exists = vi.fn(({ number }: { owner: string; repo: string; number: number }) => Promise.resolve(number === 7));
  const guard = agentGitHubGuard({ pullRequestExists: exists });

  it("refuses a PR tool naming another repository", async () => {
    await expect(guard.check(guardInput("pull_request_read", { owner: "evil", repo: "app", pullNumber: 7, method: "get" }))).rejects.toBeInstanceOf(GuardRejection);
    await expect(guard.check(guardInput("pull_request_read", { owner: "acme", repo: "other", pullNumber: 7, method: "get" }))).rejects.toThrow(/selected repository/);
    await expect(guard.check(guardInput("get_pull_request", { owner: "acme", repo: "app", repository: "evil/app", pullNumber: 7 }))).rejects.toBeInstanceOf(GuardRejection);
    expect(exists).not.toHaveBeenCalled();
  });

  it("refuses when the bound repository is missing", async () => {
    const input = { ...guardInput("list_commits", {}), bound: {} };
    await expect(guard.check(input)).rejects.toBeInstanceOf(GuardRejection);
  });

  it("needs a pull request number that exists in the repository for a PR tool", async () => {
    exists.mockClear();
    await expect(guard.check(guardInput("pull_request_read", { pullNumber: 7, method: "get" }))).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledWith({ owner: "acme", repo: "app", number: 7 });
    await expect(guard.check(guardInput("get_pull_request_files", { pullNumber: 7 }))).resolves.toBeUndefined();
    await expect(guard.check(guardInput("pull_request_review_write", { pullNumber: 7, method: "create" }))).resolves.toBeUndefined();
    await expect(guard.check(guardInput("pull_request_read", { pullNumber: 8, method: "get" }))).rejects.toThrow(/pull request/);
    await expect(guard.check(guardInput("pull_request_read", { method: "get" }))).rejects.toThrow(/pull request number/);
    for (const bad of [0, -1, 1.5, "7", NaN, null, Number.MAX_SAFE_INTEGER + 2, [7], {}]) {
      await expect(guard.check(guardInput("pull_request_read", { pullNumber: bad }))).rejects.toBeInstanceOf(GuardRejection);
    }
  });

  it("checks the number on any tool that carries a pull request number, and fails closed when the lookup fails", async () => {
    await expect(guard.check(guardInput("list_commits", { pullNumber: 9 }))).rejects.toBeInstanceOf(GuardRejection);
    const failing = agentGitHubGuard({ pullRequestExists: () => Promise.reject(new Error("GitHub down")) });
    await expect(failing.check(guardInput("pull_request_read", { pullNumber: 7 }))).rejects.toThrow("GitHub down");
  });

  it("lets add_issue_comment name a pull request, without a preflight", async () => {
    const call = vi.fn();
    await expect(guard.check(guardInput("add_issue_comment", { issue_number: 12, body: "ok" }, call))).resolves.toBeUndefined();
    expect(call).not.toHaveBeenCalled();
    expect(guard.requiredTools("add_issue_comment", { issue_number: 12, body: "ok" })).toEqual([]);
    await expect(guard.check(guardInput("add_issue_comment", { issue_number: 0, body: "ok" }))).rejects.toBeInstanceOf(GuardRejection);
    await expect(guard.check(guardInput("add_issue_comment", { issue_number: "12", body: "ok" }))).rejects.toBeInstanceOf(GuardRejection);
  });

  it("refuses a pull request number on the other issue tools, as issueNotPullRequestGuard does", async () => {
    expect(guard.requiredTools("update_issue", { issue_number: 3 })).toEqual(["issue_read"]);
    expect(guard.requiredTools("update_issue", {})).toEqual([]);
    const asIssue = vi.fn(() => Promise.resolve(issueResult(3)));
    await expect(guard.check(guardInput("update_issue", { issue_number: 3, title: "x" }, asIssue as never))).resolves.toBeUndefined();
    expect(asIssue).toHaveBeenCalledWith("issue_read", { method: "get", owner: "acme", repo: "app", issue_number: 3 });
    const asPull = vi.fn(() => Promise.resolve(issueResult(4, { pull_request: { url: "x" } })));
    await expect(guard.check(guardInput("update_issue", { issue_number: 4, title: "x" }, asPull as never))).rejects.toThrow(/not a pull request/);
    await expect(guard.check(guardInput("issue_read", { issue_number: 4, method: "get" }, asPull as never))).rejects.toThrow(/not a pull request/);
  });

  it("refuses an issue number that is not a positive integer", async () => {
    for (const bad of [0, -2, 1.5, "3", null, NaN]) {
      await expect(guard.check(guardInput("update_issue", { issue_number: bad }))).rejects.toBeInstanceOf(GuardRejection);
    }
  });

});

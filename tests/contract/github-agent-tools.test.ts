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
  it("grants issues and pull-request reads and writes with exactly the permissions of the tool, plus metadata read", () => {
    expect(githubAgentToolPermissions("add_issue_comment")).toEqual({ issues: "write", metadata: "read" });
    expect(githubAgentToolPermissions("pull_request_read")).toEqual({ pull_requests: "read", contents: "read", metadata: "read" });
    expect(githubAgentToolPermissions("get_issue")).toEqual({ issues: "read", metadata: "read" });
    expect(githubAgentToolPermissions("list_issues")).toEqual({ issues: "read", metadata: "read" });
    expect(githubAgentToolPermissions("search_issues")).toEqual({ issues: "read", metadata: "read" });
    expect(githubAgentToolPermissions("update_issue")).toEqual({ issues: "write", metadata: "read" });
    expect(githubAgentToolPermissions("create_issue")).toEqual({ issues: "write", metadata: "read" });
    expect(githubAgentToolPermissions("get_pull_request")).toEqual({ pull_requests: "read", contents: "read", metadata: "read" });
    expect(githubAgentToolPermissions("get_pull_request_files")).toEqual({ pull_requests: "read", contents: "read", metadata: "read" });
    expect(githubAgentToolPermissions("list_pull_requests")).toEqual({ pull_requests: "read", contents: "read", metadata: "read" });
    expect(githubAgentToolPermissions("pull_request_review_write")).toEqual({ pull_requests: "write", metadata: "read" });
    for (const tool of ["list_commits", "get_commit", "get_file_contents", "search_code"]) {
      expect(githubAgentToolPermissions(tool)).toEqual({ contents: "read", metadata: "read" });
    }
  });

  it("gives the caller a copy it can't use to change the catalog", () => {
    const first = githubAgentToolPermissions("get_issue") as Record<string, string>;
    first.contents = "write";
    expect(githubAgentToolPermissions("get_issue")).toEqual({ issues: "read", metadata: "read" });
    expect(GITHUB_AGENT_TOOL_PERMISSIONS.get_issue).toEqual({ issues: "read" });
  });

  it("never grants contents write, workflows, administration or actions in any tool", () => {
    for (const [tool, permissions] of Object.entries(GITHUB_AGENT_TOOL_PERMISSIONS)) {
      expect(() => checkAgentTokenPermissions(githubAgentToolPermissions(tool)), tool).not.toThrow();
      expect(Object.keys(permissions).every((key) => ["issues", "pull_requests", "contents"].includes(key)), tool).toBe(true);
      expect(permissions.contents === undefined || permissions.contents === "read", tool).toBe(true);
      expect(isGitHubAgentToolRefused(tool), tool).toBe(false);
    }
  });

  it.each([
    "push_files", "create_or_update_file", "delete_file", "create_branch", "create_repository", "fork_repository", "create_pull_request",
    "update_pull_request_branch", "merge_pull_request", "enable_pull_request_auto_merge",
    "run_workflow", "list_workflow_runs", "rerun_workflow", "get_workflow", "dispatch_workflow_event", "create_secret", "list_secrets", "get_secret_scanning_alert", "secret_scanning",
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

  it("refuses them even when the catalog lists them: a refusal overrides a catalog entry", () => {
    const catalog = { merge_pull_request: { contents: "read" }, run_workflow_x: { contents: "read" }, get_issue: { issues: "read" } } as const;
    expect(refusal(() => githubAgentToolPermissions("merge_pull_request", catalog)).message).toBe(`AGENT_TOOL_NOT_GRANTED: ${REFUSAL}`);
    expect(refusal(() => githubAgentToolPermissions("run_workflow_x", catalog)).message).toBe(`AGENT_TOOL_NOT_GRANTED: ${REFUSAL}`);
    expect(githubAgentToolPermissions("get_issue", catalog)).toEqual({ issues: "read", metadata: "read" });
  });

  it("freezes the catalog", () => {
    expect(Object.isFrozen(GITHUB_AGENT_TOOL_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(GITHUB_AGENT_TOOL_PERMISSIONS.get_issue)).toBe(true);
    expect(Object.isFrozen(GITHUB_AGENT_REFUSED_TOOLS)).toBe(true);
  });

  it("matches the globs case-insensitively and after normalization", () => {
    for (const tool of ["Merge_Pull_Request", "MERGE_PULL_REQUEST", " merge_pull_request ", "Run_Workflow", "list_WORKFLOWS", "delete_SECRET", "ｍerge_pull_request", "merge_pull_\u200brequest"]) {
      expect(isGitHubAgentToolRefused(tool), tool).toBe(true);
      expect(refusal(() => githubAgentToolPermissions(tool)).message, tool).toContain(REFUSAL);
    }
  });

  it("refuses an unmapped tool the same way", () => {
    for (const tool of ["get_me", "actions_run_trigger", "search_repositories", "close_issue", "dismiss_notification", "", "get_issue ", "GET_ISSUE", "get_issue\u200b", "constructor", "__proto__", "toString", "hasOwnProperty", "get_issue*"]) {
      const error = refusal(() => githubAgentToolPermissions(tool));
      expect(error.code, JSON.stringify(tool)).toBe("AGENT_TOOL_NOT_GRANTED");
      expect(error.message, JSON.stringify(tool)).toBe(`AGENT_TOOL_NOT_GRANTED: ${REFUSAL}`);
    }
  });

  it("refuses a tool name that is not a string", () => {
    for (const tool of [undefined, null, 4, {}, ["get_issue"]]) {
      expect(refusal(() => githubAgentToolPermissions(tool as never)).code).toBe("AGENT_TOOL_NOT_GRANTED");
    }
  });
});

describe("checkAgentTokenPermissions", () => {
  it.each([
    [{ contents: "write", metadata: "read" }],
    [{ contents: "write" }],
    [{ workflows: "write" }],
    [{ workflows: "read" }],
    [{ administration: "write" }],
    [{ administration: "read" }],
    [{ actions: "write" }],
    [{ deployments: "write" }],
    [{ issues: "read", secrets: "write" }],
    [{ pull_requests: "write", checks: "write" }],
    [{ members: "read" }],
    [{ statuses: "write" }],
    [{ packages: "read" }],
    [{ ISSUES: "read" }],
    [{ issues: "admin" }],
    [{ issues: "WRITE" }],
    [{ issues: true }],
    [{ issues: undefined }],
    [{ metadata: "write" }],
    [{ issues: "read", ["__proto__"]: "x" }],
  ])("throws for %j", (permissions) => {
    const error = refusal(() => checkAgentTokenPermissions(permissions));
    expect(error.code).toBe("FORBIDDEN");
  });

  it("throws for permissions that are not a plain object", () => {
    for (const permissions of [undefined, null, "issues", 4, ["issues"]]) expect(() => checkAgentTokenPermissions(permissions as never)).toThrow(AgentXError);
  });

  it("throws on an inherited-looking key that is really own via JSON", () => {
    expect(() => checkAgentTokenPermissions(JSON.parse('{"__proto__": "write"}') as never)).toThrow(AgentXError);
  });

  it("passes issues, pull_requests, contents read and metadata read and returns them", () => {
    expect(checkAgentTokenPermissions({ issues: "write", metadata: "read" })).toEqual({ issues: "write", metadata: "read" });
    expect(checkAgentTokenPermissions({ pull_requests: "write", contents: "read", issues: "read", metadata: "read" })).toEqual({ pull_requests: "write", contents: "read", issues: "read", metadata: "read" });
    expect(checkAgentTokenPermissions({})).toEqual({});
    // `actions` and `deployments` are allowed at `read`, and only at `read`.
    expect(checkAgentTokenPermissions({ actions: "read", metadata: "read" })).toEqual({ actions: "read", metadata: "read" });
    expect(checkAgentTokenPermissions({ deployments: "read" })).toEqual({ deployments: "read" });
    expect(checkAgentTokenPermissions({ actions: "read", deployments: "read", contents: "read" })).toEqual({ actions: "read", deployments: "read", contents: "read" });
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

  it("refuses every tool that names another repository, and a non-string owner or repo", async () => {
    for (const args of [{ owner: "evil" }, { repo: "other" }, { owner: 5 }, { repo: ["app"] }, { repository: "evil/app" }, { repository: "acme/other" }, { owner: null }]) {
      await expect(guard.check(guardInput("list_commits", args))).rejects.toBeInstanceOf(GuardRejection);
    }
  });

  it("accepts the bound repository, ignoring case", async () => {
    await expect(guard.check(guardInput("list_commits", { owner: "ACME", repo: "App" }))).resolves.toBeUndefined();
    await expect(guard.check(guardInput("list_commits", { repository: "Acme/App" }))).resolves.toBeUndefined();
    await expect(guard.check(guardInput("list_commits", {}))).resolves.toBeUndefined();
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

  it("accepts pull_number as the number argument and rejects two numbers that differ", async () => {
    await expect(guard.check(guardInput("get_pull_request", { pull_number: 7 }))).resolves.toBeUndefined();
    await expect(guard.check(guardInput("get_pull_request", { pull_number: 7, pullNumber: 7 }))).resolves.toBeUndefined();
    await expect(guard.check(guardInput("get_pull_request", { pull_number: 7, pullNumber: 8 }))).rejects.toBeInstanceOf(GuardRejection);
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

  it("runs the repository check before any network call", async () => {
    const call = vi.fn();
    await expect(guard.check(guardInput("update_issue", { owner: "evil", repo: "app", issue_number: 3 }, call))).rejects.toBeInstanceOf(GuardRejection);
    expect(call).not.toHaveBeenCalled();
  });
});

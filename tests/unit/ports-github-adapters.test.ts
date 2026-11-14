// Port lane L2: the GitHub adapters pass the same conformance suites as the fakes, run over a GitHub client fixture (`GitHubFixtureProvider`) with GitHub-shaped
// answers; and the adapter-specific behaviour the neutral contract cannot say is checked here. What the real GitHub client does (the requests it makes, the
// installation tokens it mints, the branches it will read) is tested with that client, in the lane that brings it.
import { describe, expect, it } from "vitest";
import { codeBuildCheckRunner } from "../../packages/broker/src/plugins/check-runner/codebuild/index.js";
import { githubActionsCheckRunner } from "../../packages/broker/src/plugins/check-runner/github-actions/index.js";
import { githubCodeHost, GITHUB_CODE_HOST_CAPABILITIES } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { replyTargetOf } from "../../packages/broker/src/plugins/code-host/github/mapping.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import type { CodeBuildGateway } from "../../packages/broker/src/codebuild.js";
import { CodeHostCapabilitiesSchema, type CodeBuildCheckResult } from "../../packages/contracts/src/index.js";
import { checkRunnerChecks, type CheckRunnerWorld } from "../support/ports/check-runner-conformance.js";
import { codeHostChecks, type CodeHostWorld } from "../support/ports/code-host-conformance.js";
import { runContract } from "../support/ports/plugin-contract-kit.js";
import { GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, GitHubFixtureProvider } from "../support/ports/github-fixture-provider.js";
import { githubDelivery, githubPayloads, signGithubBody, webhookSecretReader } from "../support/ports/github-deliveries.js";

const GITHUB_NOW = Date.parse("2026-10-30T10:00:00.000Z");
const WORKING_BRANCH = (n: number) => `agentx/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function githubModel(): FakeHostModel {
  return new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
}

function githubCodeHostWorld(): CodeHostWorld & { api: GitHubFixtureProvider } {
  const model = githubModel();
  const api = new GitHubFixtureProvider(model);
  const host = githubCodeHost(api, { credentialRef: "github", now: () => GITHUB_NOW, webhookSecret: webhookSecretReader() });
  return {
    host, model, api, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, now: () => GITHUB_NOW, branch: WORKING_BRANCH,
    // P6: the GitHub normaliser. A pull request opened, and a push to a branch, signed as GitHub signs them; and one whose signature is wrong.
    signedDelivery: (event) => event.kind === "change_request.opened"
      ? githubDelivery("pull_request", githubPayloads.pullRequest("opened", Number(event.id)))
      : githubDelivery("push", githubPayloads.push(`refs/heads/${event.branch}`, event.revision)),
    forgedDelivery: () => githubDelivery("pull_request", githubPayloads.pullRequest("opened"), { signature: signGithubBody("{}") }),
    limitReads: (retryAt) => { model.rateLimitedUntil = retryAt; },
  };
}

function githubActionsWorld(): CheckRunnerWorld {
  const model = githubModel();
  const api = new GitHubFixtureProvider(model);
  const runner = githubActionsCheckRunner(api);
  return {
    runner, model, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, project: "unit",
    changeRequest: () => {
      const revision = model.commit(WORKING_BRANCH(1), { "src/a.ts": "export const a = 1;\n" });
      const { cr } = model.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "t" });
      return { ref: { repository: { url: GITHUB_REPO_URL }, id: cr.id, url: model.crUrl(cr.id) }, revision };
    },
    finishRun: () => { throw new Error("GitHub Actions runs are not started by Rovara"); },
  };
}

// Nothing is skipped: the GitHub normaliser (task P6) runs the neutral events check too.
runContract("GitHub CodeHost adapter passes the CodeHost contract", codeHostChecks, githubCodeHostWorld);
runContract("GitHub Actions CheckRunner passes the CheckRunner contract", checkRunnerChecks, githubActionsWorld);

class FakeCodeBuild implements CodeBuildGateway {
  readonly builds = new Map<string, CodeBuildCheckResult>();
  readonly tokens = new Map<string, string>();
  async start(input: Parameters<CodeBuildGateway["start"]>[0]): Promise<CodeBuildCheckResult> {
    const existing = this.tokens.get(input.idempotencyToken);
    if (existing !== undefined) return this.builds.get(existing)!;
    const buildId = `${input.projectName}:build-${this.builds.size + 1}`;
    const result: CodeBuildCheckResult = { gate: input.gate, projectName: input.projectName, buildId, status: "IN_PROGRESS", requestedSourceVersion: input.commit, logsUrl: `https://logs.example.test/${buildId}` };
    this.builds.set(buildId, result);
    this.tokens.set(input.idempotencyToken, buildId);
    return result;
  }
  async status(input: Parameters<CodeBuildGateway["status"]>[0]): Promise<CodeBuildCheckResult> {
    const found = this.builds.get(input.buildId);
    if (found === undefined) throw new Error("no such build");
    return found;
  }
  finish(buildId: string, status: CodeBuildCheckResult["status"]): void {
    this.builds.set(buildId, { ...this.builds.get(buildId)!, status });
  }
}

function codeBuildWorld(): CheckRunnerWorld & { gateway: FakeCodeBuild } {
  const model = githubModel();
  const gateway = new FakeCodeBuild();
  const runner = codeBuildCheckRunner({ gateway, allowedRepositories: [GITHUB_REPO_URL] });
  return {
    runner, model, gateway, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, project: "agentx-unit",
    changeRequest: () => { throw new Error("CodeBuild has no change requests"); },
    finishRun: (runId, conclusion) => { gateway.finish(runId, conclusion === "success" ? "SUCCEEDED" : "FAILED"); },
  };
}

runContract("CodeBuild CheckRunner passes the CheckRunner contract", checkRunnerChecks, codeBuildWorld);

describe("GitHub adapter specifics", () => {
  it("advertises capabilities that fit the schema, and only a basic git credential", () => {
    expect(CodeHostCapabilitiesSchema.safeParse(GITHUB_CODE_HOST_CAPABILITIES).success).toBe(true);
    expect(GITHUB_CODE_HOST_CAPABILITIES.credentialKinds).toEqual(["basic"]);
  });

  it("refuses a change request id that is not a number, before asking GitHub anything", async () => {
    const world = githubCodeHostWorld();
    const before = world.api.calls.length;
    for (const id of ["", "0", "01", "1.5", "abc", "1; drop", "99999999999"]) {
      await expect(world.host.getChangeRequest({ repository: world.repository, id, url: "" }, world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(world.api.calls.length).toBe(before);
  });

  it("holds the input rules itself, whatever client sits under it: working branches only, an organization scope and a bounded page for the branch listing", async () => {
    const world = githubCodeHostWorld();
    world.model.commit("feature/x", { "x.txt": "x\n" });
    const before = world.api.calls.length;
    for (const branch of ["feature/x", "agentx/x", "agentx/../../etc", `agentx/${"0".repeat(35)}/`, ""]) {
      await expect(world.host.branchHead(world.repository, branch, world.scope), branch).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    await expect(world.host.listBranches(world.repository, 1, { system: "private-install" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    for (const page of [0, -1, 1.5, 1_001, Number.NaN]) await expect(world.host.listBranches(world.repository, page, world.scope), String(page)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(world.api.calls.length).toBe(before);
    expect((await world.host.listBranches(world.repository, 1_000, world.scope)).page).toBe(1_000);
    world.model.commit(WORKING_BRANCH(1), { "y.txt": "y\n" });
    await expect(world.host.branchHead(world.repository, WORKING_BRANCH(1), world.scope)).resolves.toMatch(/^[a-f0-9]{40}$/);
  });

  it("checks reply text before anything, and sends only to a comment in a thread", () => {
    expect(replyTargetOf("review_comment:12")).toEqual({ kind: "thread", id: "12" });
    expect(replyTargetOf("12")).toEqual({ kind: "thread", id: "12" });
    expect(replyTargetOf("discussion:12")).toEqual({ kind: "none" });
    expect(replyTargetOf("review:12")).toEqual({ kind: "none" });
    for (const bad of ["", "0", "-1", "12; x", "review_comment:", "other:12", "1".repeat(20)]) expect(replyTargetOf(bad)).toEqual({ kind: "none" });
  });

  it("does not post when the reply text is not fixed text, even for a comment that is gone", async () => {
    const world = githubCodeHostWorld();
    const head = world.model.commit(WORKING_BRANCH(1), { "src/a.ts": "x\n" });
    const { ref } = await world.host.reconcileChangeRequest({ repository: world.repository, sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "t" }, world.scope);
    expect(head).toMatch(/^[a-f0-9]{40}$/);
    const before = world.api.calls.length;
    await expect(world.host.reply(ref, "discussion:5", "thanks @someone", world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(world.api.calls.length).toBe(before);
  });

  it("gives a long comment to the port cut to its bound, and never fails the read", async () => {
    const world = githubCodeHostWorld();
    world.model.commit(WORKING_BRANCH(1), { "src/a.ts": "x\n" });
    const { ref } = await world.host.reconcileChangeRequest({ repository: world.repository, sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "t" }, world.scope);
    world.model.addDiscussionComment(ref.id, "priya", "x".repeat(70_000));
    const feedback = await world.host.feedback(ref, world.scope);
    expect(feedback.comments[0]!.body).toHaveLength(65_536);
  });

  it("hands over the expiry GitHub stated for the token, not one of its own; no stated expiry is refused", async () => {
    const world = githubCodeHostWorld();
    const stated = new Date(Date.now() + 50 * 60_000).toISOString();
    world.api.tokenExpiry = stated;
    expect(await world.host.issueGitCredential(world.repository, "clone", world.scope)).toMatchObject({ kind: "basic", expiresAt: stated });
    world.api.tokenExpiry = null;
    await expect(world.host.issueGitCredential(world.repository, "clone", world.scope)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    // A token GitHub says has already expired is handed over as it is: the exchange refuses it (credential-exchange.test.ts).
    world.api.tokenExpiry = "2020-01-01T00:00:00Z";
    expect(await world.host.issueGitCredential(world.repository, "clone", world.scope)).toMatchObject({ expiresAt: "2020-01-01T00:00:00.000Z" });
  });

  it("refuses the credential when the provider does not serve the reference (an empty answer is never a credential)", async () => {
    const world = githubCodeHostWorld();
    const stub = githubCodeHost({ ...world.api, resolveWithExpiry: async () => ({}) } as never, { credentialRef: "other" });
    await expect(stub.issueGitCredential(world.repository, "clone", world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("CodeBuild adapter specifics", () => {
  it("refuses a listing of a bare revision or a change request: CodeBuild cannot see them, and an empty list would read as nothing running", async () => {
    const world = codeBuildWorld();
    await expect(world.runner.listChecks({ kind: "revision", repository: world.repository, revision: "a".repeat(40) }, world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(world.runner.listChecks({ kind: "change-request", ref: { repository: world.repository, id: "1", url: "" } }, world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("maps every CodeBuild status to a pending check or a finished one with a conclusion", async () => {
    const world = codeBuildWorld();
    const revision = "a".repeat(40);
    const { run } = await world.runner.start!({ repository: world.repository, revision, gate: "unit", project: world.project, timeoutMinutes: 10, idempotencyKey: "k" }, world.scope);
    const target = { kind: "run" as const, repository: world.repository, revision, run, gate: "unit", project: world.project };
    const expected: Array<[CodeBuildCheckResult["status"], string | undefined]> = [
      ["IN_PROGRESS", undefined], ["SUCCEEDED", "success"], ["FAILED", "failure"], ["FAULT", "error"], ["STOPPED", "cancelled"], ["TIMED_OUT", "timed_out"],
    ];
    for (const [status, conclusion] of expected) {
      world.gateway.finish(run.id, status);
      const check = await world.runner.getRun!(target, world.scope);
      expect(check.state).toBe(conclusion === undefined ? "pending" : "completed");
      expect(check.conclusion).toBe(conclusion);
    }
  });

  it("reads a run only with its project", async () => {
    const world = codeBuildWorld();
    await expect(world.runner.getRun!({ kind: "run", repository: world.repository, revision: "a".repeat(40), run: { runner: "codebuild", id: "b:1" }, gate: "unit" }, world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

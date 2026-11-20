// TE-B4: the tracking pass keeps one "Rovara" Check per head (O48). Driven through the real tracking pass over the in-memory store and the fake host, and once through the real GitHub client
// over the fake GitHub HTTP API (token, lookup, create, update, refusal).
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CHECK_STALE_MS, type ProofHoldFacts, type TestProof, type TestProofItem } from "../../packages/contracts/src/index.js";
import {
  SUMMARY_CHECK_PERMISSION_RETRY_MS, markReadyAnyway, taskRecordKey, summaryCheckKey, syncSummaryCheck, trackPullRequest, type LiveRoles, type MergeTrackingDependencies, type ProofHoldSource, type SummaryCheckSource,
} from "../../packages/broker/src/core/merge/index.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { GitHubAppCredentialProvider, rovaraCheckBody } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { GitHubFixtureApi } from "../support/ports/github-fixture-api.js";
import { ORG, TASK_ID, mergeWorld } from "../support/merge-world.js";

const DIGEST = "d".repeat(64);
const item = (verdict: TestProofItem["verdict"], reason: TestProofItem["reason"]): TestProofItem => ({ checkId: "unit", label: "unit", granularity: "check", verdict, reason });
const proof = (items: TestProofItem[]): TestProof => ({ schemaVersion: 1, candidateDigest: DIGEST, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items, durationMs: 1 });
const PROVEN: ProofHoldFacts = { proof: proof([item("proves_change", "assertion_failed_on_old")]) };
const VACUOUS: ProofHoldFacts = { proof: proof([item("does_not_prove", "passed_on_old")]) };

const source = (over: Partial<SummaryCheckSource> = {}): SummaryCheckSource => ({ enabled: () => true, personName: async () => "Priya", detailsUrl: () => "https://rovara.example.test/tasks/1", ...over });
const holdSource = (facts: ProofHoldFacts): ProofHoldSource => ({ mode: () => "hold", facts: async () => facts });

async function world(options: { draft?: boolean; facts?: ProofHoldFacts; check?: SummaryCheckSource | undefined } = {}) {
  const w = await mergeWorld();
  const pr = w.prs[0]!;
  if (options.draft === true) pr.model.getChangeRequest(String(pr.number)).draft = true;
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const tracking: MergeTrackingDependencies = {
    ...w.tracking, ...(options.facts === undefined ? {} : { proofHold: holdSource(options.facts) }), ...(options.check === undefined ? {} : { summaryCheck: options.check }),
    log: (event, fields) => { logs.push({ event, fields }); },
  };
  const checks = () => pr.model.summaryChecks;
  const latest = () => checks()[checks().length - 1];
  return { w, pr, tracking, checks, latest, logs };
}

describe("the conclusion through the pass", () => {
  it("held, then marked ready anyway: the same run flips to success, 'overridden by Priya'", async () => {
    const { tracking, checks, latest, w, pr } = await world({ draft: true, facts: VACUOUS, check: source() });
    await trackPullRequest(tracking, TASK_ID);
    const roles: LiveRoles = { read: async () => ({ orgRole: "member", projectRole: "contributor" }) };
    await markReadyAnyway(
      { store: w.store, audit: w.audit, roles, now: () => w.now.value, loadTask: (taskId) => w.host.loadTask(taskId), nudge: async () => undefined },
      { companyId: ORG, taskId: TASK_ID, repositoryId: pr.repositoryId, number: pr.number, expectedHeadSha: pr.head, actorId: "owner-1" },
    );
    await trackPullRequest(tracking, TASK_ID);
    expect(checks()).toHaveLength(1);
    expect(latest()?.payload).toMatchObject({ conclusion: "success" });
    expect(latest()?.payload.title).toContain("overridden by Priya");
  });
  it("Rovara's own failure Check is not read as the customer's CI (no fix loop, CI stays passing)", async () => {
    const { tracking, latest, w, pr } = await world({ draft: true, facts: VACUOUS, check: source() });
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload.conclusion).toBe("failure");
    expect(pr.model.checksOf(pr.head).some((check) => check.name === "Rovara" && check.conclusion === "failure")).toBe(true);
    await trackPullRequest(tracking, TASK_ID);
    expect(await w.trackingOf(pr)).toMatchObject({ ci: "passing", failingChecks: [] });
    expect((await w.task()).workflow.stage).toBe("WAIT_FOR_MERGE");
  });
  it("a head Rovara is still working on (not waiting for the merge) is in progress, never success, though the pull request was ready before", async () => {
    const { tracking, latest, w } = await world({ check: source() });
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload.conclusion).toBe("success");
    await w.setWorkflow({ state: "RUNNING" });
    await w.store.delete({ key: summaryCheckKey(ORG, TASK_ID, "app", 1) });
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload.status).toBe("in_progress");
  });
  it("a source whose facts read throws: neutral (a Rovara problem), never failure", async () => {
    const { tracking, latest } = await world({ draft: true, facts: VACUOUS, check: source({ facts: async () => { throw new Error("boom"); } }) });
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload).toMatchObject({ status: "completed", conclusion: "neutral" });
  });
  it("the gate switched off while a run is in progress: that run is finished as neutral, once", async () => {
    let on = true;
    const { tracking, latest, pr } = await world({ check: source({ enabled: () => on, facts: async () => ({ fullSuite: "pending" }) }) });
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload.status).toBe("in_progress");
    on = false;
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload).toMatchObject({ status: "completed", conclusion: "neutral" });
    const writes = pr.model.summaryCheckWrites;
    await trackPullRequest(tracking, TASK_ID);
    expect(pr.model.summaryCheckWrites).toBe(writes);
  });
  it("a head a person pushed: neutral, Rovara's checks did not run on it", async () => {
    const { tracking, latest, pr } = await world({ check: source() });
    pr.model.commit(pr.model.getChangeRequest(String(pr.number)).sourceBranch, { "src/b.ts": "export const b = 2;\n" });
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(latest()?.payload.title).toContain("did not run");
  });
  it("in progress for longer than the stale limit: the next pass makes it neutral", async () => {
    const { tracking, latest, w } = await world({ check: source({ facts: async () => ({ fullSuite: "pending" }) }) });
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload.status).toBe("in_progress");
    w.now.value += ROVARA_CHECK_STALE_MS + 1;
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload).toMatchObject({ status: "completed", conclusion: "neutral" });
  });
});

describe("writes: idempotent, one run per head, bounded", () => {
  it("no Check permission: recorded, not asked again within the hour, asked again after", async () => {
    const { tracking, w, pr, logs } = await world({ check: source() });
    pr.model.summaryCheckPermission = false;
    await trackPullRequest(tracking, TASK_ID);
    await trackPullRequest(tracking, TASK_ID);
    expect(pr.model.summaryCheckWrites).toBe(0);
    expect(logs.filter((entry) => entry.event === "summary_check.no_permission")).toHaveLength(1);
    pr.model.summaryCheckPermission = true;
    w.now.value += SUMMARY_CHECK_PERMISSION_RETRY_MS + 1;
    await trackPullRequest(tracking, TASK_ID);
    expect(pr.model.summaryCheckWrites).toBe(1);
  });
  it("a host failure never fails the pass, and is logged with a fixed name only", async () => {
    const { tracking, w, pr, logs } = await world({ check: source() });
    const host = (await w.host.repository("web", 1, "app", ORG))!.codeHost;
    const failing = Object.create(host, { upsertSummaryCheck: { value: async () => { throw new Error("secret ghs_abcdefabcdefabcdefabcdefabcdefabcdef"); } } }) as typeof host;
    await trackPullRequest({ ...tracking, repository: async () => ({ url: "https://github.com/acme/app", codeHost: failing }) }, TASK_ID);
    expect(await w.trackingOf(pr)).toMatchObject({ ci: "passing" });
    const failed = logs.find((entry) => entry.event === "summary_check.failed");
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed)).not.toContain("ghs_");
  });
  it("a Details address that is not https is left out", async () => {
    const { tracking, latest } = await world({ check: source({ detailsUrl: () => "javascript:alert(1)" }) });
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.detailsUrl).toBeUndefined();
  });
  it("a host with no Check source writes nothing (its own Check could not be told apart from CI)", async () => {
    const { tracking, w, checks } = await world({ check: source() });
    const host = (await w.host.repository("web", 1, "app", ORG))!.codeHost;
    const blind = Object.create(host, { summaryCheckSource: { value: async () => undefined } }) as typeof host;
    await trackPullRequest({ ...tracking, repository: async () => ({ url: "https://github.com/acme/app", codeHost: blind }) }, TASK_ID);
    expect(checks()).toEqual([]);
  });
  it("a closed pull request is not written", async () => {
    const { tracking, w, pr } = await world();
    const host = (await w.host.repository("web", 1, "app", ORG))!.codeHost;
    const result = await syncSummaryCheck({ store: w.store, now: () => w.now.value, source: source() }, {
      task: { ...(await w.task()), orgId: ORG }, pullRequest: pr, codeHost: host, repositoryUrl: "https://github.com/acme/app", scope: { orgId: ORG },
      status: { headRevision: pr.head, draft: false, state: "closed" }, ci: "passing", ciMode: "their_ci_fix", headByRovara: true, ready: true, proofHoldOn: false,
    });
    expect(result).toBe("off");
    expect(pr.model.summaryCheckWrites).toBe(0);
    void tracking;
  });
});

describe("Rovara stops following the task", () => {
  it("a Check still in progress is finished as neutral, once", async () => {
    const { tracking, latest, w, pr } = await world({ check: source({ facts: async () => ({ fullSuite: "pending" }) }) });
    await trackPullRequest(tracking, TASK_ID);
    expect(latest()?.payload.status).toBe("in_progress");
    const { change } = await import("../../packages/contracts/src/index.js");
    await w.store.update({ key: taskRecordKey(TASK_ID), ops: [change.set(["closedAt"], new Date(w.now.value).toISOString())] });
    expect(await trackPullRequest(tracking, TASK_ID)).toBe("gone");
    expect(latest()?.payload).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(latest()?.payload.title).toContain("stopped following");
    const writes = pr.model.summaryCheckWrites;
    await trackPullRequest(tracking, TASK_ID);
    expect(pr.model.summaryCheckWrites).toBe(writes);
  });
});

describe("through the real GitHub client over the fake GitHub API", () => {
  async function githubWorld(options: { deny?: boolean } = {}) {
    let api: GitHubFixtureApi | undefined;
    const w = await mergeWorld({
      codeHost: (model) => {
        api = new GitHubFixtureApi(model);
        if (options.deny === true) api.deniedPermissions.add("checks:write");
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const client = new GitHubAppCredentialProvider({
          credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          fetchImplementation: api.fetch, now: () => Date.parse("2026-11-09T10:00:00.000Z"), requireInstallationBound: async () => undefined,
        });
        return githubCodeHost(client, { credentialRef: "github" });
      },
    });
    const pr = w.prs[0]!;
    pr.model.getChangeRequest(String(pr.number)).draft = true;
    return { w, pr, api: () => api!, tracking: (facts: ProofHoldFacts) => ({ ...w.tracking, proofHold: holdSource(facts), summaryCheck: source() }) };
  }
  it("creates the run with a checks-write-only token, updates the same run, and never reads it as CI", async () => {
    const { w, pr, api, tracking } = await githubWorld();
    await trackPullRequest(tracking(VACUOUS), TASK_ID);
    expect(api().checkRuns).toHaveLength(1);
    expect(api().checkRuns[0]).toMatchObject({ name: "Rovara", head_sha: pr.head, status: "completed", conclusion: "failure", details_url: "https://rovara.example.test/tasks/1" });
    const writers = api().tokens.filter((token) => token.permissions["checks"] === "write");
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.every((token) => Object.keys(token.permissions).join() === "checks")).toBe(true);
    await trackPullRequest(tracking(PROVEN), TASK_ID);
    expect(api().checkRuns).toHaveLength(1);
    expect(api().checkRuns[0]).toMatchObject({ conclusion: "success" });
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
    expect(await w.trackingOf(pr)).toMatchObject({ ci: "passing" });
  });
  it("a lost record does not make a second run: the App's own run on the head is found and updated", async () => {
    const { w, pr, api, tracking } = await githubWorld();
    await trackPullRequest(tracking(VACUOUS), TASK_ID);
    await w.store.delete({ key: summaryCheckKey(ORG, TASK_ID, pr.repositoryId, pr.number) });
    await trackPullRequest(tracking(PROVEN), TASK_ID);
    expect(api().checkRuns).toHaveLength(1);
    expect(api().checkRuns[0]!.conclusion).toBe("success");
  });
  it("an installation without the Check permission: nothing written, the pass goes on", async () => {
    const { w, pr, api, tracking } = await githubWorld({ deny: true });
    await trackPullRequest(tracking(PROVEN), TASK_ID);
    expect(api().checkRuns).toEqual([]);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
    expect(typeof (await w.store.get(summaryCheckKey(ORG, TASK_ID, pr.repositoryId, pr.number)))?.["noPermissionAtMs"]).toBe("number");
  });
  it("another app's 'Rovara' check is still the customer's CI", async () => {
    const { w, pr, tracking } = await githubWorld();
    pr.model.setChecks(pr.head, [{ name: "Rovara", state: "completed", conclusion: "failure", required: false, url: "", source: "123" }]);
    await trackPullRequest(tracking(PROVEN), TASK_ID);
    expect(await w.trackingOf(pr)).toMatchObject({ ci: "failing" });
  });
});

describe("the Check Run request body", () => {
  const payload = { status: "completed" as const, conclusion: "success" as const, title: "Ready", summary: "Ready", text: "Ready" };
  const head = "a".repeat(40);
  it("a completed run carries its conclusion and time; an in-progress one neither", () => {
    expect(rovaraCheckBody({ headSha: head, payload }, 0)).toMatchObject({ name: "Rovara", head_sha: head, status: "completed", conclusion: "success", completed_at: "1970-01-01T00:00:00.000Z" });
    const running = rovaraCheckBody({ headSha: head, payload: { status: "in_progress", title: "x", summary: "x", text: "x" } }, 0);
    expect(running).not.toHaveProperty("conclusion");
    expect(running).not.toHaveProperty("completed_at");
  });
  it.each([
    ["a short head", { headSha: "abc", payload }],
    ["a run id that is not a number", { headSha: head, runId: "1/../2", payload }],
    ["an unknown status", { headSha: head, payload: { ...payload, status: "queued" } }],
    ["an unknown conclusion", { headSha: head, payload: { ...payload, conclusion: "action_required" } }],
    ["completed with no conclusion", { headSha: head, payload: { status: "completed", title: "x", summary: "x", text: "x" } }],
    ["in progress with a conclusion", { headSha: head, payload: { ...payload, status: "in_progress" } }],
    ["text past 65,535", { headSha: head, payload: { ...payload, text: "x".repeat(65_536) } }],
    ["an empty title", { headSha: head, payload: { ...payload, title: "" } }],
    ["a details address that is not https", { headSha: head, payload, detailsUrl: "http://rovara.example.test" }],
  ])("refuses %s with fixed words", (_label, input) => {
    expect(() => rovaraCheckBody(input as never, 0)).toThrow(/^CONFIG_INVALID: the check run/u);
  });
});

// TE-B2 (honest CI states): "No CI" never counts as passing silently and unreadable CI times out to "CI not readable" instead of waiting as `pending` forever.
// Pure rules (`readCi`, `ciAllowsReady`, `mergeReadiness`) plus the tracking pass over the fake host: the default mode leaves a no-CI pull request a draft with the reason, `sandbox_only` marks it ready and
// says "No CI on this repository", and a row written by the code before this lane still reads.
import { describe, expect, it } from "vitest";
import {
  CI_STATE_WORDS, MERGE_NOT_READY_MESSAGES as M, ciEvidenceLevel, mergeTrackingDecisionDigest, mergeTrackingKey, type ChangeRequestStatus, type MergeTrackingItem,
} from "../../packages/contracts/src/index.js";
import { mergeReadiness, type MergePullRequestFacts, type ReadinessInput } from "../../packages/broker/src/core/merge/merge.js";
import {
  CI_UNREADABLE_AFTER_MS, DEFAULT_CI_MODE, NO_CI_GRACE_MS, ciAllowsReady, readCi, readMergeTracking, trackPullRequest, trackingItemOf, type ProjectCiMode,
} from "../../packages/broker/src/core/merge/index.js";
import { readyToMerge } from "../../packages/broker/src/local/app/attention.js";
import { ciCountsAsPassing, unreadableSinceOf, mergeViewOf } from "../../packages/broker/src/core/merge/index.js";
import { nextFor } from "../../packages/mcp/src/tools.js";
import { ORG, TASK_ID, githubShapedHost, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const HEAD = "a".repeat(40);
const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const status = (overrides: Partial<ChangeRequestStatus> = {}): ChangeRequestStatus => ({
  id: "7", state: "open", draft: false, headRevision: HEAD, targetBranch: "main", mergeableState: "clean", mergeable: true, behindBy: 0, checks: [], requiredChecks: [], targetHasRequiredChecks: false,
  headDefinesChecks: true, requestedReviewers: 0, reviews: [], ...overrides,
});
const MODES: ProjectCiMode[] = ["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"];

describe("readCi: unreadable checks", () => {
  const input = { checksEverSeen: false, lastRovaraPushAt: undefined, now: NOW };
  it("is one named constant, the existing no-CI wait", () => {
    expect(CI_UNREADABLE_AFTER_MS).toBe(NO_CI_GRACE_MS);
  });
  it("starts the clock the first time the checks cannot be read, and waits as pending until the wait is over", () => {
    const first = readCi(status({ checksUnavailable: true }), input);
    expect(first).toMatchObject({ ci: "pending", unreadableSince: NOW, recheckAt: NOW + CI_UNREADABLE_AFTER_MS });
    const later = readCi(status({ checksUnavailable: true }), { ...input, unreadableSince: NOW - CI_UNREADABLE_AFTER_MS + 1, now: NOW });
    expect(later).toMatchObject({ ci: "pending", unreadableSince: NOW - CI_UNREADABLE_AFTER_MS + 1 });
  });
  it("reads 'not readable' once the checks have been unreadable for the whole wait, and keeps the start", () => {
    const since = NOW - CI_UNREADABLE_AFTER_MS;
    const read = readCi(status({ checksUnavailable: true }), { ...input, unreadableSince: since });
    expect(read).toMatchObject({ ci: "unreadable", unreadableSince: since });
    expect(read.recheckAt).toBeUndefined();
    // Even with checks listed alongside the flag: unreadable checks are never read as passing.
    expect(readCi(status({ checksUnavailable: true, checks: [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "" }] }), { ...input, unreadableSince: since }).ci).toBe("unreadable");
  });
  it("treats checks that exist but cannot be counted (a protected base whose required list was not read) the same way, not as pending forever", () => {
    const uncounted = status({ targetHasRequiredChecks: true, requiredChecks: [], checks: [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "" }] });
    expect(readCi(uncounted, input)).toMatchObject({ ci: "pending", unreadableSince: NOW });
    expect(readCi(uncounted, { ...input, unreadableSince: NOW - CI_UNREADABLE_AFTER_MS }).ci).toBe("unreadable");
  });
  it("carries no start once the checks read normally", () => {
    const readable = readCi(status({ checks: [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "" }] }), { ...input, unreadableSince: NOW - 10 * CI_UNREADABLE_AFTER_MS });
    expect(readable.ci).toBe("passing");
    expect(readable.unreadableSince).toBeUndefined();
  });
});

describe("ciAllowsReady: the truth table", () => {
  it("passing is ready in every mode; pending, failing and unreadable never are, except that sandbox_only does not rely on CI to read", () => {
    for (const mode of MODES) {
      expect(ciAllowsReady("passing", mode)).toBe(true);
      expect(ciAllowsReady("pending", mode)).toBe(false);
      expect(ciAllowsReady("failing", mode)).toBe(false);
    }
    expect(ciAllowsReady("unreadable", "sandbox_only")).toBe(true);
    for (const mode of MODES.filter((mode) => mode !== "sandbox_only")) expect(ciAllowsReady("unreadable", mode)).toBe(false);
  });
  it("'No CI' is ready only in sandbox_only; every other mode keeps the draft", () => {
    expect(ciAllowsReady("none", "sandbox_only")).toBe(true);
    for (const mode of MODES.filter((mode) => mode !== "sandbox_only")) expect(ciAllowsReady("none", mode)).toBe(false);
  });
  it("the default mode is today's version 2 behaviour (their_ci_fix), so a project with no setting gets a draft for 'No CI'", () => {
    expect(DEFAULT_CI_MODE).toBe("their_ci_fix");
    expect(ciAllowsReady("none", DEFAULT_CI_MODE)).toBe(false);
  });
});

describe("mergeReadiness words for the new states", () => {
  const facts = (overrides: Partial<MergePullRequestFacts>): MergePullRequestFacts => ({
    repositoryId: "app", number: 1, headSha: HEAD, state: "open", draft: false, baseBranch: "main", ci: "passing", branch: "up_to_date", behindRequired: false, ...overrides,
  });
  const input = (pr: MergePullRequestFacts): ReadinessInput => ({
    pullRequests: [pr], approvals: new Map([["app#1", { approved: true as const, commitId: HEAD, by: { hostUserId: "1", login: "priya" }, approvers: [{ hostUserId: "1", login: "priya" }] }]]),
    workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" }, recordedBases: new Map([["app#1", "main"]]), presser: { hostUserId: "2" }, allowSelfApproval: true, requesterName: "Priya",
  });
  it("says why a no-CI pull request is still a draft, and that unreadable CI is not readable, with the way out", () => {
    expect(mergeReadiness(input(facts({ draft: true, ci: "none" })))).toEqual({ ready: false, message: M.draftNoCi });
    expect(mergeReadiness(input(facts({ ci: "unreadable" })))).toEqual({ ready: false, message: M.ciNotReadable });
    expect(mergeReadiness(input(facts({ draft: true, ci: "unreadable" })))).toEqual({ ready: false, message: M.ciNotReadable });
    expect(M.draftNoCi).toContain(CI_STATE_WORDS.none);
    expect(M.ciNotReadable).toContain("grant checks read, or set this project to 'do not read CI'");
  });
  it("a person may still merge a pull request that has no CI (it is printed, and the person decides); pending and failing still refuse", () => {
    expect(mergeReadiness(input(facts({ ci: "none" })))).toEqual({ ready: true });
    expect(mergeReadiness(input(facts({ ci: "pending" })))).toEqual({ ready: false, message: M.checks });
    expect(mergeReadiness(input(facts({ ci: "failing" })))).toEqual({ ready: false, message: M.checks });
  });
});

/** A world whose pull request is a draft with no checks, no workflow files and Rovara's push already a full no-CI wait old. */
async function noCiWorld(options: { mode?: ProjectCiMode | undefined } = {}): Promise<MergeWorld & { deps2: MergeWorld["tracking"] }> {
  const world = await mergeWorld();
  const pr = world.prs[0]!;
  pr.model.setChecks(pr.head, []);
  pr.model.getChangeRequest(String(pr.number)).draft = true;
  const deps2 = { ...world.tracking, ...(options.mode === undefined ? {} : { ciMode: () => options.mode! }) };
  return { ...world, deps2 };
}

describe("tracking a pull request with no CI", () => {
  it("waits the grace first (pending), then reads 'none' and, in the default mode, leaves the draft alone and says why in the item", async () => {
    const world = await noCiWorld();
    const pr = world.prs[0]!;
    await trackPullRequest(world.deps2, TASK_ID);
    expect(await world.trackingOf(pr)).toMatchObject({ ci: "pending" });
    world.now.value += NO_CI_GRACE_MS;
    await trackPullRequest(world.deps2, TASK_ID);
    expect(await world.trackingOf(pr)).toMatchObject({ ci: "none", draft: true });
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(true);
    expect(world.milestones.written.filter((m) => m.kind === "pr_ready")).toEqual([]);
  });
  it("in every mode but sandbox_only the draft stays", async () => {
    for (const mode of MODES.filter((mode) => mode !== "sandbox_only")) {
      const world = await noCiWorld({ mode });
      const pr = world.prs[0]!;
      await trackPullRequest(world.deps2, TASK_ID);
      world.now.value += NO_CI_GRACE_MS;
      await trackPullRequest(world.deps2, TASK_ID);
      expect(pr.model.getChangeRequest(String(pr.number)).draft, mode).toBe(true);
    }
  });
  it("in sandbox_only the pull request is marked ready, and the milestone says 'No CI on this repository'", async () => {
    const world = await noCiWorld({ mode: "sandbox_only" });
    const pr = world.prs[0]!;
    await trackPullRequest(world.deps2, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(true);
    world.now.value += NO_CI_GRACE_MS;
    await trackPullRequest(world.deps2, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
    const ready = world.milestones.written.filter((m) => m.kind === "pr_ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.text).toContain(CI_STATE_WORDS.none);
  });
  it("a passing pull request is marked ready in the default mode, with no CI words on the milestone", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    pr.model.getChangeRequest(String(pr.number)).draft = true;
    await trackPullRequest(world.tracking, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
    expect(world.milestones.written.find((m) => m.kind === "pr_ready")!.text).not.toContain("CI");
  });
});

describe("tracking a pull request whose checks cannot be read", () => {
  /** A host that says "the checks could not be read" about every pass. */
  async function unreadableWorld(options: { mode?: ProjectCiMode | undefined } = {}) {
    const flag = { on: true };
    const world = await mergeWorld({
      codeHost: (model) => {
        const host = githubShapedHost(model);
        const read = host.changeRequestStatus.bind(host);
        return Object.create(host, { changeRequestStatus: { value: async (...args: Parameters<typeof read>) => ({ ...(await read(...args)), ...(flag.on ? { checksUnavailable: true as const } : {}) }) } }) as typeof host;
      },
    });
    const pr = world.prs[0]!;
    pr.model.getChangeRequest(String(pr.number)).draft = true;
    const deps2 = { ...world.tracking, ...(options.mode === undefined ? {} : { ciMode: () => options.mode! }) };
    return { world, pr, deps2, flag };
  }
  it("is pending at first with the start written, 'not readable' after the wait, and the draft stays", async () => {
    const { world, pr, deps2 } = await unreadableWorld();
    await trackPullRequest(deps2, TASK_ID);
    const first = (await world.trackingOf(pr))!;
    expect(first).toMatchObject({ ci: "pending", ciUnreadableSince: new Date(world.now.value).toISOString() });
    world.now.value += CI_UNREADABLE_AFTER_MS - 1;
    await trackPullRequest(deps2, TASK_ID);
    expect((await world.trackingOf(pr))!["ci"]).toBe("pending");
    world.now.value += 1;
    await trackPullRequest(deps2, TASK_ID);
    expect(await world.trackingOf(pr)).toMatchObject({ ci: "unreadable", ciUnreadableSince: first["ciUnreadableSince"] });
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(true);
    const [item] = await readMergeTracking(world.store, TASK_ID, ORG);
    expect(item!.ci).toBe("unreadable");
  });
  it("clears the start when the checks read again, and marks ready once they pass", async () => {
    const { world, pr, deps2, flag } = await unreadableWorld();
    await trackPullRequest(deps2, TASK_ID);
    flag.on = false;
    world.now.value += 60_000;
    await trackPullRequest(deps2, TASK_ID);
    const after = (await world.trackingOf(pr))!;
    expect(after["ci"]).toBe("passing");
    expect(after).not.toHaveProperty("ciUnreadableSince");
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
  });
  it("a brief failure that recovers never reaches 'not readable', even over a long time", async () => {
    const { world, pr, deps2, flag } = await unreadableWorld();
    for (let round = 0; round < 4; round += 1) {
      flag.on = true;
      await trackPullRequest(deps2, TASK_ID);
      flag.on = false;
      world.now.value += CI_UNREADABLE_AFTER_MS - 1_000;
      await trackPullRequest(deps2, TASK_ID);
      expect((await world.trackingOf(pr))!["ci"]).toBe("passing");
      world.now.value += CI_UNREADABLE_AFTER_MS;
    }
  });
  it("starts over for a new head", async () => {
    const { world, pr, deps2 } = await unreadableWorld();
    await trackPullRequest(deps2, TASK_ID);
    world.now.value += 2 * CI_UNREADABLE_AFTER_MS;
    const head = pr.model.commit(pr.model.getChangeRequest(String(pr.number)).sourceBranch, { "src/b.ts": "x\n" });
    await trackPullRequest({ ...deps2, recordedHead: async () => head }, TASK_ID);
    expect(await world.trackingOf(pr)).toMatchObject({ ci: "pending", ciUnreadableSince: new Date(world.now.value).toISOString() });
  });
  it("in sandbox_only (the project does not read CI) the pull request is marked ready even though the checks are not readable, and the milestone says so", async () => {
    const { world, pr, deps2 } = await unreadableWorld({ mode: "sandbox_only" });
    await trackPullRequest(deps2, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(true);
    world.now.value += CI_UNREADABLE_AFTER_MS;
    await trackPullRequest(deps2, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
    expect(world.milestones.written.find((m) => m.kind === "pr_ready")!.text).toContain(CI_STATE_WORDS.unreadable);
  });
});

describe("a row written by the code before this lane", () => {
  it("still reads, keeps its digest, and is rewritten without the new field", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    const stamp = new Date(world.now.value).toISOString();
    // Exactly the fields today's writer produces (no `ciUnreadableSince`), pending as the old code left an unreadable pull request.
    const fields = {
      orgId: ORG, taskId: TASK_ID, repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head, draft: false, state: "open" as const, baseBranch: "main", ci: "pending" as const,
      ciBasis: "all_checks" as const, checksEverSeen: true, failingChecks: [], review: "approved" as const, branch: "up_to_date" as const, headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-11-09", count: 0 },
    };
    const stored: MergeTrackingItem = { ...fields, version: 1, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: stamp };
    await world.store.put({ item: { ...mergeTrackingKey(TASK_ID, pr.repositoryId, pr.number), entityType: "MERGE_TRACKING", ...stored } as never });
    expect(trackingItemOf(await world.trackingOf(pr), ORG, TASK_ID)).toMatchObject({ ci: "pending", version: 1 });
    expect(mergeTrackingDecisionDigest({ ...fields })).toBe(stored.decisionDigest);
    await trackPullRequest(world.tracking, TASK_ID);
    const rewritten = (await world.trackingOf(pr))!;
    expect(rewritten["ci"]).toBe("passing");
    expect(rewritten).not.toHaveProperty("ciUnreadableSince");
  });
});

describe("what the person reads", () => {
  const merge = (ci: "none" | "unreadable" | "passing") => ({
    subjectId: "pr1", taskId: TASK_ID, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "v1", openPath: `/app/sessions/${TASK_ID}`,
    kind: "merge" as const, prRisk: "low" as const, prReasons: [], proof: { proven: 3, passed: 1, failed: 0, notTested: 0 }, reviewVerdict: "approved" as const, ci, securityFindingsHigh: 0, fullSuitePending: false,
  });
  it("the merge card says 'No CI' or 'CI not readable' instead of 'the checks passed'", async () => {
    const { cardOfItem } = await import("../../packages/broker/src/core/decisions/project.js");
    for (const ci of ["none", "unreadable"] as const) {
      const card = cardOfItem(merge(ci), {})!.card;
      const chip = card.evidence.find((entry) => entry.label === "CI")!;
      expect(chip.value).toBe(CI_STATE_WORDS[ci]);
      expect(chip.state).toBe("warning");
      expect(card.recommended.why).not.toContain("The checks passed");
      expect(card.recommended.why).toContain(CI_STATE_WORDS[ci]);
    }
    expect(cardOfItem(merge("passing"), {})!.card.recommended.why).toContain("The checks passed");
  });
  it("a pull request whose CI is unreadable is not 'ready to merge' on the task page", async () => {
    const { readyToMerge } = await import("../../packages/broker/src/local/app/attention.js");
    const item = { state: "open" as const, draft: false, review: "approved" as const, branch: "up_to_date" as const, headByRovara: true };
    expect(readyToMerge({ ...item, ci: "unreadable" })).toBe(false);
    expect(readyToMerge({ ...item, ci: "pending" })).toBe(false);
  });
  it("the evidence level of the pull request's first line is no_ci or ci_not_readable for the two honest states", () => {
    expect(ciEvidenceLevel("none")).toBe("no_ci");
    expect(ciEvidenceLevel("unreadable")).toBe("ci_not_readable");
    expect(ciEvidenceLevel("passing")).toBe("their_ci");
    expect(ciEvidenceLevel("pending")).toBeUndefined();
  });
});

// ---- review fixes (M1, M2, L1, L3)
describe("M1: a pull request that was never a draft", () => {
  const withReviewers = (world: MergeWorld, mode?: ProjectCiMode) => ({
    ...world.tracking, settings: { read: async () => ({ allowSelfApproval: true, mergeMethod: "squash" as const, codeReviewers: ["lead"], revision: 1 }) },
    ...(mode === undefined ? {} : { ciMode: () => mode }),
  });
  async function nonDraftNoCi(mode?: ProjectCiMode) {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    pr.model.setChecks(pr.head, []);
    pr.model.setAccount("lead", "write");
    const deps = withReviewers(world, mode);
    await trackPullRequest(deps, TASK_ID);
    world.now.value += NO_CI_GRACE_MS;
    await trackPullRequest(deps, TASK_ID);
    return { world, pr };
  }
  it("a non-draft no-CI pull request still gets its reviewers and readyAt in the default mode (the draft is the only thing kept back)", async () => {
    const { world, pr } = await nonDraftNoCi();
    expect(await world.trackingOf(pr)).toMatchObject({ ci: "none", draft: false });
    expect(pr.model.getChangeRequest(String(pr.number)).requestedReviewers).toContain("lead");
    expect(await world.trackingOf(pr)).toHaveProperty("readyAt");
  });
  it("and a draft no-CI pull request in the default mode still gets no reviewers", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    pr.model.setChecks(pr.head, []);
    pr.model.getChangeRequest(String(pr.number)).draft = true;
    pr.model.setAccount("lead", "write");
    const deps = withReviewers(world);
    await trackPullRequest(deps, TASK_ID);
    world.now.value += NO_CI_GRACE_MS;
    await trackPullRequest(deps, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).requestedReviewers).not.toContain("lead");
  });
  it("the task page says 'Ready to merge' only for passing CI, or no CI in sandbox_only", () => {
    const item = { state: "open" as const, draft: false, review: "approved" as const, branch: "up_to_date" as const, headByRovara: true };
    expect(readyToMerge({ ...item, ci: "passing" })).toBe(true);
    expect(readyToMerge({ ...item, ci: "none" })).toBe(false);
    expect(readyToMerge({ ...item, ci: "none" }, "their_ci_fix")).toBe(false);
    expect(readyToMerge({ ...item, ci: "none" }, "sandbox_only")).toBe(true);
    expect(readyToMerge({ ...item, ci: "unreadable" }, "sandbox_only")).toBe(false);
  });
});

describe("M2: the MCP words", () => {
  const task = (ci: string[] | undefined) => ({
    workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 3 }, merge: { ready: true },
    ...(ci === undefined ? {} : { mergeTracking: ci.map((value) => ({ ci: value })) }),
  }) as never;
  it("says its checks passed only when every tracked pull request's checks passed; no CI is said as no CI", () => {
    expect(nextFor(task(["passing"]))).toContain("its checks passed");
    const none = nextFor(task(["passing", "none"]));
    expect(none).not.toContain("checks passed");
    expect(none).toContain(CI_STATE_WORDS.none);
    expect(nextFor(task(undefined))).not.toContain("checks passed");
  });
});

describe("L1: an approval of an earlier head carries over a clean sync only on passing CI (or no CI in sandbox_only)", () => {
  it("the predicate", () => {
    expect(ciCountsAsPassing("passing", "their_ci_fix")).toBe(true);
    for (const mode of MODES) {
      expect(ciCountsAsPassing("none", mode)).toBe(mode === "sandbox_only");
      expect(ciCountsAsPassing("unreadable", mode)).toBe(false);
      expect(ciCountsAsPassing("pending", mode)).toBe(false);
      expect(ciCountsAsPassing("failing", mode)).toBe(false);
    }
  });
  it("through the task page's merge view: a no-CI approval of the head before a sync counts in sandbox_only and not in the default mode", async () => {
    const OLD = "1".repeat(40);
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    const entry = (await world.task()).workflow.pullRequests![0]!;
    await world.setWorkflow({ pullRequests: [{ ...entry, syncedFrom: OLD }] });
    await world.seedTracking({ ci: "none", approval: { hostUserId: pr.model.accounts.get("priya")!.hostUserId, login: "priya", commitId: OLD } });
    const items = await readMergeTracking(world.store, TASK_ID, ORG);
    const task = await world.task();
    const view = async (mode?: ProjectCiMode) => mergeViewOf({ ...world.deps, ...(mode === undefined ? {} : { ciMode: () => mode }) }, task, items, undefined);
    expect(await view()).toMatchObject({ ready: false, message: M.staleApproval });
    expect(await view("their_ci_fix")).toMatchObject({ ready: false, message: M.staleApproval });
    expect(await view("sandbox_only")).toMatchObject({ ready: true });
    // Positive control: passing CI carries it in every mode.
    await world.seedTracking({ ci: "passing", approval: { hostUserId: pr.model.accounts.get("priya")!.hostUserId, login: "priya", commitId: OLD } });
    expect(await mergeViewOf(world.deps, task, await readMergeTracking(world.store, TASK_ID, ORG), undefined)).toMatchObject({ ready: true });
  });
});

describe("L3: the unreadable wait is kept for the head it was seen on only (press path and tracking use one rule)", () => {
  const item = (head: string, since: string | undefined) => ({ headSha: head, ...(since === undefined ? {} : { ciUnreadableSince: since }) });
  it("returns the start for the same head, nothing for another head, nothing for no start or a start that is not a time", () => {
    const since = "2026-11-09T09:00:00.000Z";
    expect(unreadableSinceOf(item(HEAD, since), HEAD)).toBe(Date.parse(since));
    expect(unreadableSinceOf(item("b".repeat(40), since), HEAD)).toBeUndefined();
    expect(unreadableSinceOf(item(HEAD, undefined), HEAD)).toBeUndefined();
    expect(unreadableSinceOf(undefined, HEAD)).toBeUndefined();
  });
});

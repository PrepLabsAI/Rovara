// TE-B2 (honest CI states): "No CI" never counts as passing silently and unreadable CI times out to "CI not readable" instead of waiting as `pending` forever.
// Pure rules (`readCi`, `ciAllowsReady`, `mergeReadiness`) plus the tracking pass over the fake host: the default mode leaves a no-CI pull request a draft with the reason, `sandbox_only` marks it ready and
// says "No CI on this repository", and a row written by the code before this lane still reads.
import { describe, expect, it } from "vitest";
import {
  CI_STATE_WORDS, MERGE_NOT_READY_MESSAGES as M, ciEvidenceLevel, type ChangeRequestStatus,
} from "../../packages/contracts/src/index.js";
import { mergeReadiness, type MergePullRequestFacts, type ReadinessInput } from "../../packages/broker/src/core/merge/merge.js";
import {
  CI_UNREADABLE_AFTER_MS, NO_CI_GRACE_MS, readCi, readMergeTracking, trackPullRequest, type ProjectCiMode,
} from "../../packages/broker/src/core/merge/index.js";
import { mergeViewOf } from "../../packages/broker/src/core/merge/index.js";
import { nextFor } from "../../packages/mcp/src/tools.js";
import { ORG, TASK_ID, githubShapedHost, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const HEAD = "a".repeat(40);
const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const status = (overrides: Partial<ChangeRequestStatus> = {}): ChangeRequestStatus => ({
  id: "7", state: "open", draft: false, headRevision: HEAD, targetBranch: "main", mergeableState: "clean", mergeable: true, behindBy: 0, checks: [], requiredChecks: [], targetHasRequiredChecks: false,
  headDefinesChecks: true, requestedReviewers: 0, reviews: [], ...overrides,
});

describe("readCi: unreadable checks", () => {
  const input = { checksEverSeen: false, lastRovaraPushAt: undefined, now: NOW };
  it("treats checks that exist but cannot be counted (a protected base whose required list was not read) the same way, not as pending forever", () => {
    const uncounted = status({ targetHasRequiredChecks: true, requiredChecks: [], checks: [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "" }] });
    expect(readCi(uncounted, input)).toMatchObject({ ci: "pending", unreadableSince: NOW });
    expect(readCi(uncounted, { ...input, unreadableSince: NOW - CI_UNREADABLE_AFTER_MS }).ci).toBe("unreadable");
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

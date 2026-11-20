// TE-B5 (the gap the TE-B2 review found): "a required check that never reported". A pull request waiting on a required check that no app runs used to read `pending` forever. Now, once Rovara's push is a full wait old and
// nothing else is still running, the state is `required_missing`: it names the check, keeps the draft a draft in every mode, refuses the merge with words, and clears as soon as the check reports.
import { describe, expect, it } from "vitest";
import { CI_STATE_WORDS, MERGE_NOT_READY_MESSAGES as M, type ChangeRequestStatus } from "../../packages/contracts/src/index.js";
import {
  CI_REQUIRED_MISSING_AFTER_MS, ciAllowsMerge, ciAllowsReady, ciCountsAsPassing, mergeReadiness, readCi, trackPullRequest, type MergePullRequestFacts, type ProjectCiMode, type ReadinessInput,
} from "../../packages/broker/src/core/merge/index.js";
import { readyToMerge } from "../../packages/broker/src/local/app/attention.js";
import { TASK_ID, githubShapedHost, mergeWorld } from "../support/merge-world.js";

const HEAD = "a".repeat(40);
const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const check = (name: string, state: "completed" | "in_progress" = "completed", conclusion?: string) => ({ name, state, ...(conclusion === undefined ? {} : { conclusion }), required: false, url: "" }) as ChangeRequestStatus["checks"][number];
const status = (overrides: Partial<ChangeRequestStatus> = {}): ChangeRequestStatus => ({
  id: "7", state: "open", draft: true, headRevision: HEAD, targetBranch: "main", mergeableState: "blocked", mergeable: true, behindBy: 0, checks: [check("unit", "completed", "success")],
  requiredChecks: [{ name: "deploy-gate" }], targetHasRequiredChecks: true, headDefinesChecks: true, requestedReviewers: 0, reviews: [], ...overrides,
});
const pushedLongAgo = { checksEverSeen: true, lastRovaraPushAt: NOW - CI_REQUIRED_MISSING_AFTER_MS, now: NOW };

describe("readCi: a required check that never reported", () => {
  it("is passing when the required check has reported, and a source-named requirement is not met by another app's check", () => {
    expect(readCi(status({ checks: [check("unit", "completed", "success"), check("deploy-gate", "completed", "success")] }), pushedLongAgo).ci).toBe("passing");
    const named = status({ requiredChecks: [{ name: "deploy-gate", source: "42" }], checks: [{ ...check("deploy-gate", "completed", "success"), source: "7" }] as never });
    expect(readCi(named, pushedLongAgo).ci).toBe("required_missing");
  });
});

describe("tracking a head a person pushed", () => {
  it("writes the start once for that head and says required_missing after the wait, never at once", async () => {
    const world = await mergeWorld({
      codeHost: (model) => {
        const host = githubShapedHost(model);
        const read = host.changeRequestStatus.bind(host);
        return Object.create(host, { changeRequestStatus: { value: async (...args: Parameters<typeof read>) => ({ ...(await read(...args)), requiredChecks: [{ name: "deploy-gate" }], targetHasRequiredChecks: true }) } }) as typeof host;
      },
    });
    const pr = world.prs[0]!;
    pr.model.getChangeRequest(String(pr.number)).draft = true;
    pr.model.commit(pr.model.getChangeRequest(String(pr.number)).sourceBranch, { "src/b.ts": "x\n" });
    const person = { ...world.tracking, recordedHead: async () => pr.head };
    await trackPullRequest(person, TASK_ID);
    const first = (await world.trackingOf(pr))!;
    expect(first).toMatchObject({ ci: "pending", headByRovara: false, ciMissingSince: new Date(world.now.value).toISOString() });
    world.now.value += CI_REQUIRED_MISSING_AFTER_MS;
    await trackPullRequest(person, TASK_ID);
    expect(await world.trackingOf(pr)).toMatchObject({ ci: "required_missing", ciMissingSince: first["ciMissingSince"] });
  });
});

describe("what the state allows", () => {
  const MODES: ProjectCiMode[] = ["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"];
  it("never marks ready, never counts as a pass, never lets a merge through, in any mode", () => {
    for (const mode of MODES) {
      expect(ciAllowsReady("required_missing", mode), mode).toBe(false);
      expect(ciCountsAsPassing("required_missing", mode), mode).toBe(false);
    }
    expect(ciAllowsMerge("required_missing")).toBe(false);
    expect(readyToMerge({ state: "open", draft: false, ci: "required_missing", review: "approved", branch: "up_to_date", headByRovara: true })).toBe(false);
  });
  it("is refused with its own words, not 'checks are running'", () => {
    const facts: MergePullRequestFacts = { repositoryId: "app", number: 1, headSha: HEAD, state: "open", draft: false, baseBranch: "main", ci: "required_missing", branch: "up_to_date", behindRequired: false };
    const input: ReadinessInput = {
      pullRequests: [facts], approvals: new Map([["app#1", { approved: true as const, commitId: HEAD, by: { hostUserId: "1", login: "priya" }, approvers: [{ hostUserId: "1", login: "priya" }] }]]),
      workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" }, recordedBases: new Map([["app#1", "main"]]), presser: { hostUserId: "2" }, allowSelfApproval: true, requesterName: "Priya",
    };
    expect(mergeReadiness(input)).toEqual({ ready: false, message: M.requiredMissing });
    expect(M.requiredMissing).toContain(CI_STATE_WORDS.required_missing);
  });
});

describe("tracking a pull request whose required check never reports", () => {
  async function missingWorld() {
    const flag = { reports: false };
    const world = await mergeWorld({
      codeHost: (model) => {
        const host = githubShapedHost(model);
        const read = host.changeRequestStatus.bind(host);
        return Object.create(host, { changeRequestStatus: { value: async (...args: Parameters<typeof read>) => {
          const base = await read(...args);
          return { ...base, requiredChecks: [{ name: "deploy-gate" }], targetHasRequiredChecks: true, checks: flag.reports ? [...base.checks, check("deploy-gate", "completed", "success")] : base.checks };
        } } }) as typeof host;
      },
    });
    const pr = world.prs[0]!;
    pr.model.getChangeRequest(String(pr.number)).draft = true;
    return { world, pr, flag };
  }
  it("is pending, then required_missing with the name, and the draft stays; it is marked ready once the check reports", async () => {
    const { world, pr, flag } = await missingWorld();
    for (const mode of ["sandbox_only", "their_ci_fix"] as const) {
      await trackPullRequest({ ...world.tracking, ciMode: () => mode }, TASK_ID);
      expect(await world.trackingOf(pr), mode).toMatchObject({ ci: "pending" });
    }
    world.now.value += CI_REQUIRED_MISSING_AFTER_MS;
    await trackPullRequest({ ...world.tracking, ciMode: () => "sandbox_only" }, TASK_ID);
    expect(await world.trackingOf(pr)).toMatchObject({ ci: "required_missing", ciMissingChecks: ["deploy-gate"], draft: true });
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(true);
    expect(world.milestones.written.filter((m) => m.kind === "pr_ready")).toEqual([]);
    flag.reports = true;
    world.now.value += 60_000;
    await trackPullRequest(world.tracking, TASK_ID);
    const after = (await world.trackingOf(pr))!;
    expect(after["ci"]).toBe("passing");
    expect(after).not.toHaveProperty("ciMissingChecks");
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
  });
});

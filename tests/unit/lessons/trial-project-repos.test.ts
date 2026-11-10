// A lesson restricted ONLY to readers of repositories the project has now (a pull request review comment or a human fix-up commit in a private project repository) is project-wide
// where tier 0 and the trial are decided, re-checked live at settle and again at go-live. Any other restriction, another project's repository, an unreadable project definition and an absent port keep it restricted.
// Every other trial rule still applies to it.
import { describe, expect, it } from "vitest";
import { processDraft, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { memberCorrectionOf } from "../../../packages/broker/src/lessons/reflect.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { classifyTier as realClassifyTier } from "../../../packages/broker/src/lessons/tier.js";
import { isPublishable, trialBlockers, type TrialContext } from "../../../packages/broker/src/lessons/trial.js";
import type { CounterDeps } from "../../../packages/broker/src/lessons/counters.js";
import type { ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import type { Audience, Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, allowAllAccess, directory, draft, embedder, facts, lessonRecord, materialFor, settings, verifier } from "./lesson-helpers.js";

const REPO = "github:repo/9";
const OTHER_REPO = "github:repo/77";
const repoAudience = (scope = REPO): Audience => ({ kind: "restricted", acl: { source: "github", scope, capturedAt: "2026-10-30T09:00:00.000Z", liveCheck: "on_read" } });
const slackAudience: Audience = { kind: "restricted", acl: { source: "slack", scope: "slack:T1/C9", principals: ["U1"], capturedAt: "x", liveCheck: "none" } };
const CLEAR: TrialContext = { preset: "standard", mode: "On", trialAllowed: true, contradiction: false, refinement: false, reviewRequired: false, held: false, braked: false };

/** A lesson drafted from a member's pull request review comment in a repository: restricted to that repository's readers, one repository, verified citation. */
const prComment = (over: Partial<Lesson> = {}, audience: Audience = repoAudience()): Lesson =>
  lessonRecord({
    status: "pending", type: "convention", tier: 1, approvals: [], citationChecks: [{ index: 0, result: "valid", at: 1 }],
    provenance: { ...draft().provenance, sourceKinds: ["human_edit"], memberCorrection: true, claimsSupported: true, fromSharedTask: true, audience, sourceScopes: [REPO] }, ...over,
  });

describe("trialBlockers and classifyTier follow the project's own repositories", () => {
  it("a lesson restricted only to the project's repositories has no restricted_source blocker, and every other rule still applies to it", () => {
    const lesson = prComment();
    expect(trialBlockers(lesson, 1, { ...CLEAR, projectRepos: new Set([REPO]) })).toEqual([]);
    expect(trialBlockers(lesson, 1, { ...CLEAR, projectRepos: new Set([REPO, OTHER_REPO]) })).toEqual([]);
    // Other trial rules are untouched: a missing member correction, a tier 2, an outsider, Regulated.
    const reasons = (l: Lesson, tier: Lesson["tier"], context: TrialContext = { ...CLEAR, projectRepos: new Set([REPO]) }) => trialBlockers(l, tier, context);
    expect(reasons(prComment({ provenance: { ...prComment().provenance, memberCorrection: false } }), 1)).toEqual(["not_member_correction"]);
    expect(reasons(prComment(), 2)).toEqual(["needs_two_people"]);
    expect(reasons(prComment(), 1, { ...CLEAR, preset: "regulated", projectRepos: new Set([REPO]) })).toContain("preset_regulated");
    expect(reasons(prComment({ type: "review_check" }), 1)).toContain("review_check");
  });

  it("another project's repository, a repository only partly the project's, a Slack channel, an unreadable definition and no read at all keep it restricted", () => {
    expect(trialBlockers(prComment(), 1, { ...CLEAR, projectRepos: new Set([OTHER_REPO]) })).toEqual(["restricted_source"]);
    expect(trialBlockers(prComment({}, repoAudience(`${REPO}+${OTHER_REPO}`)), 1, { ...CLEAR, projectRepos: new Set([REPO]) })).toEqual(["restricted_source"]);
    expect(trialBlockers(prComment({}, slackAudience), 1, { ...CLEAR, projectRepos: new Set([REPO]) })).toEqual(["restricted_source"]);
    expect(trialBlockers(prComment(), 1, { ...CLEAR, projectRepos: undefined })).toEqual(["restricted_source"]);
    expect(trialBlockers(prComment(), 1, CLEAR)).toEqual(["restricted_source"]);
    expect(trialBlockers(prComment(), 1, { ...CLEAR, projectRepos: new Set() })).toEqual(["restricted_source"]);
  });

  it("tier 0 is open to a fact restricted only to the project's repositories; otherwise it is tier 1 with restricted_source", () => {
    const fact = (audience: Audience, projectRepos?: ReadonlySet<string>) => {
      const l = lessonRecord({ provenance: { ...draft().provenance, audience, sourceScopes: [REPO] } });
      return realClassifyTier({ ...l, material: materialFor(l) }, projectRepos === undefined ? {} : { projectRepos });
    };
    expect(fact({ kind: "project" })).toMatchObject({ tier: 0 });
    expect(fact(repoAudience(), new Set([REPO]))).toMatchObject({ tier: 0, reasons: ["cited_fact"] });
    expect(fact(repoAudience(), new Set([OTHER_REPO]))).toMatchObject({ tier: 1, reasons: ["restricted_source"] });
    expect(fact(repoAudience())).toMatchObject({ tier: 1, reasons: ["restricted_source"] });
    expect(fact(slackAudience, new Set([REPO]))).toMatchObject({ tier: 1, reasons: ["restricted_source"] });
  });

  it("isPublishable is asked with the project's repositories too: a stable lesson restricted to them is publishable, otherwise not", () => {
    const stable = prComment({ status: "active", trial: { state: "stable", startedAt: 1, stableAt: 2 } as never });
    // Published only into repository A itself (its place is the target); no target, or another repository of the project, is refused.
    expect(isPublishable(stable, [], new Set([REPO]), REPO)).toBe(true);
    expect(isPublishable(stable, [], new Set([REPO]))).toBe(false);
    expect(isPublishable(stable, [], new Set([REPO, OTHER_REPO]), OTHER_REPO)).toBe(false);
    expect(isPublishable(stable, [], undefined, REPO)).toBe(false);
    expect(isPublishable(stable, [])).toBe(false);
    expect(isPublishable(stable, [], new Set([OTHER_REPO]), REPO)).toBe(false);
  });
});

describe("memberCorrectionOf: a span restricted only to repositories is a member's correction (the live check is trialBlockers'); other restrictions still are not", () => {
  const span = (audience: Audience | undefined) => ({ id: "S1", kind: "human_edit" as const, trust: "member" as const, authorId: "ann", ...(audience === undefined ? {} : { audience }) });
  it("repository readers qualify; Slack and a list do not", () => {
    expect(memberCorrectionOf([span(repoAudience())], "member")).toBe(true);
    expect(memberCorrectionOf([span(repoAudience(`${REPO}+${OTHER_REPO}`))], "member")).toBe(true);
    expect(memberCorrectionOf([span(slackAudience)], "member")).toBe(false);
    expect(memberCorrectionOf([span({ kind: "restricted", acl: { source: "github", scope: REPO, principals: ["U1"], capturedAt: "x", liveCheck: "none" } })], "member")).toBe(false);
  });
});

function setup(projectRepos?: ProcessDeps["projectRepos"]) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  let n = 0;
  const deps: ProcessDeps & CounterDeps & ApproveDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: settings({ preset: "standard" }), newId: () => `les_${String(++n).padStart(4, "0")}`,
    judge: { rate: async () => "unrelated" }, directory: directory({ eligibleIds: ["owner", "ann", "bob"] }), access: allowAllAccess,
    ...(projectRepos === undefined ? {} : { projectRepos }),
  };
  return { deps, audit };
}
const prDraft = (audience: Audience = repoAudience()) => draft({ provenance: { ...draft().provenance, sourceKinds: ["human_edit"], memberCorrection: true, claimsSupported: true, fromSharedTask: true, audience, sourceScopes: [REPO] } });

describe("settling a pull request comment lesson from a private project repository", () => {
  it("goes live on trial when the repository is the project's now, with a person-free approval and the live read asked for this project", async () => {
    const asked: string[] = [];
    const { deps, audit } = setup(async (key) => { asked.push(`${key.workspaceId}/${key.project}`); return new Set([REPO]); });
    const out = await processDraft(deps, KEY, prDraft());
    expect(out.lesson).toMatchObject({ status: "active", trial: { state: "trial" } });
    expect(audit.actions()).toContain("lesson.trial_started");
    expect(asked.length).toBeGreaterThanOrEqual(2); // at settle and again at go-live
    expect(asked.every((who) => who === `${KEY.workspaceId}/${KEY.project}`)).toBe(true);
  });

  it.each([
    ["another project's repository", setup(async () => new Set([OTHER_REPO]))],
    ["an unreadable project definition (undefined)", setup(async () => undefined)],
    ["an unreadable project definition (throws)", setup(async () => { throw new Error("down"); })],
    ["no port on this install", setup()],
  ])("stays off trial with %s", async (_name, { deps, audit }) => {
    const out = await processDraft(deps, KEY, prDraft());
    expect(out.lesson!.status).not.toBe("active");
    expect(out.lesson!.trial).toBeUndefined();
    expect(audit.actions()).not.toContain("lesson.trial_started");
  });

  it("is read again at go-live: a repository that leaves the project between the settle and the go-live sends the lesson to a person", async () => {
    let reads = 0;
    const { deps, audit } = setup(async () => (reads++ === 0 ? new Set([REPO]) : new Set<string>()));
    const out = await processDraft(deps, KEY, prDraft());
    expect(out.lesson!.status).toBe("pending");
    expect(out.lesson!.trial).toBeUndefined();
    expect(audit.actions()).toContain("lesson.pending");
    expect(audit.actions()).not.toContain("lesson.trial_started");
  });

  it("other trial rules still apply: a pull request comment lesson that is not a member's correction does not go on trial even from the project's own repository", async () => {
    const { deps } = setup(async () => new Set([REPO]));
    const notMember = draft({ provenance: { ...prDraft().provenance, memberCorrection: false } });
    const out = await processDraft(deps, KEY, notMember);
    expect(out.lesson!.trial).toBeUndefined();
  });
});

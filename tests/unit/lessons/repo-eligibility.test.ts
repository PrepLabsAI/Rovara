// Which lessons may ever go into one repository's file. Every kind of input the reflector can be given, the AND of a merge, an old lesson, and the eligibility rule.
import { describe, expect, it } from "vitest";
import { isRepoFileEligible, mergedRepoVisibility, repoFileBlockers, repoVisibilityOf, type RepoInputSpan } from "../../../packages/lessons/src/repo-eligibility.js";
import { SPAN_KINDS, type Audience } from "../../../packages/lessons/src/types.js";
import { lessonRecord } from "./lesson-helpers.js";

const A = "github:repo/1001";
const B = "github:repo/2002";
const open: Audience = { kind: "project" };
const readersOf = (place: string): Audience => ({ kind: "restricted", acl: { source: "github", scope: place, capturedAt: "2026-11-09T00:00:00Z", liveCheck: "on_read" } });
const span = (kind: string, over: Partial<RepoInputSpan> = {}): RepoInputSpan => ({ kind, trust: "member", scopes: [A], audience: open, ...over });
const PREFIX = "https://github.com/acme/api/pull/";
const proof = (place = A) => ({ place, repository: "api", linkPrefix: PREFIX });
/** A task whose own start and steering are proved repository-visible, and whose header names only that repository and its pull requests. */
const task = { kind: "task", repoInputs: proof(), repositories: ["api"], links: [`${PREFIX}7`] } as const;
const good = span("pr_comment");

describe("repoVisibilityOf: every kind of input the reflector can be given", () => {
  const cases: Array<{ name: string; subject?: Parameters<typeof repoVisibilityOf>[0]; spans: RepoInputSpan[]; ok: boolean; blocked?: string[] }> = [
    // Passes: the repository's own words, work and facts.
    { name: "a pull request comment on the repository (public repository, project audience)", spans: [good], ok: true },
    { name: "a pull request comment on a private repository (readers of that one repository)", spans: [span("pr_comment", { audience: readersOf(A) })], ok: true },
    { name: "a person's fix-up commits on the repository's pull request", spans: [span("human_edit", { authorIds: ["ann", "bob"] })], ok: true },
    { name: "a merge or revert outcome in the repository", spans: [span("outcome", { trust: "system" })], ok: true },
    { name: "a fact read from the repository's code", subject: { kind: "facts" }, spans: [span("fact", { trust: "system" })], ok: true },
    { name: "an intent from a GitHub issue or pull request of the repository (the place is on the span)", spans: [span("intent"), good], ok: true },
    { name: "Rovara's plan, finding and CI text, derived from repository-only inputs", spans: [good, span("plan", { trust: "system", scopes: undefined, audience: undefined }), span("review_finding", { trust: "system", scopes: undefined, audience: undefined }), span("ci_failure", { trust: "system", scopes: undefined, audience: undefined })], ok: true },
    { name: "a CI result that carries the repository's place", spans: [good, span("ci_failure", { trust: "system" })], ok: true },
    // Never.
    { name: "a Slack message (public or private channel)", spans: [good, span("pr_comment", { scopes: ["slack:channel/C123"], audience: readersOf("slack:channel/C123") })], ok: false, blocked: ["other_place"] },
    { name: "a tracker issue", spans: [good, span("fact", { trust: "system", scopes: ["linear:issue/ENG-1"], audience: open })], ok: false, blocked: ["other_place"] },
    { name: "a send-back typed in Rovara, even with a repository place on it", spans: [good, span("send_back")], ok: false, blocked: ["typed_in_rovara"] },
    { name: "a 'remember this' note", spans: [good, span("remembered", { scopes: ["rovara:project/p"] })], ok: false, blocked: ["typed_in_rovara"] },
    { name: "a close reason typed in Rovara", spans: [good, span("close_reason")], ok: false, blocked: ["typed_in_rovara"] },
    { name: "task text with no repository place (typed in Rovara, the CLI or chat)", spans: [good, span("intent", { scopes: undefined, audience: undefined })], ok: false, blocked: ["intent_not_repo"] },
    { name: "task text from a tracker", spans: [good, span("intent", { scopes: ["linear:issue/ENG-1"] })], ok: false, blocked: ["intent_not_repo"] },
    { name: "task text that came from another repository", spans: [good, span("intent", { scopes: [B] })], ok: false, blocked: ["other_repo"] },
    { name: "material from another repository of the same project", spans: [good, span("pr_comment", { scopes: [B] })], ok: false, blocked: ["other_repo"] },
    { name: "one span from two repositories", spans: [span("human_edit", { scopes: [A, B] })], ok: false, blocked: ["other_repo"] },
    { name: "a repository span whose readers are narrower than the repository's (named principals)", spans: [span("pr_comment", { audience: { kind: "restricted", acl: { source: "github", scope: A, principals: ["p1"], capturedAt: "t", liveCheck: "none" } } })], ok: false, blocked: ["audience_not_repo"] },
    { name: "a repository span restricted to a task's own readers", spans: [span("pr_comment", { audience: { kind: "restricted", acl: { source: "rovara", scope: "rovara:task/t1", principals: ["p1"], capturedAt: "t", liveCheck: "none" } } })], ok: false, blocked: ["audience_not_repo"] },
    { name: "a repository span with two sources in the audience scope", spans: [span("pr_comment", { audience: readersOf(`${A}+${B}`) })], ok: false, blocked: ["audience_not_repo"] },
    { name: "a repository span with no audience", spans: [span("pr_comment", { audience: undefined })], ok: false, blocked: ["audience_not_repo"] },
    { name: "a repository span with no place", spans: [span("pr_comment", { scopes: undefined })], ok: false, blocked: ["missing_place"] },
    { name: "a repository span with an empty place list", spans: [span("pr_comment", { scopes: [] })], ok: false, blocked: ["missing_place"] },
    { name: "a plan that holds a person's words", spans: [good, span("plan", { scopes: undefined, audience: undefined, authorId: "ann" })], ok: false, blocked: ["typed_in_rovara"] },
    { name: "a finding written by a member", spans: [good, span("review_finding", { scopes: undefined, audience: undefined })], ok: false, blocked: ["typed_in_rovara"] },
    { name: "a plan carrying a place that is not a repository", spans: [good, span("plan", { trust: "system", scopes: ["rovara:task/t1"], audience: open })], ok: false, blocked: ["other_place"] },
    { name: "a lesson loaded into the task", spans: [good, span("loaded_lesson", { scopes: undefined, audience: undefined })], ok: false, blocked: ["loaded_lesson"] },
    { name: "tasks behind loaded lessons (inheritedTasks)", subject: { ...task, inheritedTasks: ["task-9"] }, spans: [good], ok: false, blocked: ["loaded_lesson"] },
    { name: "a span of a kind this build does not know", spans: [good, span("email_thread")], ok: false, blocked: ["unknown_input"] },
    { name: "a task whose own start and steering are not proved repository-visible", subject: { kind: "task" }, spans: [good], ok: false, blocked: ["task_inputs_unproved"] },
    { name: "a task whose proved inputs are another repository's", subject: { ...task, repoInputs: proof(B) }, spans: [good], ok: false, blocked: ["other_repo"] },
    { name: "a task whose proof names no repository place", subject: { ...task, repoInputs: proof("slack:channel/C1") }, spans: [good], ok: false, blocked: ["task_inputs_unproved"] },
    { name: "a subject of a kind this build does not know", subject: { kind: "digest" }, spans: [good], ok: false, blocked: ["unknown_input"] },
    { name: "only derived text, nothing from a repository", spans: [span("plan", { trust: "system", scopes: undefined, audience: undefined })], ok: false, blocked: ["no_repo_evidence"] },
    { name: "no input at all", spans: [], ok: false, blocked: ["no_repo_evidence"] },
  ];
  for (const c of cases) {
    it(`${c.ok ? "sets" : "does not set"} repoOnly for ${c.name}`, () => {
      const result = repoVisibilityOf(c.subject ?? task, c.spans);
      if (c.ok) {
        expect(result.repoOnly).toEqual({ place: A });
        expect(result.blocked).toEqual([]);
      } else {
        expect(result.repoOnly).toBeUndefined();
        expect(result.blocked.length).toBeGreaterThan(0);
        for (const code of c.blocked ?? []) expect(result.blocked).toContain(code);
      }
    });
  }

  it("covers every span kind the reflector knows: each is either passing, derived or never, and none falls through to a pass by accident", () => {
    for (const kind of SPAN_KINDS) {
      const alone = repoVisibilityOf(task, [good, span(kind, { scopes: undefined, audience: undefined, trust: "system" })]);
      // With no place at all, only the derived kinds (written by Rovara) may pass beside a repository span.
      expect(alone.repoOnly !== undefined, `${kind} with no place`).toBe(kind === "plan" || kind === "review_finding" || kind === "ci_failure");
    }
  });

  it("fail closed over random mixes: repoOnly is set exactly when no span is bad and one is from the repository, whatever the order or the number", () => {
    let seed = 7;
    const next = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
    const goodOnes = [good, span("human_edit"), span("outcome", { trust: "system" }), span("intent"), span("plan", { trust: "system", scopes: undefined, audience: undefined })];
    const badOnes = [span("send_back"), span("remembered"), span("close_reason"), span("pr_comment", { scopes: ["slack:channel/C1"] }), span("pr_comment", { scopes: [B] }), span("loaded_lesson"), span("email_thread"), span("intent", { scopes: undefined }), span("pr_comment", { audience: undefined })];
    for (let round = 0; round < 300; round += 1) {
      const picked: RepoInputSpan[] = [];
      const wantBad = next() < 0.5;
      for (let i = 0, n = 1 + Math.floor(next() * 6); i < n; i += 1) picked.push(goodOnes[Math.floor(next() * goodOnes.length)]!);
      if (!picked.some((s) => s.kind === "pr_comment" || s.kind === "human_edit" || s.kind === "outcome")) picked.push(good);
      if (wantBad) picked.splice(Math.floor(next() * (picked.length + 1)), 0, badOnes[Math.floor(next() * badOnes.length)]!);
      expect(repoVisibilityOf(task, picked).repoOnly !== undefined, JSON.stringify(picked)).toBe(!wantBad);
    }
  });
});

describe("mergedRepoVisibility: the AND of a merge", () => {
  const only = (place: string) => ({ repoOnly: { place } });
  it("keeps repoOnly only when both sides carry it for the same repository", () => {
    expect(mergedRepoVisibility(only(A), only(A))).toEqual({ repoOnly: { place: A } });
  });
  it("clears it when either side is not repository-only, and keeps the reasons", () => {
    expect(mergedRepoVisibility(only(A), { repoBlockCodes: ["typed_in_rovara"] })).toEqual({ repoBlockCodes: ["typed_in_rovara"] });
    expect(mergedRepoVisibility({ repoBlockCodes: ["other_place"] }, only(A))).toEqual({ repoBlockCodes: ["other_place"] });
    expect(mergedRepoVisibility({ repoBlockCodes: ["typed_in_rovara"] }, { repoBlockCodes: ["other_place"] }).repoBlockCodes).toEqual(["typed_in_rovara", "other_place"]);
  });
  it("clears it for two different repositories", () => {
    expect(mergedRepoVisibility(only(A), only(B))).toEqual({ repoBlockCodes: ["other_repo"] });
  });
  it("reads an unset side (a lesson learned before the field) as false", () => {
    expect(mergedRepoVisibility(only(A), {})).toEqual({ repoBlockCodes: ["predates_field"] });
    expect(mergedRepoVisibility({}, only(A))).toEqual({ repoBlockCodes: ["predates_field"] });
    expect(mergedRepoVisibility({}, {})).toEqual({ repoBlockCodes: ["predates_field"] });
    expect(mergedRepoVisibility({ repoBlockCodes: [] }, only(A))).toEqual({ repoBlockCodes: ["predates_field"] });
  });
  it("never sets repoOnly on a result that is not an AND of two repoOnly sides (random sides)", () => {
    const sides = [only(A), only(B), {}, { repoBlockCodes: ["other_place" as const] }, { repoBlockCodes: [] }];
    for (const left of sides) for (const right of sides) {
      const merged = mergedRepoVisibility(left, right);
      const both = "repoOnly" in left && "repoOnly" in right && left.repoOnly.place === right.repoOnly.place;
      expect(merged.repoOnly !== undefined).toBe(both);
    }
  });
});

describe("isRepoFileEligible: the rule", () => {
  const stable = { state: "stable" as const, startedAt: 1, stableAt: 2 };
  const eligible = (over: Parameters<typeof lessonRecord>[0] = {}, prov: Record<string, unknown> = {}) => {
    const base = lessonRecord({ trial: stable, ...over });
    return { ...base, provenance: { ...base.provenance, repoOnly: { place: A }, audience: open, ...prov } };
  };
  const names = ["Ann Ng"];

  it("accepts an active, stable lesson that is repository-only for that repository and names nobody", () => {
    expect(isRepoFileEligible(eligible(), A, names)).toBe(true);
    expect(repoFileBlockers(eligible(), A, names)).toEqual([]);
  });
  it("accepts a person-approved lesson that never went on trial, by any of the three person approval modes", () => {
    for (const mode of ["one", "second_person", "sole_owner_exception"] as const) {
      expect(isRepoFileEligible(eligible({ trial: undefined, approvals: [{ approvalId: "a", by: "p1", at: 1, mode }] }), A, names), mode).toBe(true);
    }
  });
  it("accepts a lesson restricted to the readers of that one repository", () => {
    expect(isRepoFileEligible(eligible({}, { audience: readersOf(A) }), A, names)).toBe(true);
  });

  const refused: Array<[string, ReturnType<typeof eligible>, string]> = [
    ["a lesson with no repoOnly (learned before the field)", (() => { const l = eligible(); delete (l.provenance as { repoOnly?: unknown }).repoOnly; return l; })(), "not_repo_only"],
    ["a lesson that is repository-only for another repository", eligible({}, { repoOnly: { place: B } }), "other_repo"],
    ["a lesson on trial", eligible({ trial: { state: "trial", startedAt: 1 } }), "on_trial"],
    ["an auto-applied lesson that is not stable", eligible({ trial: undefined, approvals: [{ approvalId: "a", by: "system:auto", at: 1, mode: "auto" }] }), "not_stable_or_approved"],
    ["a lesson nobody approved", eligible({ trial: undefined, approvals: [] }), "not_stable_or_approved"],
    ["a trial approval is not a person's", eligible({ trial: undefined, approvals: [{ approvalId: "a", by: "system:trial", at: 1, mode: "trial" }] }), "not_stable_or_approved"],
    ["a retired lesson", eligible({ status: "retired" }), "not_active"],
    ["a pending lesson", eligible({ status: "pending" }), "not_active"],
    ["a lesson restricted to another repository's readers", eligible({}, { audience: readersOf(B) }), "restricted_audience"],
    ["a lesson restricted to named people", eligible({}, { audience: { kind: "restricted", acl: { source: "slack", scope: "slack:channel/C1", principals: ["u1"], capturedAt: "t", liveCheck: "none" } } }), "restricted_audience"],
    ["a lesson restricted to two sources including the repository", eligible({}, { audience: readersOf(`${A}+${B}`) }), "restricted_audience"],
    ["a lesson whose text names a person (display name)", eligible({ body: "Ask Ann Ng before changing retries." }), "names_a_person"],
    ["a lesson whose text names a person (handle)", eligible({ description: "Ping @ann-ng for the schema." }), "names_a_person"],
    ["a lesson whose text names a person (e-mail)", eligible({ title: "Mail ann@example.com" }), "names_a_person"],
    ["a tier 2 lesson", eligible({ tier: 2 }), "needs_review"],
    ["a lesson that needs review", eligible({ reviewRequired: true }), "needs_review"],
    ["a lesson with a retire proposal", eligible({ retireProposedAt: 5 }), "needs_review"],
    ["a lesson with a thumbs-down", eligible({ counters: { loaded: 3, helpful: 0, harmful: 1, citationStale: 0 } }), "needs_review"],
    ["a lesson with a stale citation", eligible({ citationChecks: [{ index: 0, result: "stale", at: 1 }] }), "needs_review"],
  ];
  for (const [name, lesson, blocker] of refused) {
    it(`refuses ${name}`, () => {
      expect(isRepoFileEligible(lesson, A, names)).toBe(false);
      expect(repoFileBlockers(lesson, A, names)).toContain(blocker);
    });
  }
  it("a tier 2 lesson whose text is the team's own (read back from the file) is not held back for its tier, but every other review reason still applies", () => {
    expect(repoFileBlockers(eligible({ tier: 2, tierReasons: ["escalation_words", "team_file_text"] }), A, names)).toEqual([]);
    expect(repoFileBlockers(eligible({ tier: 2, tierReasons: ["team_file_text"], reviewRequired: true }), A, names)).toContain("needs_review");
    expect(repoFileBlockers(eligible({ tier: 2, tierReasons: ["escalation_words"] }), A, names)).toContain("needs_review");
  });
  it("refuses a repository argument that is not a repository place, and repoOnly with a different place spelling", () => {
    expect(repoFileBlockers(eligible(), "not a place", names)).toEqual(["repo_unknown"]);
    expect(isRepoFileEligible(eligible(), "github:repo/1001 ", names)).toBe(false);
    expect(isRepoFileEligible(eligible(), "github:repo/10010", names)).toBe(false);
  });
  it("is eligible for A and not for B (the repository-only rule)", () => {
    const lesson = eligible({}, { audience: readersOf(A) });
    expect(isRepoFileEligible(lesson, A, names)).toBe(true);
    expect(isRepoFileEligible(lesson, B, names)).toBe(false);
  });
});

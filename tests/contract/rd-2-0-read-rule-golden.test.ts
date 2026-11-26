// RD-2.0-READ-RULE: every "may this person read this task" answer of today, recorded BEFORE the five rules were folded into one function (`RD2_READ_RULE_RECORD=1`
// on a65c40ce7, the head RD-2.0 had), for every kind of person and every read: the task read, the answers read, the task list's round (`taskReadable`), the merge standing,
// the events, the diff, the plan, the proof, the plan comments and the four new page reads. The fixture is the base's answers (status, code and words, or the shape of a
// served answer, with the task's money named); this test compares the code now against it. `CHANGED` is the exact list of cells that moved on purpose (empty after the
// first commit, which changes no answer), each with the reason; a cell not listed that differs, or a listed cell that does not differ, fails.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PERSONAS, READS, readRuleWorld, type Answer } from "../support/read-rule-world.js";

const GOLDEN = new URL("../fixtures/rd-2-0-read-rule/answers.json", import.meta.url);
const RECORD = process.env["RD2_READ_RULE_RECORD"] === "1";

/** Cells that moved on purpose: `<persona> | <read>`: the new answer and why. The same list, with the reasons, is in RD-2-0-READ-RULE-DONE.md (commit 2). */
const CHANGED: Record<string, { now: Answer; why: string }> = {};
const NEW_READS = ["spec", "checks", "changes", "timeline"] as const;
// WIDENING (approved): a co-owner and the People list's commenters and viewers read the task's events (the events were the task's own person's and a share's alone).
for (const persona of ["co-owner", "commenter", "viewer"]) CHANGED[`${persona} | events`] = { now: { status: 200, shape: "events" }, why: "widening: events for a co-owner / People commenter / viewer" };
// NARROWING of an unreleased placeholder: a person the rule refuses is told the missing task's answer on the four new reads (they said ROUTE_NOT_SERVED to everyone, the stubs' placeholder).
for (const persona of ["project member", "unknown role", "company admin", "stranger", "other company"]) {
  for (const read of NEW_READS) CHANGED[`${persona} | ${read}`] = { now: { status: 404, code: "TASK_NOT_FOUND", message: "no such task" }, why: "narrowing: the new reads refuse a non-reader as a missing task" };
}
// OWNER DECISION 254zzz558 (option A, Q1 answered): a person the task is SHARED with (the stored share, "Can view") reads the whole task page, the code changes included, and can comment. Each cell below was a refusal (the
// diff, the plan, the proof and the comments: the missing task's; the new reads: ROUTE_NOT_SERVED) and is now the answer the task's own person gets on that read in this world (the diff and the plan have nothing to show yet:
// the same 404 as for the owner). A person with no share is not touched. The Slack channel share is not in this golden (it has no persona of the base); its cells are in tests/unit/task-read-rule.test.ts.
const SHARE_NOW: Record<string, Answer> = {
  diff: { status: 404, code: "NOT_FOUND", message: "no such pull request on this task" },
  plan: { status: 404, code: "NOT_FOUND", message: "this task has no plan document yet" },
  evidence: { status: 200, shape: "items,taskId" },
  comments: { status: 200, shape: "comments" },
  spec: { status: 200, shape: "spec" },
  checks: { status: 200, shape: "checks" },
  changes: { status: 200, shape: "changes" },
};
for (const persona of ["shared reader", "admin and shared"]) {
  for (const [read, now] of Object.entries(SHARE_NOW)) CHANGED[`${persona} | ${read}`] = { now, why: "widening (owner decision 254zzz558, option A): a share reads the whole task page, the code changes included" };
}
// READ-RULE-SHARE-B (owner DEC 254zzz577), the cells that moved on top of the merged RD-2 stack. Each is listed with its reason; nothing else moved.
// Rule 1 (a share works with NO project access, same company only): "left the project" holds a stored share row, is a live member of the company and holds no project grant. Before, the stored share needed a live project grant, so
// all 10 reads below refused them; now they read exactly as the "shared reader" does (the timeline is still a placeholder, ROUTE_NOT_SERVED, for everyone it admits; the readable and merge reads stay refused: they are not part of the page). "other company" is a member of ANOTHER company: not one cell moved for them.
const SHARED_ANSWERS: Record<string, Answer> = {
  task: { status: 200, shape: "task | task:no-money" },
  answers: { status: 200, shape: "outcome:answered" },
  events: { status: 200, shape: "events" },
  ...SHARE_NOW,
};
for (const [read, now] of Object.entries(SHARED_ANSWERS)) CHANGED[`left the project | ${read}`] = { now, why: "rule 1 (DEC 254zzz577): a stored share needs a live member of the task's company, not a project grant" };
// Rule 3 (both "Can view" kinds are the same: the whole page): a People-list commenter or viewer now reads the plan and the proof, as a share does (they were the owner's and co-owner's alone). The diff, the comments, the spec, the checks, the changes
// and the events of a People viewer were already served and did not move.
for (const persona of ["commenter", "viewer"]) for (const read of ["plan", "evidence"]) CHANGED[`${persona} | ${read}`] = { now: SHARE_NOW[read]!, why: "rule 3 (DEC 254zzz577): a People commenter or viewer reads the plan and the proof like a share" };
// FILLED READS (not a read-rule change): a lane that fills a stub moves every cell the rule ADMITS from the placeholder's ROUTE_NOT_SERVED to the served answer.
// RD-2a (spec):
for (const persona of ["owner", "co-owner", "commenter", "viewer"]) CHANGED[`${persona} | spec`] = { now: { status: 200, shape: "spec" }, why: "RD-2a fills the spec read: a person the rule admits is served" };
// RD-2b2 (changes):
for (const persona of ["owner", "co-owner", "commenter", "viewer"]) CHANGED[`${persona} | changes`] = { now: { status: 200, shape: "changes" }, why: "RD-2b2 fills the changes read: a person the rule admits is served" };
// RD-2b1 (checks):
for (const persona of ["owner", "co-owner", "commenter", "viewer"]) CHANGED[`${persona} | checks`] = { now: { status: 200, shape: "checks" }, why: "RD-2b1 fills the checks read: a person the rule admits is served" };

describe("RD-2.0-READ-RULE: every read answers every kind of person as it did on the base (but the named cells)", () => {
  it("matches the recorded answers", async () => {
    const w = await readRuleWorld();
    const answers: Record<string, Answer> = {};
    for (const persona of PERSONAS) for (const read of READS) answers[`${persona.name} | ${read}`] = await w.ask(persona, read);
    if (RECORD) {
      writeFileSync(GOLDEN, `${JSON.stringify(Object.fromEntries(Object.entries(answers).sort(([a], [b]) => (a < b ? -1 : 1))), null, 1)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Answer>;
    expect(Object.keys(answers).sort()).toEqual(Object.keys(golden).sort());
    const expected = Object.fromEntries(Object.entries(golden).map(([key, value]) => [key, CHANGED[key]?.now ?? value]));
    const different = Object.entries(answers).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(expected[key])).map(([key, value]) => ({ key, now: value, base: golden[key] }));
    expect(different).toEqual([]);
    for (const [key, change] of Object.entries(CHANGED)) expect(JSON.stringify(golden[key]), `${key} must differ from the base (${change.why})`).not.toBe(JSON.stringify(change.now));
    // The table is not vacuous: served answers, refusals and the other kinds all appear.
    const statuses = new Set(Object.values(golden).map((answer) => answer.status));
    expect([...statuses].sort()).toEqual(expect.arrayContaining([200, 401, 404]));
  }, 120_000);
});

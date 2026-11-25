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
for (const persona of ["project member", "unknown role", "left the project", "company admin", "stranger", "other company"]) {
  for (const read of NEW_READS) CHANGED[`${persona} | ${read}`] = { now: { status: 404, code: "TASK_NOT_FOUND", message: "no such task" }, why: "narrowing: the new reads refuse a non-reader as a missing task" };
}
// NEW REFUSAL (ship B, Q1 pending): a share shows the task's summary; the plan, the checks and the code changes answer TASK_PART_NOT_SHOWN with words from the one table (never the missing task's 404).
const PART_WORDS: Record<string, string> = { spec: "The plan is not shown.", checks: "The checks are not shown.", changes: "The code changes are not shown." };
// NARROWING (the answers read, pre-review S1): the answers frame carries none of the plan, design or requirements text for a share (option B), so the scripted answer that cites the plan cannot be verified: "not found".
for (const persona of ["shared reader", "admin and shared"]) CHANGED[`${persona} | answers`] = { now: { status: 200, shape: "outcome:not_found" }, why: "narrowing: a share's answer frame has no plan text (option B)" };
for (const persona of ["shared reader", "admin and shared"]) {
  for (const read of ["spec", "checks", "changes"]) CHANGED[`${persona} | ${read}`] = { now: { status: 403, code: "TASK_PART_NOT_SHOWN", message: `The owner shared this task's summary with you. ${PART_WORDS[read]!}` }, why: "new refusal: a share is not shown this part (ship B, Q1)" };
}
// FILLED READS (not a read-rule change): a lane that fills a stub moves every cell the rule ADMITS from the placeholder's ROUTE_NOT_SERVED to the served answer.
// RD-2a (spec):
for (const persona of ["owner", "co-owner", "commenter", "viewer"]) CHANGED[`${persona} | spec`] = { now: { status: 200, shape: "spec" }, why: "RD-2a fills the spec read: a person the rule admits is served" };

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

// TE-F10: choosing and pairing the cases, the eval-set source, and the table of when the layer is on. Each rule has a test that fails when the rule is removed.
import { describe, expect, it } from "vitest";
import {
  checkKindInfo, modelOfFrame, pairSideBySideCases, selectSideBySideCases, sideBySideIsOn, sideBySideOrder, SIDE_BY_SIDE_CHECK_KIND, SIDE_BY_SIDE_MAX_CASES, type SideBySideCase,
} from "../../packages/contracts/src/index.js";
import { collect } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { COMPANY_A, evalCases, MODEL, reportIncomplete, reportModelOnly, reportNeeded, reportNone, sbsWorld, source } from "../support/side-by-side-world.js";

const ids = (cases: readonly SideBySideCase[]): string[] => cases.map((item) => item.caseId);

describe("choosing the cases", () => {
  it("picks at most five, by a seeded hash: the same picks for the same seed, whatever order the cases come in", async () => {
    const cases = await source(COMPANY_A, 40).cases();
    const first = selectSideBySideCases(cases, { seed: "task-1" });
    expect(first).toHaveLength(SIDE_BY_SIDE_MAX_CASES);
    const shuffled = [...cases].reverse().sort((a, b) => (a.caseId.length % 3) - (b.caseId.length % 3) || b.caseId.localeCompare(a.caseId));
    expect(ids(selectSideBySideCases(shuffled, { seed: "task-1" }))).toEqual(ids(first));
    expect(ids(selectSideBySideCases(cases, { seed: "task-2" }))).not.toEqual(ids(first));
  });
  it("takes a count from data but never more than five, never fewer than none, and never repeats a case id", async () => {
    const cases = await source(COMPANY_A, 12).cases();
    expect(selectSideBySideCases(cases, { seed: "s", max: 2 })).toHaveLength(2);
    expect(selectSideBySideCases(cases, { seed: "s", max: 50 })).toHaveLength(5);
    expect(selectSideBySideCases(cases, { seed: "s", max: -3 })).toHaveLength(0);
    expect(selectSideBySideCases(cases, { seed: "s", max: Number.NaN })).toHaveLength(5);
    const twice = selectSideBySideCases([...cases, ...cases], { seed: "s" });
    expect(new Set(ids(twice)).size).toBe(twice.length);
  });
  it("decides the A/B order from the seed and the case id alone, and both orders occur", () => {
    const orders = Array.from({ length: 40 }, (_, index) => sideBySideOrder("seed", `case-${String(index)}`));
    expect(new Set(orders)).toEqual(new Set(["old_first", "new_first"]));
    expect(sideBySideOrder("seed", "case-1")).toBe(sideBySideOrder("seed", "case-1"));
  });
});

describe("pairing the two sides", () => {
  it("refuses a case whose old and new frames differ in row, and says which rule", async () => {
    const [good] = await source(COMPANY_A, 1).cases();
    const other = { ...good!, caseId: "other", new: { ...good!.new, row: "openai" } };
    const outcome = pairSideBySideCases([good!, other], { modelChange: false });
    expect(ids(outcome.paired)).toEqual([good!.caseId]);
    expect(outcome.refused).toEqual([{ caseId: "other", reason: "different_row" }]);
  });
  it("refuses a case whose two sides name different models, unless the change IS a model change", async () => {
    const cases = await source(COMPANY_A, 2, { newModel: "gemini-2.5-pro" }).cases();
    expect(modelOfFrame(cases[0]!.old, "gemini")).toBe(MODEL);
    expect(modelOfFrame(cases[0]!.new, "gemini")).toBe("gemini-2.5-pro");
    const refused = pairSideBySideCases(cases, { modelChange: false });
    expect(refused.paired).toEqual([]);
    expect(refused.refused.map((item) => item.reason)).toEqual(["different_model", "different_model"]);
    expect(pairSideBySideCases(cases, { modelChange: true }).paired).toHaveLength(2);
  });
  it("refuses a frame the port would refuse (an unknown key), without echoing it", async () => {
    const [good] = await source(COMPANY_A, 1).cases();
    const bad = { ...good!, caseId: "bad", old: { ...good!.old, company: "org_x" } } as unknown as SideBySideCase;
    expect(pairSideBySideCases([bad], { modelChange: false })).toEqual({ paired: [], refused: [{ caseId: "bad", reason: "bad_frame" }] });
  });
  it("reads the model from the body for the families that name it there", async () => {
    const [good] = await source(COMPANY_A, 1).cases();
    expect(modelOfFrame({ ...good!.old, body: new TextEncoder().encode(JSON.stringify({ model: "gpt-x" })) }, "openai_compatible")).toBe("gpt-x");
  });
});

describe("the eval-set source", () => {
  it("builds frames the port accepts: both sides go through the fake adapter and differ only in the prompt", async () => {
    const world = sbsWorld();
    const [item] = await source(COMPANY_A, 1, { oldSystem: "OLD-PROMPT-TEXT", newSystem: "NEW-PROMPT-TEXT" }).cases();
    expect(item!.old.row).toBe("gemini");
    expect(item!.old.path).toBe(item!.new.path);
    world.answers("fine", "fine");
    const old = await collect(world.rawEgress, world.rawScope, item!.old);
    const next = await collect(world.rawEgress, world.rawScope, item!.new);
    expect([old.settle?.class, next.settle?.class]).toEqual(["ok", "ok"]);
    const sent = world.world.provider.calls.map((call) => new TextDecoder().decode(call.body));
    expect(sent[0]).toContain("OLD-PROMPT-TEXT");
    expect(sent[1]).toContain("NEW-PROMPT-TEXT");
  });
  it("is bound to one company", async () => {
    expect(source(COMPANY_A, 1).company).toBe(COMPANY_A.orgId);
    expect(source(COMPANY_A, 1).kind).toBe("eval_set");
  });
});

describe("when the layer is on", () => {
  const off = { aiPilot: false, optIn: false };
  it("is on for Careful, for the AI pilot, and when opted in; off for Lightweight and Balanced otherwise", () => {
    const needed = reportNeeded();
    expect(sideBySideIsOn(needed, { preset: "careful", ...off })).toMatchObject({ on: true, reason: "careful" });
    expect(sideBySideIsOn(needed, { preset: "lightweight", aiPilot: true, optIn: false })).toMatchObject({ on: true, reason: "ai_pilot" });
    expect(sideBySideIsOn(needed, { preset: "balanced", aiPilot: false, optIn: true })).toMatchObject({ on: true, reason: "opt_in" });
    expect(sideBySideIsOn(needed, { preset: "balanced", ...off })).toEqual({ on: false, reason: "not_enabled" });
    expect(sideBySideIsOn(needed, { preset: "lightweight", ...off })).toEqual({ on: false, reason: "not_enabled" });
  });
  it("is off when F4 found no prompt-affecting change, whatever the preset, and on for an incomplete report", () => {
    expect(sideBySideIsOn(reportNone(), { preset: "careful", aiPilot: true, optIn: true })).toEqual({ on: false, reason: "no_prompt_change" });
    expect(sideBySideIsOn(reportIncomplete(), { preset: "careful", ...off }).on).toBe(true);
    expect(sideBySideIsOn(reportModelOnly(), { preset: "careful", ...off }).on).toBe(true);
  });
  it("refuses an input that is not one of the three presets, and never turns on for it", () => {
    expect(sideBySideIsOn(reportNeeded(), { preset: "whatever" as never, ...off })).toEqual({ on: false, reason: "not_enabled" });
    expect(sideBySideIsOn(reportNeeded(), { preset: "balanced", aiPilot: "yes" as never, optIn: 1 as never })).toEqual({ on: false, reason: "not_enabled" });
  });
});

describe("the check kind", () => {
  it("is registered additively, carries pairs only, and never counts toward the proof that a change works", () => {
    expect(SIDE_BY_SIDE_CHECK_KIND).toBe("side_by_side");
    expect(checkKindInfo(SIDE_BY_SIDE_CHECK_KIND)).toMatchObject({ id: "side_by_side", parts: ["pairs"], countsTowardProof: false });
  });
  it("leaves the cases helper deterministic: the source has no randomness", async () => {
    expect(ids(await source(COMPANY_A, 9).cases())).toEqual(evalCases(9).map((item) => item.caseId));
  });
});

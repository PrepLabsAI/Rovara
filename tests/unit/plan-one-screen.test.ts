// The one-screen plan is a pure, capped, deterministic view of a plan document, and a plan that does not fit gets a `plan-too-big` finding.
import { describe, expect, it } from "vitest";
import { PLAN_ONE_SCREEN_MAX_CHARS, PlanOneScreenSchema, planQualityFinding, type PlanClaim, type PlanDocument, type RunEstimate } from "@rovara-code/contracts";
import { costLine, cutWords, planFiles, planFullCharacters, planIsTooBig, planOneScreen, planOneScreenText } from "../../packages/core/src/developer/plan-one-screen.js";
import { planQualityFindings } from "../../packages/core/src/developer/plan-quality.js";
import { planDocument } from "../support/plan-documents.js";

const estimate: RunEstimate = { lowUsd: 1.2, highUsd: 3.1, runLimitUsd: 6, stopAtUsd: 9, basis: "history", samples: 4, minutes: { low: 12, high: 25, basis: "history", samples: 4 } };
const bigClaim = (index: number): PlanClaim => ({ id: String(index), text: `Claim ${String(index)}: ${"the importer reads every row of the partner file and rejects bad rows with a reason ".repeat(3)}`, evidence: [{ kind: "code", path: `src/importer/part${String(index)}.ts`, startLine: 1, endLine: 9 }] });
const bigPlan = (): PlanDocument => planDocument({
  claims: Array.from({ length: 12 }, (_, i) => bigClaim(i + 1)),
  risks: ["A slow gateway could keep a retry open for a long time.", "The partner file format may change without notice to us.", "Bad rows could hide real failures from the report.", "A fourth risk that is never shown."],
});

describe("planOneScreen", () => {
  it("shows the problem, approach, files, risks, cost and how each top claim is proved", () => {
    const view = planOneScreen(planDocument(), estimate);
    expect(view.problem).toBe("Retry failed payments: Failed payments are dropped without a retry.");
    expect(view.approach).toEqual(["Payments that fail with a timeout are retried.", "A payment is never charged twice."]);
    expect(view.files).toEqual(["payments/src/charge.ts"]);
    expect(view.risks).toEqual(["A slow gateway could keep a retry open for a long time."]);
    expect(view.cost).toBe(costLine(estimate));
    expect(view.cost).toContain("$1.20 to $3.10");
    expect(view.proof.map((entry) => entry.how)).toEqual(["not_planned", "not_planned"]);
    expect(view.tooBig).toBe(false);
    expect(PlanOneScreenSchema.safeParse(view).success).toBe(true);
  });

  it("is deterministic: the same plan gives the same screen", () => {
    expect(planOneScreen(bigPlan(), estimate)).toEqual(planOneScreen(bigPlan(), estimate));
  });

  it("never exceeds the cap, however big the plan, and says it is too big", () => {
    const view = planOneScreen(bigPlan(), estimate);
    expect(view.characters).toBeLessThanOrEqual(PLAN_ONE_SCREEN_MAX_CHARS);
    expect([...planOneScreenText(view)].length).toBe(view.characters);
    expect(view.tooBig).toBe(true);
    expect(view.fullCharacters).toBeGreaterThan(PLAN_ONE_SCREEN_MAX_CHARS);
    expect(view.approach.length).toBeGreaterThan(0);
  });

  it("keeps the top three risks only and lists at most five claims", () => {
    const view = planOneScreen(planDocument({ claims: Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), text: `Short claim ${String(i + 1)}.` })), risks: ["r1 risk", "r2 risk", "r3 risk", "r4 risk"] }));
    expect(view.risks).toEqual(["r1 risk", "r2 risk", "r3 risk"]);
    expect(view.approach).toHaveLength(5);
    expect(view.proof).toHaveLength(5);
  });

  it("names how a claim is proved from the plan's checks and scenarios", () => {
    const plan = planDocument({
      claims: [{ id: "1", text: "Timeouts are retried." }, { id: "2", text: "The page shows a retry notice." }, { id: "3", text: "The API returns 202." }, { id: "4", text: "Lint stays clean." }],
      checks: {
        proposed: [
          { id: "c1", label: "retry unit tests", command: { cwd: "x", executable: "npx", args: ["vitest", "run"], timeoutSeconds: 60 } },
          { id: "c2", label: "style", command: { cwd: "x", executable: "npm", args: ["run", "lint"], timeoutSeconds: 60 } },
        ],
        proves: { c1: ["1"], c2: ["4"] },
      },
      e2e: { schemaVersion: 2, scenarios: [
        { scenarioId: "s1", steps: [{ kind: "navigate" }], assertions: [{ kind: "visible" }] },
        { scenarioId: "s2", steps: [{ kind: "request" }], assertions: [{ kind: "http-status" }] },
      ] } as never,
      scenarioProves: { s1: ["2"], s2: ["3"] },
    });
    expect(planOneScreen(plan).proof.map((entry) => entry.how)).toEqual(["test", "browser", "api", "check"]);
  });

  it("counts a child's proof for its parent claim", () => {
    const plan = planDocument({ checks: { proposed: [{ id: "c1", label: "unit tests", command: { cwd: "x", executable: "pytest", args: [], timeoutSeconds: 60 } }], proves: { c1: ["1.1"] } } });
    expect(planOneScreen(plan).proof[0]?.how).toBe("test");
  });

  it("takes files from cited code and from the ordered work items, without duplicates or prose", () => {
    const itemId = "11111111-1111-4111-8111-111111111111";
    const plan = planDocument({ workBreakdown: { schemaVersion: 1, taskId: "22222222-2222-4222-8222-222222222222", version: 1, items: [{ id: itemId, title: "Edit src/retry.ts", description: "Also change payments/src/charge.ts and docs e.g. later", repository: "acme/pay", dependsOn: [] }] } });
    expect(planFiles(plan)).toEqual(["payments/src/charge.ts", "src/retry.ts"]);
  });

  it("flattens hidden characters and line breaks and cuts at a word", () => {
    expect(cutWords("one‮two\nthree   four", 100)).toBe("one two three four");
    const cut = cutWords("alpha beta gamma delta epsilon", 14);
    expect(cut.endsWith("…")).toBe(true);
    expect([...cut].length).toBeLessThanOrEqual(14);
  });

  it("omits the cost line when there is no estimate", () => {
    expect(planOneScreen(planDocument()).cost).toBeUndefined();
  });
});

describe("plan-too-big finding", () => {
  it("is added for a plan over the cap, is not revisable and never blocks", () => {
    const findings = planQualityFindings(bigPlan(), { kind: "plan" });
    const found = findings.find((finding) => finding.code === "plan-too-big");
    expect(found).toBeDefined();
    expect(found?.revisable).toBe(false);
    expect(found?.ownerSentence).toContain("one screen");
    expect(found?.count).toBe(planFullCharacters(bigPlan()));
  });
  it("is absent for a plan that fits and for requirements and design documents", () => {
    expect(planIsTooBig(planDocument())).toBe(false);
    expect(planQualityFindings(planDocument(), { kind: "plan" }).some((finding) => finding.code === "plan-too-big")).toBe(false);
    expect(planQualityFindings(bigPlan(), { kind: "design" })).toEqual([]);
  });
  it("is the same from the contract's builder", () => {
    expect(planQualityFinding({ code: "plan-too-big", count: 2_345 }).ownerSentence).toContain("2345");
  });
});

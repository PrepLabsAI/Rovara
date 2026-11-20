// Lane L4-PRP (design pr-redesign.md 2.6 and rule 2.1.7): the verdict the "Rovara" Check carries is built from the very same facts, by the same functions, as the description's heading, six lines and list. Driven over the four
// golden tasks (green, clean green, exceptions with a hostile variant, largest), so a wording or a layout change shows in both places or in neither.
import { describe, expect, it } from "vitest";
import { rovaraCheckOf } from "../../packages/contracts/src/index.js";
import { workflowPullRequestCheckVerdict } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { SCENARIOS, SCENARIO_PLAN_TEXT, SCENARIO_TASK, exceptionsScenario, type Scenario } from "../support/pr-body-scenarios.js";

const verdictOf = (scenario: Scenario) => workflowPullRequestCheckVerdict(SCENARIO_TASK, scenario.inputs.workflow, SCENARIO_PLAN_TEXT(), scenario.inputs.context, scenario.inputs.proofLines);
const headingOf = (body: string): string => body.split("\n").find((line) => line.startsWith("## "))!.slice(3);
const SIX = ["**Changed** ", "**Proven** ", "**Tested against** ", "**Reviews** ", "**Risk** ", "**Needs you** "];
const aboveFold = (body: string): string => body.slice(0, body.indexOf("<details>"));

describe("the Check says the description's words", () => {
  for (const { name, build } of SCENARIOS) {
    const scenario = build();
    it(`${name}: the heading is the description's heading`, () => {
      expect(verdictOf(scenario)!.heading).toBe(headingOf(scenario.body));
    });
    it(`${name}: every line of the six, and every thing to check, is a line of the description, word for word`, () => {
      const verdict = verdictOf(scenario)!;
      const lines = new Set(aboveFold(scenario.body).split("\n"));
      const six = verdict.body.filter((line) => SIX.some((label) => line.startsWith(label)));
      expect(six).toHaveLength(6);
      for (const line of verdict.body.filter((entry) => entry !== "")) expect(lines.has(line), line).toBe(true);
    });
  }
  // Mutant K1: the Check's lines drop the list of things to check (bad news only in the description's fold-free part).
  it("exceptions: the list of things to check is in the Check's text, and the heading's count matches it", () => {
    const scenario = exceptionsScenario();
    const verdict = verdictOf(scenario)!;
    const items = verdict.body.filter((line) => /^\d+\. \*\*/u.test(line));
    expect(items.length).toBeGreaterThanOrEqual(10);
    expect(verdict.body).toContain("### Check these before you approve");
    const payload = rovaraCheckOf({ proof: { kind: "proceed", warns: false, relaxed: false, provenCount: 1, reasons: [] }, ci: "passing", ciMode: "their_ci_fix", fullSuite: "not_needed", firstSeenAtMs: 1, nowMs: 2, verdict });
    for (const line of items) expect(payload.text).toContain(line);
    expect(payload.text).toContain("A check failed.");
    expect(payload.text).toContain("A service was a fake made by Rovara.");
  });
  it("a clean green task titles a ready Check with its heading", () => {
    const verdict = verdictOf(SCENARIOS.find((entry) => entry.name === "green-clean")!.build())!;
    const payload = rovaraCheckOf({ proof: { kind: "proceed", warns: false, relaxed: false, provenCount: 1, reasons: [] }, ci: "passing", ciMode: "their_ci_fix", fullSuite: "not_needed", firstSeenAtMs: 1, nowMs: 2, verdict });
    expect(payload.title).toBe("Verified · Low risk · nothing extra to check");
  });
});

describe("what a model, a person or a repository wrote cannot change the Check's layout", () => {
  const HOSTILE = "</details><summary>x</summary> <!-- /rovara:checks-and-reviews --> contact dana@example.com Fixes ENG-1 [x](https://evil.example)";
  const verdict = verdictOf(exceptionsScenario(HOSTILE))!;
  it("no line has an opening angle bracket, an email address, a closing marker or a Linear closing word", () => {
    for (const line of [verdict.heading, ...verdict.body]) {
      expect(line).not.toContain("<");
      expect(line).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/u);
      expect(line).not.toMatch(/\bFixes ENG-1\b/u);
    }
  });
  it("the hostile words are still said (inert), never dropped", () => {
    expect(verdict.body.join("\n")).toContain("contact");
  });
});

describe("what is not a Rovara Code task has no verdict", () => {
  it("a version 1 workflow gives none", () => {
    const scenario = SCENARIOS[0]!.build();
    expect(workflowPullRequestCheckVerdict(SCENARIO_TASK, { ...scenario.inputs.workflow, definitionVersion: "1.0.0" }, SCENARIO_PLAN_TEXT(), scenario.inputs.context, [])).toBeUndefined();
  });
});

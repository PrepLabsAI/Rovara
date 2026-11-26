import { planQualityFinding, type E2EDisplayBaseline, type E2EDisplayScenario, type PlanQualityFinding } from "@agentx/contracts";

/**
 * T7b: what a finished grounding round (the proposed plan's must-not-change scenarios on the unchanged app) says about the plan, as plan quality findings.
 *
 * Only fixed fields leave this module: a scenario ID, the assertion kind that failed (a fixed enum) and a fixed code. What the app showed (`failedAssertion.actual`) is an observed
 * value that can hold seed data, so it never enters a finding, a sentence, a log line or Slack. A row that could not be decided (UNKNOWN) is a note for the card, not a finding.
 */
export type GroundingFindings = Readonly<{
  /** One `scenario-base-mismatch` per scenario that FAILED on the unchanged app. Informational: it never gates, and the planner may be asked to correct it once. */
  findings: PlanQualityFinding[];
  /** Scenarios that ran but could not be decided either way. */
  undecidedScenarioIds: string[];
  /** Scenarios that behaved as the plan says. */
  passedScenarioIds: string[];
}>;

export function groundingFindingsOf(results: E2EDisplayBaseline): GroundingFindings {
  const rows: readonly E2EDisplayScenario[] = results.scenarios;
  const findings = rows.filter((row) => row.status === "FAILED").map((row) => planQualityFinding({
    code: "scenario-base-mismatch", scenarioIds: [row.scenarioId],
    ...(row.failedAssertion === undefined ? {} : { steps: [{ scenarioId: row.scenarioId, assertionKind: row.failedAssertion.kind }] }),
  }));
  return { findings, undecidedScenarioIds: rows.filter((row) => row.status === "UNKNOWN").map((row) => row.scenarioId),
    passedScenarioIds: rows.filter((row) => row.status === "PASSED").map((row) => row.scenarioId) };
}



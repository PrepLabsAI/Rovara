import { planQualityFinding, type E2EDisplayBaseline, type E2EDisplayScenario, type PlanDocument, type PlanQualityFinding } from "@agentx/contracts";

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

/** The most characters of the plan's own expected value a card shows. */
export const GROUNDING_EXPECTED_MAX_CHARS = 80;

/** Text from the plan, made safe to show: control characters and markup-significant characters removed, spaces collapsed, cut to the bound. */
export function escapedPlanText(text: string): string {
  const clean = text.replace(/\p{Cc}+/gu, " ").replace(/[<>&`*_~|\\]/g, "").replace(/\s+/g, " ").trim();
  return clean.length <= GROUNDING_EXPECTED_MAX_CHARS ? clean : `${clean.slice(0, GROUNDING_EXPECTED_MAX_CHARS - 1)}…`;
}

/**
 * What the plan itself expects for a scenario's assertion of the given kind, in the plan's own words (escaped, at most 80 characters), or undefined. This reads the plan document
 * and never the evidence: the expected value a card shows next to a mismatch is what the planner wrote, not what the app displayed.
 */
export function plannedExpectation(plan: Pick<PlanDocument, "e2e">, scenarioId: string, assertionKind: string): string | undefined {
  const intent = plan.e2e;
  if (intent === undefined || intent.schemaVersion !== 2) return undefined;
  const assertion = intent.scenarios.find((scenario) => scenario.scenarioId === scenarioId)?.assertions.find((item) => item.kind === assertionKind);
  if (assertion === undefined) return undefined;
  switch (assertion.kind) {
    case "text": return escapedPlanText(assertion.equals);
    case "visible": return assertion.equals ? "visible" : "not visible";
    case "http-status": return String(assertion.equals);
    case "csv": return `${assertion.columns.length} columns, ${assertion.rows.length} rows`;
    case "file": return escapedPlanText(assertion.relativePath);
    case "json": case "state": return escapedPlanText(JSON.stringify(assertion.equals) ?? "");
  }
}

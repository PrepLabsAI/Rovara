import type { E2ESharedView } from "../../contracts/src/e2e-view.js";

const LIST_LIMIT = 8;
const SCOPE_NOTE = "E2E projection status describes only the supplied DTO scope; it does not establish app, native, live, browser, auth, or internal-callable completion.";

export interface E2ESlackBlock {
  type: "section" | "context";
  text: { type: "mrkdwn"; text: string };
}

/** Renders a bounded, read-only Slack summary. Proposals are labels; this adapter executes nothing. */
export function renderE2ESlackBlocks(view: E2ESharedView): E2ESlackBlock[] {
  const { setup, e2e } = view;
  const lines = [
    `*E2E checks: ${e2e.status} — ${slackBounded(e2e.label, 900)}*`,
    `Groups received: ${e2e.receivedGroups}/${e2e.expectedGroups} · Cases executed: ${e2e.executedCases}`,
    `Criteria qualified: ${e2e.qualifiedCriteria}/${e2e.requiredCriteria} · Required unavailable: ${e2e.unavailableCriteria} · Optional unavailable: ${e2e.optionalUnavailableCriteria}`,
    `Setup: ${setup.status}`,
    `Selected targets: ${slackList(setup.selectedTargetIds)}`,
    `Blocking inputs: ${slackList(setup.blockingInputIds)}`,
    `Mock-substitutable inputs: ${slackList(setup.mockSubstitutableInputIds)}`,
    `Declared mock IDs: ${slackList(e2e.mockedComponentIds)}`,
    `Observed mock consumption IDs (${e2e.observedMockedComponentIds.length}): ${slackList(e2e.observedMockedComponentIds)}`,
    `Required unexercised criteria: ${slackList(e2e.requiredUnexercisedCriteriaIds)}`,
    `Unexercised behaviors: ${slackList(e2e.unexercisedBehaviors)}`,
    `Current plan digest: ${slackBounded(e2e.executionPlanDigest ?? "unavailable", 900)}`,
    `Policy: ${e2e.policyPresence} · Phase: ${slackBounded(e2e.workflowPhase ?? "unknown", 500)}`,
    `Owner action proposals (read-only): ${slackList(view.actions)}`,
  ];
  return [
    ...lines.map((text) => ({ type: "section" as const, text: { type: "mrkdwn" as const, text } })),
    { type: "context", text: { type: "mrkdwn", text: slackBounded(SCOPE_NOTE, 900) } },
  ];
}

/** Renders the same bounded facts for a page without adding controls or executable actions. */
export function renderE2EPageHtml(view: E2ESharedView): string {
  const { setup, e2e } = view;
  const rows: Array<[string, string]> = [
    ["Status", `${e2e.status} — ${e2e.label}`],
    ["Groups received", `${e2e.receivedGroups}/${e2e.expectedGroups}`],
    ["Cases executed", String(e2e.executedCases)],
    ["Criteria qualified", `${e2e.qualifiedCriteria}/${e2e.requiredCriteria}`],
    ["Required unavailable", String(e2e.unavailableCriteria)],
    ["Optional unavailable", String(e2e.optionalUnavailableCriteria)],
    ["Setup", setup.status],
    ["Selected targets", list(setup.selectedTargetIds)],
    ["Blocking inputs", list(setup.blockingInputIds)],
    ["Mock-substitutable inputs", list(setup.mockSubstitutableInputIds)],
    ["Declared mock IDs", list(e2e.mockedComponentIds)],
    [`Observed mock consumption IDs (${e2e.observedMockedComponentIds.length})`, list(e2e.observedMockedComponentIds)],
    ["Required unexercised criteria", list(e2e.requiredUnexercisedCriteriaIds)],
    ["Unexercised behaviors", list(e2e.unexercisedBehaviors)],
    ["Current plan digest", e2e.executionPlanDigest ?? "unavailable"],
    ["Policy", e2e.policyPresence],
    ["Workflow phase", e2e.workflowPhase ?? "unknown"],
    ["Owner action proposals (read-only)", list(view.actions)],
  ];
  return `<section aria-labelledby="e2e-summary"><h2 id="e2e-summary">E2E checks</h2><dl>${rows.map(([label, value]) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join("")}</dl><p>${html(SCOPE_NOTE)}</p></section>`;
}

/** Keeps the complete canonical DTO available to MCP callers with an explicit scope label. */
export function renderE2EMcpProjection(view: E2ESharedView): { scope: string; view: E2ESharedView } {
  return { scope: SCOPE_NOTE, view };
}

function list(values: readonly string[]): string {
  if (values.length === 0) return "none (total 0)";
  const shown = values.slice(0, LIST_LIMIT);
  const remainder = values.length - shown.length;
  return `${shown.join(", ")}${remainder > 0 ? `, and ${remainder} more (total ${values.length})` : ` (total ${values.length})`}`;
}

function slackList(values: readonly string[]): string {
  if (values.length === 0) return "none (total 0)";
  const shown = values.slice(0, 3).map((value) => slackBounded(value, 96));
  const omitted = values.length - shown.length;
  return `total ${values.length}: ${shown.join(", ")}${omitted > 0 ? `; +${omitted} omitted (shortened)` : ""}`;
}

function slackBounded(value: string, limit: number): string {
  const suffix = "… (shortened)";
  let escaped = "";
  let shortened = false;
  for (const char of value.replace(/[\r\n]+/gu, " ")) {
    const part = char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : /[*_~`]/u.test(char) ? `\\${char}` : char;
    if (escaped.length + part.length + suffix.length > limit) { shortened = true; break; }
    escaped += part;
  }
  return shortened ? `${escaped}${suffix}` : escaped;
}

function html(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

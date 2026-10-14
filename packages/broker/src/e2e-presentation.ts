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
    `*E2E checks: ${slack(view.e2e.status)} — ${slack(e2e.label)}*`,
    `Groups received: ${e2e.receivedGroups}/${e2e.expectedGroups} · Cases executed: ${e2e.executedCases}`,
    `Criteria qualified: ${e2e.qualifiedCriteria}/${e2e.requiredCriteria} · Required unavailable: ${e2e.unavailableCriteria} · Optional unavailable: ${e2e.optionalUnavailableCriteria}`,
    `Setup: ${slack(setup.status)} · Selected targets: ${slack(list(setup.selectedTargetIds))}`,
    `Blocking inputs: ${slack(list(setup.blockingInputIds))} · Mock-substitutable: ${slack(list(setup.mockSubstitutableInputIds))}`,
    `Declared mock IDs: ${slack(list(e2e.mockedComponentIds))} · ${e2e.observedMockedComponentIds.length} observed consumption IDs: ${slack(list(e2e.observedMockedComponentIds))}`,
    `Required unexercised criteria: ${slack(list(e2e.requiredUnexercisedCriteriaIds))} · Behaviors: ${slack(list(e2e.unexercisedBehaviors))}`,
    `Current plan digest: ${slack(e2e.executionPlanDigest ?? "unavailable")} · Policy: ${e2e.policyPresence} · Phase: ${slack(e2e.workflowPhase ?? "unknown")}`,
    `Owner action proposals (read-only): ${slack(list(view.actions))}`,
  ];
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    { type: "context", text: { type: "mrkdwn", text: slack(SCOPE_NOTE) } },
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
  if (values.length === 0) return "none";
  const shown = values.slice(0, LIST_LIMIT);
  const remainder = values.length - shown.length;
  return `${shown.join(", ")}${remainder > 0 ? `, and ${remainder} more (total ${values.length})` : ` (total ${values.length})`}`;
}

function slack(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/[*_~`]/gu, "\\$&");
}

function html(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

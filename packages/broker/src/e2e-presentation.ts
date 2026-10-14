import type { E2ESharedView } from "../../contracts/src/e2e-view.js";

const LIST_LIMIT = 8;
const SCOPE_NOTE = "Portable source and mock checks are scoped evidence. Browser, native, live-service, authentication, and internal-callable behavior remain unverified unless separately qualified.";

export interface E2ESlackBlock {
  type: "section";
  text: { type: "mrkdwn"; text: string };
}

export interface E2ESlackContextBlock {
  type: "context";
  elements: Array<{ type: "mrkdwn"; text: string }>;
}

/** Renders a bounded, read-only Slack summary. Proposals are labels; this adapter executes nothing. */
export function renderE2ESlackBlocks(view: E2ESharedView): Array<E2ESlackBlock | E2ESlackContextBlock> {
  const { setup, e2e } = view;
  const lines = [
    `*E2E ${e2e.status}: ${slackBounded(e2e.label, 140)}*`,
    `Groups ${e2e.receivedGroups}/${e2e.expectedGroups} · cases ${e2e.executedCases} · criteria ${e2e.qualifiedCriteria}/${e2e.requiredCriteria}`,
    `Required unavailable ${e2e.unavailableCriteria} · optional unavailable ${e2e.optionalUnavailableCriteria} · unmet required ${e2e.requiredUnexercisedCriteriaIds.length}`,
    `Setup ${setup.status} · selected targets ${setup.selectedTargetIds.length} · blocking inputs ${setup.blockingInputIds.length} · mockable ${setup.mockSubstitutableInputIds.length}`,
    `Mocks ${e2e.mockedComponentIds.length} declared · ${e2e.observedMockedComponentIds.length} independently observed · ${e2e.unexercisedBehaviors.length} unexercised`,
    `Policy ${e2e.policyPresence} · phase ${slackBounded(e2e.workflowPhase ?? "unknown", 120)} · advisory owner proposals ${view.actions.length}`,
    `Plan digest ${slackBounded(e2e.executionPlanDigest ?? "unavailable", 160)}`,
  ];
  return [
    ...lines.map((text) => ({ type: "section" as const, text: { type: "mrkdwn" as const, text } })),
    { type: "context", elements: [{ type: "mrkdwn", text: slackBounded(SCOPE_NOTE, 900) }] },
  ];
}

/** A fail-closed notifier fallback when its bounded display projection is missing or stale. */
export function renderE2EUnavailableSlackBlock(taskPageUrl?: string): E2ESlackBlock {
  const taskLink = taskPageUrl === undefined ? "Open the task for details." : `<${slackBounded(taskPageUrl, 1800)}|Open the task for details.>`;
  return { type: "section", text: { type: "mrkdwn", text: `*Required E2E status: UNKNOWN*\nManifest/results unavailable. ${taskLink}` } };
}

/** Renders a hashed notification snapshot without implying that it is current readiness. */
export function renderE2ENotifierSlackBlocks(view: E2ESharedView, capturedAt: string, taskPageUrl?: string): E2ESlackBlock[] {
  const taskLink = taskPageUrl === undefined ? "Open the task for current status." : `<${slackBounded(taskPageUrl, 1800)}|Open the task for current status.>`;
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Captured E2E observation: ${view.e2e.status}*\n${slackBounded(view.e2e.label, 140)}\nCaptured ${slackBounded(capturedAt, 40)}. Current readiness is UNKNOWN; it was not rechecked in this notification. ${taskLink}` } },
    { type: "section", text: { type: "mrkdwn", text: `Captured cases ${view.e2e.executedCases} · criteria ${view.e2e.qualifiedCriteria}/${view.e2e.requiredCriteria} · required unavailable ${view.e2e.unavailableCriteria}` } },
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
    ["Unmet or unqualified required criteria", list(e2e.requiredUnexercisedCriteriaIds)],
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

// Read-only projections shared by hosted task reads and the terminal display capture.
import { buildE2ESharedView, type DeveloperTaskView, type E2EScenarioResults, type E2ESharedView } from "@agentx/contracts";
import { renderE2ENotifierSlackBlocks, renderE2EMcpProjection, renderE2EPageHtml, renderE2EScenarioRowsHtml, renderE2EScenarioSlackBlocks, renderE2ESlackBlocks } from "../e2e-presentation.js";

export function applicationResultsPresentation(taskId: string, shared: E2ESharedView, results?: E2EScenarioResults): NonNullable<DeveloperTaskView["e2ePresentation"]> {
  const base = renderE2EPageHtml(shared);
  const candidates = results === undefined ? [] : [results, ...(results.baseline === undefined ? [] : [{ scenarios: results.scenarios }])];
  const section = candidates.map((candidate) => renderE2EScenarioRowsHtml(candidate, { artifactPath: (sha256) => `/review/${taskId}/task/api/e2e/artifacts/${sha256}` }))
    .find((html) => base.length + html.length <= 65_536) ?? "";
  return { shared, pageHtml: `${base}${section}`, slackBlocks: [...(results === undefined ? [] : renderE2EScenarioSlackBlocks(results)), ...renderE2ESlackBlocks(shared)].slice(0, 16), mcp: renderE2EMcpProjection(shared) };
}

export function unavailableApplicationView(closed = false): E2ESharedView {
  const shared = buildE2ESharedView({ plan: null, currentRound: null, results: [], setup: null, actor: "viewer" });
  if (!closed) return shared;
  return { ...shared, e2e: { ...shared.e2e, label: "Current eligibility unavailable: task closed.", workflowPhase: "closed" } };
}

/** Closed tasks expose a matched capture as history while current eligibility stays UNKNOWN. */
export function closedApplicationResults(taskId: string, history: { view: E2ESharedView; capturedAt: string; candidateDigest: string; roundId: string; scenarioResults?: E2EScenarioResults } | undefined) {
  const presentation = applicationResultsPresentation(taskId, unavailableApplicationView(true));
  if (history === undefined) return { presentation };
  const historical = applicationResultsPresentation(taskId, history.view, history.scenarioResults);
  const html = `<section><h2>Recorded historical E2E result</h2><p>Recorded ${history.view.e2e.status} at ${history.capturedAt}; this is not current eligibility.</p>${historical.pageHtml.replaceAll("e2e-summary", "e2e-historical-summary")}</section>`;
  if (presentation.pageHtml.length + html.length <= 65_536) presentation.pageHtml += html;
  presentation.slackBlocks = [{ type: "section", text: { type: "mrkdwn", text: "*Current E2E eligibility: UNKNOWN*\nTask closed. No current run counts are available." } },
    ...renderE2ENotifierSlackBlocks(history.view, history)].slice(0, 16);
  presentation.mcp.scope = `${presentation.mcp.scope} Task closed; recorded historical ${history.view.e2e.status} at ${history.capturedAt}. These counts are historical only.`.slice(0, 2_000);
  return { presentation, ...(history.scenarioResults === undefined ? {} : { scenarioResults: history.scenarioResults }) };
}

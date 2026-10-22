import type { E2EDisplayAgentNavigation, E2EDisplayBaseline, E2EDisplayScenario, E2EScenarioResults, E2ESharedView } from "../../contracts/src/e2e-view.js";
import { accountDisplayName, displayText, summarizeScenarios } from "./e2e/application-display.js";
import { E2E_OWNER_SENTENCES } from "./e2e/owner-sentences.js";

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

/**
 * A fail-closed notifier fallback when its bounded display projection is missing or stale. It states no status, so it
 * cannot be read as a verdict: before any round has started it says the tests have not run, afterwards that the results
 * could not be shown here. An unstated round is treated as started, the wording that claims nothing about the tests.
 */
export function renderE2EUnavailableSlackBlock(taskPageUrl?: string, roundStarted = true): E2ESlackBlock {
  const [words, linkText] = roundStarted
    ? ["I couldn't show the test results here.", "Open the task page for the latest status."]
    : ["Browser and API tests haven't run yet.", "Open the task page for status."];
  const taskLink = taskPageUrl === undefined ? linkText : `<${slackBounded(taskPageUrl, 1800)}|${linkText}>`;
  return { type: "section", text: { type: "mrkdwn", text: `${words} ${taskLink}` } };
}

/**
 * Renders a hashed notification snapshot without implying that it is current readiness. A snapshot that carries scenario rows (display schema v2) is a browser and API
 * round: it shows those rows, and says that it is a snapshot.
 */
export function renderE2ENotifierSlackBlocks(view: E2ESharedView, captured: { candidateDigest: string; roundId: string; capturedAt: string; scenarioResults?: E2EScenarioResults },
  taskPageUrl?: string): E2ESlackBlock[] {
  const taskLink = taskPageUrl === undefined ? "Open the task for current status." : `<${slackBounded(taskPageUrl, 1800)}|Open the task for current status.>`;
  const { e2e } = view;
  if (captured.scenarioResults !== undefined && captured.scenarioResults.scenarios.length > 0) {
    return [...renderE2EScenarioSlackBlocks(captured.scenarioResults, taskPageUrl === undefined ? {} : { taskPageUrl }),
      { type: "section", text: { type: "mrkdwn", text: `Recorded ${slackBounded(captured.capturedAt, 80)} for candidate ${slackBounded(captured.candidateDigest.slice(0, 12), 12)}; this is a snapshot, not a recheck.` } }];
  }
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Captured portable source/mock observations: ${e2e.status}*\n${slackBounded(e2e.label, 140)}\nCandidate ${slackBounded(captured.candidateDigest, 128)} · round ${slackBounded(captured.roundId, 80)} · captured ${slackBounded(captured.capturedAt, 80)}. Current readiness is UNKNOWN; it was not rechecked in this notification. ${taskLink}` } },
    { type: "section", text: { type: "mrkdwn", text: `Captured groups ${e2e.receivedGroups}/${e2e.expectedGroups} · cases ${e2e.executedCases} · criteria ${e2e.qualifiedCriteria}/${e2e.requiredCriteria} · required unavailable ${e2e.unavailableCriteria} · unmet required ${slackBounded(e2e.requiredUnexercisedCriteriaIds.join(", ") || "none", 300)}` } },
    { type: "section", text: { type: "mrkdwn", text: `Mocks ${e2e.mockedComponentIds.length} declared · ${e2e.observedMockedComponentIds.length} observed · unexercised behaviors ${slackBounded(e2e.unexercisedBehaviors.join(", ") || "none", 300)}. ${slackBounded(SCOPE_NOTE, 900)}` } },
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

// ---------------------------------------------------------------------------------------------
// M1.3 Task 3.7: the per-scenario results of a browser and API round, on the task page and in Slack
// ---------------------------------------------------------------------------------------------

/** One Slack message part stays well inside Slack's 3000-character limit for a section's text. */
const SLACK_RESULTS_MAX_CHARS = 3000;
const BASELINE_UNAVAILABLE = "Couldn't run the checks on the unchanged code.";
/** The most skipped AI-navigated titles a page or Slack message prints. */
const SKIPPED_TITLES_LIMIT = 12;

/** `Browser and API checks: 4 passed, 1 failed, 0 incomplete`. */
export function e2eScenarioSummary(rows: readonly Pick<E2EDisplayScenario, "status">[]): string {
  const counts = summarizeScenarios(rows);
  return `Browser and API checks: ${counts.passed} passed, ${counts.failed} failed, ${counts.incomplete} incomplete`;
}

/** The badge for a mocked origin: its service name from the origin reference (`inventory-v1` is "Inventory service mocked"). */
export function e2eMockedBadge(originRef: string): string {
  const name = displayText(originRef.replace(/-v\d+$/u, "").replace(/[-_]+/gu, " "), 60);
  const words = name === "" ? "external" : name;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} service mocked`;
}

/** The badge of an AI-navigated row: what the model clicked and which check decided (`E2E_OWNER_SENTENCES.badge`). The names are scrubbed again, because a stored row is not trusted to be clean. */
export function e2eAgentBadge(navigation: E2EDisplayAgentNavigation): string {
  const acted = navigation.steps.flatMap((step) => step.actedOn.map((node) => ({ did: node.did, name: displayText(node.name, 60) })).filter((node) => node.name !== ""));
  return E2E_OWNER_SENTENCES.badge({ acted, decidedBy: navigation.decidedBy ?? [] });
}

/** The one Slack line for AI navigation across a round's rows, or undefined when no row has a navigation block. */
export function e2eAgentSlackLine(rows: readonly E2EDisplayScenario[]): string | undefined {
  const navigated = rows.flatMap((row) => (row.agentNavigation === undefined ? [] : [row.agentNavigation]));
  if (navigated.length === 0) return undefined;
  return E2E_OWNER_SENTENCES.slackLine({ steps: navigated.reduce((total, item) => total + item.steps.length, 0), modelCalls: navigated.reduce((total, item) => total + item.modelCalls, 0) });
}

/** The one-line sentence of a row, from fields the schema bounds; scrubbed again here because a stored row is not trusted to be clean. */
function rowSentence(row: E2EDisplayScenario): string {
  const title = displayText(row.title, 120);
  const reason = row.reason === undefined ? "" : displayText(row.reason, 300);
  const word = row.status === "PASSED" ? "passed" : row.status === "FAILED" ? "failed" : "incomplete";
  return `${title} — ${word}${reason === "" ? "" : `: ${reason}`} (${displayText(accountDisplayName(row.accountLabel), 60)})`;
}

/** What the unchanged code did, in a sentence for the page and Slack. Information only: it never says anything about the change itself. */
function baselineSentence(baseline: E2EDisplayBaseline): string {
  if (baseline.status === "UNAVAILABLE") return baseline.reason === "agent-steps-only" ? E2E_OWNER_SENTENCES.baseline.agentStepsOnly : BASELINE_UNAVAILABLE;
  const counts = summarizeScenarios(baseline.scenarios);
  const total = baseline.scenarios.length;
  if (baseline.status === "FAILED") return `Before the change: ${counts.failed} of ${total} failed, as expected for new behaviour.`;
  if (baseline.status === "PASSED") return `Before the change: all ${total} passed.`;
  return `Before the change: ${counts.incomplete} of ${total} could not be checked.`;
}

/** The AI-navigated scenarios a baseline that ran left out: the count in words and their titles, never rows. Nothing for a baseline that skipped none. */
function skippedAiScenarios(baseline: E2EDisplayBaseline): { sentence: string; titles: string[]; more: string | undefined } | undefined {
  const skipped = baseline.skippedAiScenarios ?? [];
  if (baseline.status === "UNAVAILABLE" || skipped.length === 0) return undefined;
  const titles = skipped.map((item) => displayText(item.title, 120)).filter((title) => title !== "");
  const shown = titles.slice(0, SKIPPED_TITLES_LIMIT);
  // "and N more" is the full skipped count less the titles shown: a title that scrubs to nothing is still a skipped check, so it counts here and the number agrees with the sentence.
  return { sentence: E2E_OWNER_SENTENCES.baseline.skipped(skipped.length), titles: shown,
    more: skipped.length > shown.length ? E2E_OWNER_SENTENCES.baseline.skippedMore(skipped.length - shown.length) : undefined };
}

const originsOf = (rows: readonly E2EDisplayScenario[]) => [...new Set(rows.flatMap((row) => row.mockedOrigins.map((origin) => displayText(origin, 200))).filter((origin) => origin !== ""))].sort();

/**
 * The text-only Slack summary of a browser and API round: the counts, the first failed row (else the first incomplete one), what was mocked, what the unchanged code did
 * and a link to the task page, in at most 3000 characters. No image is uploaded: candidate-app pixels stay on the page behind the session (owner decision D3).
 */
export function renderE2EScenarioSlackBlocks(results: E2EScenarioResults, options: { taskPageUrl?: string } = {}): E2ESlackBlock[] {
  const rows = results.scenarios;
  const lines = [e2eScenarioSummary(rows)];
  const navigation = e2eAgentSlackLine(rows);
  if (navigation !== undefined) lines.push(slackBounded(navigation, 200));
  const first = rows.find((row) => row.status === "FAILED") ?? rows.find((row) => row.status === "UNKNOWN");
  if (first !== undefined) lines.push(slackBounded(rowSentence(first), 600));
  const origins = originsOf(rows);
  if (origins.length > 0) lines.push(slackBounded(`Mocked: ${origins.join(", ")}`, 500));
  if (results.baseline !== undefined) {
    lines.push(slackBounded(baselineSentence(results.baseline), 200));
    const skipped = skippedAiScenarios(results.baseline);
    if (skipped !== undefined) lines.push(slackBounded(skipped.sentence, 200), slackSkippedList(skipped.titles, skipped.more));
  }
  if (options.taskPageUrl !== undefined) lines.push(`<${slackBounded(options.taskPageUrl, 1500)}|Open the task page>`);
  return [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n").slice(0, SLACK_RESULTS_MAX_CHARS) } }];
}

/** The Slack list of skipped checks: the titles are cut to fit 400 characters, the "and N more" tail never is. */
function slackSkippedList(titles: readonly string[], more: string | undefined): string {
  const tail = more === undefined ? "" : `${titles.length === 0 ? " " : ", "}${more}`;
  return `${slackBounded(`${E2E_OWNER_SENTENCES.baseline.skippedListLead} ${titles.join(", ")}`, 400 - tail.length)}${tail}`;
}

/** The skipped AI-navigated checks of a baseline as a sentence and a list of titles: not a table, so none of them can read as a result row. */
function skippedAiHtml(baseline: E2EDisplayBaseline): string {
  const skipped = skippedAiScenarios(baseline);
  if (skipped === undefined) return "";
  return `<p>${html(skipped.sentence)}</p><p class="muted">${html(E2E_OWNER_SENTENCES.baseline.skippedListLead)}</p><ul class="e2e-skipped">${[...skipped.titles, ...(skipped.more === undefined ? [] : [skipped.more])].map((title) => `<li>${html(title)}</li>`).join("")}</ul>`;
}

function rowsTable(rows: readonly E2EDisplayScenario[], rowAttribute: string, artifactPath: (sha256: string) => string): string {
  const body = rows.map((row) => {
    const reason = row.reason === undefined ? "" : html(displayText(row.reason, 300));
    const badges = row.mockedOrigins.map((origin) => `<span class="tag">${html(e2eMockedBadge(origin))}</span>`).join(" ");
    const navigated = row.agentNavigation === undefined ? "" : `<span class="tag">${html(e2eAgentBadge(row.agentNavigation))}</span>`;
    const shot = row.screenshotRef === undefined ? "" : `<a href="${html(artifactPath(row.screenshotRef.sha256))}">View screenshot</a>`;
    const details = [reason, navigated, badges, shot].filter((part) => part !== "").join(" ");
    const status = row.status === "PASSED" ? "Passed" : row.status === "FAILED" ? "Failed" : "Incomplete";
    return `<tr ${rowAttribute}="${html(displayText(row.scenarioId, 120))}" data-status="${row.status}"><td>${html(displayText(row.title, 120))} <span class="muted">(${row.kind === "web" ? "Browser" : "API"})</span></td>`
      + `<td>${status}</td><td>${html(displayText(accountDisplayName(row.accountLabel), 60))}</td><td>${details}</td></tr>`;
  }).join("");
  return `<table class="e2e-rows"><thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Account</th><th scope="col">Details</th></tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * The task page's section of the per-scenario results: a row for each scenario (status, account, what failed, a "<service> mocked" badge, a link to the screenshot) and, apart,
 * what the unchanged code did. A screenshot is a link to the page's API, never an inline image. Empty when there is nothing to show.
 */
export function renderE2EScenarioRowsHtml(results: E2EScenarioResults, options: { artifactPath: (sha256: string) => string }): string {
  if (results.scenarios.length === 0 && results.baseline === undefined) return "";
  const baseline = results.baseline;
  const baselineHtml = baseline === undefined ? ""
    : `<h3>Before the change</h3><p>${html(baselineSentence(baseline))}</p>`
      + (baseline.status === "UNAVAILABLE" ? "" : `<p class="muted">This ran on the unchanged code, for information only. It does not decide anything about this change.</p>${skippedAiHtml(baseline)}${rowsTable(baseline.scenarios, "data-e2e-baseline-row", options.artifactPath)}`);
  return `<section id="e2e-results" aria-label="Browser and API results"><h2>Browser and API results</h2>`
    + (results.scenarios.length === 0 ? "" : `<p>${html(e2eScenarioSummary(results.scenarios))}</p>${rowsTable(results.scenarios, "data-e2e-row", options.artifactPath)}`)
    + `${baselineHtml}</section>`;
}

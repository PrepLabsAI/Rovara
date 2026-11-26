// RD-2b1: the checks of one task as the new task page's Checks tab reads them (`GET /v1/dev/tasks/{taskId}/checks`, row `tasks.checks`, shape `TaskChecksReadSchema` in packages/code-api). A pure join of what the core already stores:
// the workflow snapshot (the checks the policy selected, the recorded results for the current code, the reviews, the accepted findings), the plan the owner APPROVED (which claim each check proves: `checks.proves`, and each
// end-to-end scenario's `scenarioProves`; no approved plan, no claims), and the evidence pack kept for exactly the current code (before and after, flaky, known failing, the failing tests with their likely cause, the security scan,
// what was not tested) with each artifact as a link (`evidenceViewOf`). It reads nothing itself and does not depend on the testing switch (`ROVARA_VERIFICATION_RESULTS`): the four-result view is not used.
//
// Nothing is invented and nothing reads better than the facts. A row's state is derived from stored facts only (see `rowStateOf`); two facts that disagree read "Couldn't verify", never "Passed"; a fact that is not stored is left out
// (the page reads a missing member as "Unknown"). Every text that came from a repository, a worker or a model goes through `words` (control and direction characters removed, then redacted, one line, made inert, cut); the words the page
// shows for a state, a scenario, a review and a missing part are fixed here (`CHECKS_WORDS`). Counts and lists are bounded. Anything that is source code or about source code (failing test names and causes, review findings' files and text,
// the security scan's items, the output and screenshot links) is shown only when `codeDetails` says the reader may read code.
import {
  FAILURE_CAUSES_LISTED_MAX, FailureCausesSchema, blockingFindings, failureCauseWords, findingAccepted, findingBlocks, notChangingReference, workflowSelectedChecks,
  type EvidencePack, type EvidenceView, type PlanDocument, type WorkflowReviewReport, type WorkflowSnapshot,
} from "@agentx/contracts";
import { proofWords, reviewDidNotFinish } from "../../core-host/app/proof-report.js";

/** `faked`: a Rovara-made fake answered an outside call of the check, so it is never change proof (DEC 234); it is not shown as Passed. */
export const CHECK_STATES = ["not_run", "running", "passed", "flaky", "failed", "unverified", "out_of_date", "known_failing", "faked"] as const;
export type CheckState = (typeof CHECK_STATES)[number];
/** `partial`: the reviewer saw only part of the diff. `findings_accepted`: every blocking finding was accepted by the owner. */
export type ReviewState = "not_run" | "running" | "passed" | "partial" | "findings" | "findings_accepted" | "unfinished";

/** The most rows, claims, links and lines one answer carries (the stored sources are bounded too; these keep the answer small whatever they hold). */
export const CHECKS_VIEW_LIMITS = { rows: 100, acceptance: 60, screenshots: 12, notTested: 20, notes: 5, reviewFindings: 20, scanItems: 20, checksPerClaim: 20 } as const;

/** Whether Code serves the files the links name (`/v1/app/tasks/{taskId}/evidence/{sha256}`, RD-2d, task-evidence-file-routes.ts). It does: a link carries its address. Were the route ever unmounted, setting this false makes a link say "Not available yet" and carry no address. */
export const EVIDENCE_FILES_SERVED = true;

/** The fixed words of this read (rows, reviews and missing parts); a surface shows them as they are. */
export const CHECKS_WORDS = {
  planUnreadable: "Which claim each check proves could not be read.",
  planUnapproved: "The plan is not approved yet, so which claim each check proves is not shown.",
  planNotStructured: "The acceptance list is not available for this plan.",
  evidenceUnreadable: "The recorded evidence for these checks could not be read.",
  reviewOnly: "No automated check applies to this change.",
  fileNotYet: "Not available yet",
  viewFailed: "The checks could not be shown.",
  wholeRun: "Result is for the whole end-to-end run",
} as const;
export const PLAN_UNREADABLE_WORDS = CHECKS_WORDS.planUnreadable;
export const REVIEW_ONLY_WORDS = CHECKS_WORDS.reviewOnly;

/** The end-to-end result is recorded as one aggregate check (`E2E_PROJECT_CHECK_ID`); its scenarios are rows of their own. */
const E2E_AGGREGATE_ID = "project-e2e";
const E2E_AGGREGATE_LABEL = "End-to-end checks";

export interface CheckLinkView { kind: string; id?: string; href?: string; label?: string }
export interface CheckRowView {
  id: string; label: string; kind: string; state: CheckState; proves: string[]; what?: string; before?: string; after?: string;
  ranOn?: { commit?: string; at?: string };
  failures?: Array<{ test: string; cause?: string }>; failuresNotListed?: number;
  output?: CheckLinkView; screenshots?: CheckLinkView[]; retention?: "kept" | "expired" | "withheld";
}
export interface ReviewRowView { role: "code" | "security"; state: ReviewState; findings: Array<{ file?: string; line?: number; severity?: string; text?: string; accepted: boolean }> }
export interface ChecksView {
  taskId: string;
  candidateDigest?: string;
  ranOn?: { commit?: string; at?: string };
  acceptance: Array<{ claimId: string; text: string; checkIds: string[] }>;
  rows: CheckRowView[];
  reviews: ReviewRowView[];
  securityScan?: { tool: string; counts: Record<string, number>; items: Array<{ ruleId: string; severity: string; path: string; line: number; message: string }> };
  /** What the task did not test (the pack's own list), each a thing a person may print as "not tested". */
  notTested: string[];
  /** Served as an additive member that the `tasks.checks` row does not declare yet (the schema is tolerant: a client reads unknown members as they are; declaring it in the row is a Code API 1.6 change, 1.5 being on mainline). Notices about this read itself, never untested items: the checks could not be shown, a part could not be used (the plan, the recorded evidence), or no automated check applies (the policy's own words). */
  notes: string[];
}

/** Why there is no plan to read claims from: no version is approved yet, the approved one has no structured form (written before structured plans), or it could not be read. A task with no plan document at all has no note. */
export type PlanNote = "unapproved" | "markdown" | "unreadable";
const PLAN_NOTE_WORDS: Record<PlanNote, string> = { unapproved: CHECKS_WORDS.planUnapproved, markdown: CHECKS_WORDS.planNotStructured, unreadable: CHECKS_WORDS.planUnreadable };

export interface ChecksViewInput {
  taskId: string;
  workflow: WorkflowSnapshot | undefined;
  /** The plan version the owner approved, or undefined (never a draft). */
  plan: PlanDocument | undefined;
  planNote?: PlanNote | undefined;
  /** The pack kept for the current code, or undefined. A pack for other code is never used (checked again here). */
  pack: EvidencePack | undefined;
  /** The pack exists in the store but could not be read (a fault, or a version this build does not read): not the same as none kept. */
  packUnreadable?: boolean | undefined;
  /** The pack with each artifact as a link (`evidenceViewOf`), or undefined (no pack, or a view that did not fit its schema: then each row that has a file says it is withheld). */
  links: EvidenceView | undefined;
  /** Whether the reader may read code and facts about code (see the header). Today the host says yes to anyone who passed the task read rule. */
  codeDetails: boolean;
  /** Whether the links carry an address (`EVIDENCE_FILES_SERVED`). */
  evidenceLinks: boolean;
}

/** Control characters (NUL, ESC, C1 and the like) and format characters (direction marks and isolates, zero-width) are removed, whitespace is one space: before anything is redacted, so a secret cannot hide behind one. */
export const plainText = (text: string): string => text.replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "");
const words = (text: string, max = 200): string => proofWords(plainText(text), max);
const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A list a stored record keeps under an id of its own (a check or scenario id may be any word, `constructor` included): only an own key counts. */
const ownList = (record: Readonly<Record<string, readonly string[]>> | undefined, key: string): string[] => (record !== undefined && Object.hasOwn(record, key) ? [...(record[key] ?? [])] : []);
const FAILED_AFTER: ReadonlySet<string> = new Set(["failed", "timed_out"]);
const OUTCOMES: ReadonlySet<string> = new Set(["passed", "failed", "timed_out"]);

type PackCheck = EvidencePack["checks"][number];

// ---- what each row says about the code it ran on

interface Verified {
  /** `current`: the recorded results are for the code the workflow holds now. `stale`: they are for other code. `none`: nothing recorded. */
  kind: "current" | "stale" | "none";
  at?: string | undefined;
  commit?: string | undefined;
}

/** The commit is named only when the candidate is one repository's: with several, one commit would read as the run's (the digest stays the identity). */
function verifiedOf(workflow: WorkflowSnapshot): Verified {
  const verification = workflow.verification;
  if (verification === undefined) return { kind: "none" };
  const digest = workflow.candidate?.digest;
  if (digest === undefined || verification.candidateDigest !== digest) return { kind: "stale", at: verification.recordedAt };
  const repositories = workflow.candidate?.repositories ?? [];
  return { kind: "current", at: verification.recordedAt, commit: repositories.length === 1 ? repositories[0]?.commitSha : undefined };
}

const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : (Object.fromEntries([[key, value]]) as { [P in K]?: V }));
const mapped = <T, U>(value: T | undefined, map: (value: T) => U): U | undefined => (value === undefined ? undefined : map(value));
const nonEmpty = <T>(list: readonly T[]): T[] | undefined => (list.length === 0 ? undefined : [...list]);
const outcomeOf = (outcome: string | undefined): string | undefined => (outcome !== undefined && OUTCOMES.has(outcome) ? outcome : undefined);

const ranOnOf = (verified: Verified): { commit?: string; at?: string } | undefined =>
  verified.kind === "none" ? undefined : { ...opt("commit", verified.commit), ...opt("at", verified.at) };

/** A test that failed in this check and then passed on the round's one rerun. */
const flakyIn = (check: PackCheck | undefined): boolean => (check?.tests?.flakyOnRerunCount ?? 0) > 0;

type VerificationResult = NonNullable<WorkflowSnapshot["verification"]>["results"][number];
const passedState = (packed: PackCheck | undefined): CheckState => (flakyIn(packed) ? "flaky" : "passed");
const failedState = (packed: PackCheck | undefined): CheckState => (packed?.class === "already_failing" ? "known_failing" : "failed");
const couldNotRun = (result: VerificationResult): boolean => result.status === "UNKNOWN" || result.broken === true || result.neverStarted === true || result.programNotFound === true;

/** A recorded PASS: the kept check must not say it failed (two facts that disagree are "Couldn't verify"), and a Rovara-made fake never makes a pass. */
function passedResult(result: VerificationResult, packed: PackCheck | undefined): CheckState {
  if (packed !== undefined && FAILED_AFTER.has(packed.after)) return "unverified";
  return result.madeByRovara === true ? "faked" : passedState(packed);
}

function stateOfResult(result: VerificationResult, verified: Verified, running: boolean, packed: PackCheck | undefined): CheckState {
  if (verified.kind !== "current") return running ? "running" : "out_of_date";
  if (couldNotRun(result)) return "unverified";
  return result.status === "PASS" ? passedResult(result, packed) : failedState(packed);
}

/** What a kept check says when no result was recorded for it; undefined when it says nothing (not run). */
function stateOfPack(packed: PackCheck): CheckState | undefined {
  if (packed.after === "passed") return passedState(packed);
  if (FAILED_AFTER.has(packed.after)) return failedState(packed);
  return packed.after === "unknown" ? "unverified" : undefined;
}

/**
 * The state of one check for the code the task holds NOW. Out of date: the recorded result is for other code (and no new run is in flight). Couldn't verify (`unverified`): the result is unknown, or the check could not run (its program
 * is missing, its command is broken, its process never started), or the recorded result and the kept check disagree: the code is not shown as passing. Faked: a Rovara-made fake answered. Known failing: it failed, and the kept pack says
 * it already failed on the unchanged code (`already_failing`). Flaky: it passed after a rerun of a failing test. Not run yet / Running: no result for it, by the step the task is at.
 */
export function rowStateOf(workflow: WorkflowSnapshot, verified: Verified, checkId: string, packed: PackCheck | undefined): CheckState {
  const running = workflow.stage === "VERIFY" && workflow.state === "RUNNING";
  const result = workflow.verification?.results.find((entry) => entry.checkId === checkId);
  if (result !== undefined) return stateOfResult(result, verified, running, packed);
  return (packed === undefined ? undefined : stateOfPack(packed)) ?? (running ? "running" : "not_run");
}

// ---- the plan: which claim each check proves, and the end-to-end scenarios

interface Scenario { id: string; proves: string[]; what: string }

/** What a scenario does, in fixed words made from the kinds of its steps and the count of its assertions (the scenario's own text is the model's and is never shown). */
export function scenarioWords(steps: readonly unknown[], assertions: number): string {
  const count = (kinds: readonly string[]): number => steps.filter((step) => isRecord(step) && typeof step["kind"] === "string" && kinds.includes(step["kind"])).length;
  const pages = count(["navigate", "deep-link", "launch-app", "restart-app"]);
  const clicks = count(["click", "tap"]);
  const fields = count(["fill"]);
  const requests = count(["request", "invoke-contract", "inspect-contract"]);
  const agent = count(["agent"]);
  const other = steps.length - pages - clicks - fields - requests - agent;
  const parts = [
    ...(pages > 0 ? [`opens ${plural(pages, "page", "pages")}`] : []), ...(clicks > 0 ? [`clicks ${plural(clicks, "time", "times")}`] : []), ...(fields > 0 ? [`fills ${plural(fields, "field", "fields")}`] : []),
    ...(requests > 0 ? [`sends ${plural(requests, "request", "requests")}`] : []), ...(agent > 0 ? ["lets an AI agent act toward a goal"] : []), ...(other > 0 ? [`does ${plural(other, "other action", "other actions")}`] : []),
  ];
  const checks = assertions > 0 ? `checks ${plural(assertions, "result", "results")}` : "";
  const text = [...parts, ...(checks === "" ? [] : [parts.length === 0 ? checks : `then ${checks}`])].join(", ");
  return text === "" ? "Runs one scenario" : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

function scenariosOf(plan: PlanDocument | undefined): Scenario[] {
  const intent: unknown = plan?.e2e;
  const listed = isRecord(intent) && Array.isArray(intent["scenarios"]) ? intent["scenarios"] as unknown[] : [];
  const seen = new Set<string>();
  const out: Scenario[] = [];
  for (const scenario of listed) {
    if (!isRecord(scenario) || typeof scenario["scenarioId"] !== "string" || seen.has(scenario["scenarioId"])) continue;
    seen.add(scenario["scenarioId"]);
    const steps = Array.isArray(scenario["steps"]) ? scenario["steps"] as unknown[] : [];
    const assertions = Array.isArray(scenario["assertions"]) ? scenario["assertions"].length : 0;
    out.push({ id: scenario["scenarioId"], proves: ownList(plan?.scenarioProves, scenario["scenarioId"]), what: scenarioWords(steps, assertions) });
  }
  return out;
}

// ---- links

type PackCheckLink = EvidenceView["checks"][number]["outputTailRef"];
type PackLink = NonNullable<PackCheckLink>;

/** A link as the page reads it. A file that is available has an address only when Code serves the files (`evidenceLinks`); until then it says so in fixed words. */
function linkOf(kind: string, link: PackLink, label: string, served: boolean): CheckLinkView {
  const open = link.state === "available";
  return { kind, id: link.sha256, label: open && !served ? CHECKS_WORDS.fileNotYet : label, ...(open && served && link.href !== undefined ? { href: link.href } : {}) };
}
const retentionOf = (links: readonly PackLink[]): CheckRowView["retention"] =>
  links.length === 0 ? undefined : links.some((link) => link.state === "expired") ? "expired" : links.some((link) => link.state === "withheld") ? "withheld" : "kept";

// ---- failing tests

interface Budget { left: number }

/** The failing tests of one failed check, each with its likely cause (the pack's `failureCauses`; a test with no cause found says "unknown (...)" by the cause's own words), `FAILURE_CAUSES_LISTED_MAX` in all rows together. */
function failuresOf(check: PackCheck | undefined, budget: Budget): { failures: Array<{ test: string; cause?: string }>; notListed: number } | undefined {
  if (check === undefined || check.after !== "failed") return undefined;
  const causes = FailureCausesSchema.safeParse(check.tests?.failureCauses);
  if (causes.success && causes.data.length > 0) {
    const shown = causes.data.slice(0, Math.max(0, budget.left));
    budget.left -= shown.length;
    return { failures: shown.map((row) => ({ test: words(row.testId, 100), cause: failureCauseWords(row.cause, (text, max) => words(text, max)) })), notListed: causes.data.length - shown.length };
  }
  // No cause was found for this check (the worker answers every failing test of a check, or none): the failing tests' names are still the pack's own facts.
  const names = (check.tests?.names ?? []).filter((entry) => entry.status === "failed" || entry.status === "errored");
  if (names.length === 0) return undefined;
  const shown = names.slice(0, Math.max(0, budget.left));
  budget.left -= shown.length;
  return { failures: shown.map((entry) => ({ test: words(entry.name, 100) })), notListed: names.length - shown.length };
}

// ---- reviews

const ROLES = [["CRITIC", "code"], ["SECURITY", "security"]] as const;

/** Findings that block and are all accepted read "findings accepted"; a review that saw only part of the diff and found nothing reads "partial"; a failure marker beats a nominal pass. */
function reviewStateOf(report: WorkflowReviewReport, accepted: WorkflowSnapshot["acceptedFindings"]): ReviewState {
  if (reviewDidNotFinish(report)) return "unfinished";
  if (report.status === "FINDINGS") return blockingFindings(report, accepted).length > 0 ? "findings" : "findings_accepted";
  if (report.status === "PASS") return report.partialDiff === true ? "partial" : "passed";
  return "unfinished";
}

function reviewRowOf(workflow: WorkflowSnapshot, role: "CRITIC" | "SECURITY", name: "code" | "security", codeDetails: boolean): ReviewRowView {
  const digest = workflow.candidate?.digest;
  const report: WorkflowReviewReport | undefined = digest === undefined ? undefined : (workflow.reviews ?? []).find((entry) => entry.role === role && entry.candidateDigest === digest);
  if (report === undefined) return { role: name, state: workflow.stage === "REVIEW" && workflow.state === "RUNNING" ? "running" : "not_run", findings: [] };
  // The findings that can block (the change introduced them; a security finding is never advisory); a pre-existing or advisory remark never blocks and is not a finding here.
  const findings = report.findings.filter((finding) => findingBlocks(finding, role)).slice(0, CHECKS_VIEW_LIMITS.reviewFindings).map((finding) => ({
    ...(codeDetails ? { ...opt("file", mapped(finding.file, (file) => words(file, 500))), ...opt("line", finding.line), text: words(finding.text, 600) } : {}),
    ...opt("severity", mapped(finding.severity, (severity) => severity.toLowerCase())),
    accepted: findingAccepted(finding, role, digest, workflow.acceptedFindings),
  }));
  return { role: name, state: reviewStateOf(report, workflow.acceptedFindings), findings };
}

// ---- the rows

/** The check list: what the policy selected to run (the project's required checks, the plan's proposed checks the owner kept, the optional ones chosen); before a policy exists, what the approved plan lists. */
function listedChecks(workflow: WorkflowSnapshot, plan: PlanDocument | undefined): Array<{ id: string; label: string; kind: string | undefined }> {
  if (workflow.checkPolicy !== undefined) return workflowSelectedChecks(workflow.checkPolicy).map((check) => ({ id: check.id, label: check.label, kind: check.kind }));
  return [...(plan?.checks?.alsoRun ?? []), ...(plan?.checks?.proposed ?? [])].map((check) => ({ id: check.id, label: check.label, kind: check.kind }));
}

/** The checks: those the task runs, then any that were recorded or kept but are not in the list (so a recorded failure is never hidden). */
function checksOf(workflow: WorkflowSnapshot, plan: PlanDocument | undefined, packed: ReadonlyMap<string, PackCheck>): Array<{ id: string; label: string; kind: string | undefined }> {
  const base = listedChecks(workflow, plan);
  const known = new Set(base.map((check) => check.id));
  const extras = [...new Set([...(workflow.verification?.results ?? []).map((result) => result.checkId), ...packed.keys()])].filter((id) => !known.has(id));
  return [...base, ...extras.map((id) => ({ id, label: packed.get(id)?.label ?? (id === E2E_AGGREGATE_ID ? E2E_AGGREGATE_LABEL : id), kind: packed.get(id)?.kind }))];
}

/** The plan's scenarios, then any scenario the pack has screenshots for that the plan does not list. */
function allScenarios(plan: PlanDocument | undefined, kept: EvidencePack | undefined): Scenario[] {
  const scenarios = scenariosOf(plan);
  for (const entry of kept?.browser ?? []) {
    if (!scenarios.some((scenario) => scenario.id === entry.scenarioId)) scenarios.push({ id: entry.scenarioId, proves: ownList(plan?.scenarioProves, entry.scenarioId), what: scenarioWords([], 0) });
  }
  return scenarios;
}

/** What the rows are built from. */
interface RowContext {
  workflow: WorkflowSnapshot;
  verified: Verified;
  kept: EvidencePack | undefined;
  packed: ReadonlyMap<string, PackCheck>;
  linkedChecks: ReadonlyMap<string, EvidenceView["checks"][number]>;
  links: EvidenceView | undefined;
  budget: Budget;
  codeDetails: boolean;
  evidenceLinks: boolean;
}
/** `resultId` is the check whose result and kept check a row reads; a scenario reads the end-to-end aggregate's and has only its own screenshots (`scenarioId`). */
interface RowOptions { resultId?: string; scenarioId?: string; what?: string }

const stripCount = (entry: EvidencePack["browser"][number] | undefined): number => (entry === undefined ? 0 : entry.strip.before.length + entry.strip.after.length);
const stripOf = (shots: EvidenceView["browser"][number] | undefined): PackLink[] => (shots === undefined ? [] : [...shots.strip.before, ...shots.strip.after]);
const screenshotsOf = (shots: EvidenceView["browser"][number] | undefined, served: boolean): CheckLinkView[] =>
  shots === undefined ? [] : [...shots.strip.before.map((item) => linkOf("screenshot", item, "before", served)), ...shots.strip.after.map((item) => linkOf("screenshot", item, "after", served))].slice(0, CHECKS_VIEW_LIMITS.screenshots);

interface RowLinks { output?: CheckLinkView; screenshots?: CheckLinkView[]; retention?: "kept" | "expired" | "withheld" }

/** The row's files. A row with a file but no links view (the view did not fit its schema, or the reader may not read code) says "withheld", never silence. */
function linksOfRow(context: RowContext, resultId: string, scenarioId: string | undefined): RowLinks {
  const own = scenarioId === undefined;
  const shotsPack = own ? undefined : context.kept?.browser.find((entry) => entry.scenarioId === scenarioId);
  if ((!own || context.packed.get(resultId)?.outputTailRef === undefined) && stripCount(shotsPack) === 0) return {};
  if (context.links === undefined) return { retention: "withheld" };
  const link = own ? context.linkedChecks.get(resultId)?.outputTailRef : undefined;
  const shots = own ? undefined : context.links.browser.find((entry) => entry.scenarioId === scenarioId);
  const retention = retentionOf([...(link === undefined ? [] : [link]), ...stripOf(shots)]);
  if (!context.codeDetails) return opt("retention", retention);
  return { ...opt("output", mapped(link, (item) => linkOf("output", item, "Command output", context.evidenceLinks))), ...opt("screenshots", nonEmpty(screenshotsOf(shots, context.evidenceLinks))), ...opt("retention", retention) };
}

const failuresPart = (listed: ReturnType<typeof failuresOf>): Pick<CheckRowView, "failures" | "failuresNotListed"> => ({
  ...opt("failures", listed === undefined ? undefined : nonEmpty(listed.failures)), ...opt("failuresNotListed", listed === undefined || listed.notListed === 0 ? undefined : listed.notListed),
});

function rowOf(context: RowContext, id: string, label: string, kind: string | undefined, claims: readonly string[], options: RowOptions = {}): CheckRowView {
  const resultId = options.resultId ?? id;
  const pack = context.packed.get(resultId);
  const state = rowStateOf(context.workflow, context.verified, resultId, pack);
  const own = options.scenarioId === undefined;
  // A row that has not run has no time; Out of date names the time of that run and no commit (the stale `verified` has none), never the current one.
  const ran = state === "not_run" || state === "running" ? undefined : ranOnOf(context.verified);
  return {
    id: words(id, 120), label: words(label, 200), kind: kind === undefined ? "other" : words(kind, 40), state, proves: claims.map((claim) => words(claim, 60)),
    ...opt("what", options.what), ...opt("before", own ? outcomeOf(pack?.before) : undefined), ...opt("after", own ? outcomeOf(pack?.after) : undefined), ...opt("ranOn", ran),
    ...failuresPart(own && context.codeDetails ? failuresOf(pack, context.budget) : undefined), ...linksOfRow(context, resultId, options.scenarioId),
  };
}

/** States that say how the whole end-to-end run went but not which scenario: a scenario then reads Couldn't verify, and the run's own row (with its failing lines and output) stays. */
const WHOLE_RUN_ONLY: ReadonlySet<CheckState> = new Set(["failed", "known_failing", "flaky", "faked"]);

function rowsOf(context: RowContext, checks: ReturnType<typeof checksOf>, scenarios: readonly Scenario[], proves: Readonly<Record<string, string[]>> | undefined): CheckRowView[] {
  const plain = checks.map((check) => rowOf(context, check.id, check.label, check.kind, ownList(proves, check.id)))
    // With scenarios, a passing, waiting or out-of-date aggregate is shown as its scenarios (each with the claims it proves), not twice.
    .filter((row) => row.id !== E2E_AGGREGATE_ID || scenarios.length === 0 || WHOLE_RUN_ONLY.has(row.state) || row.state === "unverified");
  // A scenario has no result of its own: it reads the aggregate round's (code and time), and has its own screenshots.
  const own = scenarios.map((scenario) => {
    const row = rowOf(context, scenario.id, scenario.id, "e2e", scenario.proves, { resultId: E2E_AGGREGATE_ID, scenarioId: scenario.id, what: scenario.what });
    return WHOLE_RUN_ONLY.has(row.state) ? { ...row, state: "unverified" as const, what: `${scenario.what}. ${CHECKS_WORDS.wholeRun}` } : row;
  });
  return [...plain, ...own].slice(0, CHECKS_VIEW_LIMITS.rows);
}

/** Which claim each check proves (the inverse of the plan's `proves`), for every claim of the plan, and the Not changing items a check proves. */
function acceptanceOf(plan: PlanDocument | undefined, rows: readonly CheckRowView[]): ChecksView["acceptance"] {
  if (plan === undefined) return [];
  const checkIdsOf = (claimId: string): string[] => rows.filter((row) => row.proves.includes(claimId)).map((row) => row.id).slice(0, CHECKS_VIEW_LIMITS.checksPerClaim);
  const entries: ChecksView["acceptance"] = [];
  const walk = (claims: PlanDocument["claims"]): void => {
    for (const claim of claims) {
      entries.push({ claimId: words(claim.id, 60), text: words(claim.text, 300), checkIds: checkIdsOf(claim.id) });
      walk(claim.children ?? []);
    }
  };
  walk(plan.claims);
  for (const id of new Set(rows.flatMap((row) => row.proves))) {
    const position = notChangingReference(id);
    const text = position === undefined ? undefined : plan.notChanging[position - 1];
    if (text !== undefined) entries.push({ claimId: id, text: words(text, 300), checkIds: checkIdsOf(id) });
  }
  return entries.slice(0, CHECKS_VIEW_LIMITS.acceptance);
}

/** The security scan the pack kept (the check of kind `security` that carries findings). Its items are facts about code: left out for a reader who may not read code (the counts stay). */
function scanOf(kept: EvidencePack | undefined, codeDetails: boolean): ChecksView["securityScan"] {
  const scan = kept?.checks.find((check) => check.kind === "security" && check.findings !== undefined)?.findings;
  if (scan === undefined) return undefined;
  const items = codeDetails ? scan.items.slice(0, CHECKS_VIEW_LIMITS.scanItems).map((item) => ({ ruleId: words(item.ruleId, 100), severity: item.severity, path: words(item.path, 500), line: item.line, message: words(item.message, 300) })) : [];
  return { tool: words(scan.tool, 60), counts: { ...scan.bySeverity }, items };
}

/** What the task did not test: the evidence pack's own list only. A notice about this read is a note (`notesOf`), never an untested item. */
function notTestedOf(kept: EvidencePack | undefined): string[] {
  return (kept?.notTested ?? []).slice(0, CHECKS_VIEW_LIMITS.notTested).map((item) => (item.text === "" ? words(item.reason, 100) : `${words(item.text, 200)}: ${words(item.reason, 100)}`));
}

/** The notices: the review-only sentence (the policy's own text when it has one), then the parts the join could not use. */
function notesOf(input: ChecksViewInput, workflow: WorkflowSnapshot, verified: Verified): string[] {
  const reviewOnly = verified.kind === "current" && workflow.verification?.reviewOnly === true;
  const reviewOnlyWords = workflow.checkPolicy?.noneReason === undefined ? CHECKS_WORDS.reviewOnly : words(workflow.checkPolicy.noneReason, 300);
  return [...(reviewOnly ? [reviewOnlyWords] : []), ...missingParts(input)].slice(0, CHECKS_VIEW_LIMITS.notes);
}

/** The parts the join could not use, in fixed words (a missing part is said, never silent). */
const missingParts = (input: ChecksViewInput): string[] => [...(input.planNote === undefined ? [] : [PLAN_NOTE_WORDS[input.planNote]]), ...(input.packUnreadable === true ? [CHECKS_WORDS.evidenceUnreadable] : [])];

/** What a surface gets when the join itself could not be made: no rows, one fixed sentence. */
export const unavailableChecksView = (taskId: string): ChecksView => ({ taskId, acceptance: [], rows: [], reviews: [], notTested: [], notes: [CHECKS_WORDS.viewFailed] });

export function checksViewOf(input: ChecksViewInput): ChecksView {
  const { taskId, workflow, plan } = input;
  if (workflow === undefined) return { taskId, acceptance: [], rows: [], reviews: [], notTested: [], notes: missingParts(input) };
  const digest = workflow.candidate?.digest;
  const verified = verifiedOf(workflow);
  const kept = input.pack !== undefined && digest !== undefined && input.pack.candidateDigest === digest ? input.pack : undefined;
  const packed = new Map((kept?.checks ?? []).map((check) => [check.checkId, check]));
  const links = input.links !== undefined && kept !== undefined && input.links.candidateDigest === kept.candidateDigest ? input.links : undefined;
  const context: RowContext = {
    workflow, verified, kept, packed, links, linkedChecks: new Map((links?.checks ?? []).map((check) => [check.checkId, check])), budget: { left: FAILURE_CAUSES_LISTED_MAX },
    codeDetails: input.codeDetails, evidenceLinks: input.evidenceLinks,
  };
  const rows = rowsOf(context, checksOf(workflow, plan, packed), allScenarios(plan, kept), plan?.checks?.proves);
  return {
    taskId, ...opt("candidateDigest", digest), ...opt("ranOn", ranOnOf(verified)), acceptance: acceptanceOf(plan, rows), rows,
    reviews: ROLES.map(([role, name]) => reviewRowOf(workflow, role, name, input.codeDetails)), ...opt("securityScan", scanOf(kept, input.codeDetails)), notTested: notTestedOf(kept), notes: notesOf(input, workflow, verified),
  };
}

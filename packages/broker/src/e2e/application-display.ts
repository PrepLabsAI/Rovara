import { createHash } from "node:crypto";
import { E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, E2EScenarioResultsSchema, E2E_DISPLAY_SCREENSHOT_MAX_BYTES, canonicalJson, redactText,
  type E2E_DISPLAY_ASSERTION_KINDS, type E2EAssertion, type E2EDisplayBaseline, type E2EDisplayScenario, type E2EScenarioResults } from "@agentx/contracts";

/**
 * M1.3 Task 3.7: the rows a browser and API round shows on the task page and in Slack.
 *
 * A row is derived from what the broker verified itself and from nothing the worker says about itself: the status is the broker's re-collected case status, the expected
 * value is the approved assertion, the actual value is the one the collector re-derived from the observation's raw bytes (and checked against the worker's report), and a
 * reason is one of a fixed set of sentences, never the worker's words. The only worker-supplied thing a row can point at is a screenshot, which is kept only if it is a
 * JPEG of exactly the size and digest the worker listed, for a case of the group, and only for a row whose status the broker found to be failed or incomplete.
 *
 * Emails are replaced and an account is shown by its profile id only. Credentials are another matter, and this module only does part of it: the free text is run through the
 * redactor by pattern (`redactText`: `password=...`, bearer tokens and the like), which cannot recognise a bare value. The broker never holds a run's synthetic passwords, so it
 * cannot scan for them. What keeps a bare password out of an observed value is the chain upstream of the broker, in two layers. First the executor itself: it refuses to record
 * verdict-input evidence (an observation, a download) that carries one of the run's account credentials (`record` in verifier/src/executor/case-ledger.ts, with the redactor of
 * Task 3.6), so the case has no value to show. Then the Docker host's own scan of the run output against the run's credentials (every spelling it knows, `snapshotExecutorOutput`),
 * which holds back the operator evidence (captures, log heads) that carries one before the worker packs it. `credential-echo` in tests/e2e/m1-3-journeys.test.ts runs the chain end
 * to end, and checks that a credential reached it and was withheld, so a round that fails for another reason does not pass for a proof.
 */

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const cut = (text: string, limit: number): string => {
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
};

/** Free text for a row: one line, redacted, with emails replaced, cut to `limit` characters. */
export function displayText(value: unknown, limit: number): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === undefined) text = "";
  else { try { text = canonicalJson(value); } catch { text = ""; } }
  const clean = redactText(text.replace(CONTROL, " ")).replace(EMAIL, "[email]").replace(/\s+/gu, " ").trim();
  return cut(clean, limit);
}

/** A scenario's title: its id in words. The plan carries no other name for it. */
export function scenarioTitle(scenarioId: string): string {
  const words = displayText(scenarioId.replace(/[-_]+/gu, " "), 120);
  if (words === "") return "Scenario";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * What the page and Slack call the account of a row. A row stores the profile id (its schema allows plain ids only, and stored rows are read by older readers); the signed-out
 * visitor (Ruling AZ) is not an account, so it reads as what it is.
 */
export function accountDisplayName(label: string): string {
  return label === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID ? "Signed-out visitor" : label;
}

/** An account by its profile id; anything that is not a plain id (an email, say) is only "account". */
export function accountLabelOf(profileId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/u.test(profileId) ? profileId : "account";
}

type Derived = Readonly<{ kind: (typeof E2E_DISPLAY_ASSERTION_KINDS)[number]; expected: string; actual: string; reason: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const rowsWord = (count: number) => (count === 1 ? "1 row" : `${count} rows`);
const same = (left: unknown, right: unknown): boolean => { try { return canonicalJson(left) === canonicalJson(right); } catch { return false; } };
const escapePointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const show = (value: unknown, limit = 60): string => (value === undefined ? "nothing" : typeof value === "string" ? `"${displayText(value, limit)}"` : displayText(value, limit));

/** The first place two JSON values differ, as a JSON pointer ("" is the whole value), or undefined when they are equal. */
function firstDifference(expected: unknown, actual: unknown, pointer = ""): { pointer: string; expected: unknown; actual: unknown } | undefined {
  if (same(expected, actual)) return undefined;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
      if (index >= expected.length || index >= actual.length) return { pointer: `${pointer}/${index}`, expected: expected[index], actual: actual[index] };
      const inner = firstDifference(expected[index], actual[index], `${pointer}/${index}`);
      if (inner !== undefined) return inner;
    }
  }
  if (isRecord(expected) && isRecord(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) return { pointer: `${pointer}/${escapePointer(key)}`, expected: expected[key], actual: actual[key] };
      const inner = firstDifference(expected[key], actual[key], `${pointer}/${escapePointer(key)}`);
      if (inner !== undefined) return inner;
    }
  }
  return { pointer, expected, actual };
}

function jsonDifference(kind: "json" | "state", expected: unknown, actual: unknown): Derived {
  const difference = firstDifference(expected, actual);
  const bounded = (value: unknown) => displayText(value, 200);
  if (difference === undefined) {
    return { kind, expected: bounded(expected), actual: bounded(actual), reason: kind === "json" ? "the response does not match the approved JSON shape" : "the state does not match the approved shape" };
  }
  const where = difference.pointer === "" ? "the whole value" : difference.pointer;
  return { kind, expected: bounded(expected), actual: bounded(actual),
    reason: displayText(`first difference at ${where}: expected ${show(difference.expected)}, received ${show(difference.actual)}`, 300) };
}

/**
 * What an approved assertion expected and what the collector re-derived, in the words of the row. `value` is the observation's re-derived value (a text, a boolean, a
 * status, a CSV's columns and rows, a parsed JSON body); a value of the wrong shape for its assertion gives nothing, because a row never invents an actual.
 */
export function deriveFailedAssertion(assertion: E2EAssertion, value: unknown): Derived | undefined {
  switch (assertion.kind) {
    case "text": {
      if (typeof value !== "string") return undefined;
      const expected = displayText(assertion.equals, 200);
      const actual = displayText(value, 200);
      return { kind: "text", expected, actual, reason: displayText(`expected "${displayText(assertion.equals, 100)}", received "${displayText(value, 100)}"`, 300) };
    }
    case "visible": {
      if (typeof value !== "boolean") return undefined;
      const expected = assertion.equals ? "visible" : "hidden";
      const actual = value ? "visible" : "hidden";
      return { kind: "visible", expected, actual, reason: `expected ${expected}, was ${actual}` };
    }
    case "http-status": {
      if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
      return { kind: "http-status", expected: String(assertion.equals), actual: String(value), reason: `expected ${assertion.equals}, received ${value}` };
    }
    case "csv": {
      if (!isRecord(value) || !Array.isArray(value.rows) || !Array.isArray(value.columns) || typeof value.downloadName !== "string") return undefined;
      const rows = value.rows as unknown[];
      const columns = value.columns as unknown[];
      const cells = (row: unknown) => (Array.isArray(row) ? row.map((cell) => displayText(cell, 40)).join(",") : displayText(row, 80));
      let firstRow = -1;
      for (let index = 0; index < Math.max(rows.length, assertion.rows.length); index += 1) if (!same(rows[index], assertion.rows[index])) { firstRow = index; break; }
      const expected = rowsWord(assertion.rows.length);
      const received = rowsWord(rows.length);
      const detail = firstRow < 0 ? "" : `; row ${firstRow + 1}: ${cells(rows[firstRow] ?? assertion.rows[firstRow])}`;
      const actual = displayText(`${received}${detail}`, 200);
      if (value.downloadName !== assertion.downloadName) {
        return { kind: "csv", expected: displayText(assertion.downloadName, 200), actual: displayText(value.downloadName, 200),
          reason: displayText(`expected file ${displayText(assertion.downloadName, 100)}, received ${displayText(value.downloadName, 100)}`, 300) };
      }
      if (!same(columns, assertion.columns)) {
        return { kind: "csv", expected: displayText(assertion.columns.join(", "), 200), actual: displayText(columns.join(", "), 200),
          reason: displayText(`expected columns ${assertion.columns.map((column) => displayText(column, 40)).join(", ")}, received ${columns.map((column) => displayText(column, 40)).join(", ")}`, 300) };
      }
      if (rows.length !== assertion.rows.length) return { kind: "csv", expected, actual, reason: `expected ${expected}, received ${rows.length}` };
      return { kind: "csv", expected, actual: firstRow < 0 ? received : actual, reason: firstRow < 0 ? "the export differs from the approved one" : `row ${firstRow + 1} differs from the approved export` };
    }
    case "json": return jsonDifference("json", assertion.equals, value);
    case "state": return jsonDifference("state", assertion.equals, value);
    case "file": return { kind: "file", expected: "the approved file contents", actual: "different contents", reason: "the file's contents differ from the approved ones" };
  }
}

// ---------------------------------------------------------------------------------------------
// The rows of a verified round
// ---------------------------------------------------------------------------------------------

export type DisplayArtifact = Readonly<{ sha256: string; bytes: Uint8Array; contentType: "image/jpeg" }>;
type ObservedAssertion = Readonly<{ assertionIndex: number; outcome: string; value: unknown }>;
/** The part of a qualified result that rows read. */
type ResultForRows = Readonly<{ reason?: string | undefined; cases: ReadonlyArray<Readonly<{ caseId: string; status: string; reason: string; mockedOrigins?: readonly string[] | undefined;
  assertionReceipts: ReadonlyArray<Readonly<{ assertionIndex: number; status: string }>> }>> }>;

export type DisplayGroupInput = Readonly<{
  /** The broker's verdict for the group. A case is shown as passed only when it is PASS or FAILED (a group the broker could not confirm shows nothing as passed). */
  verdict: "PASS" | "FAILED" | "UNKNOWN";
  reason: string;
  cases: ReadonlyArray<Readonly<{ caseId: string; scenarioId: string; targetId: string; accountProfileId: string }>>;
  /** The approved scenarios of the group, by scenario id. */
  scenarios: ReadonlyMap<string, Readonly<{ assertions: readonly E2EAssertion[] }>>;
  /** The broker's own re-collected result for the group (as it shows it), when it has one. */
  result: ResultForRows | undefined;
  /** What the collector re-derived for each case's assertions; read only for a case the broker found failed. */
  observed: ReadonlyMap<string, readonly ObservedAssertion[]>;
  /** Screenshots offered for the group's cases, already checked by `readCaptureScreenshots`. */
  screenshots: ReadonlyMap<string, Readonly<{ sha256: string; data: Uint8Array }>>;
}>;

export type BuildScenarioRowsInput = Readonly<{
  /** Whether the broker accepted the round whole (the aggregate and a successful end). Otherwise every row is incomplete and carries no failure detail or screenshot. */
  authoritative: boolean;
  /** Which rows may carry a screenshot: those that failed or are incomplete, or every row (a baseline round). */
  attach: "failed-or-incomplete" | "all";
  targetKinds: ReadonlyMap<string, "web" | "api">;
  groups: readonly DisplayGroupInput[];
}>;

/** Fixed sentences for the reasons the broker's own collector gives; any other reason is not repeated. */
const PLAIN_REASONS: ReadonlyMap<string, string> = new Map([
  ["unmocked-external-call", "called a service that has no approved mock"],
  ["application-evidence-floor-unmet", "the evidence was not enough to decide"],
  ["application-lifecycle-unconfirmed", "the run did not end cleanly"],
  ["application-round-not-complete", "the checks have not finished"],
]);
const COULD_NOT_VERIFY = "this check could not be verified";
const NOT_FINISHED = "the checks have not finished";

export function buildScenarioRows(input: BuildScenarioRowsInput): { scenarios: E2EDisplayScenario[]; artifacts: DisplayArtifact[] } {
  const scenarios: E2EDisplayScenario[] = [];
  const artifacts = new Map<string, DisplayArtifact>();
  for (const group of input.groups) {
    for (const item of group.cases) {
      const kind = input.targetKinds.get(item.targetId);
      if (kind === undefined) continue;
      const found = group.result?.cases.find((candidate) => candidate.caseId === item.caseId);
      const confirmed = input.authoritative && group.verdict !== "UNKNOWN" && found !== undefined;
      const status: E2EDisplayScenario["status"] = !confirmed ? "UNKNOWN" : found.status === "passed" ? "PASSED" : found.status === "failed" ? "FAILED" : "UNKNOWN";
      let reason: string | undefined;
      let failedAssertion: E2EDisplayScenario["failedAssertion"];
      if (status === "FAILED" && found !== undefined) {
        const failedIndex = found.assertionReceipts.find((receipt) => receipt.status === "failed")?.assertionIndex;
        const assertion = failedIndex === undefined ? undefined : group.scenarios.get(item.scenarioId)?.assertions[failedIndex];
        const value = failedIndex === undefined ? undefined : group.observed.get(item.caseId)?.find((observed) => observed.assertionIndex === failedIndex && observed.outcome === "failed");
        const derived = assertion === undefined || value === undefined ? undefined : deriveFailedAssertion(assertion, value.value);
        if (derived !== undefined) { reason = derived.reason; failedAssertion = { kind: derived.kind, expected: derived.expected, actual: derived.actual }; }
        else reason = "an assertion did not hold";
      } else if (status === "UNKNOWN") {
        // Only the collector's own reason codes are put into words; a group's reason sentence (which may quote the worker) is never repeated.
        reason = !input.authoritative ? NOT_FINISHED : PLAIN_REASONS.get(found?.reason ?? "") ?? PLAIN_REASONS.get(group.result?.reason ?? "") ?? COULD_NOT_VERIFY;
      }
      // A screenshot is a claim of the worker's: it is shown only for a row the broker found failed or incomplete (every row for a baseline), once the round is whole.
      const offered = group.screenshots.get(item.caseId);
      const wanted = input.authoritative && offered !== undefined && offered.data.byteLength <= E2E_DISPLAY_SCREENSHOT_MAX_BYTES
        && (input.attach === "all" || status !== "PASSED");
      const mocked = found?.mockedOrigins === undefined ? [] : [...new Set(found.mockedOrigins.map((origin) => displayText(origin, 200)).filter((origin) => origin !== ""))].sort().slice(0, 32);
      if (wanted) artifacts.set(offered.sha256, { sha256: offered.sha256, bytes: offered.data, contentType: "image/jpeg" });
      scenarios.push({
        scenarioId: displayText(item.scenarioId, 120) || "scenario", title: scenarioTitle(item.scenarioId), kind, accountLabel: accountLabelOf(item.accountProfileId), status,
        ...(reason === undefined ? {} : { reason }), ...(failedAssertion === undefined ? {} : { failedAssertion }),
        ...(wanted ? { screenshotRef: { sha256: offered.sha256, bytes: offered.data.byteLength, contentType: "image/jpeg" as const } } : {}),
        mockedOrigins: mocked,
      });
    }
  }
  return { scenarios, artifacts: [...artifacts.values()] };
}

export function summarizeScenarios(rows: readonly Pick<E2EDisplayScenario, "status">[]): { passed: number; failed: number; incomplete: number } {
  return { passed: rows.filter((row) => row.status === "PASSED").length, failed: rows.filter((row) => row.status === "FAILED").length, incomplete: rows.filter((row) => row.status === "UNKNOWN").length };
}

function scrubRow(row: E2EDisplayScenario): E2EDisplayScenario {
  const reason = row.reason === undefined ? "" : displayText(row.reason, 300);
  return {
    scenarioId: displayText(row.scenarioId, 120) || "scenario", title: displayText(row.title, 120) || "Scenario", kind: row.kind, accountLabel: accountLabelOf(row.accountLabel), status: row.status,
    ...(reason === "" ? {} : { reason }),
    ...(row.failedAssertion === undefined || row.status !== "FAILED" ? {}
      : { failedAssertion: { kind: row.failedAssertion.kind, expected: displayText(row.failedAssertion.expected, 200), actual: displayText(row.failedAssertion.actual, 200) } }),
    ...(row.screenshotRef === undefined ? {} : { screenshotRef: row.screenshotRef }),
    mockedOrigins: [...new Set(row.mockedOrigins.map((origin) => displayText(origin, 200)).filter((origin) => origin !== ""))].slice(0, 32),
  };
}

/**
 * The results with every free-text field scrubbed again (redacted, emails replaced, bounded) and the whole held to its schema: what is stored and what is printed never
 * depends on a row having been clean when it was built. Undefined when what is left is not a valid set of results.
 */
export function scrubScenarioResults(results: E2EScenarioResults): E2EScenarioResults | undefined {
  const parsed = E2EScenarioResultsSchema.safeParse({
    scenarios: results.scenarios.map(scrubRow),
    ...(results.baseline === undefined ? {} : { baseline: { status: results.baseline.status, scenarios: results.baseline.scenarios.map(scrubRow) } }),
  });
  return parsed.success ? parsed.data : undefined;
}

/** A baseline from its rows: any FAILED makes it FAILED, else any incomplete row makes it UNKNOWN, else PASSED. */
export function baselineOf(rows: readonly E2EDisplayScenario[]): E2EDisplayBaseline {
  const counts = summarizeScenarios(rows);
  return { status: counts.failed > 0 ? "FAILED" : counts.incomplete > 0 || rows.length === 0 ? "UNKNOWN" : "PASSED", scenarios: [...rows] };
}

/** The baseline for a round that could not be run on the unchanged code. */
export const UNAVAILABLE_BASELINE: E2EDisplayBaseline = Object.freeze({ status: "UNAVAILABLE", scenarios: [] });

// ---------------------------------------------------------------------------------------------
// Screenshots in a group's operator evidence
// ---------------------------------------------------------------------------------------------

const SCREENSHOT_NAME = /^case-\d{1,4}-screenshot\.jpg$/u;

/**
 * The screenshots a group's operator evidence lists (`captures.artifacts`) and carries (`captures.files`), kept only when they are what they say: for a case of the
 * group, not dropped, named as a case capture, base64 that decodes back to the same text, a JPEG, at most 512 KiB, of exactly the listed size and digest. The first
 * for a case wins. Anything of another shape is ignored; this never throws.
 */
export function readCaptureScreenshots(operatorEvidence: unknown, caseIds: ReadonlySet<string>): Map<string, { sha256: string; data: Uint8Array }> {
  const kept = new Map<string, { sha256: string; data: Uint8Array }>();
  try {
    const captures = isRecord(operatorEvidence) ? operatorEvidence.captures : undefined;
    if (!isRecord(captures) || !Array.isArray(captures.artifacts) || !Array.isArray(captures.files)) return kept;
    for (const entry of captures.artifacts as unknown[]) {
      if (!isRecord(entry) || entry.kind !== "screenshot" || entry.omitted !== undefined || typeof entry.caseId !== "string" || !caseIds.has(entry.caseId) || kept.has(entry.caseId)) continue;
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isInteger(entry.bytes) || (entry.bytes as number) <= 0 || (entry.bytes as number) > E2E_DISPLAY_SCREENSHOT_MAX_BYTES) continue;
      const file = (captures.files as unknown[]).find((candidate) => isRecord(candidate) && candidate.sha256 === entry.sha256);
      if (!isRecord(file) || typeof file.name !== "string" || !SCREENSHOT_NAME.test(file.name) || typeof file.base64 !== "string" || file.bytes !== entry.bytes) continue;
      const bytes = Buffer.from(file.base64, "base64");
      if (bytes.toString("base64") !== file.base64 || bytes.byteLength !== entry.bytes || sha256Of(bytes) !== entry.sha256) continue;
      if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) continue;
      kept.set(entry.caseId, { sha256: entry.sha256, data: new Uint8Array(bytes) });
    }
  } catch { /* evidence of the wrong shape keeps nothing */ }
  return kept;
}

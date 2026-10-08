import { Buffer } from "node:buffer";
import { redactText, WorkflowReviewFindingSchema, type WorkflowReviewFinding } from "@agentx/contracts";

const REVIEW_RESPONSE_MAX_BYTES = 20_000;
const REVIEW_RESPONSE_MAX_ENTRIES = 50;
const REVIEW_RESPONSE_TEXT_MAX = 1000;
const REVIEW_REPORT_MAX_FINDINGS = 20;
const REVIEW_FINDING_TEXT_MAX = 600;
/**
 * Verdict rows and no-issue notes that models list as findings; they never block or show as findings.
 * A no-issue phrase is skipped only when it is the whole entry, and a PASS verdict only when it stands
 * alone or is followed by a `:` or a spaced `-`/`–`/`—` separator, so "None of the new routes check authorization"
 * or "Passed-in token is written to logs" stay findings.
 */
const NO_ISSUE_NOTE = /^(?:none|ok|n\/a|lgtm|looks good|no (?:issues?|findings?|problems?)(?: found)?)[.!]?$/i;
const PASS_VERDICT_ROW = /^pass(?:ed)?(?:$|\s*:|\s+[-–—])/i;
/**
 * The only words a skipped PASS row may carry after its verdict. Anything else ("PASS: token is written to logs")
 * may describe a defect, so it is kept as a finding.
 */
const PASS_ROW_NO_ISSUE = new Set([
  "unchanged", "no change", "no changes", "not applicable", "n/a", "no issues", "no issues found", "nothing to report",
  "covered by tests", "tests cover this", "ok", "looks good",
]);
const SEVERITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

/**
 * A finding's `file` as AgentX keeps it: a relative path with no `..` segment, NUL or backslash, unchanged by
 * redaction. Anything else is treated as no file, so the finding cannot point at host files or carry a secret.
 */
export function safeFindingFile(file: string): string | undefined {
  const trimmed = file.trim().replace(/^(?:\.\/)+/, "");
  if (trimmed.length === 0 || trimmed.includes("\0") || trimmed.includes("\\") || trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)
    || trimmed.split("/").some((part) => part === "..") || redactText(trimmed) !== trimmed) return undefined;
  return trimmed;
}

export type WorkflowReviewerResponse = {
  status: "PASS" | "FINDINGS" | "UNKNOWN";
  findings: WorkflowReviewFinding[];
  failureReason?: "RESPONSE_TOO_LARGE" | "INVALID_JSON" | "INVALID_SHAPE";
};

/** Strips one fenced block wrapping the whole answer, e.g. ```json\n{...}\n```. */
function unfence(value: string): string {
  return /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(value)?.[1] ?? value;
}

/** INTRODUCED before PRE_EXISTING, then HIGH > MEDIUM > LOW > no severity. */
function rank(finding: WorkflowReviewFinding): number {
  return (finding.origin === "INTRODUCED" ? 0 : 10) + (finding.severity === undefined ? 3 : SEVERITY_RANK[finding.severity]);
}

/**
 * Reads one reviewer entry: a plain string is an INTRODUCED finding (the pre-structured shape);
 * an object must match the finding contract with text of at most 1,000 characters.
 * The text is redacted before it is truncated to the stored limit, so a secret is never cut past its pattern.
 */
function readEntry(entry: unknown): WorkflowReviewFinding | "SKIP" | undefined {
  const raw: unknown = typeof entry === "string" ? { text: entry, origin: "INTRODUCED" } : entry;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { text } = raw as { text?: unknown };
  if (typeof text !== "string" || text.trim().length === 0 || text.trim().length > REVIEW_RESPONSE_TEXT_MAX) return undefined;
  const plain = text.trim();
  const verdict = PASS_VERDICT_ROW.exec(plain);
  const remainder = verdict === null ? undefined : plain.slice(verdict[0].length).trim();
  // A kept PASS row is stored as what follows its verdict, so redaction (which reads "PASS: <words>" as a
  // password) leaves the defect description readable.
  const redacted = redactText(remainder === undefined || remainder.length === 0 ? plain : remainder);
  const checked = WorkflowReviewFindingSchema.safeParse({ ...raw, text: redacted.slice(0, REVIEW_FINDING_TEXT_MAX) });
  if (!checked.success) return undefined;
  const { file: rawFile, ...rest } = checked.data;
  const file = rawFile === undefined ? undefined : safeFindingFile(rawFile);
  const finding: WorkflowReviewFinding = { ...rest, ...(file === undefined ? {} : { file }) };
  // A located or rated entry is a real finding whatever its wording.
  if (finding.severity !== undefined || rawFile !== undefined || finding.line !== undefined) return finding;
  // Verdict wording is judged on the reviewer's own text, only to classify it.
  if (NO_ISSUE_NOTE.test(plain)) return "SKIP";
  // A PASS row is skipped only when nothing follows the verdict or what follows is a known no-issue phrase.
  if (remainder !== undefined && (remainder.length === 0 || PASS_ROW_NO_ISSUE.has(remainder.replace(/[.!]+$/, "").trim().toLowerCase()))) return "SKIP";
  return finding;
}

/**
 * Reads a reviewer's JSON answer. `classify` sees every kept finding before ranking and the 20-finding cut,
 * so a finding it moves to INTRODUCED is ranked, and decides the status, as one.
 */
export function parseWorkflowReviewerResponse(
  value: string,
  options: { classify?: (finding: WorkflowReviewFinding) => WorkflowReviewFinding } = {},
): WorkflowReviewerResponse {
  if (Buffer.byteLength(value, "utf8") > REVIEW_RESPONSE_MAX_BYTES) return { status: "UNKNOWN", findings: [], failureReason: "RESPONSE_TOO_LARGE" };
  let parsed: unknown;
  try { parsed = JSON.parse(unfence(value)) as unknown; } catch { return { status: "UNKNOWN", findings: [], failureReason: "INVALID_JSON" }; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" };
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.findings) || record.findings.length > REVIEW_RESPONSE_MAX_ENTRIES) {
    return { status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" };
  }
  const findings: WorkflowReviewFinding[] = [];
  for (const entry of record.findings as unknown[]) {
    const finding = readEntry(entry);
    if (finding === undefined) return { status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" };
    if (finding !== "SKIP") findings.push(options.classify === undefined ? finding : options.classify(finding));
  }
  // Array.prototype.sort is stable, so equal-rank findings keep the reviewer's order.
  const kept = findings.sort((a, b) => rank(a) - rank(b)).slice(0, REVIEW_REPORT_MAX_FINDINGS);
  return { status: kept.some((finding) => finding.origin === "INTRODUCED") ? "FINDINGS" : "PASS", findings: kept };
}

// Proof and evidence P4: the findings a project's own scanner or linter writes as SARIF (bandit, semgrep, CodeQL, ESLint's SARIF formatter, and any tool that writes SARIF 2.1.0), compared with the same
// tool's findings on the code the task started from, so the pull request says how many findings are NEW. AgentX never changes a customer's command: it reads the SARIF file the command already writes
// (the report path comes from the command line, see `sarifPathOf`), and for the baseline it runs the very same command once more on the original code (sarif-baseline.ts).
//
// Fail closed and bounded: a file that is not SARIF, is too large, or lists too many results is "not read" (no finding is claimed, and no scan is ever shown as clean because its file was unreadable). The
// comparison needs both sides: without a baseline there is no "new", so nothing is reported. A finding's message is data from the tool: it is redacted, made one plain line and cut, and for a rule that is about
// secrets the quoted text in it (which may be the secret) is removed.
import { redactText, type EvidenceRaw, EVIDENCE_FINDINGS_MAX, type ProjectCommand } from "@agentx/contracts";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { plainPath } from "./cobertura-lcov-coverage.js";

export const SARIF_REPORT_MAX_BYTES = 16 * 1024 * 1024;
/** More results than this in one file and the file is not read: the counts could not be trusted to be complete. */
export const SARIF_MAX_RESULTS = 100_000;
const MESSAGE_MAX = 200;
const RULE_MAX = 100;
const TOOL_MAX = 60;

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export interface SarifFinding {
  ruleId: string;
  severity: FindingSeverity;
  /** Repository-relative where the tool's address could be made so, else the tool's own address. One plain line. */
  path: string;
  line: number;
  message: string;
  /** What makes a finding "the same one" on two runs: the tool, the rule, the file and the tool's fingerprint (or, without one, the message). Never the line number: code that moved is not new. */
  key: string;
}
export interface ParsedSarif { tool: string; findings: SarifFinding[] }

// ---- where the SARIF file is

const OUTPUT_OPTIONS = ["-o", "--output", "--output-file", "--outfile", "--out", "--sarif-file", "--sarif-output", "--output-path"];

/**
 * The SARIF file a command's own line asks its tool to write: an argument that is a `.sarif` or `.sarif.json` path (alone or as an option's value), or the output file of a command that asks for the SARIF
 * format (`-f sarif -o out.json`, `--sarif -o out.json`, `--format=sarif-latest --output=out.sarif`). Undefined when the line names none. The command is never altered.
 */
export function sarifPathOf(command: ProjectCommand): string | undefined {
  const args = command.args;
  const values = args.map((arg) => (arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg));
  const explicit = values.find((value) => value.length <= 1_024 && !value.startsWith("-") && /\.sarif(?:\.json)?$/iu.test(value));
  if (explicit !== undefined) return explicit;
  if (!args.some((arg) => /sarif/iu.test(arg))) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!OUTPUT_OPTIONS.includes(name)) continue;
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
    if (value !== undefined && value !== "" && value.length <= 1_024 && !value.startsWith("-")) return value;
  }
  return undefined;
}

// ---- parsing

const RISKY_MESSAGE = /pass(?:word|wd)|secret|token|api[-_ ]?key|credential|hard-?coded|private[-_ ]?key/iu;
const QUOTED = /(['"`])(?:(?!\1).){1,200}\1/gu;

/** A tool's message as one plain redacted line: control characters gone, a secret-like value redacted, and, for a rule about secrets, whatever was quoted removed. */
export function plainMessage(text: string, ruleId = ""): string {
  let line = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (RISKY_MESSAGE.test(line) || RISKY_MESSAGE.test(ruleId)) line = line.replace(QUOTED, "$1…$1");
  return Array.from(redactText(line)).slice(0, MESSAGE_MAX).join("");
}

const object = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function severityOf(result: Record<string, unknown>, rule: Record<string, unknown> | undefined): FindingSeverity {
  // GitHub's convention: `security-severity` is a CVSS-like score on the result or its rule (9.0+ critical, 7.0+ high, 4.0+ medium, above 0 low).
  const score = [object(result.properties)?.["security-severity"], object(rule?.properties)?.["security-severity"]].map((value) => (typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN)).find((value) => Number.isFinite(value));
  if (score !== undefined) return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "info";
  const level = text(result.level) ?? text(object(rule?.defaultConfiguration)?.level) ?? "warning";
  return level === "error" ? "high" : level === "warning" ? "medium" : level === "note" ? "low" : "info";
}

/** The path as the tool wrote it, as a repository-relative one when it lies under one of `roots` (a `file://` address and a percent-encoded name are read first). */
export function repositoryPathOf(uri: string, roots: readonly string[]): string {
  let value = uri.trim();
  if (value.startsWith("file://")) value = value.slice("file://".length).replace(/^\/(?=[A-Za-z]:)/u, "");
  try { value = decodeURIComponent(value); } catch { /* keep the text as written */ }
  value = value.replaceAll("\\", "/");
  if (isAbsolute(value)) {
    const real = normalize(value);
    for (const root of roots) {
      const inside = relative(root, real);
      if (inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return plainPath(inside.split(sep).join("/"));
    }
  }
  return plainPath(value.replace(/^(?:\.\/)+/u, "").replace(/^\/+/u, ""));
}

/**
 * SARIF 2.1.0: every result of every run (at most `SARIF_MAX_RESULTS`), with its rule's severity. `roots` are the directories absolute addresses are made relative to. Undefined when the text is not SARIF
 * (no `runs` array), is not JSON, or holds more results than the limit.
 */
export function parseSarif(source: string, roots: readonly string[] = [], maxResults = SARIF_MAX_RESULTS): ParsedSarif | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return undefined; }
  const runs = object(parsed)?.runs;
  if (!Array.isArray(runs)) return undefined;
  const findings: SarifFinding[] = [];
  let tool = "";
  for (const raw of runs) {
    const run = object(raw);
    const driver = object(object(run?.tool)?.driver);
    if (run === undefined || driver === undefined) continue;
    const toolName = plainPath(text(driver.name) ?? "scanner", TOOL_MAX);
    if (tool === "") tool = toolName;
    const rules = Array.isArray(driver.rules) ? driver.rules.map(object) : [];
    // One lookup table per run: a rule is found by id in constant time, however many rules and results the file lists (a scan per result was quadratic).
    const ruleById = new Map<string, Record<string, unknown>>();
    for (const candidate of rules) { const id = text(candidate?.id); if (candidate !== undefined && id !== undefined && !ruleById.has(id)) ruleById.set(id, candidate); }
    const results = Array.isArray(run.results) ? run.results : [];
    for (const rawResult of results) {
      if (findings.length >= maxResults) return undefined;
      const result = object(rawResult);
      if (result === undefined) continue;
      const index = typeof result.ruleIndex === "number" ? result.ruleIndex : typeof object(result.rule)?.index === "number" ? (object(result.rule)!.index as number) : undefined;
      const ruleKey = text(result.ruleId) ?? text(object(result.rule)?.id);
      const rule = (index === undefined ? undefined : rules[index]) ?? (ruleKey === undefined ? undefined : ruleById.get(ruleKey));
      const ruleId = plainPath(ruleKey ?? text(rule?.id) ?? "rule", RULE_MAX);
      const location = object(object(Array.isArray(result.locations) ? result.locations[0] : undefined)?.physicalLocation);
      const uri = text(object(location?.artifactLocation)?.uri);
      const startLine = object(location?.region)?.startLine;
      const path = uri === undefined ? "unknown file" : repositoryPathOf(uri, roots);
      const line = typeof startLine === "number" && Number.isInteger(startLine) && startLine >= 1 && startLine <= 10_000_000 ? startLine : 1;
      const message = plainMessage(text(object(result.message)?.text) ?? text(object(result.message)?.markdown) ?? "", ruleId);
      const fingerprints = { ...object(result.fingerprints), ...object(result.partialFingerprints) };
      const fingerprint = Object.keys(fingerprints).sort().map((name) => text(fingerprints[name])).find((value) => value !== undefined && value !== "");
      findings.push({
        ruleId, severity: severityOf(result, rule), path, line, message,
        key: [toolName, ruleId, path, fingerprint === undefined ? `m:${message}` : `f:${fingerprint.slice(0, 200)}`].join("\0"),
      });
    }
  }
  return { tool: tool === "" ? "scanner" : tool, findings };
}

// ---- comparing with the baseline

/** The findings the candidate has that the baseline does not: each key is counted, and a candidate finding is new only past the baseline's count of its key (the later ones in the file, by line). */
export function newFindings(candidate: readonly SarifFinding[], baseline: readonly SarifFinding[]): SarifFinding[] {
  const budget = new Map<string, number>();
  for (const finding of baseline) budget.set(finding.key, (budget.get(finding.key) ?? 0) + 1);
  const ordered = [...candidate].sort((left, right) => left.line - right.line);
  const fresh: SarifFinding[] = [];
  for (const finding of ordered) {
    const left = budget.get(finding.key) ?? 0;
    if (left > 0) budget.set(finding.key, left - 1);
    else fresh.push(finding);
  }
  return fresh;
}

/** The evidence's findings part: every new finding counted by severity, the 100 most severe listed. */
export function findingsPart(tool: string, fresh: readonly SarifFinding[]): NonNullable<EvidenceRaw["checks"][number]["findings"]> {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of fresh) bySeverity[finding.severity] += 1;
  const items = [...fresh]
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) || left.line - right.line)
    .slice(0, EVIDENCE_FINDINGS_MAX)
    .map((finding) => ({ ruleId: finding.ruleId, severity: finding.severity, path: finding.path, line: finding.line, message: finding.message }));
  return { tool: plainPath(tool, TOOL_MAX), newCount: fresh.length, bySeverity, items };
}

// ---- when a baseline cannot be trusted

const PREBUILT = [/\bcodeql\b[^\n]*\banalyze\b/iu, /\bspotbugs\b/iu, /\bfindsecbugs\b/iu, /\bjoern\b/iu];
/**
 * Whether a SARIF-writing command is known to read state an earlier step built and git ignores (CodeQL's `database analyze` reads the database `database create` built; SpotBugs reads compiled classes). The baseline
 * run shows the original SOURCE and re-runs only this command, so such a scan would read the candidate's own build and compare the candidate with itself: no baseline is run for it, and it says so.
 */
export function readsPrebuiltState(command: ProjectCommand): boolean {
  const line = [command.executable.split("/").at(-1) ?? command.executable, ...command.args].join(" ").slice(0, 2_000);
  return PREBUILT.some((pattern) => pattern.test(line));
}

/** Whether two scans list exactly the same findings, line numbers and messages included. */
export function sameFindings(left: readonly SarifFinding[], right: readonly SarifFinding[]): boolean {
  if (left.length !== right.length) return false;
  const tuple = (finding: SarifFinding) => `${finding.key}\0${String(finding.line)}\0${finding.severity}\0${finding.message}`;
  const seen = new Map<string, number>();
  for (const finding of left) seen.set(tuple(finding), (seen.get(tuple(finding)) ?? 0) + 1);
  for (const finding of right) {
    const count = seen.get(tuple(finding)) ?? 0;
    if (count === 0) return false;
    seen.set(tuple(finding), count - 1);
  }
  return true;
}

/**
 * What is said of a scan whose findings could not be compared with the original code: no finding is called new, but the high and critical ones it reported on this code are counted as unverified, so the risk
 * rule can ask for a look instead of reading "no baseline" as "nothing new". Undefined when it reported none (nothing high is hidden).
 */
export function unverifiedPart(tool: string, candidate: readonly SarifFinding[]): NonNullable<EvidenceRaw["checks"][number]["findings"]> | undefined {
  const high = candidate.filter((finding) => finding.severity === "critical" || finding.severity === "high").length;
  return high === 0 ? undefined : { ...findingsPart(tool, []), unverified: high };
}

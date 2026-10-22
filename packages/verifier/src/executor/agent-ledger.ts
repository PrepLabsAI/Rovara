import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { E2E_AGENT_ACTIONS_SCHEMA_VERSION, E2EAgentActionLedgerSchema, canonicalJson, e2eAgentValueDigest, e2eAgentValueKeyId,
  type E2EAgentActionLedger } from "@agentx/contracts";
import { E2E_AGENT_EVIDENCE_DIR, E2E_AGENT_LEDGER_FILE, agentCaseDirectoryName } from "./evidence-paths.js";

/**
 * The action ledger of an agent step (Task 4.3b): what the agent did, written by this executor from the observation it showed the model, the same way for every step, and
 * rewritten to disk after every action so a crash or a kill leaves the actions taken so far under the verdict `cut-short`.
 *
 * It holds roles, names (at most 120 characters), test ids, keyed digests and relative paths, and one kind of literal: a typed value, key or option that is text of the approved goal.
 * Anything else the model typed is only an HMAC under the run's value key (`e2eAgentValueDigest`), so a dictionary cannot recover it without the key, which no file the executor writes
 * carries. The file is read by the host as operator evidence and by Task 4.4 through `parseVerifiedE2EAgentActionLedger`, never trusted as is.
 */

export { E2E_AGENT_EVIDENCE_DIR, E2E_AGENT_LEDGER_FILE, agentCaseDirectoryName };

const NAME_MAX = 120;
const LITERAL_MAX = 256;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export type LedgerNode = { role: string; name: string; testId: string | null };
export type LedgerActionInput = Readonly<{
  tool: "tap" | "type" | "press" | "select" | "scroll" | "navigate";
  node: LedgerNode | null;
  /** The typed text, key, option label or scroll direction. Never stored as given: see `valueLiteral` in the module note. */
  value: string | null;
  /** An app-relative path without a query or fragment, for `navigate` (also for a refused one, where it is "/"). */
  url: string | null;
  /** SHA-256 of the observation text the model chose from. */
  snapshotSha256: string;
  outcome: "ok" | "action-failed" | "policy-denied";
}>;
export type LedgerStepEnd = Readonly<{ verdict: "concluded" | "failed"; stopCode: E2EAgentActionLedger["steps"][number]["stopCode"]; receiptIds: readonly string[] }>;

export interface E2EAgentLedgerWriter {
  /** The directory the case's ledger and traces live in. */
  readonly directory: string;
  beginStep(stepIndex: number, goal: string): void;
  recordAction(action: LedgerActionInput): void;
  endStep(stepIndex: number, end: LedgerStepEnd): void;
}

/** A role as the ledger schema spells one: lowercase letters, at most 32. An engine role outside that alphabet reads as the generic one. */
export function ledgerRole(role: string | undefined): string {
  const cleaned = (role ?? "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 32);
  return cleaned === "" ? "generic" : cleaned;
}
/** A name as the ledger holds it: the first 120 UTF-16 code units, never cutting a surrogate pair in two. */
export function ledgerName(name: string | undefined): string {
  const text = name ?? "";
  if (text.length <= NAME_MAX) return text;
  return /[\uD800-\uDBFF]/.test(text.charAt(NAME_MAX - 1)) ? text.slice(0, NAME_MAX - 1) : text.slice(0, NAME_MAX);
}

export function createE2EAgentLedgerWriter(options: { outDir: string; runId: string; caseId: string; valueKey: string }): E2EAgentLedgerWriter {
  const directory = join(options.outDir, E2E_AGENT_EVIDENCE_DIR, agentCaseDirectoryName(options.caseId));
  const file = join(directory, E2E_AGENT_LEDGER_FILE);
  type Step = E2EAgentActionLedger["steps"][number];
  const steps: Step[] = [];
  const goals = new Map<number, string>();
  let current: Step | null = null;

  const persist = (): void => {
    const ledger = E2EAgentActionLedgerSchema.parse({ schemaVersion: E2E_AGENT_ACTIONS_SCHEMA_VERSION, runId: options.runId, caseId: options.caseId,
      valueKeyId: e2eAgentValueKeyId(options.valueKey), steps });
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    // Whole file, then an atomic rename, with the bytes on disk before the rename: a reader sees the ledger as of the last action or the one before, never half of one.
    const temporary = `${file}.${String(process.pid)}.tmp`;
    const handle = openSync(temporary, "w", 0o644);
    try { writeSync(handle, `${canonicalJson(ledger)}\n`); fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temporary, file);
  };

  return Object.freeze({
    directory,
    beginStep(stepIndex: number, goal: string): void {
      if (current !== null || steps.some((step) => step.stepIndex === stepIndex)) throw new Error("the agent ledger begins each step once, and one step at a time");
      current = { stepIndex, goalDigest: sha256(goal), verdict: "cut-short", actions: [], stopCode: null, receiptIds: [] };
      goals.set(stepIndex, goal);
      steps.push(current);
      persist();
    },
    recordAction(action: LedgerActionInput): void {
      if (current === null) throw new Error("the agent ledger has no step to record an action in");
      const goal = goals.get(current.stepIndex) as string;
      const value = action.value;
      const valueDigest = value === null ? null : e2eAgentValueDigest(options.valueKey, value);
      // Only text of the approved goal is kept as it is; every other value is a digest alone.
      const valueLiteral = value !== null && value.length > 0 && value.length <= LITERAL_MAX && goal.includes(value) ? value : null;
      current.actions.push({ tool: action.tool, node: action.node === null ? null : { role: ledgerRole(action.node.role), name: ledgerName(action.node.name), testId: action.node.testId === null ? null : action.node.testId.slice(0, NAME_MAX) },
        valueDigest, valueLiteral, url: action.url, snapshotSha256: action.snapshotSha256, outcome: action.outcome });
      try { persist(); } catch (error) { current.actions.pop(); throw error; }
    },
    endStep(stepIndex: number, end: LedgerStepEnd): void {
      if (current === null || current.stepIndex !== stepIndex) throw new Error("the agent ledger ends the step it began");
      current.verdict = end.verdict;
      current.stopCode = end.stopCode;
      current.receiptIds = [...new Set(end.receiptIds)];
      current = null;
      persist();
    },
  });
}

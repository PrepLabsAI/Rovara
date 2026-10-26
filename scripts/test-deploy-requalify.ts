// AUTOREQUALIFY tooling for test-deploy (AR-5): what the `requalify-infra` and `requalify-now` units are, how the check finds out whether the automatic renewal is installed,
// and how it reports the last renewal. Pure code and read-only AWS reads; nothing here writes. The Lambda unit, the lift context and the step plans are named here so
// scripts/test-deploy.ts only wires them in.
import { REQUALIFY_PROFILE_ID, RequalifyLockSchema, RequalifyRunRecordSchema, requalifyHoldKey, requalifyLockKey, requalifyRunKey } from "../packages/contracts/src/index.js";
import { e2eModelCheckRunnerKey } from "../packages/broker/src/e2e/model-route-registry.js";
import type { CheckTemplate, Finding } from "./test-deploy-check.js";

/** The renewal's Lambda: built from the same files as every control-plane Lambda, but only present on a stack that deployed `requalify-infra`. */
export const REQUALIFY_LAMBDA = {
  unit: "requalify-steps",
  // CDK's logical ID of `RuntimeRequalify/Steps` (infra/lib/runtime-requalify.ts); a contract test synthesizes the stack and requires this exact value.
  logicalId: "RuntimeRequalifyStepsAC5E645B",
  entry: "packages/broker/src/aws/runtime-requalify-handler.ts",
  extraFiles: [{ from: "packages/worker/ec2/boot.sh", name: "boot.sh" }],
} as const;
export type RequalifyLambdaUnit = typeof REQUALIFY_LAMBDA.unit;

/** The resources the `requalify-infra` unit adds (all of them start with this) and the CDK context that switches them on. The qualification transport stays on, as TEST runs it. */
export const REQUALIFY_INFRA = {
  logicalIdPrefix: "RuntimeRequalify",
  context: { "agentx:autoRequalify": "enabled", "agentx:e2eQualificationTransport": "enabled" },
} as const;

/** Whether a (deployed or head) control-plane template holds the renewal's Lambda, which is how the check and the code deploy tell whether the automatic renewal is installed. */
export function requalifyInstalled(template: CheckTemplate): boolean {
  return template.Resources?.[REQUALIFY_LAMBDA.logicalId]?.Type === "AWS::Lambda::Function";
}

// ---------------------------------------------------------------------------------------------
// The check: lock, hold and the last renewal, read from the state table
// ---------------------------------------------------------------------------------------------

/** The only AWS call shape the readers need: `Runner.aws`, or a fake. */
export interface RequalifyReader {
  aws(args: readonly string[], allowFailure?: boolean): { status: number | null; stdout: string; stderr: string };
}

type DynamoValue = { S?: string; N?: string; BOOL?: boolean; NULL?: boolean; M?: Record<string, DynamoValue>; L?: DynamoValue[] };

/** A DynamoDB-JSON item as the plain object it stands for (strings, numbers, booleans, null, maps and lists). */
export function plainItem(item: Record<string, DynamoValue>): Record<string, unknown> {
  const plain = (value: DynamoValue): unknown => {
    if (value.S !== undefined) return value.S;
    if (value.N !== undefined) return Number(value.N);
    if (value.BOOL !== undefined) return value.BOOL;
    if (value.NULL === true) return null;
    if (value.M !== undefined) return Object.fromEntries(Object.entries(value.M).map(([key, inner]) => [key, plain(inner)]));
    if (value.L !== undefined) return value.L.map(plain);
    return undefined;
  };
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, plain(value)]));
}

export type RowRead = { state: "absent" } | { state: "found"; item: Record<string, unknown> } | { state: "unreadable"; reason: string };

/** One row by key with `dynamodb query` (consistent, read only; the check's reader allows query and scan, not get-item). */
export function readRow(reader: RequalifyReader, input: { table: string; region: string; key: { pk: string; sk: string } }): RowRead {
  const result = reader.aws([
    "dynamodb", "query", "--table-name", input.table, "--consistent-read", "--key-condition-expression", "pk = :pk AND sk = :sk",
    "--expression-attribute-values", JSON.stringify({ ":pk": { S: input.key.pk }, ":sk": { S: input.key.sk } }), "--region", input.region, "--output", "json",
  ], true);
  if (result.status !== 0) return { state: "unreadable", reason: result.stderr.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "no error text" };
  try {
    const items = (JSON.parse(result.stdout) as { Items?: Array<Record<string, DynamoValue>> }).Items ?? [];
    return items[0] === undefined ? { state: "absent" } : { state: "found", item: plainItem(items[0]) };
  } catch {
    return { state: "unreadable", reason: "the answer was not JSON" };
  }
}

export type LockFact = { state: "free" } | { state: "held"; runId: string; expiresAt: string } | { state: "unreadable"; reason: string };

/** The single-flight lock: free when there is no row or its time is up; a row that is not exactly a lock is unreadable, never free. */
export function lockFact(read: RowRead, now: Date): LockFact {
  if (read.state === "absent") return { state: "free" };
  if (read.state === "unreadable") return { state: "unreadable", reason: read.reason };
  const { pk: _pk, sk: _sk, ...fields } = read.item;
  void _pk; void _sk;
  const parsed = RequalifyLockSchema.safeParse(fields);
  if (!parsed.success) return { state: "unreadable", reason: "the lock row is not a renewal lock" };
  return Date.parse(parsed.data.expiresAt) <= now.getTime() ? { state: "free" } : { state: "held", runId: parsed.data.runId, expiresAt: parsed.data.expiresAt };
}

export type LastRunFact =
  | { state: "none" }
  | { state: "found"; runId: string; switchedAt: string; generation: number; newRunner: string; previousRunner: string | null; amiId: string | null; workerImage: string | null; executorImage: string | null; pointerRunner: string | undefined }
  | { state: "unreadable"; reason: string };

export type RequalifyFacts =
  | { state: "not-installed"; plannedGrants?: readonly Finding[] | undefined }
  | { state: "installed"; lock: LockFact; hold: "none" | "present" | "unreadable"; lastRun: LastRunFact };

/**
 * The last renewal, reached from the model-check runner pointer: the switch writes `requalifyRunId` into it, and the run record is the audit row of that switch. A pointer a script wrote
 * has no run id (nothing renewed it automatically yet); a run id whose record is missing or does not parse is unreadable, never "no run".
 */
export function readLastRun(reader: RequalifyReader, input: { table: string; region: string }): LastRunFact {
  const pointer = readRow(reader, { ...input, key: e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID) });
  if (pointer.state === "unreadable") return { state: "unreadable", reason: `the runner pointer could not be read: ${pointer.reason}` };
  if (pointer.state === "absent") return { state: "none" };
  const runId = pointer.item["requalifyRunId"];
  if (runId === undefined) return { state: "none" };
  if (typeof runId !== "string") return { state: "unreadable", reason: "the runner pointer's requalifyRunId is not text" };
  const row = readRow(reader, { ...input, key: requalifyRunKey(runId) });
  if (row.state === "unreadable") return { state: "unreadable", reason: `the run record could not be read: ${row.reason}` };
  if (row.state === "absent") return { state: "unreadable", reason: "the runner pointer names a renewal whose record is missing" };
  const { pk: _pk, sk: _sk, ...fields } = row.item;
  void _pk; void _sk;
  const record = RequalifyRunRecordSchema.safeParse(fields);
  if (!record.success) return { state: "unreadable", reason: "the run record is not a renewal record" };
  const pointerInstance = pointer.item["instanceId"];
  return {
    state: "found", runId: record.data.runId, switchedAt: record.data.switchedAt, generation: record.data.generation, newRunner: record.data.newRunner.instanceId,
    previousRunner: record.data.previousRunner?.instanceId ?? null, amiId: record.data.amiId, workerImage: record.data.images.worker, executorImage: record.data.images.executor,
    pointerRunner: typeof pointerInstance === "string" ? pointerInstance : undefined,
  };
}

/** Everything the check says about an installed renewal, from three reads: the lock, the drain hold and the last renewal. */
export function readInstalledFacts(reader: RequalifyReader, input: { table: string; region: string; now: Date }): Extract<RequalifyFacts, { state: "installed" }> {
  const hold = readRow(reader, { ...input, key: requalifyHoldKey(REQUALIFY_PROFILE_ID) });
  return {
    state: "installed",
    lock: lockFact(readRow(reader, { ...input, key: requalifyLockKey(REQUALIFY_PROFILE_ID) }), input.now),
    hold: hold.state === "absent" ? "none" : hold.state === "found" ? "present" : "unreadable",
    lastRun: readLastRun(reader, input),
  };
}

/** The findings about the renewal. Information, except what cannot be read (a warning: silence would look like health). */
export function requalifyFindings(facts: RequalifyFacts | undefined, renewNow: string): Finding[] {
  if (facts === undefined) return [];
  const finding = (kind: Finding["kind"], severity: Finding["severity"], message: string): Finding => ({ kind, severity, subject: "requalify", label: "requalify", message });
  if (facts.state === "not-installed") {
    return [finding("requalify-not-installed", "info", "the automatic test machine renewal is not installed on this stack; the runtime is renewed by hand. `--only requalify-infra` adds it (an Add-only change set; its IAM statements are listed below for review).")];
  }
  const findings: Finding[] = [];
  if (facts.lock.state === "held") findings.push(finding("requalify-running", "info", `a renewal (run ${facts.lock.runId}) holds the lock until ${facts.lock.expiresAt}; do not deploy images or start another until it ends`));
  if (facts.lock.state === "unreadable") findings.push(finding("requalify-unreadable", "warning", `the renewal lock cannot be read: ${facts.lock.reason}`));
  if (facts.hold === "present") findings.push(finding("requalify-running", "info", "a renewal's drain hold is in place: application checks and project setup are deferred until it ends or its time is up"));
  if (facts.hold === "unreadable") findings.push(finding("requalify-unreadable", "warning", "the renewal's drain hold cannot be read"));
  const run = facts.lastRun;
  if (run.state === "none") findings.push(finding("requalify-last-run", "info", `no automatic renewal has switched the runtime yet (the runner was qualified by hand); start the first with: ${renewNow}`));
  else if (run.state === "unreadable") findings.push(finding("requalify-unreadable", "warning", `the last renewal cannot be read: ${run.reason}`));
  else {
    findings.push(finding("requalify-last-run", "info",
      `last automatic renewal: run ${run.runId} switched at ${run.switchedAt} to generation ${run.generation}; runner ${run.newRunner} replaced ${run.previousRunner ?? "no recorded runner"}; AMI ${run.amiId ?? "not recorded"}; worker image ${run.workerImage ?? "none"}; executor image ${run.executorImage ?? "none"}`));
    if (run.pointerRunner !== undefined && run.pointerRunner !== run.newRunner) {
      findings.push(finding("requalify-last-run", "warning", `the model-check runner pointer names ${run.pointerRunner}, not the last renewal's runner ${run.newRunner}: a by-hand qualification replaced it afterwards`));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// requalify-now: the owner's one-run start
// ---------------------------------------------------------------------------------------------

/** What the start step refuses when the lock is held, in words for the owner. */
export function lockHeldMessage(lock: Extract<LockFact, { state: "held" }>): string {
  return `a renewal (run ${lock.runId}) or a by-hand qualification holds the renewal lock until ${lock.expiresAt}; wait for it to end, then run this again`;
}

/** The payload that asks the renewal's Lambda for a forced run; the Lambda starts the machine, whose first step takes the same lock (single-flight). */
export const REQUALIFY_NOW_PAYLOAD = JSON.stringify({ action: "due", force: true });

/** The Lambda's answer to a forced start. Anything else is refused: a start nobody can confirm is not reported as started. */
export function parseStartAnswer(text: string): { started: boolean; reason: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("the renewal Lambda's answer was not JSON, so it is not known whether a renewal started"); }
  const answer = value as { started?: unknown; reason?: unknown } | null;
  if (answer === null || typeof answer !== "object" || typeof answer.started !== "boolean" || typeof answer.reason !== "string") {
    throw new Error("the renewal Lambda's answer was not { started, reason }, so it is not known whether a renewal started");
  }
  return { started: answer.started, reason: answer.reason };
}

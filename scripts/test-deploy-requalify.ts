// AUTOREQUALIFY tooling for test-deploy (AR-5): what the `requalify-infra` and `requalify-now` units are, how the check finds out whether the automatic renewal is installed,
// and how it reports the last renewal. Pure code and read-only AWS reads; nothing here writes. The Lambda unit, the lift context and the step plans are named here so
// scripts/test-deploy.ts only wires them in.
import {
  REQUALIFY_PROFILE_ID, REQUALIFY_TAGS, RequalifyLockSchema, RequalifyRunRecordSchema, RequalifyScheduleEnabledSchema, requalifyHoldKey, requalifyLockKey, requalifyRunKey, requalifyScheduleEnabledKey,
} from "../packages/contracts/src/index.js";
import { e2eModelCheckRunnerKey } from "../packages/broker/src/e2e/model-route-registry.js";
import type { CheckTemplate, Finding } from "./test-deploy-check.js";
import { REQUALIFY_SCHEDULE_CONTEXT_KEY, REQUALIFY_SCHEDULE_LOGICAL_ID, scheduleFindings, scheduleStateOf, type ScheduleFact } from "./test-deploy-requalify-schedule.js";

// The schedule's ID lives with the rest of the schedule logic (ARGUARD); it is exported from here as before.
export { REQUALIFY_SCHEDULE_LOGICAL_ID };

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
  | { state: "installed"; lock: LockFact; hold: "none" | "present" | "unreadable"; lastRun: LastRunFact; /** The daily schedule's state and whether it was ever enabled (ARGUARD); absent where the check did not read it. */ schedule?: ScheduleFact };

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

/** The daily schedule: what the deployed template says and whether it was ever enabled (the record the `requalify-schedule` unit and the renewal's daily check write; one read by key). */
export function readScheduleFact(reader: RequalifyReader, input: { table: string; region: string }, deployedTemplate: CheckTemplate): ScheduleFact {
  const read = readRow(reader, { ...input, key: requalifyScheduleEnabledKey(REQUALIFY_PROFILE_ID) });
  const deployed = scheduleStateOf(deployedTemplate);
  if (read.state === "absent") return { deployed, enabledOnce: { state: "no" } };
  if (read.state === "unreadable") return { deployed, enabledOnce: { state: "unreadable", reason: read.reason } };
  const { pk: _pk, sk: _sk, ...fields } = read.item;
  void _pk; void _sk;
  const parsed = RequalifyScheduleEnabledSchema.safeParse(fields);
  return { deployed, enabledOnce: parsed.success ? { state: "yes", at: parsed.data.at } : { state: "unreadable", reason: "the schedule record is not as the renewal writes it" } };
}

/** The CDK context for a head synth that includes the renewal: the install context, plus the schedule on when it is on or ever was, so a stack update made from the synth does not switch it off. */
export function requalifyHeadContext(scheduleEnabled?: boolean): Record<string, string> {
  return scheduleEnabled === true ? { ...REQUALIFY_INFRA.context, [REQUALIFY_SCHEDULE_CONTEXT_KEY]: "enabled" } : { ...REQUALIFY_INFRA.context };
}

/** The findings about the renewal. Information, except what cannot be read (a warning: silence would look like health) and a schedule that is off after it was on (an error). */
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
  if (run.state === "none") findings.push(finding("requalify-last-run", "info", `the runner pointer records no automatic renewal: none has switched the runtime yet, or a by-hand qualification replaced it afterwards (it rewrites the pointer without the run id); start one with: ${renewNow}`));
  else if (run.state === "unreadable") findings.push(finding("requalify-unreadable", "warning", `the last renewal cannot be read: ${run.reason}`));
  else {
    findings.push(finding("requalify-last-run", "info",
      `last automatic renewal: run ${run.runId} switched at ${run.switchedAt} to generation ${run.generation}; runner ${run.newRunner} replaced ${run.previousRunner ?? "no recorded runner"}; AMI ${run.amiId ?? "not recorded"}; worker image ${run.workerImage ?? "none"}; executor image ${run.executorImage ?? "none"}`));
    if (run.pointerRunner !== undefined && run.pointerRunner !== run.newRunner) {
      findings.push(finding("requalify-last-run", "warning", `the model-check runner pointer names ${run.pointerRunner}, not the last renewal's runner ${run.newRunner}: a by-hand qualification replaced it afterwards`));
    }
  }
  if (facts.schedule !== undefined) findings.push(...scheduleFindings(facts.schedule, renewNow));
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

// ---------------------------------------------------------------------------------------------
// Readiness: what must be true before a renewal may start, by the owner's hand or by the schedule (AR-5 review I1)
// ---------------------------------------------------------------------------------------------

/** The deployed template with the schedule's State set to ENABLED, and every other byte as it is. Refuses unless the schedule is there as a schedule. */
export function enableScheduleTemplate(deployed: CheckTemplate): CheckTemplate {
  const resource = deployed.Resources?.[REQUALIFY_SCHEDULE_LOGICAL_ID];
  if (resource?.Type !== "AWS::Scheduler::Schedule") throw new Error(`the deployed stack has no ${REQUALIFY_SCHEDULE_LOGICAL_ID} schedule; deploy requalify-infra first`);
  const copy = JSON.parse(JSON.stringify(deployed)) as CheckTemplate;
  copy.Resources![REQUALIFY_SCHEDULE_LOGICAL_ID]!.Properties = { ...(resource.Properties ?? {}), State: "ENABLED" };
  return copy;
}

type Tags = Record<string, string>;
export type RunnerTagFacts =
  | { state: "read"; instanceId: string; instanceState: string; instanceTags: Tags; volumes: ReadonlyArray<{ volumeId: string; tags: Tags }> }
  | { state: "unknown"; reason: string };

const tagMap = (list: unknown): Tags => Object.fromEntries((Array.isArray(list) ? list : []).flatMap((tag: unknown) => {
  const entry = tag as { Key?: unknown; Value?: unknown } | null;
  return typeof entry?.Key === "string" && typeof entry.Value === "string" ? [[entry.Key, entry.Value] as const] : [];
}));

/** The current runner (the model-check pointer's instance), its tags and the tags of its volumes that outlive it, from three read-only calls. Anything unreadable is `unknown`, never ready. */
export function readRunnerTags(reader: RequalifyReader, input: { table: string; region: string }): RunnerTagFacts {
  const pointer = readRow(reader, { ...input, key: e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID) });
  if (pointer.state !== "found") return { state: "unknown", reason: pointer.state === "absent" ? "no runner pointer is recorded" : `the runner pointer could not be read: ${pointer.reason}` };
  const instanceId = pointer.item["instanceId"];
  if (typeof instanceId !== "string" || !/^i-[0-9a-f]{8,17}$/.test(instanceId)) return { state: "unknown", reason: "the runner pointer names no instance" };
  const read = (args: readonly string[]): unknown => {
    const result = reader.aws([...args, "--region", input.region, "--output", "json"], true);
    if (result.status !== 0) return undefined;
    try { return JSON.parse(result.stdout); } catch { return undefined; }
  };
  const instance = read(["ec2", "describe-instances", "--instance-ids", instanceId, "--query", "Reservations[].Instances[].{state:State.Name,tags:Tags}"]);
  if (!Array.isArray(instance) || instance.length !== 1) return { state: "unknown", reason: `the runner ${instanceId} could not be read` };
  const volumes = read(["ec2", "describe-volumes", "--filters", `Name=attachment.instance-id,Values=${instanceId}`, "--query", "Volumes[].{id:VolumeId,tags:Tags,root:Attachments[0].DeleteOnTermination}"]);
  if (!Array.isArray(volumes)) return { state: "unknown", reason: `the volumes of ${instanceId} could not be read` };
  const first = instance[0] as { state?: unknown; tags?: unknown };
  return {
    state: "read", instanceId, instanceState: typeof first.state === "string" ? first.state : "unknown", instanceTags: tagMap(first.tags),
    // A volume that goes with the instance (the root) is not deleted separately; the workspace volume is, and only if it carries the tags.
    volumes: volumes.flatMap((volume: unknown) => {
      const entry = volume as { id?: unknown; tags?: unknown; root?: unknown };
      return typeof entry.id === "string" && entry.root !== true ? [{ volumeId: entry.id, tags: tagMap(entry.tags) }] : [];
    }),
  };
}

const missingTags = (tags: Tags, env: string): string[] => [
  ...(tags[REQUALIFY_TAGS.deploymentModeKey] === REQUALIFY_TAGS.deploymentModeValue ? [] : [`${REQUALIFY_TAGS.deploymentModeKey}=${REQUALIFY_TAGS.deploymentModeValue}`]),
  ...(tags[REQUALIFY_TAGS.environmentKey] === env ? [] : [`${REQUALIFY_TAGS.environmentKey}=${env}`]),
  ...(tags[REQUALIFY_TAGS.managedKey] === REQUALIFY_TAGS.managedValue ? [] : [`${REQUALIFY_TAGS.managedKey}=${REQUALIFY_TAGS.managedValue}`]),
];

/**
 * Why a renewal must not start yet, as owner sentences; empty when it may. A renewal builds a new runner and then retires the old one, so before the first: the control-plane stack and its
 * Lambdas must be current with this build (a stale dispatcher or broker would not hold work back, a stale renewal Lambda would not be the code that was reviewed), and the current runner and
 * its workspace volume must carry the tags the retirement requires (without them it builds the new runner and cannot retire the old one).
 */
export function readinessProblems(findings: readonly Finding[], runner: RunnerTagFacts, env: string): string[] {
  const problems: string[] = [];
  const stale = findings.filter((finding) => finding.severity === "error" && (finding.kind === "stale-lambda" || finding.kind === "iam-missing-grant" || finding.kind === "lambda-env-missing"));
  for (const finding of stale) problems.push(`${finding.kind === "stale-lambda" ? "control-plane-code is not current" : "the control-plane stack is not current"}: ${finding.kind} ${finding.label}`);
  if (runner.state === "unknown") return [...problems, `the current runner cannot be checked for its tags: ${runner.reason}`];
  if (runner.instanceState !== "running") problems.push(`the current runner ${runner.instanceId} is ${runner.instanceState}, not running`);
  const instanceMissing = missingTags(runner.instanceTags, env);
  if (instanceMissing.length > 0) problems.push(`the current runner ${runner.instanceId} lacks the tags ${instanceMissing.join(", ")}`);
  for (const volume of runner.volumes) {
    const missing = missingTags(volume.tags, env);
    if (missing.length > 0) problems.push(`the workspace volume ${volume.volumeId} of the current runner lacks the tags ${missing.join(", ")}`);
  }
  if (runner.volumes.length === 0) problems.push(`the current runner ${runner.instanceId} has no separate workspace volume to check`);
  return problems;
}

/** The order the owner follows; printed by --check while the renewal is not yet running on its own, and by the plan of the units that start it. */
export const REQUALIFY_DEPLOY_ORDER = [
  "1. Tier 3 and the control-plane stack update (AR-4 grants, the new alarm, environment variables); the owner runs the guarded change set.",
  "2. control-plane-code (the renewal's Lambda is left out until it is installed).",
  "3. requalify-infra (Add only; the daily schedule is created DISABLED).",
  "4. The owner tags the current runner and its workspace volume: DeploymentMode=e2e-qualification, Environment=<env>, agentx:requalify-managed=true.",
  "5. requalify-now, once, and the live check (new runner registered, generation +1, old runner and volume gone, --check clean).",
  "6. requalify-schedule, to enable the daily check.",
].join("\n");

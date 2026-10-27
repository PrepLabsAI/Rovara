import { createHash, randomUUID } from "node:crypto";
import {
  AttachVolumeCommand, CreateVolumeCommand, DeleteVolumeCommand, DescribeInstancesCommand, DescribeLaunchTemplateVersionsCommand, DescribeVolumesCommand,
  RunInstancesCommand, TerminateInstancesCommand, type EC2Client,
} from "@aws-sdk/client-ec2";
import { GetRoleCommand, type IAMClient } from "@aws-sdk/client-iam";
import { PutMetricDataCommand, type CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import { StartExecutionCommand, type SFNClient } from "@aws-sdk/client-sfn";
import { GetParameterCommand, GetParametersCommand, PutParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  E2E_QUALIFICATION_INSTANCE_ID_PATTERN, E2E_QUALIFICATION_PROFILE_ID, E2E_QUALIFICATION_ROLE_ID_PATTERN, QUALIFICATION_POLL_TIMEOUT_MS, QUALIFICATION_READY_TIMEOUT_MS,
  QUALIFICATION_VOLUME_DEVICE, QUALIFIED_AMI_SETTING_NAME, REQUALIFY_PROFILE_ID, REQUALIFY_REFUSAL_PREFIX, REQUALIFY_STEP_REASON_CODES, REQUALIFY_TAGS, WORKER_SETTING_PARAMETERS,
  WebApiRuntimeInstallProposalSchema, agentXError, buildRunInstancesInput, canonicalJson, chunkParameterNames, e2eQualificationPrefix, launchTemplateShapeProblem, qualificationVolumeTags,
  renderQualificationUserData, requalifyHoldKey, requalifyRunKey, webApiRuntimeInstallProposalSha256,
  type QualificationFacts, type QualificationSettings, type RequalifyReasonCode, type RequalifyRunRecord,
} from "@agentx/contracts";
import { e2eModelCheckRunnerKey } from "../e2e/model-route-registry.js";
import { e2eRegisteredRuntimeKey } from "./e2e-runtime-readiness.js";
import { assertRunStateIsCurrent, bootIdentityOf } from "./runtime-requalify-state.js";
import { issueRequalifyChallenge, nextGeneration, registerRequalifiedRuntime, type RequalifyDependencies } from "./runtime-requalify.js";
import { acquireRequalifyLock, releaseRequalifyLock } from "./runtime-requalify-lock.js";
import { dailyHeartbeat, recordRenewalSuccess } from "./runtime-requalify-heartbeat.js";

/**
 * AUTOREQUALIFY steps (AR-2): the actions the renewal's Step Functions machine calls, one Lambda invocation per action. Every action takes the machine's
 * state and returns it with one more phase filled in. Waiting is the machine's job (Wait states), so each polling action answers once and says
 * `waiting`, `ready`, `failed` or `timeout`; the deadline it checks was set by the step that started the phase.
 *
 * The state holds identifiers, times and fixed codes only. The challenge secret is written to the runner's prefix by `issueRequalifyChallenge` and never
 * returned; a refusal or an AWS fault reaches the machine as an error whose text it never copies into an alert (the alert carries a fixed reason code).
 */

export type RequalifyReason = RequalifyReasonCode | (typeof REQUALIFY_STEP_REASON_CODES)[number];
const REASONS = new Set<string>(["launch-failed", "not-ready", "qualification-failed", "drain-timeout", "drain-read-failed", "retire-failed", "cost-guard", ...REQUALIFY_STEP_REASON_CODES]);

const RUN_WAIT_DEADLINES = { volumeMs: 3 * 60_000, attachMs: 5 * 60_000, terminateMs: 10 * 60_000, qualifyMarginMs: 10 * 60_000, drainMarginMs: 5 * 60_000 } as const;
/** The expiry of a catalog row that makes the daily check start a renewal (day 4 of 7: three daily attempts before the 24 h error). */
export const REQUALIFY_DUE_WINDOW_MS = 72 * 3_600_000;
/** An abandoned renewal alerts only when a row is this close to the 24 h error. */
export const REQUALIFY_ALERT_WINDOW_MS = 48 * 3_600_000;
const AL2023_AMI = /^ami-[0-9a-f]{8,17}$/;
const ACTIVE_RUNNER_STATES = ["pending", "running", "stopping", "stopped"];

export interface RequalifyConfig {
  workerRoleArn: string;
  /** `/agentx/<env>/`: where the worker settings and the qualified AMI setting live. */
  workerSettingsPrefix: string;
  /** The public SSM parameter naming the newest AL2023 arm64 AMI. */
  amiParameterName: string;
  controlPlaneUrl: string;
  logGroupName: string;
  operatorTopicArn: string;
  metricsNamespace: string;
  stateMachineArn: string;
}

/** What the drain step needs from the dispatchers (AR-3): the work that began before the hold and has not finished. `unknown` never counts as drained. */
export interface RequalifyDrainPort {
  activeWork(): Promise<number | "unknown">;
}

export interface RequalifyStepsDependencies extends RequalifyDependencies {
  config: RequalifyConfig;
  ec2: Pick<EC2Client, "send">;
  ssm: Pick<SSMClient, "send">;
  iam: Pick<IAMClient, "send">;
  sns: Pick<SNSClient, "send">;
  cloudwatch: Pick<CloudWatchClient, "send">;
  sfn: Pick<SFNClient, "send">;
  drain: RequalifyDrainPort;
  bootScript(): string;
  invokePublicKey(): Promise<string>;
  /** Reads the proposal the runner uploaded and its digest; refuses anything that is not a READY web/API proposal. Tests substitute it. */
  parseProposal?(bytes: Buffer): { proposal: unknown; sha256: string };
}

/** The proposal as the product defines it: the schema parses it, and the digest is over the parsed form (the registrar re-checks both). */
function parseRunnerProposal(bytes: Buffer): { proposal: unknown; sha256: string } {
  // The proposal holds the challenge secret and a parser's or schema's message can quote the input around the fault: only fixed messages leave this function.
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("the proposal is not valid JSON"); }
  const parsed = WebApiRuntimeInstallProposalSchema.safeParse(value);
  if (!parsed.success) throw new Error("the proposal is not a READY web/API qualification");
  return { proposal: parsed.data, sha256: webApiRuntimeInstallProposalSha256(parsed.data) };
}

const Iso = z.string().datetime();
const Instance = z.string().regex(E2E_QUALIFICATION_INSTANCE_ID_PATTERN);
const Role = z.string().regex(E2E_QUALIFICATION_ROLE_ID_PATTERN);
const Poll = z.enum(["waiting", "ready", "failed", "timeout"]);
const Termination = z.object({ instanceId: Instance.optional(), roleId: Role.optional(), volumeIds: z.array(z.string().regex(/^vol-[0-9a-f]{8,17}$/)).max(8), deadlineAt: Iso, status: Poll.optional() });
export type TerminationState = z.infer<typeof Termination>;

const StateSchema = z.looseObject({
  runId: z.string().uuid(),
  lock: z.object({ acquired: z.boolean() }).optional(),
  preflight: z.object({ settingsDigest: z.string().regex(/^[a-f0-9]{64}$/), workerRoleId: Role, refused: z.literal("cost-guard").optional() }).optional(),
  ami: z.object({ amiId: z.string().regex(AL2023_AMI) }).optional(),
  volume: z.object({ volumeId: z.string().regex(/^vol-[0-9a-f]{8,17}$/), deadlineAt: Iso, status: Poll.optional() }).optional(),
  // workspaceId and generation are absent in a run the previous code started (see runtime-requalify-state.ts): the state must still parse so the failure path can run.
  instance: z.object({ instanceId: Instance, workspaceId: z.string().uuid().optional(), generation: z.number().int().positive().optional(), attachDeadlineAt: Iso, readyDeadlineAt: Iso, attachStatus: Poll.optional(), readyStatus: Poll.optional() }).optional(),
  challenge: z.object({ challengeId: z.string().uuid(), expiresAt: Iso, generation: z.number().int().positive(), transportCorrelationId: z.string().uuid(), qualifyDeadlineAt: Iso, drainDeadlineAt: Iso }).optional(),
  qualification: z.object({ status: Poll, failure: z.array(z.string()).max(16).optional() }).optional(),
  drain: z.object({ status: Poll.optional() }).optional(),
  switch: z.object({ switched: z.boolean(), generation: z.number().int().positive().optional(), previous: z.object({ instanceId: Instance, roleId: Role }).nullable().optional() }).optional(),
  previousTermination: Termination.optional(),
  newTermination: Termination.optional(),
  reason: z.string().optional(),
  error: z.unknown().optional(),
});
export type RequalifyState = z.infer<typeof StateSchema>;

const ActionSchema = z.object({
  action: z.enum(["due", "lock", "preflight", "pinAmi", "createVolume", "awaitVolume", "runInstance", "attachVolume", "awaitReady", "issueChallenge", "awaitQualification", "putHold", "awaitDrain",
    "switch", "recoverSwitch", "recordAmi", "terminatePrevious", "awaitTerminatedPrevious", "complete", "failAlert", "terminateNew", "awaitTerminatedNew", "releaseLock"]),
  state: z.unknown().optional(),
  force: z.boolean().optional(),
}).strict();

/** The steps that carry a launched runner towards the switch: a run whose state predates the workspace id and generation is refused here, cleanly. */
const CONTINUING_ACTIONS: ReadonlySet<string> = new Set(["attachVolume", "awaitReady", "issueChallenge", "awaitQualification", "putHold", "awaitDrain"]);

const nowOf = (deps: RequalifyStepsDependencies): number => deps.now?.() ?? Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

export async function runRequalifyAction(deps: RequalifyStepsDependencies, event: unknown): Promise<unknown> {
  const { action, state: rawState, force } = ActionSchema.parse(event);
  if (action === "due") return dueAction(deps, force === true);
  const state = StateSchema.parse(rawState);
  if (CONTINUING_ACTIONS.has(action)) assertRunStateIsCurrent(state);
  const out = await perform(deps, action, state);
  return { ...state, ...out };
}

async function perform(deps: RequalifyStepsDependencies, action: Exclude<z.infer<typeof ActionSchema>["action"], "due">, state: RequalifyState): Promise<Partial<RequalifyState>> {
  switch (action) {
    case "lock": return { lock: { acquired: await acquireRequalifyLock(deps, state.runId) } };
    case "preflight": return { preflight: await preflight(deps) };
    case "pinAmi": return { ami: await pinAmi(deps) };
    case "createVolume": return { volume: await createVolume(deps, state) };
    case "awaitVolume": return { volume: await awaitVolume(deps, need(state.volume, "volume")) };
    case "runInstance": return { instance: await runInstance(deps, state) };
    case "attachVolume": return { instance: await attachVolume(deps, state) };
    case "awaitReady": return { instance: await awaitReady(deps, state) };
    case "issueChallenge": return { challenge: await issueChallenge(deps, state) };
    case "awaitQualification": return { qualification: await awaitQualification(deps, state) };
    case "putHold": await putHold(deps, state); return { drain: {} };
    case "awaitDrain": return { drain: await awaitDrain(deps, state) };
    case "switch": return { switch: await switchRuntime(deps, state) };
    case "recoverSwitch": return { switch: await recoverSwitch(deps, state) };
    case "recordAmi": await recordAmi(deps, state); return {};
    case "terminatePrevious": return { previousTermination: await terminatePrevious(deps, state) };
    case "awaitTerminatedPrevious": return { previousTermination: await awaitTerminated(deps, state, need(state.previousTermination, "previousTermination"), "previous") };
    case "complete": await complete(deps, state); return {};
    case "failAlert": await failAlert(deps, state); return {};
    case "terminateNew": { const newTermination = await terminateNew(deps, state); return newTermination === undefined ? {} : { newTermination }; }
    case "awaitTerminatedNew": return state.newTermination === undefined ? {} : { newTermination: await awaitTerminated(deps, state, state.newTermination, "new") };
    case "releaseLock": await releaseRequalifyLock(deps, state.runId); return {};
  }
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`requalify state has no ${what}; the machine's steps are out of order`);
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Reading the environment
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Every worker setting as stored (absent names are left out). The digest of this map is what a deploy during the run changes. */
async function readWorkerSettingValues(deps: RequalifyStepsDependencies): Promise<Record<string, string>> {
  const names = Object.fromEntries(Object.entries(WORKER_SETTING_PARAMETERS).map(([key, name]) => [key, `${deps.config.workerSettingsPrefix}${name}`]));
  const found = new Map<string, string>();
  for (const chunk of chunkParameterNames(Object.values(names))) {
    for (const parameter of (await deps.ssm.send(new GetParametersCommand({ Names: chunk }))).Parameters ?? []) if (parameter.Name !== undefined && parameter.Value !== undefined) found.set(parameter.Name, parameter.Value);
  }
  return Object.fromEntries(Object.entries(names).flatMap(([key, name]) => { const value = found.get(name); return value === undefined ? [] : [[key, value] as const]; }));
}

const digestOf = (values: Record<string, string>): string => createHash("sha256").update(canonicalJson(values)).digest("hex");

function qualificationSettings(values: Record<string, string>): QualificationSettings {
  const required = (key: keyof typeof WORKER_SETTING_PARAMETERS): string => {
    const value = values[key];
    if (!value) throw new Error(`worker setting ${key} is missing`);
    return value;
  };
  const optional = (key: keyof typeof WORKER_SETTING_PARAMETERS): string | undefined => { const value = values[key]; return value && value !== "none" ? value : undefined; };
  const retention = required("promptCacheRetention");
  if (retention !== "short" && retention !== "long") throw new Error("worker prompt cache retention must be short or long");
  const executorImage = optional("executorImage");
  if (executorImage === undefined) throw new Error("the executor image is not set in this environment");
  return {
    workerImage: required("workerImage"), executorImage, modelProvider: required("modelProvider"), modelId: required("modelId"), promptCacheRetention: retention,
    openRouterSecretArn: optional("openRouterSecretArn"), openRouterProviders: optional("openRouterProviders"), anthropicSecretArn: optional("anthropicSecretArn"), openaiSecretArn: optional("openaiSecretArn"),
  };
}

const launchSubnet = (deps: RequalifyStepsDependencies) => [...deps.expectedBinding.subnets].sort((a, b) => a.availabilityZone.localeCompare(b.availabilityZone))[0]!;

interface InspectedInstance { state: string; tags: Record<string, string>; volumeIds: string[]; privateIp: string | undefined }

async function inspectInstance(deps: RequalifyStepsDependencies, instanceId: string): Promise<InspectedInstance | undefined> {
  let response;
  try { response = await deps.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] })); }
  catch (error) {
    if ((error as { name?: string }).name === "InvalidInstanceID.NotFound") return undefined;
    throw error;
  }
  const instance = response.Reservations?.flatMap((reservation) => reservation.Instances ?? []).find((item) => item.InstanceId === instanceId);
  if (instance === undefined) return undefined;
  const tags: Record<string, string> = {};
  for (const tag of instance.Tags ?? []) if (tag.Key !== undefined && tag.Value !== undefined) tags[tag.Key] = tag.Value;
  const root = instance.RootDeviceName;
  const volumeIds = (instance.BlockDeviceMappings ?? []).flatMap((mapping) => mapping.DeviceName !== root && mapping.Ebs?.VolumeId !== undefined ? [mapping.Ebs.VolumeId] : []);
  return { state: instance.State?.Name ?? "unknown", tags, volumeIds, privateIp: instance.PrivateIpAddress };
}

/** The three tags IAM requires to terminate or delete (and the environment). A resource missing any of them is not the renewal's to end. */
const isManaged = (tags: Record<string, string>, environment: string): boolean =>
  tags[REQUALIFY_TAGS.deploymentModeKey] === REQUALIFY_TAGS.deploymentModeValue && tags[REQUALIFY_TAGS.environmentKey] === environment && tags[REQUALIFY_TAGS.managedKey] === REQUALIFY_TAGS.managedValue;

async function getObject(deps: RequalifyStepsDependencies, key: string): Promise<Buffer | undefined> {
  try {
    const response = await deps.s3.send(new GetObjectCommand({ Bucket: deps.artifactBucketName, Key: key }));
    return Buffer.from(await response.Body!.transformToByteArray());
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return undefined;
    throw error;
  }
}

/** The status.json the runner's hook uploads. Anything else is not a status; codes are filtered to the hook's own grammar before they reach state. */
function parseStatus(bytes: Buffer): { state: "SUCCEEDED" | "FAILED"; failure: string[] } {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("the qualification status is not valid JSON"); }
  const status = value as { state?: unknown; failure?: unknown } | null;
  if (status === null || typeof status !== "object" || (status.state !== "SUCCEEDED" && status.state !== "FAILED")) throw new Error("the qualification status is neither SUCCEEDED nor FAILED");
  const codes = status.failure !== null && typeof status.failure === "object" ? (status.failure as { codes?: unknown }).codes : undefined;
  const failure = Array.isArray(codes) ? codes.filter((code): code is string => typeof code === "string" && code.length <= 97 && /^[a-z0-9-]+(:[a-z0-9-]+)?$/.test(code)).slice(0, 16) : [];
  return { state: status.state, failure };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The daily check
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Starts a renewal when a catalog row expires within 72 hours, the deployed images differ from the last renewal's, or the operator forced one. Single-flight by execution name and by the lock. */
async function dueAction(deps: RequalifyStepsDependencies, force: boolean): Promise<{ started: boolean; reason: string }> {
  // The schedule's own run (not the operator's forced start) reports how old the last renewal is (ARGUARD); it never fails the check.
  if (!force) await dailyHeartbeat(deps);
  const now = nowOf(deps);
  let reason: string | undefined = force ? "requested" : undefined;
  if (reason === undefined) {
    const expiries = await Promise.all((["web", "api"] as const).map(async (kind) => {
      const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eRegisteredRuntimeKey(deps.featureCatalogId, REQUALIFY_PROFILE_ID, kind), ConsistentRead: true }))).Item;
      return typeof item?.["expiresAt"] === "string" ? Date.parse(item["expiresAt"]) : undefined;
    }));
    if (expiries.some((expiry) => expiry !== undefined && (Number.isNaN(expiry) || expiry - now <= REQUALIFY_DUE_WINDOW_MS))) reason = "expiring";
  }
  if (reason === undefined && await imagesChangedSinceLastRenewal(deps)) reason = "images-changed";
  if (reason === undefined) return { started: false, reason: "not-due" };
  const stamp = iso(now).replace(/[-:T]/g, "").slice(0, 10);
  try {
    await deps.sfn.send(new StartExecutionCommand({
      stateMachineArn: deps.config.stateMachineArn, name: `requalify-${deps.environment}-${stamp}`, input: JSON.stringify({ runId: randomUUID(), trigger: reason }),
    }));
    return { started: true, reason };
  } catch (error) {
    if ((error as { name?: string }).name === "ExecutionAlreadyExists") return { started: false, reason: "already-started" };
    throw error;
  }
}

/** The images the last renewal qualified against are in its run record (reached from the model-check pointer); a runner the script recorded has none, which counts as no change. */
async function imagesChangedSinceLastRenewal(deps: RequalifyStepsDependencies): Promise<boolean> {
  const pointer = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID), ConsistentRead: true }))).Item;
  const runId: unknown = pointer?.["requalifyRunId"];
  if (typeof runId !== "string") return false;
  const record = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: requalifyRunKey(runId), ConsistentRead: true }))).Item as Partial<RequalifyRunRecord> | undefined;
  if (record?.images === undefined) return false;
  const values = await readWorkerSettingValues(deps);
  const executor = values["executorImage"] && values["executorImage"] !== "none" ? values["executorImage"] : null;
  return (values["workerImage"] ?? null) !== record.images.worker || executor !== record.images.executor;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Preflight and launch
// ---------------------------------------------------------------------------------------------------------------------------------------------------

async function activeRunnerCount(deps: RequalifyStepsDependencies): Promise<number> {
  let count = 0;
  let token: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const response = await deps.ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${REQUALIFY_TAGS.deploymentModeKey}`, Values: [REQUALIFY_TAGS.deploymentModeValue] },
        { Name: `tag:${REQUALIFY_TAGS.environmentKey}`, Values: [deps.environment] },
        { Name: "instance-state-name", Values: ACTIVE_RUNNER_STATES },
      ],
      ...(token === undefined ? {} : { NextToken: token }),
    }));
    count += (response.Reservations ?? []).reduce((sum, reservation) => sum + (reservation.Instances?.length ?? 0), 0);
    token = response.NextToken;
    if (token === undefined) return count;
  }
  return count + 2;
}

async function preflight(deps: RequalifyStepsDependencies): Promise<NonNullable<RequalifyState["preflight"]>> {
  const template = (await deps.ec2.send(new DescribeLaunchTemplateVersionsCommand({ LaunchTemplateId: deps.expectedBinding.launchTemplateId, Versions: ["$Default"] }))).LaunchTemplateVersions?.[0]?.LaunchTemplateData;
  const problem = launchTemplateShapeProblem(template);
  if (problem !== undefined) throw new Error(problem);
  // The binding is derived from deployment settings; a registered runtime built from another binding means the derivation is wrong, and every project would stop matching it.
  const webRow = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eRegisteredRuntimeKey(deps.featureCatalogId, REQUALIFY_PROFILE_ID, "web"), ConsistentRead: true }))).Item;
  if (webRow !== undefined && webRow["bindingDigest"] !== createHash("sha256").update(canonicalJson(deps.expectedBinding)).digest("hex")) throw new Error("the derived runtime binding differs from the registered runtime's");
  const values = await readWorkerSettingValues(deps);
  qualificationSettings(values);
  const roleName = /\/([A-Za-z0-9+=,.@_-]{1,64})$/.exec(deps.config.workerRoleArn)?.[1];
  if (roleName === undefined) throw new Error("the worker role ARN has no role name");
  const role = (await deps.iam.send(new GetRoleCommand({ RoleName: roleName }))).Role;
  if (role?.Arn !== deps.config.workerRoleArn || role.RoleId === undefined || !E2E_QUALIFICATION_ROLE_ID_PATTERN.test(role.RoleId)) throw new Error("the worker role is not the foundation's");
  const base = { settingsDigest: digestOf(values), workerRoleId: role.RoleId };
  // The cost guard: the old runner plus the one this run would launch is the most there may ever be.
  return (await activeRunnerCount(deps)) >= 2 ? { ...base, refused: "cost-guard" } : base;
}

async function pinAmi(deps: RequalifyStepsDependencies): Promise<{ amiId: string }> {
  const amiId = (await deps.ssm.send(new GetParameterCommand({ Name: deps.config.amiParameterName }))).Parameter?.Value;
  if (amiId === undefined || !AL2023_AMI.test(amiId)) throw new Error("the AMI parameter does not name an AMI");
  return { amiId };
}

async function createVolume(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<NonNullable<RequalifyState["volume"]>> {
  const created = await deps.ec2.send(new CreateVolumeCommand({
    AvailabilityZone: launchSubnet(deps).availabilityZone, Size: deps.expectedBinding.volumeSizeGiB, VolumeType: "gp3", Encrypted: true, ClientToken: state.runId,
    TagSpecifications: [{ ResourceType: "volume", Tags: Object.entries(qualificationVolumeTags({ env: deps.environment, runId: state.runId })).map(([Key, Value]) => ({ Key, Value })) }],
  }));
  if (created.VolumeId === undefined) throw new Error("CreateVolume returned no volume ID");
  return { volumeId: created.VolumeId, deadlineAt: iso(nowOf(deps) + RUN_WAIT_DEADLINES.volumeMs) };
}

function pollResult(deps: RequalifyStepsDependencies, deadlineAt: string, done: boolean, failed = false): z.infer<typeof Poll> {
  if (failed) return "failed";
  if (done) return "ready";
  return nowOf(deps) >= Date.parse(deadlineAt) ? "timeout" : "waiting";
}

async function awaitVolume(deps: RequalifyStepsDependencies, volume: NonNullable<RequalifyState["volume"]>): Promise<NonNullable<RequalifyState["volume"]>> {
  const found = (await deps.ec2.send(new DescribeVolumesCommand({ VolumeIds: [volume.volumeId] }))).Volumes?.[0]?.State;
  return { ...volume, status: pollResult(deps, volume.deadlineAt, found === "available") };
}

/** The qualification facts the user data needs. The invoke public key, the settings and the role's unique ID are read now; the settings must still be the preflight's. */
async function qualificationFacts(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<QualificationFacts> {
  const pre = need(state.preflight, "preflight");
  const values = await readWorkerSettingValues(deps);
  if (digestOf(values) !== pre.settingsDigest) throw new Error("the worker settings changed during the run");
  const subnet = launchSubnet(deps);
  return {
    region: "", artifactBucket: deps.artifactBucketName, controlPlaneUrl: deps.config.controlPlaneUrl, invokePublicKey: await deps.invokePublicKey(), logGroupName: deps.config.logGroupName,
    launchTemplateId: deps.expectedBinding.launchTemplateId, workerRoleId: pre.workerRoleId, binding: deps.expectedBinding, subnet, volumeSizeGiB: deps.expectedBinding.volumeSizeGiB,
    settings: qualificationSettings(values),
  };
}

async function runInstance(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<NonNullable<RequalifyState["instance"]>> {
  const facts = await qualificationFacts(deps, state);
  const volume = need(state.volume, "volume");
  // One workspace id and one generation for the run: the runner is booted with them and the challenge is issued with them (the runner compares the two). The lock is held, so the generation is stable.
  const workspaceId = randomUUID();
  const generation = await nextGeneration(deps);
  const userData = renderQualificationUserData(facts, { workspaceId, volumeId: volume.volumeId, generation, qualification: { profile: E2E_QUALIFICATION_PROFILE_ID } }, deps.bootScript());
  const request = buildRunInstancesInput(facts, { env: deps.environment, runId: state.runId, revision: "requalify", userData, imageId: need(state.ami, "ami").amiId });
  const launched = await deps.ec2.send(new RunInstancesCommand(request));
  const instances = launched.Instances ?? [];
  if (instances.length !== 1 || instances[0]?.InstanceId === undefined) throw new Error(`RunInstances returned ${instances.length} instances, expected exactly one`);
  const now = nowOf(deps);
  return { instanceId: instances[0].InstanceId, workspaceId, generation, attachDeadlineAt: iso(now + RUN_WAIT_DEADLINES.attachMs), readyDeadlineAt: iso(now + RUN_WAIT_DEADLINES.attachMs + QUALIFICATION_READY_TIMEOUT_MS) };
}

async function attachVolume(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<NonNullable<RequalifyState["instance"]>> {
  const instance = need(state.instance, "instance");
  const found = await inspectInstance(deps, instance.instanceId);
  const current = found?.state ?? "pending";
  if (current === "pending") return { ...instance, attachStatus: pollResult(deps, instance.attachDeadlineAt, false) };
  if (current !== "running") return { ...instance, attachStatus: "failed" };
  await deps.ec2.send(new AttachVolumeCommand({ VolumeId: need(state.volume, "volume").volumeId, InstanceId: instance.instanceId, Device: QUALIFICATION_VOLUME_DEVICE }));
  return { ...instance, attachStatus: "ready" };
}

async function awaitReady(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<NonNullable<RequalifyState["instance"]>> {
  const instance = need(state.instance, "instance");
  const prefix = e2eQualificationPrefix(need(state.preflight, "preflight").workerRoleId, instance.instanceId);
  if ((await getObject(deps, `${prefix}ready.json`)) !== undefined) return { ...instance, readyStatus: "ready" };
  // A worker that failed before it was ready says so in status.json: stop at once instead of waiting out the clock.
  const status = await getObject(deps, `${prefix}status.json`);
  if (status !== undefined && parseStatus(status).state === "FAILED") return { ...instance, readyStatus: "failed" };
  return { ...instance, readyStatus: pollResult(deps, instance.readyDeadlineAt, false) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Challenge, qualification, drain, switch
// ---------------------------------------------------------------------------------------------------------------------------------------------------

async function issueChallenge(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<NonNullable<RequalifyState["challenge"]>> {
  const instance = need(state.instance, "instance");
  const issued = await issueRequalifyChallenge(deps, { runId: state.runId, instanceId: instance.instanceId, roleId: need(state.preflight, "preflight").workerRoleId, ...bootIdentityOf(instance) });
  const expires = Date.parse(issued.expiresAt);
  return {
    challengeId: issued.challengeId, expiresAt: issued.expiresAt, generation: issued.generation, transportCorrelationId: issued.transportCorrelationId,
    qualifyDeadlineAt: iso(Math.min(expires - RUN_WAIT_DEADLINES.qualifyMarginMs, nowOf(deps) + QUALIFICATION_POLL_TIMEOUT_MS)), drainDeadlineAt: iso(expires - RUN_WAIT_DEADLINES.drainMarginMs),
  };
}

async function awaitQualification(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<NonNullable<RequalifyState["qualification"]>> {
  const challenge = need(state.challenge, "challenge");
  const prefix = e2eQualificationPrefix(need(state.preflight, "preflight").workerRoleId, need(state.instance, "instance").instanceId);
  const bytes = await getObject(deps, `${prefix}status.json`);
  if (bytes === undefined) return { status: pollResult(deps, challenge.qualifyDeadlineAt, false) };
  const status = parseStatus(bytes);
  return status.state === "SUCCEEDED" ? { status: "ready" } : { status: "failed", failure: status.failure };
}

async function putHold(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<void> {
  const now = nowOf(deps);
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...requalifyHoldKey(REQUALIFY_PROFILE_ID), entityType: "RUNTIME_REQUALIFY_HOLD", runId: state.runId, acquiredAt: iso(now), until: need(state.challenge, "challenge").drainDeadlineAt },
      // The lock makes this run the only one; a hold left by a crashed run is replaced once its time is up.
      ConditionExpression: "attribute_not_exists(pk) OR runId = :runId OR #until <= :now", ExpressionAttributeNames: { "#until": "until" }, ExpressionAttributeValues: { ":runId": state.runId, ":now": iso(now) },
    }));
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new Error("another renewal's hold is in place", { cause: error });
    throw error;
  }
}

async function deleteHold(deps: RequalifyStepsDependencies, runId: string): Promise<void> {
  try {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: requalifyHoldKey(REQUALIFY_PROFILE_ID), ConditionExpression: "runId = :runId", ExpressionAttributeValues: { ":runId": runId } }));
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
  }
}

async function awaitDrain(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<NonNullable<RequalifyState["drain"]>> {
  // A read that was refused or failed is not a drain that ran out of time: it gets its own fixed reason (the AWS error text is never carried). It still throws, so nothing counts 0 and nothing switches.
  const work = await deps.drain.activeWork().catch(() => { throw agentXError("FORBIDDEN", `${REQUALIFY_REFUSAL_PREFIX}drain-read-failed`); });
  return { status: pollResult(deps, need(state.challenge, "challenge").drainDeadlineAt, work === 0) };
}

/** The switch: abandons (no write) if the worker settings moved during the run; otherwise registers in one transaction and lifts the hold. */
async function switchRuntime(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<NonNullable<RequalifyState["switch"]>> {
  const pre = need(state.preflight, "preflight");
  const instance = need(state.instance, "instance");
  const values = await readWorkerSettingValues(deps);
  if (digestOf(values) !== pre.settingsDigest) return { switched: false };
  const prefix = e2eQualificationPrefix(pre.workerRoleId, instance.instanceId);
  const bytes = await getObject(deps, `${prefix}proposal.json`);
  if (bytes === undefined) throw new Error("the qualification succeeded but proposal.json does not exist");
  const { proposal, sha256 } = (deps.parseProposal ?? parseRunnerProposal)(bytes);
  const result = await registerRequalifiedRuntime(deps, {
    runId: state.runId, instanceId: instance.instanceId, roleId: pre.workerRoleId, proposal, proposalSha256: sha256,
    amiId: need(state.ami, "ami").amiId, images: { worker: values["workerImage"] ?? null, executor: values["executorImage"] && values["executorImage"] !== "none" ? values["executorImage"] : null },
  });
  // The hold also expires by itself, and the one-use challenge is consumed: a failure to delete either is not a failed switch.
  try { await deleteHold(deps, state.runId); } catch { /* expires at its own time */ }
  try { await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.artifactBucketName, Key: `${prefix}challenge.json` })); } catch { /* consumed already */ }
  return { switched: true, generation: result.generation, previous: result.previousRunner === null ? null : { instanceId: result.previousRunner.instanceId, roleId: result.previousRunner.roleId } };
}

/**
 * The switch step failed or its answer was lost. The audit record is written in the switch's own transaction, so it exists exactly when the switch
 * committed: if it does, carry on to the retirement from it (the previous runner is in it); if not, nothing was switched.
 */
async function recoverSwitch(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<NonNullable<RequalifyState["switch"]>> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: requalifyRunKey(state.runId), ConsistentRead: true }))).Item as Partial<RequalifyRunRecord> | undefined;
  if (item?.runId !== state.runId || typeof item.generation !== "number") return { switched: false };
  try { await deleteHold(deps, state.runId); } catch { /* expires at its own time */ }
  const previous = item.previousRunner;
  return { switched: true, generation: item.generation, previous: previous === null || previous === undefined ? null : { instanceId: previous.instanceId, roleId: previous.roleId } };
}

async function recordAmi(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<void> {
  await deps.ssm.send(new PutParameterCommand({ Name: `${deps.config.workerSettingsPrefix}${QUALIFIED_AMI_SETTING_NAME}`, Type: "String", Overwrite: true, Value: need(state.ami, "ami").amiId }));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Retiring a runner (the old one after a switch, or the new one after a failure)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Ends one runner and records what to delete next. Refuses (throws) unless it carries every renewal tag for this environment; a runner that is already gone only has its volumes left. */
async function terminate(deps: RequalifyStepsDependencies, target: { instanceId: string; roleId: string | undefined }, runIdTag: string | undefined): Promise<TerminationState> {
  const found = await inspectInstance(deps, target.instanceId);
  const deadlineAt = iso(nowOf(deps) + RUN_WAIT_DEADLINES.terminateMs);
  const base = { instanceId: target.instanceId, ...(target.roleId === undefined ? {} : { roleId: target.roleId }) };
  if (found === undefined || found.state === "terminated") return { ...base, volumeIds: [], deadlineAt };
  if (!isManaged(found.tags, deps.environment) || (runIdTag !== undefined && found.tags[REQUALIFY_TAGS.runKey] !== runIdTag)) throw new Error("the runner does not carry the renewal's tags; it is not ended automatically");
  if (found.state !== "shutting-down") await deps.ec2.send(new TerminateInstancesCommand({ InstanceIds: [target.instanceId] }));
  return { ...base, volumeIds: found.volumeIds.slice(0, 8), deadlineAt };
}

async function terminatePrevious(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<TerminationState> {
  const sw = need(state.switch, "switch");
  // Nothing to retire (no switch, or no earlier runner on record): already "ready" for the awaiting step.
  if (!sw.switched || sw.previous === undefined || sw.previous === null) return { volumeIds: [], deadlineAt: iso(nowOf(deps)), status: "ready" };
  if (sw.previous.instanceId === state.instance?.instanceId) throw new Error("the previous runner is the new one");
  return terminate(deps, sw.previous, undefined);
}

/** An instance this run launched whose ID never reached the state (RunInstances can fail after it created one), found by the run's tag. */
async function findRunInstance(deps: RequalifyStepsDependencies, runId: string): Promise<string | undefined> {
  const response = await deps.ec2.send(new DescribeInstancesCommand({ Filters: [
    { Name: `tag:${REQUALIFY_TAGS.runKey}`, Values: [runId] }, { Name: `tag:${REQUALIFY_TAGS.environmentKey}`, Values: [deps.environment] }, { Name: "instance-state-name", Values: ACTIVE_RUNNER_STATES },
  ] }));
  return response.Reservations?.flatMap((reservation) => reservation.Instances ?? []).find((instance) => instance.InstanceId !== undefined)?.InstanceId;
}

/** The new runner and its volume are ended only if the switch did not commit and the pointer does not name the runner: after a switch it is the one serving. */
async function terminateNew(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<TerminationState | undefined> {
  if (state.switch?.switched === true) return undefined;
  const instanceId = state.instance?.instanceId ?? (state.volume === undefined ? undefined : await findRunInstance(deps, state.runId));
  const volumeIds = state.volume === undefined ? [] : [state.volume.volumeId];
  if (instanceId === undefined && volumeIds.length === 0) return undefined;
  const deadlineAt = iso(nowOf(deps) + RUN_WAIT_DEADLINES.terminateMs);
  if (instanceId === undefined) return { volumeIds, deadlineAt };
  const pointer = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID), ConsistentRead: true }))).Item;
  if (pointer?.["instanceId"] === instanceId) return undefined;
  const ended = await terminate(deps, { instanceId, roleId: state.preflight?.workerRoleId }, state.runId);
  // A volume attached to the new runner is only ever the one this run created.
  return { ...ended, volumeIds: [...new Set([...ended.volumeIds, ...volumeIds])].slice(0, 8) };
}

async function awaitTerminated(deps: RequalifyStepsDependencies, state: RequalifyState, termination: TerminationState, which: "previous" | "new"): Promise<TerminationState> {
  if (termination.status === "ready") return termination;
  const found = termination.instanceId === undefined ? undefined : await inspectInstance(deps, termination.instanceId);
  if (found !== undefined && found.state !== "terminated") return { ...termination, status: pollResult(deps, termination.deadlineAt, false) };
  // Gone: delete the workspace volumes, each only if it carries the renewal's tags (and, for the new runner, this run).
  for (const volumeId of termination.volumeIds) {
    let volume;
    try { volume = (await deps.ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }))).Volumes?.[0]; }
    catch (error) {
      if ((error as { name?: string }).name === "InvalidVolume.NotFound") continue;
      throw error;
    }
    if (volume === undefined) continue;
    const tags = Object.fromEntries((volume.Tags ?? []).flatMap((tag) => tag.Key !== undefined && tag.Value !== undefined ? [[tag.Key, tag.Value] as const] : []));
    if (!isManaged(tags, deps.environment) || (which === "new" && tags[REQUALIFY_TAGS.runKey] !== state.runId)) return { ...termination, status: "failed" };
    if (volume.State === "in-use") return { ...termination, status: pollResult(deps, termination.deadlineAt, false) };
    try { await deps.ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId })); }
    catch (error) {
      if ((error as { name?: string }).name === "VolumeInUse") return { ...termination, status: pollResult(deps, termination.deadlineAt, false) };
      if ((error as { name?: string }).name !== "InvalidVolume.NotFound") throw error;
    }
  }
  // The one-use challenge of the retired runner's prefix is of no use now.
  if (termination.roleId !== undefined && termination.instanceId !== undefined) {
    try { await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.artifactBucketName, Key: `${e2eQualificationPrefix(termination.roleId, termination.instanceId)}challenge.json` })); } catch { /* best effort */ }
  }
  return { ...termination, status: "ready" };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Completion and failure
// ---------------------------------------------------------------------------------------------------------------------------------------------------

async function metric(deps: RequalifyStepsDependencies, name: string): Promise<void> {
  try { await deps.cloudwatch.send(new PutMetricDataCommand({ Namespace: deps.config.metricsNamespace, MetricData: [{ MetricName: name, Value: 1, Unit: "Count" }] })); } catch { /* a metric is never worth failing a run */ }
}

async function complete(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<void> {
  await metric(deps, "RequalifySucceeded");
  // The time the stale alarm counts from. A failure to record it must not strand the lock: the next daily check reports a larger age, which is the safe direction.
  try { await recordRenewalSuccess(deps, state.runId); } catch { console.error("requalify-success-record-failed"); }
  await releaseRequalifyLock(deps, state.runId);
}

/** The reason code the alert carries: only a fixed code, never text from the error. */
export function alertReason(state: RequalifyState): RequalifyReason {
  // The one refusal that is the reason itself: the machine's reason for a failed AwaitDrain is "drain-timeout", which would point the owner at the wrong cause.
  if (refusalDetail(state.error) === "drain-read-failed") return "drain-read-failed";
  return typeof state.reason === "string" && REASONS.has(state.reason) ? state.reason as RequalifyReason : "unexpected-error";
}

/** A refusal's own code (`requalify-refused:<code>`) found in a step error, or undefined. The error is a fixed message of this code base, never free text from a runner. */
function refusalDetail(error: unknown): string | undefined {
  const text = typeof error === "object" && error !== null ? JSON.stringify(error) : "";
  return /requalify-refused:([a-z-]{1,40})/.exec(text)?.[1];
}

async function soonestExpiry(deps: RequalifyStepsDependencies): Promise<number | undefined> {
  const expiries = await Promise.all((["web", "api"] as const).map(async (kind) => {
    const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eRegisteredRuntimeKey(deps.featureCatalogId, REQUALIFY_PROFILE_ID, kind), ConsistentRead: true }))).Item;
    return typeof item?.["expiresAt"] === "string" ? Date.parse(item["expiresAt"]) : undefined;
  }));
  const known = expiries.filter((expiry): expiry is number => expiry !== undefined && !Number.isNaN(expiry));
  return known.length === 0 ? undefined : Math.min(...known);
}

async function pointerNames(deps: RequalifyStepsDependencies, instanceId: string | undefined): Promise<boolean> {
  if (instanceId === undefined) return false;
  const pointer = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID), ConsistentRead: true }))).Item;
  return pointer?.["instanceId"] === instanceId;
}

async function recordedPrevious(deps: RequalifyStepsDependencies, runId: string): Promise<{ instanceId: string } | null> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: requalifyRunKey(runId), ConsistentRead: true }))).Item as Partial<RequalifyRunRecord> | undefined;
  return item?.previousRunner ?? null;
}

/** Lifts the hold, deletes the challenge, counts the failure and sends the one alert. The runner itself is ended by the next steps. */
async function failAlert(deps: RequalifyStepsDependencies, state: RequalifyState): Promise<void> {
  const reason = alertReason(state);
  await deleteHold(deps, state.runId);
  if (state.instance !== undefined && state.preflight !== undefined && state.switch?.switched !== true) {
    try { await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.artifactBucketName, Key: `${e2eQualificationPrefix(state.preflight.workerRoleId, state.instance.instanceId)}challenge.json` })); } catch { /* best effort */ }
  }
  await metric(deps, "RequalifyFailed");
  // A drain that ran out of time is the next day's to retry unless the machine is close to its 24 h error.
  if (reason === "drain-timeout") {
    const soonest = await soonestExpiry(deps);
    if (soonest === undefined || soonest - nowOf(deps) > REQUALIFY_ALERT_WINDOW_MS) return;
  }
  // The switch may have committed without the machine knowing (its answer was lost and the recovery failed too): the pointer and the run record say so.
  const committed = state.switch?.switched === true || await pointerNames(deps, state.instance?.instanceId);
  const previous = state.switch?.previous ?? (committed ? await recordedPrevious(deps, state.runId) : null);
  const detail = state.qualification?.failure?.join(",") ?? (refusalDetail(state.error) === reason ? undefined : refusalDetail(state.error));
  const lines = [
    `The automatic renewal of the browser and API test machine did not finish (${deps.environment}).`,
    `reason: ${reason}${detail ? ` (${detail})` : ""}`, `run: ${state.runId}`,
    ...(state.instance ? [`new runner: ${state.instance.instanceId}`] : []), ...(previous ? [`previous runner: ${previous.instanceId}`] : []),
    committed ? `The new runner is serving. ${previous ? "Check that the previous runner is gone and end it if not." : "No previous runner was recorded."}` : "The old runner and the registered rows were left as they were.",
  ];
  await deps.sns.send(new PublishCommand({ TopicArn: deps.config.operatorTopicArn, Subject: `Rovara test machine renewal: ${reason}`.slice(0, 100), Message: lines.join("\n") }));
}

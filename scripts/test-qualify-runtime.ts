// Plan-first qualification of the web/API runtime on one fresh TEST worker, then registration of what it proved.
//
//   npx tsx scripts/test-qualify-runtime.ts --env agentxlivetest123 --profile agentx-test [--apply]
//
// Without --apply it prints the plan and exits 0, with no AWS call. With --apply it first proves the
// operator can use the transport (puts, reads back and deletes e2e-runtime/<run id>/preflight.json) and
// launches nothing otherwise, then launches ONE worker from the environment's own launch template with the
// opt-in qualification hook of boot.sh (the same boot the provisioner renders, plus the hook's three
// settings, one of them the worker role's unique ID), issues a linux-arm64-web-api-v1 challenge for that
// worker's private endpoint, hands the challenge over through the standing transport under
// e2e-runtime/<role unique ID>:<instance ID>/ in the control artifacts bucket (the one prefix the
// grant e2e-runtime/${aws:userid}/ allows that instance), waits for the worker's status.json, and only when
// it says SUCCEEDED downloads proposal.json and registers it. Nothing is ever terminated here, and the
// only objects it deletes are its own preflight object and the one-use challenge: when anything fails
// the worker is left running for diagnosis, and its ID and the command that ends it are printed.
// Run `scripts/test-deploy.ts --only qualification-transport,executor-image,...` first.
//
// Order differs from the plan's "issue the challenge, then launch": the challenge names the worker's
// private endpoint, which exists only once the worker does, so the hook waits for challenge.json. The
// instance is tagged DeploymentMode=e2e-qualification, not the launch template's ec2-ebs: the session
// reconciler ends any ec2-ebs instance of the environment that no session owns, 15 minutes after launch.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { AttachVolumeCommand, CreateVolumeCommand, DescribeInstancesCommand, DescribeLaunchTemplateVersionsCommand, DescribeVolumesCommand, EC2Client, RunInstancesCommand, type RunInstancesCommandInput } from "@aws-sdk/client-ec2";
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ec2Binding } from "../packages/cli/src/setup/project-add.js";
import { environmentSettingsPrefix, environmentStackName } from "../packages/contracts/src/environments.js";
import {
  E2E_QUALIFICATION_PROFILE_ID,
  Ec2RuntimeBindingSchema,
  WORKER_SETTING_PARAMETERS,
  E2E_QUALIFICATION_ROLE_ID_PATTERN,
  e2eQualificationPrefix,
  ec2WorkerUserData,
  type Ec2RuntimeBinding,
} from "../packages/contracts/src/session.js";
import { Runner, type ReleaseOptions } from "./release-common.js";
import { loadAllowlist, parseOptions } from "./test-deploy.js";

const DEFAULT_REGION = "us-east-1";
const ALLOWLIST_ERROR = "test-qualify-runtime only targets allowlisted TEST installations";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKER_PORT = 8080;
const VOLUME_DEVICE = "/dev/sdf";
const VOLUME_SIZE_GIB = 20;
const INSTANCE_TYPE = "m6g.large";
/** The web/API challenge lives 60 minutes (docs/runtime-installation.md): registration is refused after that. */
export const QUALIFICATION_POLL_TIMEOUT_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 30_000;
/** The worker uploads ready.json once it answers /ping: boot, volume attach and image pulls take a few minutes. */
const READY_TIMEOUT_MS = 20 * 60_000;

export interface QualificationSettings {
  workerImage: string;
  /** Required to qualify, though optional in the worker settings: the web/API runtime needs it. */
  executorImage?: string | undefined;
  modelProvider: string;
  modelId: string;
  promptCacheRetention: "short" | "long";
  openRouterSecretArn?: string | undefined;
  openRouterProviders?: string | undefined;
  anthropicSecretArn?: string | undefined;
  openaiSecretArn?: string | undefined;
}

/** What is read from the live stack: nothing about the TEST installation is written into this file. */
export interface QualificationFacts {
  region: string;
  artifactBucket: string;
  controlPlaneUrl: string;
  invokePublicKey: string;
  logGroupName: string;
  launchTemplateId: string;
  /** The unique ID (AROA...) of the worker instance role: the first half of the instance's `${aws:userid}`, which scopes its grant. */
  workerRoleId: string;
  /** The binding `agentx project add` registers for this foundation: every worker subnet. The challenge, and so the registered rows, carry it. */
  binding: Ec2RuntimeBinding;
  /** The one subnet of the binding the worker is launched into. */
  subnet: { availabilityZone: string; subnetId: string };
  volumeSizeGiB: number;
  settings: QualificationSettings;
}

/** The runtime binding project registration builds from the foundation's outputs (its own function), and the subnet to launch into: the first by zone. */
export function qualificationBinding(outputs: Record<string, string>, stackName: string): { binding: Ec2RuntimeBinding; launchSubnet: { availabilityZone: string; subnetId: string } } {
  const binding = ec2Binding(outputs, stackName);
  const [launchSubnet] = [...binding.subnets].sort((a, b) => a.availabilityZone.localeCompare(b.availabilityZone));
  if (launchSubnet === undefined) throw new Error(`stack ${stackName} lists no worker subnet`);
  return { binding, launchSubnet };
}

/** A failed get-object is "not there yet" when the object is missing or the principal may not list the bucket (so a missing key reads as AccessDenied); anything else is an error. */
export function classifyGetObjectFailure(stderr: string): "absent" | "error" {
  return /NoSuchKey|Not Found|\b404\b|AccessDenied|Forbidden/.test(stderr) ? "absent" : "error";
}

export type QualificationStep =
  | { id: string; kind: "check-admin-session" }
  | { id: string; kind: "resolve-facts" }
  | { id: string; kind: "preflight"; key: string }
  | { id: string; kind: "create-volume"; clientToken: string }
  | { id: string; kind: "run-instance"; minCount: 1; maxCount: 1; clientToken: string; workspaceId: string; qualification: { profile: typeof E2E_QUALIFICATION_PROFILE_ID } }
  | { id: string; kind: "attach-volume"; device: string }
  | { id: string; kind: "read-private-ip" }
  | { id: string; kind: "wait-ready"; object: string; statusObject: string; timeoutMs: number; intervalMs: number }
  | { id: string; kind: "issue-challenge"; profile: typeof E2E_QUALIFICATION_PROFILE_ID; generation: 1; transportCorrelationId: string; port: number }
  | { id: string; kind: "upload-challenge"; object: string }
  | { id: string; kind: "poll-status"; object: string; timeoutMs: number; intervalMs: number }
  | { id: string; kind: "download-proposal"; object: string }
  | { id: string; kind: "register" }
  | { id: string; kind: "delete-challenge"; object: string }
  | { id: string; kind: "print-registered-rows" };

export interface QualificationInput {
  env: string;
  profile: string;
  region: string;
  /** Names the run: the S3 prefix and the client token of every create call. */
  runId: string;
  /** The worker's workspace ID, which is also the challenge's transport correlation. */
  workspaceId: string;
}

export function planTestQualification(input: QualificationInput, allowlist: readonly string[] = loadAllowlist()): QualificationStep[] {
  if (!allowlist.includes(input.env)) throw new Error(ALLOWLIST_ERROR);
  if (!UUID.test(input.runId)) throw new Error("the run ID must be a lowercase UUID");
  if (!UUID.test(input.workspaceId)) throw new Error("the workspace ID must be a lowercase UUID");
  // The objects of the run live under a prefix holding the launched instance's ID, known only after the launch: the plan names them.
  return [
    { id: "check-admin-session", kind: "check-admin-session" },
    { id: "resolve-facts", kind: "resolve-facts" },
    { id: "preflight", kind: "preflight", key: preflightKey(input.runId) },
    { id: "create-volume", kind: "create-volume", clientToken: input.runId },
    { id: "run-instance", kind: "run-instance", minCount: 1, maxCount: 1, clientToken: input.runId, workspaceId: input.workspaceId, qualification: { profile: E2E_QUALIFICATION_PROFILE_ID } },
    { id: "attach-volume", kind: "attach-volume", device: VOLUME_DEVICE },
    { id: "read-private-ip", kind: "read-private-ip" },
    { id: "wait-ready", kind: "wait-ready", object: "ready.json", statusObject: "status.json", timeoutMs: READY_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    { id: "issue-challenge", kind: "issue-challenge", profile: E2E_QUALIFICATION_PROFILE_ID, generation: 1, transportCorrelationId: input.workspaceId, port: WORKER_PORT },
    { id: "upload-challenge", kind: "upload-challenge", object: "challenge.json" },
    { id: "poll-status", kind: "poll-status", object: "status.json", timeoutMs: QUALIFICATION_POLL_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    { id: "download-proposal", kind: "download-proposal", object: "proposal.json" },
    { id: "register", kind: "register" },
    { id: "delete-challenge", kind: "delete-challenge", object: "challenge.json" },
    { id: "print-registered-rows", kind: "print-registered-rows" },
  ];
}

/** The key of the preflight object: under the run's own ID, apart from every instance's prefix. */
export function preflightKey(runId: string): string {
  return `e2e-runtime/${runId}/preflight.json`;
}

/** What stands for the instance's prefix in the printed plan, before there is an instance. */
const PLAN_PREFIX = "e2e-runtime/<worker role unique ID>:<instance ID>/";

/** The role name of a role ARN (`arn:aws:iam::<account>:role[/path]/<name>`): what `iam get-role` takes. */
export function roleNameFromArn(arn: string): string {
  const name = /^arn:aws[a-z-]*:iam::\d{12}:role\/(?:[^/\s]+\/)*([A-Za-z0-9+=,.@_-]{1,64})$/.exec(arn)?.[1];
  if (name === undefined) throw new Error(`not an IAM role ARN: ${arn === "" ? "(empty)" : arn}`);
  return name;
}

export function formatQualificationPlan(steps: readonly QualificationStep[], input: QualificationInput): string {
  const describe = (step: QualificationStep): string => {
    switch (step.kind) {
      case "check-admin-session": return "check the Rovara admin sign-in (agentx admin workspace list) before anything is created";
      case "resolve-facts": return "read the live stacks (control plane, foundation, runtime), the worker settings, the signing key, the launch template and the worker role's unique ID (iam get-role); refuse unless the executor image and the qualification transport are deployed";
      case "preflight": return `put, read back and delete s3://<control artifacts bucket>/${step.key}; refuse to launch anything, naming the permission, if any of the three fails`;
      case "create-volume": return `create one new encrypted ${VOLUME_SIZE_GIB} GiB gp3 workspace volume (client token ${step.clientToken})`;
      case "run-instance": return `launch ONE ${INSTANCE_TYPE} instance (MinCount=MaxCount=1, client token ${step.clientToken}) from the environment's launch template, with the worker's normal boot plus the qualification hook (prefix ${PLAN_PREFIX}), tagged DeploymentMode=e2e-qualification so the session reconciler leaves it alone`;
      case "attach-volume": return `attach the volume to that instance at ${step.device}`;
      case "read-private-ip": return "read the instance's private IP address";
      case "wait-ready": return `wait up to ${step.timeoutMs / 60_000} minutes for the worker to upload ${PLAN_PREFIX}${step.object} (it is healthy), so boot time does not use the challenge's lifetime`;
      case "issue-challenge": return `issue a ${step.profile} challenge (agentx admin runtime-installation challenge) for http://<private ip>:${step.port}, generation ${step.generation}, correlation ${step.transportCorrelationId}`;
      case "upload-challenge": return `upload challenge.json to s3://<control artifacts bucket>/${PLAN_PREFIX}${step.object}`;
      case "poll-status": return `poll ${PLAN_PREFIX}${step.object} every ${step.intervalMs / 1000}s for up to ${step.timeoutMs / 60_000} minutes (the challenge's lifetime)`;
      case "download-proposal": return `only if the status is SUCCEEDED: download ${PLAN_PREFIX}${step.object}`;
      case "register": return "register the proposal (agentx admin runtime-installation register --proposal-file)";
      case "delete-challenge": return `after a successful registration, delete the one-use ${PLAN_PREFIX}${step.object} from the bucket (a failure only warns and prints the command)`;
      case "print-registered-rows": return "print the registered catalog rows";
    }
  };
  return [
    `TEST qualification plan for ${input.env} (${input.region}), profile ${E2E_QUALIFICATION_PROFILE_ID}, run ${input.runId}`,
    ...steps.map((step, index) => `${index + 1}. [${step.id}] ${describe(step)}`),
    "",
    `Spend: one instance (${INSTANCE_TYPE}) and one ${VOLUME_SIZE_GIB} GiB gp3 volume, billed until you end them. Launching it needs the owner's explicit OK at run time.`,
    "On any failure the instance is left running for diagnosis: this script never terminates an instance or deletes a volume (it deletes only its own preflight and challenge objects), and prints how.",
  ].join("\n");
}

/** The worker's boot configuration for the qualification instance, rendered by the product's own user data helper. */
export function renderQualificationUserData(
  facts: QualificationFacts,
  run: { workspaceId: string; volumeId: string; qualification: { profile: typeof E2E_QUALIFICATION_PROFILE_ID } },
  bootScript: string,
): string {
  const { settings } = facts;
  if (settings.executorImage === undefined) {
    throw new Error("the worker settings have no executor image, which the web/API runtime needs; deploy it first (test-deploy --only executor-image)");
  }
  return ec2WorkerUserData({
    workspaceId: run.workspaceId,
    generation: 1,
    volumeId: run.volumeId,
    expectNewVolume: true,
    workerImage: settings.workerImage,
    executorImage: settings.executorImage,
    invokePublicKey: facts.invokePublicKey,
    controlPlaneUrl: facts.controlPlaneUrl,
    modelProvider: settings.modelProvider,
    modelId: settings.modelId,
    promptCacheRetention: settings.promptCacheRetention,
    ...(settings.openRouterSecretArn ? { openRouterSecretArn: settings.openRouterSecretArn } : {}),
    ...(settings.openRouterProviders ? { openRouterProviders: settings.openRouterProviders } : {}),
    ...(settings.anthropicSecretArn ? { anthropicSecretArn: settings.anthropicSecretArn } : {}),
    ...(settings.openaiSecretArn ? { openaiSecretArn: settings.openaiSecretArn } : {}),
    logGroupName: facts.logGroupName,
    e2eQualification: { bucket: facts.artifactBucket, roleId: facts.workerRoleId, profile: run.qualification.profile },
  }, bootScript);
}

/** One instance from the environment's own launch template: its instance type, profile and security group stay the template's. */
export function buildRunInstancesInput(
  facts: QualificationFacts,
  run: { env: string; runId: string; revision: string; userData: string },
): RunInstancesCommandInput {
  return {
    ClientToken: run.runId,
    MinCount: 1,
    MaxCount: 1,
    LaunchTemplate: { LaunchTemplateId: facts.launchTemplateId, Version: "$Default" },
    SubnetId: facts.subnet.subnetId,
    UserData: run.userData,
    TagSpecifications: [{
      ResourceType: "instance",
      Tags: [
        { Key: "Application", Value: "AgentX" },
        // Not the launch template's ec2-ebs: the session reconciler ends an ec2-ebs instance of this environment that no session owns once it is
        // 15 minutes old, which would end this one mid-qualification. The request's tags override the template's for the same key.
        { Key: "DeploymentMode", Value: "e2e-qualification" },
        { Key: "Environment", Value: run.env },
        { Key: "Name", Value: `agentx-${run.env}-web-api-qualification-${run.runId.slice(0, 8)}` },
        { Key: "agentx:env", Value: run.env },
        { Key: "agentx:run", Value: run.runId },
        { Key: "agentx:qualification-run", Value: run.runId },
        { Key: "agentx:revision", Value: run.revision },
        { Key: "agentx:runtime-purpose", Value: "web-api-qualification" },
      ],
    }],
  };
}

export interface QualificationEffects {
  checkAdminSession(): Promise<void>;
  resolveFacts(): Promise<QualificationFacts>;
  createVolume(request: { availabilityZone: string; sizeGiB: number; clientToken: string; tags: Record<string, string> }): Promise<string>;
  runInstance(request: RunInstancesCommandInput): Promise<string>;
  attachVolume(request: { volumeId: string; instanceId: string; device: string }): Promise<void>;
  privateIpOf(instanceId: string): Promise<string>;
  issueChallenge(request: { binding: Ec2RuntimeBinding; endpoint: string; generation: number; transportCorrelationId: string; profile: string }): Promise<{ challengeId: string; file: string; expiresAt: string }>;
  putObject(key: string, file: string): Promise<void>;
  putBytes(key: string, bytes: Buffer): Promise<void>;
  /** The object's bytes, or undefined when it does not exist (yet). */
  getObject(key: string): Promise<Buffer | undefined>;
  /** The object's bytes; any failure, a denied or missing object included, throws. */
  getObjectStrict(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
  saveProposal(bytes: Buffer): string;
  register(proposalFile: string): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  print(line: string): void;
}

/** The status.json the hook uploads; anything else, or SUCCEEDED without a reason and time, is not a success. */
function parseStatus(bytes: Buffer): { state: "SUCCEEDED" | "FAILED"; reason: string } {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("the qualification status is not valid JSON; refusing to register"); }
  const status = value as { state?: unknown; reason?: unknown; finishedAt?: unknown } | null;
  if (status === null || typeof status !== "object" || (status.state !== "SUCCEEDED" && status.state !== "FAILED") || typeof status.reason !== "string" || typeof status.finishedAt !== "string") {
    throw new Error("the qualification status is not a SUCCEEDED or FAILED status with a reason and time; refusing to register");
  }
  return { state: status.state, reason: status.reason };
}

/** The registration answer's rows: the feature catalog, the profile's two kinds, and the revision each reached. */
export function describeRegisteredRows(output: string): string[] {
  let value: unknown;
  try { value = JSON.parse(output); } catch { return []; }
  const find = (node: unknown): { featureCatalogId: string; featureRevisions: Record<string, number>; profileId?: string } | undefined => {
    if (node === null || typeof node !== "object") return undefined;
    const record = node as Record<string, unknown>;
    if (typeof record.featureCatalogId === "string" && record.featureRevisions !== null && typeof record.featureRevisions === "object") {
      return { featureCatalogId: record.featureCatalogId, featureRevisions: record.featureRevisions as Record<string, number>, ...(typeof record.profileId === "string" ? { profileId: record.profileId } : {}) };
    }
    for (const child of Object.values(record)) {
      const found = find(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const answer = find(value);
  if (answer === undefined) return [];
  return (["web", "api"] as const).flatMap((kind) => {
    const revision = answer.featureRevisions[kind];
    return typeof revision === "number" ? [`E2E_FEATURE_VERIFIER#${answer.featureCatalogId} / PROFILE#${answer.profileId ?? E2E_QUALIFICATION_PROFILE_ID}#${kind} revision ${revision}`] : [];
  });
}

export interface RunOptions {
  revision: string;
  profile: string;
  region: string;
  /** Names the tags of the instance. */
  env?: string;
  /** The boot script to render; the repository's own unless a test gives one. */
  bootScript?: string;
}

interface RunState {
  /** The client token and tag of the launch, once it has been attempted (RunInstances may throw after creating the instance). */
  launchRun?: string;
  facts?: QualificationFacts;
  /** The preflight object, from the moment it is put until it is deleted. */
  preflightKey?: string | undefined;
  volumeId?: string;
  instanceId?: string;
  /** e2e-runtime/<role unique ID>:<instance ID>/, once the instance is launched. */
  prefix?: string;
  privateIp?: string;
  challengeFile?: string;
  /** The challenge object, from the moment it is uploaded until it is deleted. */
  challengeKey?: string | undefined;
  proposalFile?: string;
  registered?: string;
}

/** Runs the plan against effects. Never retries a launch, never registers without a SUCCEEDED status, and never ends anything it started. */
export async function runTestQualification(steps: readonly QualificationStep[], effects: QualificationEffects, options: RunOptions): Promise<void> {
  const state: RunState = {};
  if (steps.filter((step) => step.kind === "run-instance").length !== 1) throw new Error("a qualification plan launches exactly one instance");
  try {
    for (const step of steps) {
      effects.print(`== ${step.id}`);
      switch (step.kind) {
        case "check-admin-session": await effects.checkAdminSession(); break;
        case "resolve-facts": {
          const facts = await effects.resolveFacts();
          // The role's unique ID is half of the key prefix and of the user data: refuse a malformed one before anything is created.
          if (!E2E_QUALIFICATION_ROLE_ID_PATTERN.test(facts.workerRoleId)) throw new Error("the worker role's unique ID must look like AROA followed by at least 12 capital letters or digits");
          state.facts = facts;
          break;
        }
        case "preflight": await preflight(step.key, need(state.facts, "the stack facts").artifactBucket, effects, state); break;
        case "create-volume": {
          const facts = need(state.facts, "the stack facts");
          state.volumeId = await effects.createVolume({
            availabilityZone: facts.subnet.availabilityZone, sizeGiB: facts.volumeSizeGiB, clientToken: step.clientToken,
            tags: { Application: "AgentX", "agentx:run": step.clientToken, "agentx:runtime-purpose": "web-api-qualification" },
          });
          effects.print(`volume ${state.volumeId}`);
          break;
        }
        case "run-instance": {
          const facts = need(state.facts, "the stack facts");
          state.launchRun = step.clientToken;
          const userData = renderQualificationUserData(facts, { workspaceId: step.workspaceId, volumeId: need(state.volumeId, "the volume"), qualification: step.qualification }, options.bootScript ?? readBootScript());
          state.instanceId = await effects.runInstance(buildRunInstancesInput(facts, { env: options.env ?? "", runId: step.clientToken, revision: options.revision, userData }));
          effects.print(`instance ${state.instanceId}`);
          // The grant allows only this exact prefix; the instance builds the same one from its own ID. Both validate the two IDs strictly.
          state.prefix = e2eQualificationPrefix(facts.workerRoleId, state.instanceId);
          break;
        }
        case "attach-volume": await effects.attachVolume({ volumeId: need(state.volumeId, "the volume"), instanceId: need(state.instanceId, "the instance"), device: step.device }); break;
        case "read-private-ip": state.privateIp = await effects.privateIpOf(need(state.instanceId, "the instance")); break;
        case "wait-ready": await waitReady(step, need(state.prefix, "the instance's key prefix"), effects); break;
        case "issue-challenge": {
          const facts = need(state.facts, "the stack facts");
          const binding = Ec2RuntimeBindingSchema.parse(facts.binding);
          const issued = await effects.issueChallenge({ binding, endpoint: `http://${need(state.privateIp, "the private IP")}:${step.port}`, generation: step.generation, transportCorrelationId: step.transportCorrelationId, profile: step.profile });
          state.challengeFile = issued.file;
          effects.print(`challenge ${issued.challengeId}, expires ${issued.expiresAt}`);
          break;
        }
        case "upload-challenge": {
          const key = `${need(state.prefix, "the instance's key prefix")}${step.object}`;
          state.challengeKey = key;
          await effects.putObject(key, need(state.challengeFile, "the challenge file"));
          break;
        }
        case "poll-status": await pollStatus(step, need(state.prefix, "the instance's key prefix"), effects); break;
        case "download-proposal": {
          const key = `${need(state.prefix, "the instance's key prefix")}${step.object}`;
          const bytes = await effects.getObject(key);
          if (bytes === undefined) throw new Error(`the status said SUCCEEDED but ${key} does not exist; refusing to register`);
          state.proposalFile = effects.saveProposal(bytes);
          break;
        }
        case "register": state.registered = await effects.register(need(state.proposalFile, "the proposal file")); break;
        case "delete-challenge": {
          const key = `${need(state.prefix, "the instance's key prefix")}${step.object}`;
          try {
            await effects.deleteObject(key);
            state.challengeKey = undefined;
          } catch (error) {
            // challengeKey stays set: the leftovers say how to delete it.
            effects.print(`Warning: could not delete the one-use challenge ${key} (${error instanceof Error ? error.message : String(error)}); delete it by hand.`);
            reportObjectLeftovers(state, options, (line) => effects.print(line));
          }
          break;
        }
        case "print-registered-rows": {
          const rows = describeRegisteredRows(need(state.registered, "the registration answer"));
          for (const row of rows.length > 0 ? rows : [`registered; the answer was not in the expected form: ${state.registered}`]) effects.print(row);
          break;
        }
      }
    }
  } catch (error) {
    reportLeftovers(state, options, (line) => effects.print(line));
    throw error;
  }
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not known yet; the plan's steps are out of order`);
  return value;
}

/** Writes a small object, reads it back and deletes it: the same three permissions the run needs, proven before anything costs money. */
async function preflight(key: string, bucket: string, effects: QualificationEffects, state: RunState): Promise<void> {
  const where = `s3://${bucket}/${key}`;
  const refuse = (permission: string, cause: unknown) => new Error(`preflight failed: ${permission} on ${where} is not usable (${cause instanceof Error ? cause.message : String(cause)}); nothing was launched`);
  const body = Buffer.from(`${JSON.stringify({ preflight: "test-qualify-runtime" })}\n`);
  try { await effects.putBytes(key, body); } catch (error) { throw refuse("s3:PutObject", error); }
  state.preflightKey = key;
  let read: Buffer;
  try { read = await effects.getObjectStrict(key); } catch (error) { throw refuse("s3:GetObject", error); }
  if (!read.equals(body)) throw refuse("s3:GetObject", "the object read back is not the object that was put");
  try { await effects.deleteObject(key); } catch (error) { throw refuse("s3:DeleteObject", error); }
  state.preflightKey = undefined;
}

async function waitReady(step: Extract<QualificationStep, { kind: "wait-ready" }>, prefix: string, effects: QualificationEffects): Promise<void> {
  const deadline = effects.now() + step.timeoutMs;
  for (;;) {
    if ((await effects.getObject(`${prefix}${step.object}`)) !== undefined) return;
    // A worker that failed before it was ready says so in status.json: stop at once instead of waiting out the clock.
    const status = await effects.getObject(`${prefix}${step.statusObject}`);
    if (status !== undefined) {
      const parsed = parseStatus(status);
      if (parsed.state === "FAILED") throw new Error(`the worker reported FAILED before it was ready: ${parsed.reason}`);
    }
    if (effects.now() >= deadline) throw new Error(`the worker was not ready after ${step.timeoutMs / 60_000} minutes; no challenge was issued`);
    await effects.sleep(step.intervalMs);
  }
}

async function pollStatus(step: Extract<QualificationStep, { kind: "poll-status" }>, prefix: string, effects: QualificationEffects): Promise<void> {
  const deadline = effects.now() + step.timeoutMs;
  for (;;) {
    const bytes = await effects.getObject(`${prefix}${step.object}`);
    if (bytes !== undefined) {
      const status = parseStatus(bytes);
      if (status.state === "SUCCEEDED") return;
      throw new Error(`the worker reported FAILED: ${status.reason}`);
    }
    if (effects.now() >= deadline) throw new Error(`no qualification status after ${step.timeoutMs / 60_000} minutes (the challenge has expired); nothing was registered`);
    await effects.sleep(step.intervalMs);
  }
}

/** The delete commands of objects this run put in the bucket and has not deleted. */
function reportObjectLeftovers(state: RunState, options: RunOptions, print: (line: string) => void): void {
  const bucket = state.facts?.artifactBucket;
  for (const [what, key] of [["preflight object", state.preflightKey], ["one-use challenge, which holds a secret,", state.challengeKey]] as const) {
    if (key === undefined || bucket === undefined) continue;
    print(`\nThe ${what} s3://${bucket}/${key} is still in the bucket. Delete it with:`);
    print(`  aws s3api delete-object --bucket ${bucket} --key ${key} --profile ${options.profile} --region ${options.region}`);
  }
}

function reportLeftovers(state: RunState, options: RunOptions, print: (line: string) => void): void {
  reportObjectLeftovers(state, options, print);
  if (state.launchRun !== undefined) {
    print(`\nThe launch used client token ${state.launchRun}. If RunInstances failed after it created an instance, find it by its tag:`);
    print(`  aws ec2 describe-instances --filters Name=tag:agentx:qualification-run,Values=${state.launchRun} --profile ${options.profile} --region ${options.region}`);
  }
  if (state.instanceId !== undefined) {
    print(`\nThe qualification instance ${state.instanceId} is still running (${INSTANCE_TYPE}, billed until it is ended), left for diagnosis. End it with:`);
    print(`  aws ec2 terminate-instances --instance-ids ${state.instanceId} --profile ${options.profile} --region ${options.region}`);
  }
  if (state.volumeId !== undefined) {
    print(`${state.instanceId === undefined ? "\n" : ""}The workspace volume ${state.volumeId} stays until it is deleted${state.instanceId === undefined ? "" : ", once that instance is gone"}:`);
    print(`  aws ec2 delete-volume --volume-id ${state.volumeId} --profile ${options.profile} --region ${options.region}`);
  }
}

export interface QualifyArgs {
  env: string;
  profile: string;
  region: string;
  apply: boolean;
}

export function parseQualifyArgs(argv: readonly string[]): QualifyArgs {
  const { values, flags } = parseOptions(argv, { values: ["--env", "--profile", "--region"], flags: ["--apply"] });
  const env = values.get("--env");
  if (env === undefined) throw new Error("--env is required");
  const profile = values.get("--profile");
  if (profile === undefined) throw new Error("--profile is required");
  return { env, profile, region: values.get("--region") ?? DEFAULT_REGION, apply: flags.has("--apply") };
}

function readBootScript(): string {
  return readFileSync(new URL("../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------------------------
// The thin --apply effects. Nothing below runs in the unit tests: they drive the plan with fakes.
// ---------------------------------------------------------------------------------------------

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function outputsOf(stack: { Outputs?: Array<{ OutputKey?: string | undefined; OutputValue?: string | undefined }> | undefined }): Record<string, string> {
  return Object.fromEntries((stack.Outputs ?? []).flatMap((output) => (output.OutputKey && output.OutputValue !== undefined ? [[output.OutputKey, output.OutputValue]] : [])));
}

function requireOutput(outputs: Record<string, string>, key: string, stack: string): string {
  const value = outputs[key];
  if (value === undefined || value === "") throw new Error(`stack ${stack} has no output ${key}`);
  return value;
}

function createAwsEffects(args: QualifyArgs, runner: Runner): QualificationEffects {
  const config = { region: args.region, profile: args.profile, maxAttempts: 3 };
  const cloudFormation = new CloudFormationClient(config);
  const ec2 = new EC2Client(config);
  const ssm = new SSMClient(config);
  const kms = new KMSClient(config);
  const scratch = mkdtempSync(join(tmpdir(), "test-qualify-runtime-"));
  let bucket = "";
  const cli = (commandArgs: string[]): { status: number; stdout: string; stderr: string } => {
    const result = spawnSync("node", [join(REPO_ROOT, "packages/cli/dist/bin.js"), "--json", "--env", args.env, ...commandArgs], {
      cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, AWS_PROFILE: args.profile, AWS_REGION: args.region },
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const stack = async (name: string) => {
    const found = (await cloudFormation.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
    if (found === undefined) throw new Error(`stack ${name} does not exist`);
    return found;
  };

  return {
    async checkAdminSession() {
      const result = cli(["admin", "workspace", "list"]);
      if (result.status !== 0) throw new Error(`the Rovara admin sign-in is not usable (agentx admin workspace list failed): ${result.stderr.trim().slice(0, 500)}; sign in with \`agentx --env ${args.env} login --admin\``);
    },

    async resolveFacts() {
      const controlPlaneName = environmentStackName(args.env, "control-plane");
      const foundationName = environmentStackName(args.env, "foundation");
      const controlPlane = outputsOf(await stack(controlPlaneName));
      const foundation = outputsOf(await stack(foundationName));
      bucket = requireOutput(controlPlane, "ArtifactBucketName", controlPlaneName);

      // The standing transport (Task 0.1) must already be deployed: without it the worker cannot read the challenge.
      const resources = (await cloudFormation.send(new DescribeStackResourcesCommand({ StackName: controlPlaneName }))).StackResources ?? [];
      const grant = resources.find((resource) => resource.LogicalResourceId?.startsWith("E2eQualificationTransport"));
      if (grant === undefined || !/^(CREATE|UPDATE)_COMPLETE$/.test(grant.ResourceStatus ?? "")) {
        throw new Error("the qualification transport is not deployed in the control-plane stack; run: npx tsx scripts/test-deploy.ts --env <env> --profile <profile> --only qualification-transport --apply");
      }

      const prefix = environmentSettingsPrefix(args.env);
      const names = Object.fromEntries(Object.entries(WORKER_SETTING_PARAMETERS).map(([key, name]) => [key, `${prefix}${name}`]));
      const found = new Map(((await ssm.send(new GetParametersCommand({ Names: Object.values(names) }))).Parameters ?? []).map((parameter) => [parameter.Name, parameter.Value]));
      const value = (key: keyof typeof WORKER_SETTING_PARAMETERS) => found.get(names[key] ?? "");
      const required = (key: keyof typeof WORKER_SETTING_PARAMETERS) => {
        const setting = value(key);
        if (!setting) throw new Error(`SSM parameter ${names[key]} is missing`);
        return setting;
      };
      const optional = (key: keyof typeof WORKER_SETTING_PARAMETERS) => { const setting = value(key); return setting && setting !== "none" ? setting : undefined; };
      const retention = required("promptCacheRetention");
      if (retention !== "short" && retention !== "long") throw new Error("worker prompt cache retention must be short or long");
      const executorImage = optional("executorImage");
      if (executorImage === undefined) throw new Error("the executor image is not set in this environment (SSM worker-executor-image is missing or none); run test-deploy --only executor-image first");

      // The worker role's unique ID (AROA...) scopes the standing grant: an instance's aws:userid is <that ID>:<instance ID>.
      const roleArn = requireOutput(foundation, "Ec2WorkerInstanceRoleArn", foundationName);
      const role = runner.aws(["iam", "get-role", "--role-name", roleNameFromArn(roleArn), "--query", "Role.[RoleId,Arn]", "--output", "json"], true);
      if (role.status !== 0) throw new Error(`reading the worker role failed (iam:GetRole on ${roleArn}): ${role.stderr.trim().slice(0, 300)}`);
      const [workerRoleId, foundRoleArn] = JSON.parse(role.stdout) as [string, string];
      if (foundRoleArn !== roleArn) throw new Error(`iam get-role returned ${foundRoleArn}, not the foundation's worker role ${roleArn}`);

      const signingKeyArn = requireOutput(controlPlane, "InvokeSigningKeyArn", controlPlaneName);
      const publicKey = await kms.send(new GetPublicKeyCommand({ KeyId: signingKeyArn }));
      if (publicKey.KeySpec !== "ECC_NIST_P256" || publicKey.KeyUsage !== "SIGN_VERIFY" || !publicKey.PublicKey) throw new Error("the worker invoke signing key is not the expected P-256 signing key");

      // The binding is what project registration builds from the same outputs (every worker subnet); the worker launches into the first by zone.
      const { binding, launchSubnet } = qualificationBinding(foundation, foundationName);
      const launchTemplateId = binding.launchTemplateId;

      // The template is launched as it is: refuse one that is not the reviewed shape instead of overriding it.
      const template = (await ec2.send(new DescribeLaunchTemplateVersionsCommand({ LaunchTemplateId: launchTemplateId, Versions: ["$Default"] }))).LaunchTemplateVersions?.[0]?.LaunchTemplateData;
      if (template === undefined) throw new Error("the launch template's default version was not found");
      if (template.InstanceType !== INSTANCE_TYPE || template.MetadataOptions?.HttpTokens !== "required" || template.MetadataOptions.HttpPutResponseHopLimit !== 1 || template.UserData !== undefined || template.IamInstanceProfile === undefined) {
        throw new Error(`the launch template is not ${INSTANCE_TYPE} with IMDSv2 required, hop limit 1, an instance profile and no user data of its own; stop for review`);
      }

      return {
        region: args.region,
        artifactBucket: bucket,
        controlPlaneUrl: requireOutput(controlPlane, "ApiEndpoint", controlPlaneName),
        invokePublicKey: Buffer.from(publicKey.PublicKey).toString("base64"),
        logGroupName: requireOutput(foundation, "Ec2WorkerLogGroupName", foundationName),
        launchTemplateId,
        workerRoleId,
        binding,
        subnet: launchSubnet,
        volumeSizeGiB: binding.volumeSizeGiB,
        settings: {
          workerImage: required("workerImage"),
          executorImage,
          modelProvider: required("modelProvider"),
          modelId: required("modelId"),
          promptCacheRetention: retention,
          openRouterSecretArn: optional("openRouterSecretArn"),
          openRouterProviders: optional("openRouterProviders"),
          anthropicSecretArn: optional("anthropicSecretArn"),
          openaiSecretArn: optional("openaiSecretArn"),
        },
      };
    },

    async createVolume(request) {
      const created = await ec2.send(new CreateVolumeCommand({
        AvailabilityZone: request.availabilityZone, Size: request.sizeGiB, VolumeType: "gp3", Encrypted: true, ClientToken: request.clientToken,
        TagSpecifications: [{ ResourceType: "volume", Tags: Object.entries(request.tags).map(([Key, Value]) => ({ Key, Value })) }],
      }));
      if (created.VolumeId === undefined) throw new Error("CreateVolume returned no volume ID");
      // Wait until it can be attached.
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = (await ec2.send(new DescribeVolumesCommand({ VolumeIds: [created.VolumeId] }))).Volumes?.[0]?.State;
        if (state === "available") return created.VolumeId;
        await sleep(2_000);
      }
      throw new Error(`volume ${created.VolumeId} did not become available`);
    },

    async runInstance(request) {
      const launched = await ec2.send(new RunInstancesCommand(request));
      const instances = launched.Instances ?? [];
      if (instances.length !== 1 || instances[0]?.InstanceId === undefined) throw new Error(`RunInstances returned ${instances.length} instances, expected exactly one`);
      return instances[0].InstanceId;
    },

    async attachVolume(request) {
      // The volume attaches once the instance is running; wait for that, bounded. A just-launched instance may not be readable yet.
      for (let attempt = 0; attempt < 60; attempt += 1) {
        let state: string | undefined;
        try {
          state = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [request.instanceId] }))).Reservations?.[0]?.Instances?.[0]?.State?.Name;
        } catch (error) {
          if ((error as { name?: string }).name !== "InvalidInstanceID.NotFound") throw error;
          state = "pending";
        }
        if (state === "running") break;
        if (state !== "pending") throw new Error(`instance ${request.instanceId} is ${state ?? "unknown"}, not running`);
        await sleep(5_000);
      }
      await ec2.send(new AttachVolumeCommand({ VolumeId: request.volumeId, InstanceId: request.instanceId, Device: request.device }));
    },

    async privateIpOf(instanceId) {
      const ip = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))).Reservations?.[0]?.Instances?.[0]?.PrivateIpAddress;
      if (ip === undefined) throw new Error(`instance ${instanceId} has no private IP address`);
      return ip;
    },

    async issueChallenge(request) {
      const dir = mkdtempSync(join(scratch, "challenge-"));
      const bindingFile = join(dir, "binding.json");
      const out = join(dir, "challenge.json");
      writeFileSync(bindingFile, `${JSON.stringify(request.binding)}\n`, { mode: 0o600 });
      const result = cli(["admin", "runtime-installation", "challenge", "--binding-file", bindingFile, "--endpoint", request.endpoint, "--generation", String(request.generation), "--transport-correlation-id", request.transportCorrelationId, "--profile", request.profile, "--out", out]);
      if (result.status !== 0) throw new Error(`issuing the challenge failed: ${result.stderr.trim().slice(0, 500)}`);
      // The file holds a one-use secret: only its ID and expiry are read and printed.
      const challenge = JSON.parse(readFileSync(out, "utf8")) as { challengeId?: string; expiresAt?: string };
      if (typeof challenge.challengeId !== "string" || typeof challenge.expiresAt !== "string") throw new Error("the challenge file has no challengeId or expiresAt");
      return { challengeId: challenge.challengeId, file: out, expiresAt: challenge.expiresAt };
    },

    async putObject(key, file) {
      runner.aws(["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", file, "--server-side-encryption", "AES256", "--region", args.region, "--output", "json"]);
    },

    async putBytes(key, bytes) {
      const file = join(mkdtempSync(join(scratch, "put-")), "body");
      writeFileSync(file, bytes, { mode: 0o600 });
      runner.aws(["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", file, "--server-side-encryption", "AES256", "--region", args.region, "--output", "json"]);
    },

    async getObjectStrict(key) {
      const file = join(mkdtempSync(join(scratch, "read-")), "body");
      const result = runner.aws(["s3api", "get-object", "--bucket", bucket, "--key", key, "--region", args.region, file], true);
      if (result.status !== 0) throw new Error(result.stderr.trim().slice(0, 300));
      return readFileSync(file);
    },

    async getObject(key) {
      const file = join(scratch, `get-${Date.now()}`);
      const result = runner.aws(["s3api", "get-object", "--bucket", bucket, "--key", key, "--region", args.region, file], true);
      if (result.status === 0) return readFileSync(file);
      if (classifyGetObjectFailure(result.stderr) === "absent") return undefined;
      throw new Error(`reading s3://${bucket}/${key} failed: ${result.stderr.trim().slice(0, 300)}`);
    },

    async deleteObject(key) {
      runner.aws(["s3api", "delete-object", "--bucket", bucket, "--key", key, "--region", args.region, "--output", "json"]);
    },

    saveProposal(bytes) {
      const file = join(mkdtempSync(join(scratch, "proposal-")), "runtime-install-proposal.json");
      writeFileSync(file, bytes, { mode: 0o600 });
      return file;
    },

    async register(proposalFile) {
      const result = cli(["admin", "runtime-installation", "register", "--proposal-file", proposalFile]);
      if (result.status !== 0) throw new Error(`registration failed: ${result.stderr.trim().slice(0, 500)}`);
      return result.stdout;
    },

    now: () => Date.now(),
    sleep,
    print: (line) => console.log(line),
  };
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseQualifyArgs(argv);
  if (!loadAllowlist().includes(args.env)) throw new Error(ALLOWLIST_ERROR);
  const input: QualificationInput = { env: args.env, profile: args.profile, region: args.region, runId: randomUUID(), workspaceId: randomUUID() };
  const steps = planTestQualification(input);
  console.log(formatQualificationPlan(steps, input));
  if (!args.apply) {
    console.log("\nDry run: nothing was created. Add --apply to run this plan.");
    return;
  }
  const options: ReleaseOptions = { region: args.region, repository: "", profile: args.profile, allowDirty: false, skipChecks: false, dryRun: false };
  const runner = new Runner(options);
  if (runner.capture("git", ["status", "--porcelain"]).stdout.trim() !== "") throw new Error("the working tree is dirty; commit first so the boot script that runs is the committed one");
  if (!existsSync(join(REPO_ROOT, "packages/cli/dist/bin.js"))) throw new Error("the CLI is not built; run npm run build first");
  const revision = runner.capture("git", ["rev-parse", "HEAD"]).stdout.trim();
  await runTestQualification(steps, createAwsEffects(args, runner), { revision, profile: args.profile, region: args.region, env: args.env });
  console.log("\nTEST qualification complete.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

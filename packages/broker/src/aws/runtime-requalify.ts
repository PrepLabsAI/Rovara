import { createHash, randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { DescribeInstancesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import { z } from "zod";
import {
  agentXError, canonicalJson, e2eQualificationPrefix, Ec2RuntimeBindingSchema, REQUALIFIER_ISSUER, REQUALIFY_ENVIRONMENT_PATTERN, REQUALIFY_PROFILE_ID,
  REQUALIFY_REFUSAL_PREFIX, REQUALIFY_TAGS, RequalifyLockSchema, RequalifyRunRecordSchema, requalifierSubject, requalifyLockKey, requalifyRunKey,
  E2E_QUALIFICATION_INSTANCE_ID_PATTERN, E2E_QUALIFICATION_ROLE_ID_PATTERN,
  type Ec2RuntimeBinding, type RequalifyReasonCode, type RequalifyRunRecord, type RequalifyRunnerIdentity, type WebApiRuntimeInstallProposal,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import { e2eModelCheckRunnerKey } from "../e2e/model-route-registry.js";
import { e2eRegisteredRuntimeKey } from "./e2e-runtime-readiness.js";
import {
  issueChallengeAs, readWebApiCatalogRow, registerWebApiRuntimeInstallation, type RuntimeInstallationDependencies, type WebApiRuntimeRegistrationResult,
} from "./runtime-installation.js";

/**
 * AUTOREQUALIFY authority and switch (AR-1).
 *
 * The product renews its own browser and API test machine, so no administrator signs in. What replaces the sign-in is this module: it builds the
 * service identity itself (the caller passes no identity, so there is nothing to forge), narrows the existing challenge and registration to one
 * profile, one binding, one runner the renewal launched and the next generation, and then lets the unchanged registrar re-derive every probe from
 * its retained bytes. The switch is one transaction: both catalog rows, the evidence pointer, the consumed challenge, the model-check runner
 * pointer and the audit record commit together or not at all.
 *
 * The identity has no route: the JWT authenticator never produces it, and the human admin functions refuse it (it carries no administrator claim).
 */

const RUNNER_PORT = "8080";

export type RequalifyInstance = { instanceId: string; state: string; privateIp: string | undefined; tags: Readonly<Record<string, string>> };

export interface RequalifyDependencies extends RuntimeInstallationDependencies {
  /** The environment this renewal runs for (`test`, ...); it is the value of the `Environment` tag on every runner it may touch. */
  environment: string;
  /** The binding of this environment's launch template, subnets and volume, taken from deployment settings; the renewal never accepts one from its input. */
  expectedBinding: Ec2RuntimeBinding;
  /** Describes one instance, or undefined when it does not exist. */
  describeInstance(instanceId: string): Promise<RequalifyInstance | undefined>;
}

/** The service identity. Built here from the environment alone: there is no parameter a caller could use to choose another subject. */
export function requalifierIdentity(environment: string): AuthenticatedIdentity {
  if (!REQUALIFY_ENVIRONMENT_PATTERN.test(environment)) throw refusal("invalid-input");
  const subject = requalifierSubject(environment);
  return { issuer: REQUALIFIER_ISSUER, subject, ownerKey: createHash("sha256").update(REQUALIFIER_ISSUER).update("\0").update(subject).digest("hex"), isAdministrator: false, claims: {} };
}

/** A refusal carries a fixed code and nothing else: never free text from a runner, a proposal or an AWS error. */
function refusal(code: RequalifyReasonCode) {
  return agentXError(code === "lock-not-held" || code === "runner-changed" ? "PROJECT_REVISION_MISMATCH" : code === "invalid-input" ? "CONFIG_INVALID" : "FORBIDDEN", `${REQUALIFY_REFUSAL_PREFIX}${code}`);
}

const RunInputSchema = z.object({
  runId: z.string().uuid(),
  instanceId: z.string().regex(E2E_QUALIFICATION_INSTANCE_ID_PATTERN),
  roleId: z.string().regex(E2E_QUALIFICATION_ROLE_ID_PATTERN),
}).strict();
// The register input carries the whole proposal, which holds the challenge secret. The caller (AR-2) must read `proposal.json` from the runner's prefix inside
// the same Lambda and hand it straight to `registerRequalifiedRuntime`; it must never travel through Step Functions state or logs.
export type RequalifyRunInput = z.infer<typeof RunInputSchema>;

const RegisterInputSchema = RunInputSchema.extend({
  proposal: z.unknown(),
  proposalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  amiId: z.string().regex(/^ami-[0-9a-f]{8,17}$/).nullable().default(null),
  images: z.object({ worker: z.string().min(1).max(300).regex(/^[A-Za-z0-9._:/@+=-]+$/).nullable(), executor: z.string().min(1).max(300).regex(/^[A-Za-z0-9._:/@+=-]+$/).nullable() }).strict().default({ worker: null, executor: null }),
}).strict();

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw refusal("invalid-input");
  return parsed.data;
}

function expectedBindingJson(deps: RequalifyDependencies): string {
  return canonicalJson(Ec2RuntimeBindingSchema.parse(deps.expectedBinding));
}

/** The lock row must exist, be held by this run and be unexpired. The switch repeats this inside its transaction. */
async function assertLockHeld(deps: RequalifyDependencies, runId: string): Promise<void> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: requalifyLockKey(REQUALIFY_PROFILE_ID), ConsistentRead: true }))).Item;
  const lock = RequalifyLockSchema.safeParse(item === undefined ? undefined : Object.fromEntries(Object.entries(item).filter(([name]) => name !== "pk" && name !== "sk" && name !== "ttl")));
  const now = deps.now?.() ?? Date.now();
  if (!lock.success || lock.data.runId !== runId || Date.parse(lock.data.expiresAt) <= now) throw refusal("lock-not-held");
}

/** The instance the renewal launched: running, in this environment, with every renewal tag and this run's id. Returns its private IP. */
async function managedRunnerIp(deps: RequalifyDependencies, input: RequalifyRunInput): Promise<string> {
  const instance = await deps.describeInstance(input.instanceId);
  const tags = instance?.tags ?? {};
  if (instance === undefined || instance.instanceId !== input.instanceId || instance.state !== "running" || instance.privateIp === undefined
    || tags[REQUALIFY_TAGS.deploymentModeKey] !== REQUALIFY_TAGS.deploymentModeValue || tags[REQUALIFY_TAGS.environmentKey] !== deps.environment
    || tags[REQUALIFY_TAGS.managedKey] !== REQUALIFY_TAGS.managedValue || tags[REQUALIFY_TAGS.runKey] !== input.runId) throw refusal("endpoint-not-managed-instance");
  return instance.privateIp;
}

/** The generation the renewed rows must carry: one past the newest registered generation of either kind (1 when nothing is registered). */
export async function nextGeneration(deps: Pick<RuntimeInstallationDependencies, "documentClient" | "tableName" | "featureCatalogId">): Promise<number> {
  const before = await Promise.all((["web", "api"] as const).map((kind) => readWebApiCatalogRow(deps, e2eRegisteredRuntimeKey(deps.featureCatalogId, REQUALIFY_PROFILE_ID, kind))));
  return Math.max(0, ...before.map((row) => row?.generation ?? 0)) + 1;
}

/**
 * Issues the renewal's challenge and writes `challenge.json` straight to the new runner's prefix. The caller supplies only the run, the runner and
 * its role; the profile, binding, generation (current + 1), endpoint and transport correlation are all derived here. The challenge secret is written
 * to the object store and never returned, so it cannot reach workflow state or logs.
 */
export async function issueRequalifyChallenge(deps: RequalifyDependencies, inputValue: unknown): Promise<{ challengeId: string; expiresAt: string; generation: number; transportCorrelationId: string }> {
  const input = parseInput(RunInputSchema, inputValue);
  const identity = requalifierIdentity(deps.environment);
  await assertLockHeld(deps, input.runId);
  const ip = await managedRunnerIp(deps, input);
  const generation = await nextGeneration(deps);
  const challenge = await issueChallengeAs(deps, identity, {
    binding: Ec2RuntimeBindingSchema.parse(deps.expectedBinding), profileId: REQUALIFY_PROFILE_ID, endpoint: `http://${ip}:${RUNNER_PORT}`,
    generation, transportCorrelationId: randomUUID(),
  }, { requalifyRunId: input.runId, requalifyInstanceId: input.instanceId, requalifyRoleId: input.roleId });
  await deps.s3.send(new PutObjectCommand({ Bucket: deps.artifactBucketName, Key: `${e2eQualificationPrefix(input.roleId, input.instanceId)}challenge.json`,
    Body: Buffer.from(`${canonicalJson(challenge)}\n`, "utf8"), ContentType: "application/json", ServerSideEncryption: "AES256" }));
  return { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, generation, transportCorrelationId: challenge.transportCorrelationId };
}

type PreviousRunner = { runner: RequalifyRunnerIdentity | null; pointerExists: boolean };

/** The runner the model-check pointer names now. A pointer that exists but cannot be read as a runner is refused: the renewal does not guess which machine to retire. */
async function readPreviousRunner(deps: RequalifyDependencies): Promise<PreviousRunner> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID), ConsistentRead: true }))).Item;
  if (item === undefined) return { runner: null, pointerExists: false };
  const runner = z.object({ instanceId: z.string().regex(E2E_QUALIFICATION_INSTANCE_ID_PATTERN), roleId: z.string().regex(E2E_QUALIFICATION_ROLE_ID_PATTERN), transportCorrelationId: z.string().uuid() }).safeParse(item);
  if (!runner.success) throw refusal("runner-pointer-invalid");
  return { runner: { instanceId: runner.data.instanceId, roleId: runner.data.roleId, transportCorrelationId: runner.data.transportCorrelationId }, pointerExists: true };
}

export type RequalifySwitchResult = { registration: WebApiRuntimeRegistrationResult; generation: number; previousRunner: RequalifyRunnerIdentity | null; record: RequalifyRunRecord };

/**
 * Registers the renewed runtime: the one switch. Refuses (before anything is written) unless the proposal answers a challenge this renewal issued for
 * this run, on a runner this renewal launched, for the one profile and binding, at exactly the next generation, while this run holds the lock. The
 * unchanged registrar then re-derives every probe from its retained bytes. A refusal or a lost race leaves rows, pointer and old runner untouched.
 */
export async function registerRequalifiedRuntime(deps: RequalifyDependencies, inputValue: unknown): Promise<RequalifySwitchResult> {
  const input = parseInput(RegisterInputSchema, inputValue);
  const identity = requalifierIdentity(deps.environment);
  await assertLockHeld(deps, input.runId);
  const previous = await readPreviousRunner(deps);
  const ip = await managedRunnerIp(deps, input);
  let record: RequalifyRunRecord | undefined;
  let nextRunner: RequalifyRunnerIdentity | undefined;
  const registration = await registerWebApiRuntimeInstallation(deps, identity, { proposal: input.proposal, proposalSha256: input.proposalSha256 }, {
    authorize: ({ proposal, before, challengeRow }) => {
      assertNarrow(deps, input, ip, proposal, challengeRow, Math.max(0, ...[before.web, before.api].map((row) => row?.generation ?? 0)) + 1);
    },
    extraWrites: ({ proposal, proposalSha256, revisions, transactAt }) => {
      nextRunner = { instanceId: input.instanceId, roleId: input.roleId, transportCorrelationId: proposal.challenge.transportCorrelationId };
      const at = new Date(transactAt).toISOString();
      record = RequalifyRunRecordSchema.parse({ schemaVersion: 1, entityType: "RUNTIME_REQUALIFY_RUN", runId: input.runId, environment: deps.environment, profileId: REQUALIFY_PROFILE_ID,
        requestedBySubject: identity.subject, switchedAt: at, generation: proposal.challenge.generation, featureRevisions: revisions, proposalSha256,
        challengeId: proposal.challenge.challengeId, newRunner: nextRunner, previousRunner: previous.runner, amiId: input.amiId, images: input.images });
      return [
        // Still the run that holds the lock, and still unexpired, at the moment of the switch.
        { ConditionCheck: { TableName: deps.tableName, Key: requalifyLockKey(REQUALIFY_PROFILE_ID), ConditionExpression: "runId = :runId AND expiresAt > :now",
          ExpressionAttributeValues: { ":runId": input.runId, ":now": at } } },
        // The model-check pointer moves only from the runner this renewal read (or from nothing): a script run that moved it meanwhile fails the whole switch.
        { Put: { TableName: deps.tableName, Item: { ...e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID), entityType: "E2E_MODEL_CHECK_RUNNER", roleId: input.roleId, instanceId: input.instanceId,
          transportCorrelationId: nextRunner.transportCorrelationId, recordedAt: at, requalifyRunId: input.runId },
          ...(previous.runner === null ? { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }
            : { ConditionExpression: "instanceId = :previousInstance AND transportCorrelationId = :previousCorrelation",
              ExpressionAttributeValues: { ":previousInstance": previous.runner.instanceId, ":previousCorrelation": previous.runner.transportCorrelationId } }) } },
        { Put: { TableName: deps.tableName, Item: { ...requalifyRunKey(input.runId), ...record }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
      ];
    },
  });
  if (record === undefined) throw refusal("runner-changed");
  return { registration, generation: record.generation, previousRunner: previous.runner, record };
}

/** The narrowing checks. Each throws a fixed code; none echoes anything the proposal or the challenge row said. */
function assertNarrow(deps: RequalifyDependencies, input: RequalifyRunInput, ip: string, proposal: WebApiRuntimeInstallProposal, challengeRow: Readonly<Record<string, unknown>>, nextGenerationNumber: number): void {
  const challenge = proposal.challenge;
  if (challenge.profileId !== REQUALIFY_PROFILE_ID) throw refusal("wrong-profile");
  if (canonicalJson(challenge.binding) !== expectedBindingJson(deps)) throw refusal("binding-mismatch");
  let endpoint: URL | undefined;
  try { endpoint = new URL(challenge.endpoint); } catch { endpoint = undefined; }
  if (endpoint === undefined || endpoint.protocol !== "http:" || endpoint.hostname !== ip || endpoint.port !== RUNNER_PORT || endpoint.username !== "" || endpoint.password !== "") throw refusal("endpoint-not-managed-instance");
  if (challenge.generation !== nextGenerationNumber) throw refusal("generation-not-next");
  if (challenge.issuedBySubject !== requalifierSubject(deps.environment) || challenge.issuedByOwnerKey !== requalifierIdentity(deps.environment).ownerKey
    || challengeRow["requalifyRunId"] !== input.runId || challengeRow["requalifyInstanceId"] !== input.instanceId || challengeRow["requalifyRoleId"] !== input.roleId) throw refusal("challenge-not-requalifier");
}

/** Reads one instance with `DescribeInstances` (read only); an instance that does not exist is undefined, any other fault is thrown. */
export function ec2RequalifyInstanceReader(ec2: Pick<EC2Client, "send">): RequalifyDependencies["describeInstance"] {
  return async (instanceId) => {
    let response;
    try { response = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] })); }
    catch (error) {
      if (error !== null && typeof error === "object" && (error as { name?: unknown }).name === "InvalidInstanceID.NotFound") return undefined;
      throw error;
    }
    const instance = response.Reservations?.flatMap((reservation) => reservation.Instances ?? []).find((item) => item.InstanceId === instanceId);
    if (instance === undefined) return undefined;
    const tags: Record<string, string> = {};
    for (const tag of instance.Tags ?? []) if (tag.Key !== undefined && tag.Value !== undefined) tags[tag.Key] = tag.Value;
    return { instanceId, state: instance.State?.Name ?? "unknown", privateIp: instance.PrivateIpAddress, tags };
  };
}

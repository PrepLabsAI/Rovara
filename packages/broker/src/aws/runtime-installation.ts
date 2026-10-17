import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  canonicalJson, RuntimeInstallChallengeSchema, RuntimeInstallationProposalSchema, runtimeInstallChallengeDigest,
  runtimeInstallationProposalSha256, type RuntimeInstallChallenge, type RuntimeInstallationProposal,
  ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema,
  agentXError,
} from "@agentx/contracts";
import { parseE2EReport } from "@agentx/verifier";
import type { AuthenticatedIdentity } from "../auth.js";
import { projectSetupBindingDigest, projectSetupRuntimeKey, ProjectSetupRuntimeRecordSchema } from "./project-setup-runtime-catalog.js";
import { e2eFeatureVerifierKey, E2E_FEATURE_PROCESS_RESPONSE_SCOPE, E2EFeatureVerifierRecordSchema } from "./e2e-feature-verifier-catalog.js";

const MAX_PROPOSAL_BYTES = 1_048_576;
const PROFILE_ID = "default-sandbox";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export const RuntimeInstallChallengeRequestSchema = z.object({
  binding: RuntimeInstallChallengeSchema.shape.binding,
  profileId: RuntimeInstallChallengeSchema.shape.profileId,
  endpoint: RuntimeInstallChallengeSchema.shape.endpoint,
  generation: RuntimeInstallChallengeSchema.shape.generation,
  transportCorrelationId: RuntimeInstallChallengeSchema.shape.transportCorrelationId,
}).strict();
export type RuntimeInstallChallengeRequest = ReturnType<typeof RuntimeInstallChallengeRequestSchema.parse>;

export interface RuntimeInstallationDependencies {
  documentClient: DynamoDBDocumentClient;
  s3: S3Client;
  tableName: string;
  artifactBucketName: string;
  setupCatalogId: string;
  featureCatalogId: string;
  now?: () => number;
  randomUUID?: () => string;
  challengeLifetimeMs?: number;
}

function nowFor(deps: RuntimeInstallationDependencies): number { return deps.now?.() ?? Date.now(); }
function knownProfile(profileId: RuntimeInstallChallenge["profileId"]): boolean { return profileId === "linux-arm64-docker-v1" || profileId === "darwin-arm64-colima-v1"; }
function assertAdmin(identity: AuthenticatedIdentity): void {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
}
function challengeKey(challengeId: string): { pk: string; sk: string } { return { pk: `RUNTIME_INSTALL_CHALLENGE#${challengeId}`, sk: "CHALLENGE" }; }
function evidenceKey(proposalSha256: string): { pk: string; sk: string } { return { pk: `RUNTIME_INSTALLATION_EVIDENCE#${proposalSha256}`, sk: "EVIDENCE" }; }
function runtimeEvidenceObjectKey(proposalSha256: string): string { return `runtime-installations/sha256/${proposalSha256}.json`; }

export async function issueRuntimeInstallChallenge(
  deps: RuntimeInstallationDependencies,
  identity: AuthenticatedIdentity,
  requestInput: unknown,
): Promise<RuntimeInstallChallenge> {
  assertAdmin(identity);
  const request = RuntimeInstallChallengeRequestSchema.parse(requestInput);
  if (!knownProfile(request.profileId)) throw agentXError("CONFIG_INVALID", "runtime profile is not enabled for this catalog");
  const issuedAtMs = nowFor(deps);
  const id = (deps.randomUUID ?? randomUUID)();
  const challenge = RuntimeInstallChallengeSchema.parse({
    schemaVersion: "runtime-install-challenge/v1", challengeId: id, challengeSecret: randomBytes(32).toString("base64"),
    issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: new Date(issuedAtMs + (deps.challengeLifetimeMs ?? 5 * 60_000)).toISOString(),
    issuedByOwnerKey: identity.ownerKey, issuedBySubject: identity.subject,
    binding: request.binding, setupCatalogId: deps.setupCatalogId, featureCatalogId: deps.featureCatalogId,
    profileId: request.profileId, endpoint: request.endpoint, generation: request.generation, transportCorrelationId: request.transportCorrelationId,
    probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() },
  });
  const digest = runtimeInstallChallengeDigest(challenge);
  await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: {
    ...challengeKey(id), entityType: "RUNTIME_INSTALL_CHALLENGE", state: "ISSUED", challengeDigest: digest,
    secretSha256: sha(Buffer.from(challenge.challengeSecret, "base64")), issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
    issuedByOwnerKey: identity.ownerKey, issuedBySubject: identity.subject,
    ttl: Math.ceil(Date.parse(challenge.expiresAt) / 1000),
  }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
  return challenge;
}

export function runtimeInstallationRecords(input: {
  proposal: RuntimeInstallationProposal; setupRevision: number; featureRevision: number; qualifiedAt?: string;
}): { setup: Record<string, unknown>; feature: Record<string, unknown> } {
  const proposal = RuntimeInstallationProposalSchema.parse(input.proposal);
  const binding = proposal.challenge.binding;
  const bindingDigest = projectSetupBindingDigest(binding);
  const runnerEnvironment = ProjectSetupRunnerEnvironmentSchema.parse(proposal.runnerEnvironment);
  const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse(proposal.runnerToolchain);
  const runnerEnvironmentDigest = sha(canonicalJson(runnerEnvironment));
  const runnerToolchainDigest = sha(canonicalJson(runnerToolchain));
  const qualifiedAt = input.qualifiedAt ?? proposal.createdAt;
  const expiresAt = new Date(Math.min(Date.parse(proposal.challenge.expiresAt) + 30 * 24 * 60 * 60_000, Date.parse(qualifiedAt) + 7 * 24 * 60 * 60_000)).toISOString();
  if (Date.parse(qualifiedAt) >= Date.parse(expiresAt)) throw agentXError("CONFIG_INVALID", "runtime proof has no remaining catalog lifetime");
  const setup = {
    schemaVersion: 1, entityType: "PROJECT_SETUP_RUNTIME", runtimeCatalogId: proposal.challenge.setupCatalogId, catalogRevision: input.setupRevision,
    bindingDigest, binding, manifestDigest: proposal.manifest.sha256, runnerEnvironmentDigest, runnerEnvironment,
    runnerToolchainDigest, runnerToolchain, endpoint: proposal.challenge.endpoint, generation: proposal.challenge.generation,
    transportCorrelationId: proposal.challenge.transportCorrelationId, supportedSetupScopes: ["source-interface"], state: "READY",
    qualifiedAt, expiresAt,
  };
  const feature = {
    schemaVersion: 1, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: proposal.challenge.featureCatalogId, catalogRevision: input.featureRevision,
    profileId: PROFILE_ID, bindingDigest, binding, manifestDigest: proposal.manifest.sha256, runnerEnvironmentDigest, runnerEnvironment,
    runnerToolchainDigest, runnerToolchain, endpoint: proposal.challenge.endpoint, generation: proposal.challenge.generation,
    transportCorrelationId: proposal.challenge.transportCorrelationId, supportedFeatureScopes: [E2E_FEATURE_PROCESS_RESPONSE_SCOPE], state: "READY",
    qualifiedAt, expiresAt,
  };
  return { setup, feature };
}

async function retainImmutableProposal(deps: RuntimeInstallationDependencies, proposal: RuntimeInstallationProposal, proposalSha256: string): Promise<{ key: string; sha256: string; byteLength: number }> {
  const body = canonicalJson(proposal);
  const bytes = Buffer.from(body, "utf8");
  if (bytes.byteLength > MAX_PROPOSAL_BYTES || sha(bytes) !== proposalSha256) throw agentXError("CONFIG_INVALID", "runtime proposal exceeds its evidence bound or its digest changed");
  const key = runtimeEvidenceObjectKey(proposalSha256);
  try {
    await deps.s3.send(new PutObjectCommand({ Bucket: deps.artifactBucketName, Key: key, Body: bytes, ContentType: "application/json", Metadata: { sha256: proposalSha256 }, IfNoneMatch: "*" }));
  } catch (error) {
    const details = error && typeof error === "object" ? error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } : {};
    if (details.name !== "PreconditionFailed" && details.$metadata?.httpStatusCode !== 412) throw error;
    const retained = await deps.s3.send(new GetObjectCommand({ Bucket: deps.artifactBucketName, Key: key }));
    const retainedBytes = await retained.Body?.transformToByteArray();
    if (!retainedBytes || sha(retainedBytes) !== proposalSha256 || Buffer.compare(Buffer.from(retainedBytes), bytes) !== 0) throw agentXError("RUNTIME_UNAVAILABLE", "content-addressed runtime evidence conflicts with its proposal digest");
  }
  return { key, sha256: proposalSha256, byteLength: bytes.byteLength };
}

async function readCatalogRevision(deps: RuntimeInstallationDependencies, key: { pk: string; sk: string }): Promise<number | undefined> {
  const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }));
  const item = result.Item as Record<string, unknown> | undefined;
  if (item === undefined) return undefined;
  if (!Number.isSafeInteger(item.catalogRevision) || (item.catalogRevision as number) < 1) throw agentXError("RUNTIME_UNAVAILABLE", "existing runtime catalog row has an invalid revision");
  return item.catalogRevision as number;
}

export async function registerRuntimeInstallation(
  deps: RuntimeInstallationDependencies,
  identity: AuthenticatedIdentity,
  requestInput: unknown,
): Promise<{ setupCatalogId: string; featureCatalogId: string; setupRevision: number; featureRevision: number; proposalSha256: string; evidence: { key: string; sha256: string; byteLength: number } }> {
  assertAdmin(identity);
  const request = zRegistrationRequest(requestInput);
  const proposal = RuntimeInstallationProposalSchema.parse(request.proposal);
  const report = parseE2EReport(Buffer.from(proposal.execution.run.stdout.bytesBase64, "base64"));
  if (report.kind !== "parsed") throw agentXError("CONFIG_INVALID", "runtime proposal does not contain a complete pinned upstream report");
  if (report.report.run.runner.name !== "e2e" || report.report.run.runner.version !== "0.20.0"
    || report.report.run.project.id !== "rovara-contract-p0" || report.report.run.project.configDigest !== proposal.execution.launchConfigDigest
    || canonicalJson(report.report.run.environment) !== canonicalJson(proposal.runnerEnvironment)) throw agentXError("CONFIG_INVALID", "runtime report runner, project configuration, or observed environment differs from the qualified installation");
  const proposalSha256 = runtimeInstallationProposalSha256(proposal);
  if (proposalSha256 !== request.proposalSha256) throw agentXError("CONFIG_INVALID", "runtime proposal approval digest does not match the exact proposal bytes");
  if (proposal.challenge.setupCatalogId !== deps.setupCatalogId || proposal.challenge.featureCatalogId !== deps.featureCatalogId) throw agentXError("FORBIDDEN", "runtime challenge catalogs do not match this deployment");
  const nowBeforeRetain = nowFor(deps);
  if (Date.parse(proposal.challenge.expiresAt) <= nowBeforeRetain || Date.parse(proposal.challenge.issuedAt) > nowBeforeRetain || Date.parse(proposal.createdAt) > nowBeforeRetain) throw agentXError("CONFIG_INVALID", "runtime challenge is expired or from the future");
  const key = challengeKey(proposal.challenge.challengeId);
  const challengeResult = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }));
  const challengeRow = challengeResult.Item as Record<string, unknown> | undefined;
  const challengeDigest = runtimeInstallChallengeDigest(proposal.challenge);
  const challengeSecretDigest = sha(Buffer.from(proposal.challenge.challengeSecret, "base64"));
  if (!challengeRow || challengeRow.entityType !== "RUNTIME_INSTALL_CHALLENGE" || challengeRow.state !== "ISSUED"
    || challengeRow.challengeDigest !== challengeDigest || challengeRow.secretSha256 !== challengeSecretDigest
    || challengeRow.issuedByOwnerKey !== proposal.challenge.issuedByOwnerKey || challengeRow.issuedBySubject !== proposal.challenge.issuedBySubject
    || typeof challengeRow.expiresAt !== "string" || Date.parse(challengeRow.expiresAt) <= nowBeforeRetain) throw agentXError("CONFIG_INVALID", "runtime challenge is missing, stale, mismatched, or already consumed");
  if (identity.ownerKey !== challengeRow.issuedByOwnerKey || identity.subject !== challengeRow.issuedBySubject) throw agentXError("FORBIDDEN", "runtime installation must be approved by the administrator who issued its challenge");
  if (proposal.challenge.profileId !== "linux-arm64-docker-v1" || proposal.runnerToolchain.platform !== "linux" || proposal.runnerToolchain.arch !== "arm64" || proposal.runnerToolchain.execPath !== "/usr/local/bin/node") throw agentXError("CONFIG_INVALID", "standard runtime registration requires qualification on the fixed Linux ARM64 worker supervisor");
  const expectedSetupKey = projectSetupRuntimeKey(deps.setupCatalogId, projectSetupBindingDigest(proposal.challenge.binding));
  const expectedFeatureKey = e2eFeatureVerifierKey(deps.featureCatalogId, PROFILE_ID);
  const [setupRevisionBefore, featureRevisionBefore] = await Promise.all([readCatalogRevision(deps, expectedSetupKey), readCatalogRevision(deps, expectedFeatureKey)]);
  const evidence = await retainImmutableProposal(deps, proposal, proposalSha256);
  const evidencePointerKey = evidenceKey(proposalSha256);
  const evidencePointerResult = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: evidencePointerKey, ConsistentRead: true }));
  const attribution = { issuedByOwnerKey: challengeRow.issuedByOwnerKey, issuedBySubject: challengeRow.issuedBySubject, issuedAt: challengeRow.issuedAt, approvedByOwnerKey: identity.ownerKey, approvedBySubject: identity.subject, approvedAt: new Date(nowBeforeRetain).toISOString() };
  const evidencePointer = { ...evidencePointerKey, entityType: "RUNTIME_INSTALLATION_EVIDENCE", proposalSha256, evidence, ...attribution };
  if (evidencePointerResult.Item && canonicalJson(evidencePointerResult.Item) !== canonicalJson(evidencePointer)) throw agentXError("RUNTIME_UNAVAILABLE", "immutable runtime evidence pointer conflicts with its digest or attribution");
  const setupRevision = (setupRevisionBefore ?? 0) + 1;
  const featureRevision = (featureRevisionBefore ?? 0) + 1;
  const records = runtimeInstallationRecords({ proposal, setupRevision, featureRevision, qualifiedAt: new Date(nowFor(deps)).toISOString() });
  // Validate both catalog rows through their existing strict contracts before a single transaction can publish either.
  const setup = ProjectSetupRuntimeRecordSchema.parse(records.setup);
  const feature = E2EFeatureVerifierRecordSchema.parse(records.feature);
  const transactAt = nowFor(deps);
  if (Date.parse(proposal.challenge.expiresAt) <= transactAt) throw agentXError("CONFIG_INVALID", "runtime challenge expired before its registration transaction");
  const revisionCondition = (old: number | undefined) => old === undefined
    ? { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }
    : { ConditionExpression: "catalogRevision = :expectedRevision", ExpressionAttributeValues: { ":expectedRevision": old } };
  const setupItem = { ...expectedSetupKey, ...setup };
  const featureItem = { ...expectedFeatureKey, ...feature };
  const writes = [
    { Put: { TableName: deps.tableName, Item: setupItem, ...revisionCondition(setupRevisionBefore) } },
    { Put: { TableName: deps.tableName, Item: featureItem, ...revisionCondition(featureRevisionBefore) } },
    { Put: { TableName: deps.tableName, Item: evidencePointer, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    { Update: { TableName: deps.tableName, Key: key, UpdateExpression: "SET #state = :consumed, consumedAt = :consumedAt, proposalSha256 = :proposalSha256, approvedByOwnerKey = :ownerKey, approvedBySubject = :subject, approvedAt = :approvedAt", ConditionExpression: "entityType = :entity AND #state = :issued AND challengeDigest = :challengeDigest AND secretSha256 = :secretSha256 AND issuedByOwnerKey = :ownerKey AND issuedBySubject = :subject AND expiresAt > :now", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":entity": "RUNTIME_INSTALL_CHALLENGE", ":issued": "ISSUED", ":consumed": "CONSUMED", ":challengeDigest": challengeDigest, ":secretSha256": challengeSecretDigest, ":ownerKey": identity.ownerKey, ":subject": identity.subject, ":now": new Date(transactAt).toISOString(), ":consumedAt": new Date(transactAt).toISOString(), ":approvedAt": new Date(transactAt).toISOString(), ":proposalSha256": proposalSha256 } } },
  ];
  try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: writes })); }
  catch { throw agentXError("PROJECT_REVISION_MISMATCH", "runtime challenge, catalog revision, or evidence pointer changed before paired registration"); }
  return { setupCatalogId: setup.runtimeCatalogId, featureCatalogId: feature.runtimeCatalogId, setupRevision, featureRevision, proposalSha256, evidence };
}

function zRegistrationRequest(value: unknown): { proposal: unknown; proposalSha256: string } {
  const parsed = z.object({ proposal: z.unknown(), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `invalid runtime registration request: ${parsed.error.issues[0]?.message ?? "invalid body"}`);
  return parsed.data;
}

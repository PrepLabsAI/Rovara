import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  canonicalJson, RuntimeInstallChallengeSchema, RuntimeInstallationProposalSchema, runtimeInstallChallengeDigest,
  runtimeInstallationProposalSha256, type RuntimeInstallChallenge, type RuntimeInstallationProposal,
  ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema,
  WEB_API_CHALLENGE_LIFETIME_MS, WEB_API_PROBE_PROPOSAL_MAX_BYTES, WEB_API_RUNTIME_PROFILE_ID, WebApiRuntimeInstallProposalSchema, webApiRuntimeInstallProposalSha256, type WebApiRuntimeInstallProposal,
  agentXError, REQUALIFIER_ISSUER,
} from "@agentx/contracts";
import { parseE2EReport, verifyWebApiProbeRecord } from "@agentx/verifier";
import type { AuthenticatedIdentity } from "../auth.js";
import type { TransactItems } from "./developer-task-actions.js";
import { projectSetupBindingDigest, projectSetupRuntimeKey, ProjectSetupRuntimeRecordSchema } from "./project-setup-runtime-catalog.js";
import { e2eFeatureVerifierKey, e2eWebApiRuntimeRecords, E2E_FEATURE_PROCESS_RESPONSE_SCOPE, E2EFeatureVerifierRecordSchema } from "./e2e-feature-verifier-catalog.js";
import { e2eRegisteredRuntimeKey } from "./e2e-runtime-readiness.js";

/** The standard (P0) proposal's retention bound; the web/API proposal has its own, larger one. */
export const RUNTIME_PROPOSAL_MAX_BYTES = 1_048_576;
const MAX_PROPOSAL_BYTES = RUNTIME_PROPOSAL_MAX_BYTES;
/** A P0 challenge covers three quick probes; a web/API one covers six container runs and gets `WEB_API_CHALLENGE_LIFETIME_MS`. */
const STANDARD_CHALLENGE_LIFETIME_MS = 5 * 60_000;
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
function knownProfile(profileId: RuntimeInstallChallenge["profileId"]): boolean { return profileId === "linux-arm64-docker-v1" || profileId === "darwin-arm64-colima-v1" || profileId === WEB_API_RUNTIME_PROFILE_ID; }
function assertAdmin(identity: AuthenticatedIdentity): void {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
}
function challengeKey(challengeId: string): { pk: string; sk: string } { return { pk: `RUNTIME_INSTALL_CHALLENGE#${challengeId}`, sk: "CHALLENGE" }; }
function evidenceKey(proposalSha256: string): { pk: string; sk: string } { return { pk: `RUNTIME_INSTALLATION_EVIDENCE#${proposalSha256}`, sk: "EVIDENCE" }; }
function runtimeEvidenceObjectKey(proposalSha256: string): string { return `runtime-installations/sha256/${proposalSha256}.json`; }

/**
 * The seams below are exported for the AUTOREQUALIFY wrapper, so they judge authority themselves: an administrator claim, or the internal
 * service identity (`rovara:internal`, which the JWT authenticator cannot produce because it pins the configured issuer) when the caller
 * brings the narrowing the wrapper adds (`scoped`). Anything else, including the service identity without that narrowing, is refused.
 */
function assertSeamAuthority(identity: AuthenticatedIdentity, scoped: boolean): void {
  if (identity.isAdministrator) return;
  if (identity.issuer === REQUALIFIER_ISSUER && scoped) return;
  throw agentXError("FORBIDDEN", "administrator claim is required");
}

export async function issueRuntimeInstallChallenge(
  deps: RuntimeInstallationDependencies,
  identity: AuthenticatedIdentity,
  requestInput: unknown,
): Promise<RuntimeInstallChallenge> {
  assertAdmin(identity);
  return issueChallengeAs(deps, identity, requestInput);
}

/**
 * Issues a challenge for an identity whose authority the caller has already established (the administrator claim above, or the narrow
 * AUTOREQUALIFY wrapper in `runtime-requalify.ts`). `rowExtras` are stored on the challenge row only; they are not part of the challenge digest.
 */
export async function issueChallengeAs(
  deps: RuntimeInstallationDependencies,
  identity: AuthenticatedIdentity,
  requestInput: unknown,
  rowExtras: Readonly<Record<string, string>> = {},
): Promise<RuntimeInstallChallenge> {
  assertSeamAuthority(identity, Object.keys(rowExtras).length > 0);
  const request = RuntimeInstallChallengeRequestSchema.parse(requestInput);
  if (!knownProfile(request.profileId)) throw agentXError("CONFIG_INVALID", "runtime profile is not enabled for this catalog");
  const issuedAtMs = nowFor(deps);
  const id = (deps.randomUUID ?? randomUUID)();
  const challenge = RuntimeInstallChallengeSchema.parse({
    schemaVersion: "runtime-install-challenge/v1", challengeId: id, challengeSecret: randomBytes(32).toString("base64"),
    issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: new Date(issuedAtMs + (deps.challengeLifetimeMs ?? (request.profileId === WEB_API_RUNTIME_PROFILE_ID ? WEB_API_CHALLENGE_LIFETIME_MS : STANDARD_CHALLENGE_LIFETIME_MS))).toISOString(),
    issuedByOwnerKey: identity.ownerKey, issuedBySubject: identity.subject,
    binding: request.binding, setupCatalogId: deps.setupCatalogId, featureCatalogId: deps.featureCatalogId,
    profileId: request.profileId, endpoint: request.endpoint, generation: request.generation, transportCorrelationId: request.transportCorrelationId,
    probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() },
  });
  const digest = runtimeInstallChallengeDigest(challenge);
  await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: {
    ...rowExtras, ...challengeKey(id), entityType: "RUNTIME_INSTALL_CHALLENGE", state: "ISSUED", challengeDigest: digest,
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

export async function retainImmutableProposal(deps: RuntimeInstallationDependencies, proposal: object, proposalSha256: string, maxBytes: number): Promise<{ key: string; sha256: string; byteLength: number }> {
  const body = canonicalJson(proposal);
  const bytes = Buffer.from(body, "utf8");
  if (bytes.byteLength > maxBytes || sha(bytes) !== proposalSha256) throw agentXError("CONFIG_INVALID", "runtime proposal exceeds its evidence bound or its digest changed");
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

/** What one issued challenge row proved, shared by both registration paths. */
type IssuedChallenge = { key: { pk: string; sk: string }; challengeRow: Record<string, unknown>; challengeDigest: string; challengeSecretDigest: string; nowBeforeRetain: number };

/** Loads the challenge row and refuses an expired, future, missing, mismatched, consumed or foreign-issuer challenge. */
async function loadIssuedChallenge(deps: RuntimeInstallationDependencies, identity: AuthenticatedIdentity,
  proposal: { challenge: RuntimeInstallChallenge; createdAt: string }): Promise<IssuedChallenge> {
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
  return { key, challengeRow, challengeDigest, challengeSecretDigest, nowBeforeRetain };
}

/** Retains the exact proposal bytes and builds the immutable evidence pointer, refusing a pointer that conflicts with an earlier one. */
async function prepareEvidence(deps: RuntimeInstallationDependencies, proposal: object, proposalSha256: string, issued: IssuedChallenge,
  identity: AuthenticatedIdentity, maxBytes: number): Promise<{ evidence: { key: string; sha256: string; byteLength: number }; evidencePointer: Record<string, unknown> }> {
  const { challengeRow, nowBeforeRetain } = issued;
  const evidence = await retainImmutableProposal(deps, proposal, proposalSha256, maxBytes);
  const evidencePointerKey = evidenceKey(proposalSha256);
  const evidencePointerResult = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: evidencePointerKey, ConsistentRead: true }));
  const attribution = { issuedByOwnerKey: challengeRow.issuedByOwnerKey, issuedBySubject: challengeRow.issuedBySubject, issuedAt: challengeRow.issuedAt, approvedByOwnerKey: identity.ownerKey, approvedBySubject: identity.subject, approvedAt: new Date(nowBeforeRetain).toISOString() };
  const evidencePointer = { ...evidencePointerKey, entityType: "RUNTIME_INSTALLATION_EVIDENCE", proposalSha256, evidence, ...attribution };
  if (evidencePointerResult.Item && canonicalJson(evidencePointerResult.Item) !== canonicalJson(evidencePointer)) throw agentXError("RUNTIME_UNAVAILABLE", "immutable runtime evidence pointer conflicts with its digest or attribution");
  return { evidence, evidencePointer };
}

const revisionCondition = (old: number | undefined) => old === undefined
  ? { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }
  : { ConditionExpression: "catalogRevision = :expectedRevision", ExpressionAttributeValues: { ":expectedRevision": old } };

/** The evidence pointer write and the one-use challenge consumption that close every registration transaction. */
function challengeAndEvidenceWrites(deps: RuntimeInstallationDependencies, issued: IssuedChallenge, identity: AuthenticatedIdentity,
  proposalSha256: string, evidencePointer: Record<string, unknown>, transactAt: number) {
  const { key, challengeDigest, challengeSecretDigest } = issued;
  return [
    { Put: { TableName: deps.tableName, Item: evidencePointer, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    { Update: { TableName: deps.tableName, Key: key, UpdateExpression: "SET #state = :consumed, consumedAt = :consumedAt, proposalSha256 = :proposalSha256, approvedByOwnerKey = :ownerKey, approvedBySubject = :subject, approvedAt = :approvedAt", ConditionExpression: "entityType = :entity AND #state = :issued AND challengeDigest = :challengeDigest AND secretSha256 = :secretSha256 AND issuedByOwnerKey = :ownerKey AND issuedBySubject = :subject AND expiresAt > :now", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":entity": "RUNTIME_INSTALL_CHALLENGE", ":issued": "ISSUED", ":consumed": "CONSUMED", ":challengeDigest": challengeDigest, ":secretSha256": challengeSecretDigest, ":ownerKey": identity.ownerKey, ":subject": identity.subject, ":now": new Date(transactAt).toISOString(), ":consumedAt": new Date(transactAt).toISOString(), ":approvedAt": new Date(transactAt).toISOString(), ":proposalSha256": proposalSha256 } } },
  ];
}

export async function registerRuntimeInstallation(
  deps: RuntimeInstallationDependencies,
  identity: AuthenticatedIdentity,
  requestInput: unknown,
): Promise<{ setupCatalogId: string; featureCatalogId: string; setupRevision: number; featureRevision: number; proposalSha256: string; evidence: { key: string; sha256: string; byteLength: number } }
  | WebApiRuntimeRegistrationResult> {
  assertAdmin(identity);
  const request = zRegistrationRequest(requestInput);
  if (isWebApiProposal(request.proposal)) return registerWebApiRuntimeInstallation(deps, identity, request);
  const proposal = RuntimeInstallationProposalSchema.parse(request.proposal);
  const report = parseE2EReport(Buffer.from(proposal.execution.run.stdout.bytesBase64, "base64"));
  if (report.kind !== "parsed") throw agentXError("CONFIG_INVALID", "runtime proposal does not contain a complete pinned upstream report");
  if (report.report.run.runner.name !== "e2e" || report.report.run.runner.version !== "0.20.0"
    || report.report.run.project.id !== "rovara-contract-p0" || report.report.run.project.configDigest !== proposal.execution.launchConfigDigest
    || canonicalJson(report.report.run.environment) !== canonicalJson(proposal.runnerEnvironment)) throw agentXError("CONFIG_INVALID", "runtime report runner, project configuration, or observed environment differs from the qualified installation");
  const proposalSha256 = runtimeInstallationProposalSha256(proposal);
  if (proposalSha256 !== request.proposalSha256) throw agentXError("CONFIG_INVALID", "runtime proposal approval digest does not match the exact proposal bytes");
  if (proposal.challenge.setupCatalogId !== deps.setupCatalogId || proposal.challenge.featureCatalogId !== deps.featureCatalogId) throw agentXError("FORBIDDEN", "runtime challenge catalogs do not match this deployment");
  const issued = await loadIssuedChallenge(deps, identity, proposal);
  if (proposal.challenge.profileId !== "linux-arm64-docker-v1" || proposal.runnerToolchain.platform !== "linux" || proposal.runnerToolchain.arch !== "arm64" || proposal.runnerToolchain.execPath !== "/usr/local/bin/node") throw agentXError("CONFIG_INVALID", "standard runtime registration requires qualification on the fixed Linux ARM64 worker supervisor");
  const expectedSetupKey = projectSetupRuntimeKey(deps.setupCatalogId, projectSetupBindingDigest(proposal.challenge.binding));
  const expectedFeatureKey = e2eFeatureVerifierKey(deps.featureCatalogId, PROFILE_ID);
  const [setupRevisionBefore, featureRevisionBefore] = await Promise.all([readCatalogRevision(deps, expectedSetupKey), readCatalogRevision(deps, expectedFeatureKey)]);
  const { evidence, evidencePointer } = await prepareEvidence(deps, proposal, proposalSha256, issued, identity, MAX_PROPOSAL_BYTES);
  const setupRevision = (setupRevisionBefore ?? 0) + 1;
  const featureRevision = (featureRevisionBefore ?? 0) + 1;
  const records = runtimeInstallationRecords({ proposal, setupRevision, featureRevision, qualifiedAt: new Date(nowFor(deps)).toISOString() });
  // Validate both catalog rows through their existing strict contracts before a single transaction can publish either.
  const setup = ProjectSetupRuntimeRecordSchema.parse(records.setup);
  const feature = E2EFeatureVerifierRecordSchema.parse(records.feature);
  const transactAt = nowFor(deps);
  if (Date.parse(proposal.challenge.expiresAt) <= transactAt) throw agentXError("CONFIG_INVALID", "runtime challenge expired before its registration transaction");
  const setupItem = { ...expectedSetupKey, ...setup };
  const featureItem = { ...expectedFeatureKey, ...feature };
  const writes = [
    { Put: { TableName: deps.tableName, Item: setupItem, ...revisionCondition(setupRevisionBefore) } },
    { Put: { TableName: deps.tableName, Item: featureItem, ...revisionCondition(featureRevisionBefore) } },
    ...challengeAndEvidenceWrites(deps, issued, identity, proposalSha256, evidencePointer, transactAt),
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

export type WebApiRuntimeRegistrationResult = { profileId: typeof WEB_API_RUNTIME_PROFILE_ID; featureCatalogId: string; featureRevisions: { web: number; api: number };
  proposalSha256: string; evidence: { key: string; sha256: string; byteLength: number } };

function isWebApiProposal(proposal: unknown): boolean {
  return proposal !== null && typeof proposal === "object" && (proposal as { schemaVersion?: unknown }).schemaVersion === "runtime-installation-proposal/v2";
}

/** Reads an existing per-kind row's revision and the worker generation it was qualified on. */
export async function readWebApiCatalogRow(deps: Pick<RuntimeInstallationDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<{ revision: number; generation: number } | undefined> {
  const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }));
  const item = result.Item as Record<string, unknown> | undefined;
  if (item === undefined) return undefined;
  if (!Number.isSafeInteger(item.catalogRevision) || (item.catalogRevision as number) < 1
    || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1) throw agentXError("RUNTIME_UNAVAILABLE", "existing runtime catalog row has an invalid revision or generation");
  return { revision: item.catalogRevision as number, generation: item.generation as number };
}

/**
 * Ruling Z: registration does not rest on what the runner says it saw. Each probe record carries the retained bytes its observation was derived from; this
 * re-derives the observation from them with the same pure functions the production runner used (the collector's own qualification, the pinned scenario, the
 * run's blocked-requests file, the host's structured build result) and refuses the whole proposal unless every record equals what its bytes show and every run
 * carries the id derived from this challenge. `probe-evidence-unbound:<id>` is evidence of another run or challenge (or none); `probe-evidence-mismatch:<id>`
 * is evidence that does not re-derive to the recorded observation. Nothing has been written when this throws.
 */
function assertRunBoundProbeEvidence(proposal: WebApiRuntimeInstallProposal): void {
  for (const probe of proposal.probes) {
    const checked = verifyWebApiProbeRecord({ challenge: proposal.challenge, probeId: probe.probeId, observation: probe.observation, evidence: probe.evidence });
    if (!checked.ok) throw agentXError("CONFIG_INVALID", `runtime probe evidence is not run-bound: ${checked.reason}`);
  }
}

/** A proposal that failed its schema because of a probe's evidence is refused by that probe's stable reason: missing evidence is unbound, malformed evidence cannot re-derive. */
function evidenceRefusal(proposal: unknown, issues: readonly { path: readonly PropertyKey[] }[]): string | undefined {
  const probes = (proposal as { probes?: unknown } | null)?.probes;
  if (!Array.isArray(probes)) return undefined;
  for (const issue of issues) {
    if (issue.path[0] !== "probes" || typeof issue.path[1] !== "number" || issue.path[2] !== "evidence") continue;
    const probe = probes[issue.path[1]] as { probeId?: unknown; evidence?: unknown } | null;
    if (typeof probe?.probeId !== "string") continue;
    return `${probe.evidence === undefined ? "probe-evidence-unbound" : "probe-evidence-mismatch"}:${probe.probeId}`;
  }
  return undefined;
}

/**
 * Registers the web/API runtime qualification. The proposal's own schema re-judges every recorded probe observation, so a READY label
 * alone registers nothing. The two per-kind v2 rows, the evidence pointer and the one-use challenge are one conditional transaction,
 * and neither row may move to an older worker generation than the one already registered.
 */
/** What a caller that has already established its own authority may add to the web/API registration; the human path passes nothing. */
export type WebApiRegistrationHooks = {
  /** Called after the proposal, its evidence and the challenge have been judged and before anything is written; throw to refuse. */
  authorize?: (context: { proposal: WebApiRuntimeInstallProposal; before: { web: { revision: number; generation: number } | undefined; api: { revision: number; generation: number } | undefined };
    challengeRow: Readonly<Record<string, unknown>> }) => void | Promise<void>;
  /** Extra writes that commit or fail with the paired rows, the evidence pointer and the challenge consumption. */
  extraWrites?: (context: { proposal: WebApiRuntimeInstallProposal; proposalSha256: string; revisions: { web: number; api: number }; transactAt: number }) => TransactItems;
};

export async function registerWebApiRuntimeInstallation(
  deps: RuntimeInstallationDependencies,
  identity: AuthenticatedIdentity,
  request: { proposal: unknown; proposalSha256: string },
  hooks: WebApiRegistrationHooks = {},
): Promise<WebApiRuntimeRegistrationResult> {
  assertSeamAuthority(identity, hooks.authorize !== undefined);
  const parsed = WebApiRuntimeInstallProposalSchema.safeParse(request.proposal);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `runtime proposal is not a READY web/API qualification: ${evidenceRefusal(request.proposal, parsed.error.issues) ?? parsed.error.issues[0]?.message ?? "invalid proposal"}`);
  const proposal = parsed.data;
  assertRunBoundProbeEvidence(proposal);
  const proposalSha256 = webApiRuntimeInstallProposalSha256(proposal);
  if (proposalSha256 !== request.proposalSha256) throw agentXError("CONFIG_INVALID", "runtime proposal approval digest does not match the exact proposal bytes");
  if (proposal.challenge.setupCatalogId !== deps.setupCatalogId || proposal.challenge.featureCatalogId !== deps.featureCatalogId) throw agentXError("FORBIDDEN", "runtime challenge catalogs do not match this deployment");
  const issued = await loadIssuedChallenge(deps, identity, proposal);
  if (proposal.challenge.profileId !== WEB_API_RUNTIME_PROFILE_ID || proposal.runnerToolchain.platform !== "linux" || proposal.runnerToolchain.arch !== "arm64" || proposal.runnerToolchain.execPath !== "/usr/local/bin/node") throw agentXError("CONFIG_INVALID", "web/API runtime registration requires qualification on the fixed Linux ARM64 worker supervisor");
  const keys = { web: e2eRegisteredRuntimeKey(deps.featureCatalogId, WEB_API_RUNTIME_PROFILE_ID, "web"), api: e2eRegisteredRuntimeKey(deps.featureCatalogId, WEB_API_RUNTIME_PROFILE_ID, "api") };
  const [webBefore, apiBefore] = await Promise.all([readWebApiCatalogRow(deps, keys.web), readWebApiCatalogRow(deps, keys.api)]);
  const generation = proposal.challenge.generation;
  if ([webBefore, apiBefore].some((row) => row !== undefined && row.generation > generation)) throw agentXError("CONFIG_INVALID", "runtime proposal is for an older worker generation than the registered runtime");
  await hooks.authorize?.({ proposal, before: { web: webBefore, api: apiBefore }, challengeRow: issued.challengeRow });
  const { evidence, evidencePointer } = await prepareEvidence(deps, proposal, proposalSha256, issued, identity, WEB_API_PROBE_PROPOSAL_MAX_BYTES);
  const revisions = { web: (webBefore?.revision ?? 0) + 1, api: (apiBefore?.revision ?? 0) + 1 };
  const rows = e2eWebApiRuntimeRecords({ proposal, revisions, qualifiedAt: new Date(nowFor(deps)).toISOString(), evidence });
  const transactAt = nowFor(deps);
  if (Date.parse(proposal.challenge.expiresAt) <= transactAt) throw agentXError("CONFIG_INVALID", "runtime challenge expired before its registration transaction");
  // A row that is replaced must still be at the revision read and no newer a generation than this proposal's.
  const rowCondition = (before: { revision: number } | undefined) => before === undefined ? revisionCondition(undefined)
    : { ConditionExpression: "catalogRevision = :expectedRevision AND generation <= :generation", ExpressionAttributeValues: { ":expectedRevision": before.revision, ":generation": generation } };
  const writes = [
    { Put: { TableName: deps.tableName, Item: { ...keys.web, ...rows.web }, ...rowCondition(webBefore) } },
    { Put: { TableName: deps.tableName, Item: { ...keys.api, ...rows.api }, ...rowCondition(apiBefore) } },
    ...challengeAndEvidenceWrites(deps, issued, identity, proposalSha256, evidencePointer, transactAt),
    ...(hooks.extraWrites?.({ proposal, proposalSha256, revisions, transactAt }) ?? []),
  ];
  try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: writes })); }
  catch { throw agentXError("PROJECT_REVISION_MISMATCH", "runtime challenge, catalog revision, or evidence pointer changed before registration"); }
  return { profileId: WEB_API_RUNTIME_PROFILE_ID, featureCatalogId: deps.featureCatalogId, featureRevisions: revisions, proposalSha256, evidence };
}

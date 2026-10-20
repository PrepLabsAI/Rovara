import { createHash } from "node:crypto";
import {
  canonicalJson,
  E2ERegisteredRuntimeSchema,
  E2ERuntimeReadinessSchema,
  Ec2RuntimeBindingSchema,
  resolveE2ERuntimeReadiness,
  type E2EAssertion,
  type E2EEvidenceScope,
  type E2EReadyRuntimeProfile,
  type E2ERuntimeReadiness,
  type E2ERuntimeReadinessInput,
  type E2EStep,
  type Ec2RuntimeBinding,
} from "@agentx/contracts";
import type { z } from "zod";
import type { TransactItems } from "./developer-task-actions.js";

/** A profile that serves more than one target kind (web and API) keeps one row per kind; without a kind the key is the profile's alone. */
export function e2eRegisteredRuntimeKey(runtimeCatalogId: string, profileId: string, kind?: "web" | "api"): { pk: string; sk: string } {
  return { pk: `E2E_FEATURE_VERIFIER#${runtimeCatalogId}`, sk: kind === undefined ? `PROFILE#${profileId}` : `PROFILE#${profileId}#${kind}` };
}

/**
 * The conditions that keep each runtime row an application approval selected exactly as it was read, until the transaction that records the approval (or a verdict
 * that rests on it) commits. The whole record is held: nothing about a row may move between the read and the commit, whether or not a requalification would bump its
 * generation. A selected row that is not among those read cannot be fenced, and the approval must not be recorded without its fence: that is a throw, never a skip.
 */
export function applicationRuntimeRowFences(input: { tableName: string; rows: readonly z.infer<typeof E2ERegisteredRuntimeSchema>[];
  selected: readonly { kind: "web" | "api"; profileId: string }[] }): TransactItems {
  return input.selected.map((selected) => {
    const row = input.rows.find((item) => item.capabilities.kind === selected.kind && item.profileId === selected.profileId);
    if (row === undefined) throw new Error(`the selected ${selected.kind} runtime ${selected.profileId} is not among the runtime rows this approval was derived from`);
    return { ConditionCheck: { TableName: input.tableName,
      Key: e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, selected.kind),
      ConditionExpression: "entityType = :entity AND #state = :ready AND runtimeCatalogId = :catalog AND catalogRevision = :revision AND generation = :generation AND bindingDigest = :binding AND capabilityDigest = :capability AND expiresAt = :expires AND qualifiedAt = :qualifiedAt AND manifestDigest = :manifest AND endpoint = :endpoint AND runnerEnvironmentDigest = :environmentDigest AND runnerEnvironment = :environment AND runnerToolchainDigest = :toolchainDigest AND runnerToolchain = :toolchain AND transportCorrelationId = :correlation",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":entity": "E2E_FEATURE_VERIFIER", ":ready": "READY", ":catalog": row.runtimeCatalogId, ":revision": row.catalogRevision,
        ":generation": row.generation, ":binding": row.bindingDigest, ":capability": row.capabilityDigest, ":expires": row.expiresAt, ":qualifiedAt": row.qualifiedAt,
        ":manifest": row.manifestDigest, ":endpoint": row.endpoint, ":environmentDigest": row.runnerEnvironmentDigest, ":environment": row.runnerEnvironment,
        ":toolchainDigest": row.runnerToolchainDigest, ":toolchain": row.runnerToolchain, ":correlation": row.transportCorrelationId } } };
  });
}

type ExpectedRuntime = {
  runtimeCatalogId: string;
  profileId: string;
  binding: Ec2RuntimeBinding;
  capabilityDigest: string;
  now: number;
  /** Selects the per-kind row of a profile that registers both web and API runtimes. */
  kind?: "web" | "api";
};

type E2ERegisteredRuntime = z.infer<typeof E2ERegisteredRuntimeSchema>;

const runtimeKeys = new Set([
  "pk", "sk", "schemaVersion", "entityType", "runtimeCatalogId", "profileId", "catalogRevision", "generation", "binding", "bindingDigest",
  "endpoint", "transportCorrelationId", "manifestDigest", "runnerEnvironment", "runnerEnvironmentDigest", "runnerToolchain", "runnerToolchainDigest",
  "state", "qualifiedAt", "expiresAt", "capabilities", "capabilityDigest", "probeManifest", "qualificationEvidenceRef",
]);

function parseRegisteredRow(recordInput: unknown, expected: ExpectedRuntime): E2ERegisteredRuntime | undefined {
  if (recordInput === null || typeof recordInput !== "object" || Array.isArray(recordInput)) return undefined;
  const row = recordInput as Record<string, unknown>;
  const key = e2eRegisteredRuntimeKey(expected.runtimeCatalogId, expected.profileId, expected.kind);
  if (Object.keys(row).some((name) => !runtimeKeys.has(name)) || row.pk !== key.pk || row.sk !== key.sk) return undefined;
  const { pk: _pk, sk: _sk, ...domainRecord } = row;
  void _pk;
  void _sk;
  const parsed = E2ERegisteredRuntimeSchema.safeParse(domainRecord);
  if (!parsed.success) return undefined;
  const runtime = parsed.data;
  if (expected.kind !== undefined && runtime.capabilities.kind !== expected.kind) return undefined;
  let expectedBinding: Ec2RuntimeBinding;
  try { expectedBinding = Ec2RuntimeBindingSchema.parse(expected.binding); }
  catch { return undefined; }
  const bindingDigest = createHash("sha256").update(canonicalJson(expectedBinding)).digest("hex");
  if (runtime.runtimeCatalogId !== expected.runtimeCatalogId || runtime.profileId !== expected.profileId
    || runtime.capabilityDigest !== expected.capabilityDigest || runtime.bindingDigest !== bindingDigest
    || canonicalJson(runtime.binding) !== canonicalJson(expectedBinding)) return undefined;
  return runtime;
}

/** Reads an authenticated catalog row; no writer or registration side effect is exposed here. */
export function admitE2ERegisteredRuntime(recordInput: unknown, expected: ExpectedRuntime): E2ERegisteredRuntime | undefined {
  if (!Number.isSafeInteger(expected.now) || expected.now < 0) return undefined;
  const runtime = parseRegisteredRow(recordInput, expected);
  if (runtime === undefined || runtime.state !== "READY") return undefined;
  const qualifiedAt = Date.parse(runtime.qualifiedAt);
  const expiresAt = Date.parse(runtime.expiresAt);
  if (qualifiedAt > expected.now || expiresAt <= expected.now) return undefined;
  return runtime;
}

type RuntimeRowReader = (key: { pk: string; sk: string }) => Promise<unknown>;

/** Reads the `#web` and `#api` rows of a profile and admits each; a throttled or failed read is logged and fails closed to "not READY". */
async function readAdmittedWebApiRuntimes(input: { runtimeCatalogId: string; profileId: string; now: number; read: RuntimeRowReader;
  binding?: Ec2RuntimeBinding; /** Rethrow a failed read instead of treating the row as not READY, for a caller that must tell the two apart. */ strict?: boolean }): Promise<Array<{ kind: "web" | "api"; runtime: E2ERegisteredRuntime }>> {
  const admittedRows: Array<{ kind: "web" | "api"; runtime: E2ERegisteredRuntime }> = [];
  for (const kind of ["web", "api"] as const) {
    let row: unknown;
    try { row = await input.read(e2eRegisteredRuntimeKey(input.runtimeCatalogId, input.profileId, kind)); }
    catch (error) {
      // Fail closed to "not READY", but say why: a throttled or failed read is not the same as an unqualified runtime.
      console.warn(JSON.stringify({ component: "broker", level: "warn", event: "e2e-runtime-catalog-read-failed", kind, profileId: input.profileId,
        runtimeCatalogId: input.runtimeCatalogId, error: error instanceof Error ? error.message : String(error) }));
      if (input.strict === true) throw error;
      continue;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const { binding, capabilityDigest } = row as { binding?: unknown; capabilityDigest?: unknown };
    if (typeof capabilityDigest !== "string") continue;
    const runtime = admitE2ERegisteredRuntime(row, { runtimeCatalogId: input.runtimeCatalogId, profileId: input.profileId,
      binding: input.binding ?? binding as Ec2RuntimeBinding, capabilityDigest, now: input.now, kind });
    if (runtime !== undefined) admittedRows.push({ kind, runtime });
  }
  return admittedRows;
}

/**
 * The web/API kinds of `profileId` whose catalog row is READY and unexpired, for proposing targets against them. There is no project binding at
 * proposal time, so each row is admitted against its own stored binding and capability digest: that still re-parses the row, checks its key,
 * kind, state and validity window, but the project's binding is only matched later, at planning. A missing or unreadable row is simply not READY.
 */
export async function readReadyE2ERuntimeProfiles(input: { runtimeCatalogId: string; profileId: string; now: number;
  read: RuntimeRowReader }): Promise<E2EReadyRuntimeProfile[]> {
  return (await readAdmittedWebApiRuntimes(input)).map(({ kind }) => ({ kind, profileId: input.profileId }));
}

/** A READY web or API runtime of the project's binding, with the step and assertion kinds its registered descriptor supports. */
export type ReadyE2ERuntime = E2EReadyRuntimeProfile & Readonly<{ supportedSteps: readonly E2EStep["kind"][]; supportedAssertions: readonly E2EAssertion["kind"][] }>;

/**
 * The web/API kinds of `profileId` that are READY for this project's runtime binding right now (Ruling AL): each row is admitted against the
 * project's own binding, so a row registered for another binding, an expired or parked row, or a row that holds the other kind's runtime is not
 * READY. What a kind can execute is read from its registered descriptor, not from a list kept here.
 */
export async function readProjectReadyE2ERuntimes(input: { runtimeCatalogId: string; profileId: string; binding: Ec2RuntimeBinding; now: number;
  read: RuntimeRowReader }): Promise<ReadyE2ERuntime[]> {
  return (await readAdmittedWebApiRuntimes(input)).map(({ kind, runtime }) => ({ kind, profileId: input.profileId,
    supportedSteps: [...runtime.capabilities.supportedSteps], supportedAssertions: [...runtime.capabilities.supportedAssertions] }));
}

/**
 * The registered web/API rows READY for this project's runtime binding right now, whole (planning only needs their summary), for plan approval to
 * derive its selection against. Unlike the planning read, a row that cannot be read is an error here, not a quiet "not READY".
 */
export async function readProjectAdmittedE2ERuntimes(input: { runtimeCatalogId: string; profileId: string; binding: Ec2RuntimeBinding; now: number;
  read: RuntimeRowReader }): Promise<E2ERegisteredRuntime[]> {
  return (await readAdmittedWebApiRuntimes({ ...input, strict: true })).map(({ runtime }) => runtime);
}

type RuntimeReadinessInput = {
  record: unknown;
  expected: ExpectedRuntime;
  target: E2ERuntimeReadinessInput["target"];
  requiredSteps: E2EStep["kind"][];
  requiredAssertions: E2EAssertion["kind"][];
  minimumEvidence: E2EEvidenceScope;
  installationEnabled: boolean;
  activationEnabled: boolean;
  connection: "connected" | "unconnected";
  approval: "approved" | "pending" | "declined";
};

const capabilityLabels = (steps: readonly string[], assertions: readonly string[], scopes: readonly string[]) => [
  ...steps.map((kind) => `step:${kind}`),
  ...assertions.map((kind) => `assertion:${kind}`),
  ...scopes.map((scope) => `evidence:${scope}`),
].sort();

function forcedReadiness(input: RuntimeReadinessInput, status: E2ERuntimeReadiness["status"], reasonCode: string): E2ERuntimeReadiness {
  return E2ERuntimeReadinessSchema.parse({
    targetId: input.target.targetId,
    profileId: input.target.runtimeProfileId,
    status,
    reasonCode,
    requiredCapabilities: capabilityLabels(input.requiredSteps, input.requiredAssertions, [input.minimumEvidence]),
    supportedCapabilities: [],
    suggestedAction: null,
  });
}

/** Projects the exact stored catalog fact through Task 1 capability/access readiness. */
export function projectE2ERuntimeReadiness(input: RuntimeReadinessInput): E2ERuntimeReadiness {
  if (!input.activationEnabled) {
    return resolveE2ERuntimeReadiness({
      target: input.target, requiredSteps: input.requiredSteps, requiredAssertions: input.requiredAssertions, minimumEvidence: input.minimumEvidence,
      installationEnabled: input.installationEnabled, activationEnabled: false, connection: input.connection, approval: input.approval,
      qualification: "unqualified", state: "UNAVAILABLE", expiresAt: null, now: input.expected.now, capabilities: null,
    });
  }
  if (input.record === undefined || input.record === null) {
    return resolveE2ERuntimeReadiness({
      target: input.target, requiredSteps: input.requiredSteps, requiredAssertions: input.requiredAssertions, minimumEvidence: input.minimumEvidence,
      installationEnabled: input.installationEnabled, activationEnabled: true, connection: input.connection, approval: input.approval,
      qualification: "unqualified", state: "UNAVAILABLE", expiresAt: null, now: input.expected.now, capabilities: null,
    });
  }
  const runtime = parseRegisteredRow(input.record, input.expected);
  if (runtime === undefined) return forcedReadiness(input, "INCOMPATIBLE", "INVALID_CATALOG_IDENTITY");
  if (runtime.state !== "READY") {
    return resolveE2ERuntimeReadiness({
      target: input.target, requiredSteps: input.requiredSteps, requiredAssertions: input.requiredAssertions, minimumEvidence: input.minimumEvidence,
      installationEnabled: input.installationEnabled, activationEnabled: true, connection: input.connection, approval: input.approval,
      qualification: "qualified", state: runtime.state, expiresAt: runtime.expiresAt, now: input.expected.now, capabilities: runtime.capabilities,
    });
  }
  if (Date.parse(runtime.qualifiedAt) > input.expected.now) {
    return resolveE2ERuntimeReadiness({
      target: input.target, requiredSteps: input.requiredSteps, requiredAssertions: input.requiredAssertions, minimumEvidence: input.minimumEvidence,
      installationEnabled: input.installationEnabled, activationEnabled: true, connection: input.connection, approval: input.approval,
      qualification: "unqualified", state: "READY", expiresAt: runtime.expiresAt, now: input.expected.now, capabilities: runtime.capabilities,
    });
  }
  return resolveE2ERuntimeReadiness({
    target: input.target, requiredSteps: input.requiredSteps, requiredAssertions: input.requiredAssertions, minimumEvidence: input.minimumEvidence,
    installationEnabled: input.installationEnabled, activationEnabled: true, connection: input.connection, approval: input.approval,
    qualification: "qualified", state: runtime.state, expiresAt: runtime.expiresAt, now: input.expected.now, capabilities: runtime.capabilities,
  });
}

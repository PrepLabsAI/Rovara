import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  E2EApplicationPlanIntentSchema, E2ERegisteredRuntimeSchema, E2EPolicySchema, E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, WEB_API_RUNTIME_PROFILE_ID, canonicalJson, createCandidateManifest,
  deriveE2EApplicationRuntimeAccountRef, deriveE2ESyntheticRuntimeAccountRef, e2eAnonymousRuntimeAccountRef, e2eApplicationMetadataSourceRefs, e2eRuntimeCapabilityDigest, inspectE2ERepository, proposeE2ESetup,
  type E2EPolicy, type E2EScenario, type E2ESourceSnapshot,
} from "@agentx/contracts";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { registryFor } from "./e2e-account-registry-fixtures.js";
import type { E2EAccountRegistryEntry } from "../../packages/broker/src/e2e/application-account-registry.js";

/** Fixtures shared by the application planning, approval, admission and dispatch tests: the orders contract app, its approved setup, a v2 intent, and READY catalog rows. */
export const PROFILE = WEB_API_RUNTIME_PROFILE_ID;
// The broker reads the clock itself, so the rows are valid around the real current time.
export const NOW = Date.now();
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const shaCanonical = (value: unknown) => sha(canonicalJson(value));
export const ordersContractManifest = readFileSync(new URL("../fixtures/e2e-web-api-app/package.json", import.meta.url), "utf8");
export const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };

/** One v2 catalog row of the qualified profile, carrying the real registered capability descriptor of its kind. */
export function webApiRow(kind: "web" | "api", overrides: Record<string, unknown> = {}, editCapabilities: (value: ReturnType<typeof webApiRuntimeCapabilities>) => ReturnType<typeof webApiRuntimeCapabilities> = (value) => value) {
  const capabilities = editCapabilities(webApiRuntimeCapabilities(kind, "a".repeat(64)));
  const capabilityDigest = e2eRuntimeCapabilityDigest(capabilities);
  const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: "linux 6.8.0", arch: "arm64", runtime: "node v22.23.2" };
  const runnerToolchain = { execPath: "/opt/node/bin/node", version: "v22.23.2" as const, platform: "linux", arch: "arm64" };
  const probeBody = { schemaVersion: "e2e-runtime-probe-manifest/v1" as const, profileId: PROFILE, capabilityDigest,
    runtimeManifestDigest: capabilities.runtimeManifestDigest, suiteDigest: "c".repeat(64), fixtureRefs: [{ path: "fixtures/smoke.json", sha256: "d".repeat(64) }],
    positiveProbeIds: ["web-csv-positive"], negativeProbeIds: ["web-csv-negative"] };
  return E2ERegisteredRuntimeSchema.parse({ schemaVersion: 2, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: "catalog", catalogRevision: 3,
    profileId: PROFILE, generation: 4, binding, bindingDigest: shaCanonical(binding), endpoint: "http://10.0.0.8:8080",
    transportCorrelationId: "11111111-1111-4111-8111-111111111111", manifestDigest: capabilities.runtimeManifestDigest,
    runnerEnvironment, runnerEnvironmentDigest: shaCanonical(runnerEnvironment), runnerToolchain, runnerToolchainDigest: shaCanonical(runnerToolchain),
    capabilities, capabilityDigest, probeManifest: { ...probeBody, manifestDigest: shaCanonical(probeBody) },
    qualificationEvidenceRef: { key: "runtime-evidence/qual-4.json", sha256: "e".repeat(64), byteLength: 128 },
    state: "READY", qualifiedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString(), ...overrides });
}

export function snapshotOf(contents: Record<string, string>): E2ESourceSnapshot {
  const candidate = createCandidateManifest([{ repositoryId: "example/demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const sources = Object.entries(contents).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.from(text), kind: "blob" as const }));
  return { candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sources.map((source) => source.path), sources };
}
/** The orders fixture: its package.json carries the agentx.e2e project contract (the explicit launch recipe). */
export const contractSnapshot = snapshotOf({ "package.json": ordersContractManifest });
/** A web package with a start script and a lockfile: discovery infers its launch recipe; there is no project contract. */
export const inferredSnapshot = snapshotOf({ "package.json": JSON.stringify({ name: "shop-web", scripts: { start: "node server.js" } }), "package-lock.json": "{}" });

/** The same project contract on an API package: discovery proposes an API target for it. */
export const apiSnapshot = (() => {
  const manifest = JSON.parse(ordersContractManifest) as { name: string; agentx: { e2e: Record<string, unknown> } };
  return snapshotOf({ "package.json": JSON.stringify({ ...manifest, name: "@acme/orders-api", dependencies: { express: "4.0.0" },
    agentx: { e2e: { ...manifest.agentx.e2e, targetAccounts: [] } } }) });
})();

export const csvScenario: E2EScenario = { scenarioId: "export-csv", requirementId: "orders-export", requestedTargetIds: ["web-1"], required: true,
  accountProfileId: "synthetic", minimumEvidence: "runtime", requiredRealComponentIds: [],
  steps: [{ kind: "navigate", path: "/orders" }, { kind: "click", testId: "export-csv" }],
  assertions: [{ kind: "csv", downloadName: "orders.csv", columns: ["id", "total"], rows: [["1", "10"]] }] };

/** The id of the implicit `rovara-anonymous` variant of the snapshot's first web or API target (Ruling AZ); every web/API target with a launch recipe offers one. */
export function anonymousTargetOf(snapshot: E2ESourceSnapshot, kind: "web" | "api" = "web"): string {
  const found = inspectE2ERepository(snapshot, snapshot.candidate).inspection.proposedTargets.find((item) => item.kind === kind && item.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID);
  if (found === undefined) throw new Error(`the snapshot proposes no anonymous ${kind} target`);
  return found.targetId;
}
/** A signed-out visitor's scenario: the page's welcome marker is visible and the owner-only export button is not. */
export const anonymousScenario = (targetId: string): E2EScenario => ({ scenarioId: "signed-out-visitor", requirementId: "signed-out-access", requestedTargetIds: [targetId], required: true,
  accountProfileId: E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, minimumEvidence: "runtime", requiredRealComponentIds: [],
  steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "visible", testId: "welcome", equals: true }] });

export type Ready = ReadonlyArray<{ kind: "web" | "api"; profileId: string }>;
/** Approved setup proposal and the project policy derived from it, exactly as the setup-proposals route builds them. */
export function approvedSetup(snapshot: E2ESourceSnapshot, readyProfiles: Ready, onlyTargetIds?: readonly string[]) {
  const inspection = inspectE2ERepository(snapshot, snapshot.candidate).inspection;
  const proposal = proposeE2ESetup({ inspection, snapshot, expectedCandidate: snapshot.candidate, readyProfiles });
  const policy: E2EPolicy = E2EPolicySchema.parse({ schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [],
    targets: proposal.targets.filter((target) => onlyTargetIds === undefined || onlyTargetIds.includes(target.targetId)), defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
    capture: { screenshots: false, traces: false, video: false, downloads: false },
    limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10,
      maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } });
  return { inspection, proposal, policy, setupApproval: { artifactId: "setup", digest: shaCanonical(proposal) } };
}

export type PlanInput = { snapshot?: E2ESourceSnapshot; scenario?: E2EScenario; targetId?: string; setupReady?: Ready; planRuntimeProfileId?: string; executable?: boolean;
  registeredRuntimes?: ReturnType<typeof webApiRow>[]; modelRouteRevision?: string; accountRef?: { revision?: number; definitionDigest?: string }; sourceSha?: string };

/** The approved setup, policy and v2 intent for one scenario on one target, as the selection facade and the approval evaluation both take them. */
export function planFixture(input: PlanInput) {
  const snapshot = input.snapshot ?? contractSnapshot;
  const scenario = input.scenario ?? csvScenario;
  const setup = approvedSetup(snapshot, input.setupReady ?? [{ kind: "web", profileId: PROFILE }]);
  const target = setup.proposal.targets.find((item) => item.targetId === (input.targetId ?? "web-1"))!;
  const application = setup.inspection.applications.find((item) => item.applicationId === target.applicationId)!;
  const refs = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths)
    .map((ref) => (input.sourceSha === undefined ? ref : { ...ref, sha256: input.sourceSha }));
  const executable = input.executable ?? true;
  // The account is the registry's: the revision-1 definition a setup approval of this source would have written (a source with no project contract has none).
  const registry: E2EAccountRegistryEntry[] = registryFor(snapshot, NOW);
  const registered = registry.find((entry) => entry.definition.applicationId === application.applicationId && entry.definition.profileId === target.accountProfileId);
  const accountRef = { ...(target.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID ? e2eAnonymousRuntimeAccountRef(application.applicationId)
    : registered !== undefined ? deriveE2EApplicationRuntimeAccountRef(registered.definition)
    : application.recipe === null ? { applicationId: application.applicationId, profileId: target.accountProfileId, revision: 1, definitionDigest: "2".repeat(64) }
      : deriveE2ESyntheticRuntimeAccountRef({ applicationId: application.applicationId, accountProfileId: target.accountProfileId, recipeDigest: application.recipe.recipeDigest })), ...input.accountRef };
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId], portableOperationRefs: [], mockFixtureRefs: [],
    accountContextRefs: [{ applicationId: application.applicationId, profileId: target.accountProfileId, sourcePath: "package.json", sourceSha256: refs.find((ref) => ref.path === "package.json")!.sha256 }],
    scenarios: [scenario], semanticExportDeltas: [],
    applicationRuntimeRefs: executable ? [{ targetId: target.targetId, applicationId: application.applicationId, recipeDigest: application.recipe!.recipeDigest,
      sourceRefs: refs, runtimeProfileId: input.planRuntimeProfileId ?? target.runtimeProfileId, accountProfileId: target.accountProfileId }] : [],
    runtimeAccountRefs: executable ? [accountRef] : [],
    unavailableTargetRefs: executable ? [] : [{ targetId: target.targetId, applicationId: application.applicationId, accountProfileId: target.accountProfileId, sourceRefs: refs }] });
  return { snapshot, scenario, setup, target, application, intent, accountRef, registry, executable,
    policy: { ...setup.policy, baselineScenarioIds: [scenario.scenarioId], modelRouteRevision: input.modelRouteRevision ?? null } };
}


/** A repository with a web application and an API application that both carry the orders project contract, both approved on the qualified profile. */
const apiScenario: E2EScenario = { scenarioId: "orders-health", requirementId: "orders-api", requestedTargetIds: [], required: true, accountProfileId: "synthetic", minimumEvidence: "runtime",
  requiredRealComponentIds: [], steps: [{ kind: "request", requestId: "health", path: "/health", method: "GET", body: {} }], assertions: [{ kind: "http-status", path: "/health", method: "GET", equals: 200 }] };
/** A repository with a web application and an API application that both carry the orders project contract, both approved on the qualified profile. */
export function webAndApiFixture() {
  const manifest = JSON.parse(ordersContractManifest) as { name: string; agentx: { e2e: Record<string, unknown> } };
  const snapshot = snapshotOf({ "package.json": ordersContractManifest,
    "api/package.json": JSON.stringify({ ...manifest, name: "@acme/orders-api", dependencies: { express: "4.0.0" }, agentx: { e2e: { ...manifest.agentx.e2e, targetAccounts: [] } } }) });
  const setup = approvedSetup(snapshot, [{ kind: "web", profileId: PROFILE }, { kind: "api", profileId: PROFILE }]);
  const registry: E2EAccountRegistryEntry[] = registryFor(snapshot, NOW);
  const web = setup.proposal.targets.find((item) => item.targetId === "web-1")!;
  const api = setup.proposal.targets.find((item) => item.kind === "api")!;
  const ref = (target: typeof web) => {
    const application = setup.inspection.applications.find((item) => item.applicationId === target.applicationId)!;
    const sourceRefs = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths);
    return { application, sourceRefs, runtime: { targetId: target.targetId, applicationId: application.applicationId, recipeDigest: application.recipe!.recipeDigest, sourceRefs,
      runtimeProfileId: target.runtimeProfileId, accountProfileId: target.accountProfileId },
    account: deriveE2EApplicationRuntimeAccountRef(registry.find((entry) => entry.definition.applicationId === application.applicationId && entry.definition.profileId === target.accountProfileId)!.definition) };
  };
  const policy = { ...setup.policy, baselineScenarioIds: [csvScenario.scenarioId, apiScenario.scenarioId] };
  const scenarios = [{ ...csvScenario, requestedTargetIds: [web.targetId], accountProfileId: web.accountProfileId }, { ...apiScenario, requestedTargetIds: [api.targetId], accountProfileId: api.accountProfileId }];
  const build = (executable: { web: boolean; api: boolean }) => {
    const refs = { web: ref(web), api: ref(api) };
    return E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [web.targetId, api.targetId], portableOperationRefs: [], mockFixtureRefs: [],
      accountContextRefs: (["web", "api"] as const).map((kind) => ({ applicationId: refs[kind].application.applicationId, profileId: (kind === "web" ? web : api).accountProfileId,
        sourcePath: refs[kind].sourceRefs[0]!.path, sourceSha256: refs[kind].sourceRefs[0]!.sha256 })),
      scenarios, semanticExportDeltas: [],
      applicationRuntimeRefs: (["web", "api"] as const).filter((kind) => executable[kind]).map((kind) => refs[kind].runtime),
      runtimeAccountRefs: (["web", "api"] as const).filter((kind) => executable[kind]).map((kind) => refs[kind].account),
      unavailableTargetRefs: (["web", "api"] as const).filter((kind) => !executable[kind]).map((kind) => ({ targetId: (kind === "web" ? web : api).targetId,
        applicationId: refs[kind].application.applicationId, accountProfileId: (kind === "web" ? web : api).accountProfileId, sourceRefs: refs[kind].sourceRefs })) });
  };
  return { snapshot, setup, policy, build, web, api, scenarios, registry };
}


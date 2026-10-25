import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { E2EApplicationApprovalBindingSchema, E2EAppArtifactRefSchema, E2EAppBuildManifestSchema,
  E2EApplicationPlanIntentSchema, PlanApprovalRefSchema, SourceRefSchema,
  type E2EApplicationApprovalBinding, type E2EAppArtifactRef, type E2EAppBuildManifest } from "./e2e-application.js";
import { E2EExecutionPlanSchema, E2EPolicySchema, E2ERoundSchema, E2ERunBindingSchema,
  E2ERuntimeAvailabilitySchema, E2EScenarioBundleSchema, E2EScenarioSchema, E2ESetupProposalSchema,
  type E2ERound, type E2ERunBinding, type E2EExecutionPlan, type E2EScenarioBundle } from "./e2e.js";
import { CandidateManifestSchema } from "./task-workflow.js";
import { isSafeE2ESourcePath } from "./e2e-source.js";
import { E2ERegisteredRuntimeSchema, type E2ERegisteredRuntime } from "./e2e-runtime-registration.js";
import { E2EPortableApprovalBindingSchema } from "./e2e-portable.js";
import { E2EApplicationReplaySchema } from "./e2e-replay.js";
import { E2ERuntimeAccountRefSchema } from "./e2e-application.js";
import type { E2EApplicationPlanSelectionInput } from "./e2e-application-execution-plan.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const id = (max: number) => z.string().trim().min(1).max(max);
const sourcePath = z.string().min(1).max(1024).refine(isSafeE2ESourcePath, "source path is not allowed by the existing safe-source policy");

/**
 * The most a build source manifest may weigh when it is exported for a candidate. The manifest travels inside the application admission (whose own object is
 * bounded at 24 MiB), so it gets a third of that; the worker refuses a candidate whose manifest would be larger and the broker refuses to store one.
 */
export const E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;

export const E2EApplicationBuildSourceRefSchema = z.object({ artifactId: id(200), sha256, byteLength: z.number().int().positive().max(112 * 1024 * 1024), manifestDigest: sha256 }).strict();
export type E2EApplicationBuildSourceRef = z.infer<typeof E2EApplicationBuildSourceRefSchema>;

const E2EBuildTreeEntrySchema = z.object({ path: z.string().min(1).max(1024), mode: z.enum(["100644", "100755", "120000", "160000"]), objectId: sha1 }).strict();
const E2EBuildFileSchema = z.object({ path: sourcePath, mode: z.enum(["100644", "100755"]), gitBlobId: sha1, sha256, byteLength: z.number().int().nonnegative().max(8 * 1024 * 1024) }).strict();
const E2EBuildOmissionSchema = z.object({ path: z.string().min(1).max(1024), mode: z.enum(["100644", "100755", "120000", "160000"]), objectId: sha1, reason: z.enum(["blocked-path", "symlink", "submodule"]) }).strict();
const E2EBuildArchiveSchema = z.object({ format: z.literal("e2e-application-build-source-archive/v1"), sha256, byteLength: z.number().int().positive().max(112 * 1024 * 1024), fileCount: z.number().int().min(0).max(10_000) }).strict();

export const E2EApplicationBuildSourceManifestSchema = z.object({
  schemaVersion: z.literal("e2e-application-build-source-manifest/v1"), candidateDigest: sha256,
  repository: z.object({ repositoryId: id(200), commitSha: sha1, treeSha: sha1, baseCommitSha: sha1.optional() }).strict(),
  sourceState: z.enum(["committed-tree", "candidate-index-tree"]), pathPolicy: z.literal("existing-safe-e2e-source-path/v1"),
  treeEntries: z.array(E2EBuildTreeEntrySchema).min(1).max(100_000), files: z.array(E2EBuildFileSchema).max(10_000),
  omissions: z.array(E2EBuildOmissionSchema).max(100_000), archive: E2EBuildArchiveSchema, manifestDigest: sha256,
}).strict().superRefine((manifest, context) => {
  if (manifest.files.reduce((sum, file) => sum + file.byteLength, 0) > 64 * 1024 * 1024) {
    context.addIssue({ code: "custom", path: ["files"], message: "permitted source files exceed the decoded 64 MiB aggregate limit" });
  }
  const paths = manifest.treeEntries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || paths.some((path) => path.normalize("NFC") !== path || Buffer.byteLength(path, "utf8") > 1024
    || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === ".."))) {
    context.addIssue({ code: "custom", path: ["treeEntries"], message: "complete tree inventory paths must be normalized relative unique UTF-8 paths" });
  }
  const filePaths = manifest.files.map((entry) => entry.path);
  const omittedPaths = manifest.omissions.map((entry) => entry.path);
  if (new Set(filePaths).size !== filePaths.length || new Set(omittedPaths).size !== omittedPaths.length
    || filePaths.some((path) => omittedPaths.includes(path)) || filePaths.length + omittedPaths.length !== paths.length) {
    context.addIssue({ code: "custom", path: ["files"], message: "permitted files and explicit omissions must partition the complete tree inventory" });
  }
  const treeByPath = new Map(manifest.treeEntries.map((entry) => [entry.path, entry]));
  for (const file of manifest.files) {
    const tree = treeByPath.get(file.path);
    if (!tree || tree.mode !== file.mode || tree.objectId !== file.gitBlobId || !isSafeE2ESourcePath(file.path)) context.addIssue({ code: "custom", path: ["files"], message: "permitted file does not match a safe regular candidate tree blob" });
  }
  for (const omitted of manifest.omissions) {
    const tree = treeByPath.get(omitted.path);
    const validReason = omitted.reason === "blocked-path" ? tree?.mode === omitted.mode && !isSafeE2ESourcePath(omitted.path)
      : omitted.reason === "symlink" ? omitted.mode === "120000" : omitted.mode === "160000";
    if (!tree || tree.mode !== omitted.mode || tree.objectId !== omitted.objectId || !validReason) context.addIssue({ code: "custom", path: ["omissions"], message: "omission does not match its excluded candidate tree identity" });
  }
  if (manifest.files.length !== manifest.archive.fileCount) context.addIssue({ code: "custom", path: ["archive", "fileCount"], message: "archive count must equal permitted file count" });
  try {
    if (gitTreeSha(manifest.treeEntries) !== manifest.repository.treeSha) context.addIssue({ code: "custom", path: ["repository", "treeSha"], message: "complete tree inventory does not reconstruct the candidate Git tree" });
  } catch { context.addIssue({ code: "custom", path: ["treeEntries"], message: "complete tree inventory cannot be encoded as a Git tree" }); }
  const { manifestDigest, ...body } = manifest;
  if (createHash("sha256").update(canonicalJson(body)).digest("hex") !== manifestDigest) context.addIssue({ code: "custom", path: ["manifestDigest"], message: "source manifest digest does not match its canonical content" });
});
export type E2EApplicationBuildSourceManifest = z.infer<typeof E2EApplicationBuildSourceManifestSchema>;

function gitTreeSha(entries: readonly { path: string; mode: string; objectId: string }[]): string {
  type Node = { files: Array<{ name: string; mode: string; objectId: string }>; dirs: Map<string, Node> };
  const root: Node = { files: [], dirs: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.get(part);
      if (!child) { child = { files: [], dirs: new Map() }; node.dirs.set(part, child); }
      node = child;
    }
    const name = parts.at(-1)!;
    if (node.files.some((file) => file.name === name) || node.dirs.has(name)) throw new Error("duplicate Git tree path");
    node.files.push({ name, mode: entry.mode, objectId: entry.objectId });
  }
  const write = (node: Node): Buffer => {
    const records: Array<{ name: string; directory: boolean; bytes: Buffer }> = [
      ...node.files.map((file) => ({ name: file.name, directory: false, bytes: Buffer.concat([Buffer.from(`${file.mode} ${file.name}\0`), Buffer.from(file.objectId, "hex")]) })),
      ...[...node.dirs].map(([name, child]) => ({ name, directory: true, bytes: Buffer.concat([Buffer.from(`40000 ${name}\0`), Buffer.from(createHash("sha1").update(write(child)).digest("hex"), "hex")]) })),
    ];
    records.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.directory ? "/" : "")), Buffer.from(b.name + (b.directory ? "/" : ""))));
    const body = Buffer.concat(records.map((record) => record.bytes));
    return Buffer.concat([Buffer.from(`tree ${body.byteLength}\0`), body]);
  };
  return createHash("sha1").update(write(root)).digest("hex");
}
export const E2EApplicationEvidenceRefSchema = z.object({ artifactId: id(200), sha256, byteLength: z.number().int().nonnegative().max(26_214_400), mediaType: id(120) }).strict();
export type E2EApplicationEvidenceRef = z.infer<typeof E2EApplicationEvidenceRefSchema>;

export const E2EApplicationBuildBindingSchema = z.object({
  schemaVersion: z.literal("e2e-application-build-binding/v1"), preparationId: z.string().uuid(), taskId: z.string().uuid(),
  workspaceId: z.string().uuid(), operationId: z.string().uuid(), operationFence: z.number().int().positive(), workflowRevision: z.number().int().positive(),
  candidateDigest: sha256, planDigest: sha256, intentDigest: sha256, applicationApprovalDigest: sha256, applicationId: id(120),
  recipeDigest: sha256, buildSourceManifestDigest: sha256, buildSourceSha256: sha256, runtimeProfileId: id(120), runtimeManifestDigest: sha256,
  deadlineAt: z.string().datetime({ offset: true }),
}).strict();
export type E2EApplicationBuildBinding = z.infer<typeof E2EApplicationBuildBindingSchema>;

export const E2EApplicationCliHostDescriptorSchema = z.object({ entryPointId: id(120), entryPointManifestDigest: sha256 }).strict();
export type E2EApplicationCliHostDescriptor = z.infer<typeof E2EApplicationCliHostDescriptorSchema>;
export const E2EApplicationPreparedGroupFactsSchema = z.object({ preparedEnvironmentDigest: sha256,
  originByApplicationId: z.array(z.object({ applicationId: id(120), origin: z.string().min(1).max(512) }).strict()).max(12) }).strict().superRefine((facts, context) => {
  if (new Set(facts.originByApplicationId.map((item) => item.applicationId)).size !== facts.originByApplicationId.length
    || facts.originByApplicationId.some((item, index) => index > 0 && facts.originByApplicationId[index - 1]!.applicationId >= item.applicationId)) context.addIssue({ code: "custom", path: ["originByApplicationId"], message: "prepared origins must be sorted and unique by application ID" });
  for (const item of facts.originByApplicationId) {
    try { const url = new URL(item.origin); if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== item.origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port === "0" || url.hostname.includes("*")) throw new Error(); }
    catch { context.addIssue({ code: "custom", path: ["originByApplicationId"], message: "prepared origin must be a concrete canonical HTTP(S) origin" }); }
  }
});
export type E2EApplicationPreparedGroupFacts = z.infer<typeof E2EApplicationPreparedGroupFactsSchema>;

const launchString = z.string().min(1).max(8192);
export const E2EApplicationLaunchTargetSchema = z.object({
  targetId: id(80), profileId: id(120), factoryId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/), factoryManifestDigest: sha256,
  engine: z.object({ name: id(120), version: id(120), spiVersion: z.literal(1), platform: id(120), workers: z.number().int().positive().max(64).optional(), capabilities: z.array(id(120)).max(64) }).strict().nullable(),
  artifactCapabilities: z.array(z.enum(["screenshot", "video"])).max(2), stateCapability: z.boolean(),
  app: z.object({ url: z.string().url().max(8192).optional(), bundleId: launchString.optional(), appPath: launchString.optional(), identity: launchString,
    environment: z.literal("test"), launchArguments: z.array(z.string().max(8192)).max(100).optional() }).strict().nullable(),
}).strict().superRefine((target, context) => {
  if (new Set(target.artifactCapabilities).size !== target.artifactCapabilities.length) context.addIssue({ code: "custom", path: ["artifactCapabilities"], message: "artifact capabilities must be unique" });
  if (target.engine === null && target.app !== null) context.addIssue({ code: "custom", path: ["app"], message: "engine-less API target cannot declare a launchable app" });
  if (target.app?.url) {
    try {
      const url = new URL(target.app.url);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== target.app.url || url.port === "0"
        || url.username || url.password || url.hostname.includes("*")) {
        context.addIssue({ code: "custom", path: ["app", "url"], message: "application URL must be a fixed concrete origin" });
      }
    } catch {
      context.addIssue({ code: "custom", path: ["app", "url"], message: "application URL must be a fixed concrete origin" });
    }
  }
});
export type E2EApplicationLaunchTarget = z.infer<typeof E2EApplicationLaunchTargetSchema>;

export const E2EApplicationPortableProjectionSchema = z.object({
  scope: z.object({ candidateDigest: sha256, planDigest: sha256, intentDigest: sha256, approvedSemanticApproval: PlanApprovalRefSchema }).strict(),
  selectionInput: z.unknown(), executionPlan: E2EExecutionPlanSchema, bundle: E2EScenarioBundleSchema,
}).strict();

export type E2EApplicationGroupAdmission =
  | { protocol: "trusted-e2e-application/v1"; outerBinding: E2ERunBinding; cliHost: { profileId: string; descriptor: E2EApplicationCliHostDescriptor }; preparedEnvironmentDigest: string; originByApplicationId: Array<{ applicationId: string; origin: string }>; compiledInventoryDigest: string; shards: Array<{ shardId: string; targetId: string; inventoryDigest: string; configDigest: string; expectedCaseIds: string[] }> }
  | { protocol: "trusted-e2e/v1"; outerBinding: E2ERunBinding; childBinding: E2ERunBinding; childRound: E2ERound; projectionDigest: string; compiledInventoryDigest: string };
export const E2EApplicationGroupAdmissionSchema = z.discriminatedUnion("protocol", [
  z.object({ protocol: z.literal("trusted-e2e-application/v1"), outerBinding: E2ERunBindingSchema,
    cliHost: z.object({ profileId: id(120), descriptor: E2EApplicationCliHostDescriptorSchema }).strict(), preparedEnvironmentDigest: sha256,
    originByApplicationId: E2EApplicationPreparedGroupFactsSchema.shape.originByApplicationId, compiledInventoryDigest: sha256,
    shards: z.array(z.object({ shardId: id(120), targetId: id(80), inventoryDigest: sha256, configDigest: sha256, expectedCaseIds: z.array(id(120)).min(1).max(64) }).strict()).min(1).max(3) }).strict(),
  z.object({ protocol: z.literal("trusted-e2e/v1"), outerBinding: E2ERunBindingSchema, childBinding: E2ERunBindingSchema,
    childRound: E2ERoundSchema, projectionDigest: sha256, compiledInventoryDigest: sha256 }).strict(),
]);

const sourceSnapshotWireSchema = z.object({ candidate: CandidateManifestSchema, commitSha: sha1, treeSha: sha1, treeComplete: z.literal(true),
  treePaths: z.array(z.string().min(1).max(1024)).max(100_000),
  sources: z.array(z.object({ path: sourcePath, sha256, bytesBase64: z.string().max(700_000), kind: z.literal("blob") }).strict()).max(512) }).strict();
const sourceRefSchema = SourceRefSchema;
const approvalRefSchema = PlanApprovalRefSchema;
const mockableComponentSchema = z.object({ componentId: id(120), requestedTargetId: id(80), kind: z.literal("api"),
  sourceRefs: z.array(sourceRefSchema).max(128), fixture: z.unknown().optional(), fixtureProfile: z.literal("openapi-auto-witness/v1").optional() }).strict();
const portableSelectionInputSchema = z.object({ candidateDigest: sha256, expectedCandidate: CandidateManifestSchema, sourceSnapshot: sourceSnapshotWireSchema,
  planDigest: sha256, policy: E2EPolicySchema, scenarios: z.array(E2EScenarioSchema).min(1).max(32), selectedTargetIds: z.array(id(80)).max(12),
  sandboxAvailability: E2ERuntimeAvailabilitySchema.extend({ targetId: z.literal("default-sandbox") }).nullable(),
  runtimeAvailability: z.array(E2ERuntimeAvailabilitySchema).max(12), portableApprovalBinding: E2EPortableApprovalBindingSchema.optional(),
  approvedSemanticApproval: approvalRefSchema.optional(), mockableComponents: z.array(mockableComponentSchema).max(32).optional() }).strict();
const applicationSelectionInputSchema = portableSelectionInputSchema.extend({ intent: E2EApplicationPlanIntentSchema, intentDigest: sha256,
  setupProposal: E2ESetupProposalSchema, setupApproval: approvalRefSchema, applicationApprovalBinding: E2EApplicationApprovalBindingSchema.nullable(),
  registeredRuntimes: z.array(E2ERegisteredRuntimeSchema).max(12), runtimeAccountRefs: z.array(E2ERuntimeAccountRefSchema).max(12),
  now: z.number().int().positive().safe() }).strict();
const applicationBuildBindingValueSchema = z.object({ approval: E2EApplicationApprovalBindingSchema, build: E2EAppBuildManifestSchema,
  artifacts: z.array(E2EAppArtifactRefSchema).max(32), buildSource: z.object({ manifest: E2EApplicationBuildSourceManifestSchema, reference: E2EApplicationBuildSourceRefSchema }).strict() }).strict();
const applicationMapEntrySchema = z.object({ key: id(120), value: applicationBuildBindingValueSchema }).strict();
const runtimeMapEntrySchema = z.object({ key: id(120), value: E2ERegisteredRuntimeSchema }).strict();
const orderedUniqueKeys = (values: readonly string[]) => new Set(values).size === values.length && values.every((item, index) => index === 0 || values[index - 1]! < item);
/** The creator's access as the broker proved it when it admitted the round (a direct membership grant, or the locally bound channels), compared again at verification. */
export const E2ECreatorAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct-membership"), developerId: id(200), project: id(200), role: z.enum(["developer", "administrator"]), grantId: id(64) }).strict(),
  z.object({ kind: z.literal("channel-access"), developerId: id(200), project: id(200), teamId: id(64), channelIds: z.array(id(64)).min(1).max(64),
    bindings: z.array(z.object({ channelId: id(64), updatedAt: id(40) }).strict()).min(1).max(64) }).strict(),
]);
export type E2ECreatorAuthority = z.infer<typeof E2ECreatorAuthoritySchema>;

/**
 * The application admission's schema versions. M1.3 Task 3.4 raised it to v2: its runtime bindings are keyed by `<runtimeProfileId>#<kind>` (a profile registers a web row and an API row, and
 * one plan can run both), where v1 keyed them by the profile alone. The broker builds only v2; v1 still decodes, so an admission stored before the change is read and verified as it was.
 */
export const E2E_APPLICATION_ADMISSION_SCHEMA_V1 = "workflow-e2e-application-admission/v1" as const;
export const E2E_APPLICATION_ADMISSION_SCHEMA_V2 = "workflow-e2e-application-admission/v2" as const;
export const E2E_APPLICATION_ADMISSION_SCHEMAS = [E2E_APPLICATION_ADMISSION_SCHEMA_V1, E2E_APPLICATION_ADMISSION_SCHEMA_V2] as const;
/** Whether a stored object's `schemaVersion` names an application admission (any version); anything else, a non-string included, is not one. */
export function isE2EApplicationAdmissionSchemaVersion(value: unknown): value is (typeof E2E_APPLICATION_ADMISSION_SCHEMAS)[number] {
  return typeof value === "string" && (E2E_APPLICATION_ADMISSION_SCHEMAS as readonly string[]).includes(value);
}
export type E2ERuntimeBindingKind = "web" | "api";
/** The key of a v2 runtime binding: the runtime profile and the target kind it serves, the same suffix as the catalog row's sort key (`linux-arm64-web-api-v1#web`). */
export function e2eRuntimeBindingKey(runtimeProfileId: string, kind: E2ERuntimeBindingKind): string {
  return `${runtimeProfileId}#${kind}`;
}
/**
 * The runtime row a compiled group runs on, from a bindings map keyed as the admission keyed it: `<profile>#<kind>` (v2) or the profile alone (v1, which could hold one kind only).
 * A row of another kind than asked for is never returned, so a map that holds the wrong kind under a key finds nothing.
 */
export function e2eRuntimeBindingOf(bindings: ReadonlyMap<string, E2ERegisteredRuntime>, runtimeProfileId: string, kind: E2ERuntimeBindingKind): E2ERegisteredRuntime | undefined {
  const keyed = bindings.get(e2eRuntimeBindingKey(runtimeProfileId, kind));
  if (keyed !== undefined) return keyed.capabilities.kind === kind ? keyed : undefined;
  const legacy = bindings.get(runtimeProfileId);
  return legacy !== undefined && legacy.capabilities.kind === kind ? legacy : undefined;
}
export const E2EApplicationExecutionAdmissionSchema = z.object({ schemaVersion: z.enum(E2E_APPLICATION_ADMISSION_SCHEMAS),
  taskId: id(120), operationId: id(120), operationFence: z.number().int().positive(), workflowRevision: z.number().int().positive(), candidateDigest: sha256,
  /** The exact commit and tree the worker builds from (staged from that commit's tree with `git ls-tree` and `git cat-file`); the tree is checked against the repository before any build. */
  candidateCommitSha: sha1, candidateTreeSha: sha1,
  sourceSnapshot: sourceSnapshotWireSchema, intent: E2EApplicationPlanIntentSchema, intentDigest: sha256,
  selectionInput: applicationSelectionInputSchema, applicationApprovalBinding: E2EApplicationApprovalBindingSchema.nullable(), applicationBindings: z.array(applicationMapEntrySchema).max(12),
  runtimeBindings: z.array(runtimeMapEntrySchema).max(12), launchTargets: z.array(E2EApplicationLaunchTargetSchema).max(12), modelRoute: z.object({ routeId: id(120), routeRevision: id(120) }).strict().nullable(),
  cliHosts: z.array(z.object({ profileId: id(120), descriptor: E2EApplicationCliHostDescriptorSchema }).strict()).max(12),
  preparedEnvironments: z.array(z.object({ groupId: id(80), preparedEnvironmentDigest: sha256,
    originByApplicationId: E2EApplicationPreparedGroupFactsSchema.shape.originByApplicationId }).strict()).max(4),
  policy: E2EPolicySchema, bundle: E2EScenarioBundleSchema, executionPlan: E2EExecutionPlanSchema,
  /** The creator's access when the round was admitted (the broker's own proof); absent only from admissions the broker did not build. Verification requires it. */
  creatorAuthority: E2ECreatorAuthoritySchema.optional(),
  /**
   * M1.3 Task 3.7b: signed into a baseline round (the approved scenarios on the unchanged code, for information only) and absent from every candidate round. The commit it names is
   * the commit the round builds from, so a baseline admission can only be about the base.
   */
  baseline: z.object({ purpose: z.literal("baseline"), baseCommitSha: sha1, attempt: z.number().int().positive() }).strict().optional(),
  /**
   * M1.4 Task 4.6b: signed into an audit replay of a verified AI-navigated round (the same candidate run again with no model, for an operator's check) and absent from every other
   * round. It names the round it replays, what that round showed and the recordings it serves, each bound by digest; the admission names no model route.
   */
  replay: E2EApplicationReplaySchema.optional(),
  portableProjection: E2EApplicationPortableProjectionSchema.nullable(), round: E2ERoundSchema,
  groups: z.array(E2EApplicationGroupAdmissionSchema).max(4), admissionDigest: sha256,
}).strict().superRefine((admission, context) => {
  if (admission.portableProjection && !portableSelectionInputSchema.safeParse(admission.portableProjection.selectionInput).success) {
    context.addIssue({ code: "custom", path: ["portableProjection", "selectionInput"], message: "portable projection selection input has an invalid strict wire shape" });
  }
  if (admission.candidateCommitSha !== admission.sourceSnapshot.commitSha || admission.candidateTreeSha !== admission.sourceSnapshot.treeSha
    || admission.candidateCommitSha !== admission.selectionInput.sourceSnapshot.commitSha || admission.candidateTreeSha !== admission.selectionInput.sourceSnapshot.treeSha) {
    context.addIssue({ code: "custom", path: ["candidateCommitSha"], message: "candidate commit and tree must be the exact commit and tree of the admitted source snapshot" });
  }
  if (admission.baseline !== undefined && admission.baseline.baseCommitSha !== admission.candidateCommitSha) {
    context.addIssue({ code: "custom", path: ["baseline", "baseCommitSha"], message: "a baseline round builds from its base commit and nothing else" });
  }
  if (admission.replay !== undefined && (admission.modelRoute !== null || admission.baseline !== undefined)) {
    context.addIssue({ code: "custom", path: ["replay"], message: "a replay round names no model route and is not a baseline" });
  }
  const portableSelection = admission.portableProjection?.selectionInput as { sourceSnapshot?: z.infer<typeof sourceSnapshotWireSchema> } | undefined;
  const wireSources = [admission.sourceSnapshot, admission.selectionInput.sourceSnapshot,
    ...(portableSelection?.sourceSnapshot ? [portableSelection.sourceSnapshot] : [])];
  for (const source of wireSources) {
    let totalBytes = 0;
    for (const item of source.sources) {
      const bytes = Buffer.from(item.bytesBase64, "base64");
      if (bytes.toString("base64") !== item.bytesBase64 || bytes.byteLength > 512 * 1024) context.addIssue({ code: "custom", path: ["sourceSnapshot", "sources"], message: "admission source bytes must be canonical base64 and within each-file bounds" });
      totalBytes += bytes.byteLength;
    }
    if (totalBytes > 4 * 1024 * 1024 || new Set(source.treePaths).size !== source.treePaths.length || new Set(source.sources.map((item) => item.path)).size !== source.sources.length) {
      context.addIssue({ code: "custom", path: ["sourceSnapshot"], message: "admission source snapshot exceeds limits or contains duplicate paths" });
    }
  }
  if (!orderedUniqueKeys(admission.applicationBindings.map((item) => item.key)) || !orderedUniqueKeys(admission.runtimeBindings.map((item) => item.key))
    || !orderedUniqueKeys(admission.cliHosts.map((item) => item.profileId)) || !orderedUniqueKeys(admission.preparedEnvironments.map((item) => item.groupId))) {
    context.addIssue({ code: "custom", path: [], message: "admission maps and prepared environment rows must be sorted by unique key" });
  }
  // v2 keys name the profile and the kind of the row they hold (`<profile>#<kind>`); a v1 key is the profile alone and never has a `#`. A key that says one thing about its row and holds another is refused.
  const keyedBy = (item: { key: string; value: E2ERegisteredRuntime }) => (item.value.capabilities.kind === "web" || item.value.capabilities.kind === "api"
    ? e2eRuntimeBindingKey(item.value.profileId, item.value.capabilities.kind) : undefined);
  if (admission.schemaVersion === E2E_APPLICATION_ADMISSION_SCHEMA_V2 ? admission.runtimeBindings.some((item) => item.key !== keyedBy(item))
    : admission.runtimeBindings.some((item) => item.key.includes("#"))) {
    context.addIssue({ code: "custom", path: ["runtimeBindings"], message: "runtime binding keys must be <profile>#<kind> of their row in a version 2 admission, and the profile alone in version 1" });
  }
  if (new Set(admission.launchTargets.map((item) => item.targetId)).size !== admission.launchTargets.length
    || new Set(admission.groups.map((item) => item.outerBinding.groupId)).size !== admission.groups.length) {
    context.addIssue({ code: "custom", path: [], message: "admission launch targets and group bindings must have unique identities" });
  }
  if (admission.launchTargets.some((item, index) => index > 0 && admission.launchTargets[index - 1]!.targetId >= item.targetId)
    || admission.groups.some((item, index) => index > 0 && admission.groups[index - 1]!.outerBinding.groupId >= item.outerBinding.groupId)) {
    context.addIssue({ code: "custom", path: [], message: "admission launch targets and group bindings must be sorted by their unique identities" });
  }
  const { admissionDigest, ...body } = admission;
  if (createHash("sha256").update(canonicalJson(body)).digest("hex") !== admissionDigest) context.addIssue({ code: "custom", path: ["admissionDigest"], message: "admission digest does not match its canonical content" });
});
export type E2EApplicationExecutionAdmission = z.infer<typeof E2EApplicationExecutionAdmissionSchema>;
export type E2EApplicationCompilationContext = Readonly<{
  selectionInput: E2EApplicationPlanSelectionInput; executionPlan: E2EExecutionPlan; bundle: E2EScenarioBundle;
  applicationBindings: ReadonlyMap<string, { approval: E2EApplicationApprovalBinding; build: E2EAppBuildManifest; artifacts: readonly E2EAppArtifactRef[];
    buildSource: { manifest: E2EApplicationBuildSourceManifest; reference: E2EApplicationBuildSourceRef } }>;
  runtimeBindings: ReadonlyMap<string, E2ERegisteredRuntime>; launchTargets: readonly E2EApplicationLaunchTarget[];
  modelRoute: null | { routeId: string; routeRevision: string };
  cliHostsByProfile: ReadonlyMap<string, E2EApplicationCliHostDescriptor>;
  preparedEnvironmentsByGroup: ReadonlyMap<string, E2EApplicationPreparedGroupFacts>;
  /**
   * Set only by the worker's validator, for an admission the control plane wrote before Task 4.3a: a route-pinned policy's round with no agent step was admitted with the policy's own
   * limits for its shards, not the model-free ones. The compiler then keeps those limits, so the shard digests the admission was written with still match.
   */
  policyLimitsForModelFreeShards?: true;
  /**
   * Set only by the worker's validator (and by the built-in qualification probes, whose plans are pinned): the shards with no agent step are compiled under the model-free limits as they
   * were before the evaluation fix RUN-1 (60 s run, 10 s case) instead of the normal ones. An admission written by an earlier control plane says so by only matching that way.
   */
  modelFreeShardRule?: "before-run-1";
  /**
   * Set only for an audit replay (Task 4.6b): the group runs with no model route and a read-only store of the bound recordings, whatever agent steps its scenarios have. It carries the
   * binding of each recording (what the verified round showed for the step), never the recording itself, so the compiled files do not depend on the recordings' bytes.
   */
  replay?: Readonly<{ bindings: ReadonlyArray<Readonly<{ caseId: string; stepIndex: number; keyHash: string; traceSha256: string; actionCount: number }>> }>;
}>;

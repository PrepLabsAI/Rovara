import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { E2EApplicationEvidenceRefSchema } from "./e2e-application-execution.js";
import type { E2EAppArtifactRef } from "./e2e-application.js";
import { ProjectSetupRunnerToolchainSchema } from "./session.js";
import type { E2ECollection, E2ERunBinding } from "./e2e.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = (max = 120) => z.string().trim().min(1).max(max);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => {
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value;
}, "timestamp must be a real canonical ISO UTC instant");
const uuid = z.string().uuid();
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).refine((value) =>
  !/^(?:PATH|HOME|USER|SHELL|PWD|TMPDIR|NODE_OPTIONS|NODE_PATH|AWS_|AGENTX_|PI_|GIT_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)/.test(value)
  && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY)/.test(value), "environment name is reserved or may carry a secret");

export const E2EApplicationExternalConnectionRefSchema = z.object({
  connectionId: id(), revision, originRef: id(200), grantDigest: digest,
}).strict();
export type E2EApplicationExternalConnectionRef = z.infer<typeof E2EApplicationExternalConnectionRefSchema>;

/**
 * The discovery component that stands for the API contract (OpenAPI/Swagger document) at a repository-relative path. Discovery emits one dependency edge to
 * this component for every such document an application ships, so an approved mock fixture for that edge is linked to the origin whose `contractPath` is the path.
 */
export function e2eApiSchemaComponentId(contractPath: string): string {
  return `api-schema-${createHash("sha256").update(contractPath).digest("hex").slice(0, 12)}`;
}
const contractPath = z.string().min(1).max(512).regex(/^[A-Za-z0-9._@~+/-]+$/).refine((value) => !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === ".."),
  "contract path must be a plain repository-relative path")
  .refine((value) => /(^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(value), "contract path must name an OpenAPI or Swagger document");

export const E2EApplicationServiceContractSchema = z.object({
  listenPort: z.number().int().min(1024).max(65535), portEnv: envName.nullable(),
  /** `contractPath` is the repository-relative path of the origin's OpenAPI/Swagger document; an approved mock for that document's component serves this origin in a run. */
  originBindings: z.array(z.object({ originRef: id(200), envName, contractPath: contractPath.optional() }).strict()).max(64),
}).strict().superRefine((value, context) => {
  const contractPaths = value.originBindings.flatMap((item) => (item.contractPath === undefined ? [] : [item.contractPath]));
  if (new Set(contractPaths).size !== contractPaths.length) context.addIssue({ code: "custom", path: ["originBindings"], message: "each contract may describe only one origin" });
  if (new Set(value.originBindings.map((item) => item.originRef)).size !== value.originBindings.length) context.addIssue({ code: "custom", path: ["originBindings"], message: "origin references must be unique" });
  if (new Set(value.originBindings.map((item) => item.envName)).size !== value.originBindings.length) context.addIssue({ code: "custom", path: ["originBindings"], message: "origin environment bindings must be unique" });
  if (value.portEnv !== null && value.originBindings.some((item) => item.envName === value.portEnv)) context.addIssue({ code: "custom", path: ["portEnv"], message: "port and origin environment names must be distinct" });
});
export type E2EApplicationServiceContract = z.infer<typeof E2EApplicationServiceContractSchema>;

export const E2EApplicationHostPreparationBindingSchema = z.object({
  schemaVersion: z.literal("e2e-application-host-preparation/v1"), preparationId: uuid, taskId: uuid, workspaceId: uuid,
  operationId: uuid, operationFence: revision, workflowRevision: revision, candidateDigest: digest, planDigest: digest,
  intentDigest: digest, groupId: id(), runtimeProfileId: id(), runtimeManifestDigest: digest, networkPolicyDigest: digest,
  admittedAt: utc, preparationDeadlineAt: utc, deadlineAt: utc,
}).strict().superRefine((value, context) => {
  const admitted = Date.parse(value.admittedAt); const prep = Date.parse(value.preparationDeadlineAt); const deadline = Date.parse(value.deadlineAt);
  if (prep < admitted || prep > deadline) context.addIssue({ code: "custom", path: ["preparationDeadlineAt"], message: "preparation deadline must be within the original admitted and overall deadline" });
});
export type E2EApplicationHostPreparationBinding = z.infer<typeof E2EApplicationHostPreparationBindingSchema>;

export const E2EApplicationProcessIdentitySchema = z.object({
  containerId: id(200), pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), startTime: utc,
  namespaceId: id(200), incarnation: id(200),
}).strict();
export type E2EApplicationProcessIdentity = z.infer<typeof E2EApplicationProcessIdentitySchema>;

const canonicalOrigin = z.string().url().max(512).refine((value) => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value
      && parsed.username === "" && parsed.password === "" && parsed.pathname === "/" && !parsed.search && !parsed.hash
      && parsed.port !== "0" && !parsed.hostname.includes("*") && !parsed.hostname.includes("%")
      && !parsed.hostname.endsWith(".");
  } catch { return false; }
}, "origin must be a concrete canonical HTTP(S) origin");
const uniqueBy = <T>(items: readonly T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length;
export const E2EApplicationPreparedServiceSchema = z.object({
  leaseId: id(200), applicationId: id(), origin: canonicalOrigin, processIdentity: E2EApplicationProcessIdentitySchema,
  buildManifestDigest: digest, artifactSha256: digest, recipeDigest: digest,
}).strict();
export type E2EApplicationPreparedService = z.infer<typeof E2EApplicationPreparedServiceSchema>;
export const E2EApplicationPreparedOriginSchema = z.object({ applicationId: id(), origin: canonicalOrigin }).strict();
export const E2EApplicationPreparedEnvironmentSchema = z.object({
  preparation: E2EApplicationHostPreparationBindingSchema, authorityDigest: digest, networkLeaseId: id(200),
  services: z.array(E2EApplicationPreparedServiceSchema).max(12), originByApplicationId: z.array(E2EApplicationPreparedOriginSchema).max(12),
  receiptRefs: z.array(E2EApplicationEvidenceRefSchema).max(200), preparedDigest: digest,
}).strict().superRefine((value, context) => {
  if (!uniqueBy(value.services, (item) => item.applicationId) || !uniqueBy(value.services, (item) => item.leaseId)) context.addIssue({ code: "custom", path: ["services"], message: "prepared service application and lease identities must be unique" });
  if (!uniqueBy(value.originByApplicationId, (item) => item.applicationId)) context.addIssue({ code: "custom", path: ["originByApplicationId"], message: "prepared origins must have unique applications" });
  const serviceOrigins = [...value.services].sort((a, b) => a.applicationId.localeCompare(b.applicationId)).map(({ applicationId, origin }) => ({ applicationId, origin }));
  const origins = [...value.originByApplicationId].sort((a, b) => a.applicationId.localeCompare(b.applicationId));
  if (canonicalJson(serviceOrigins) !== canonicalJson(origins)) context.addIssue({ code: "custom", path: ["originByApplicationId"], message: "prepared origin map must exactly match owned service identities" });
  if (e2eApplicationPreparedEnvironmentDigest(value) !== value.preparedDigest) context.addIssue({ code: "custom", path: ["preparedDigest"], message: "prepared environment digest does not match its sealed content" });
});
export type E2EApplicationPreparedEnvironment = z.infer<typeof E2EApplicationPreparedEnvironmentSchema>;

export function e2eApplicationPreparedEnvironmentDigest(value: Omit<E2EApplicationPreparedEnvironment, "preparedDigest"> | E2EApplicationPreparedEnvironment): string {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "preparedDigest"));
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export type E2EApplicationServicePorts = Readonly<{
  allocate(input: { binding: E2EApplicationHostPreparationBinding; application: unknown; recipe: unknown; serviceContract: E2EApplicationServiceContract; networkLeaseId: string }, signal: AbortSignal): Promise<E2EApplicationPreparedService>;
  waitReady(lease: E2EApplicationPreparedService, health: { path: string; expectedStatus: number }, deadlineAt: string, signal: AbortSignal): Promise<{ observedStatus: number; observedAt: string }>;
  observeIdentity(lease: E2EApplicationPreparedService, signal: AbortSignal): Promise<{ processIdentity: E2EApplicationProcessIdentity; artifactSha256: string; buildManifestDigest: string; recipeDigest: string }>;
  seal(lease: E2EApplicationPreparedService, input: { admissionDigest: string; binding: unknown }, signal: AbortSignal): Promise<void>;
  close(lease: E2EApplicationPreparedService, signal: AbortSignal): Promise<{ confirmed: boolean }>;
}>;
export type E2EApplicationNetworkPorts = Readonly<{
  allocate(input: { binding: E2EApplicationHostPreparationBinding; networkPolicyDigest: string; applications: readonly unknown[]; approvedExternalConnectionRefs: readonly E2EApplicationExternalConnectionRef[]; mockManifest: readonly unknown[] }, signal: AbortSignal): Promise<{ leaseId: string; originByApplicationId: readonly { applicationId: string; origin: string }[]; policyDigest: string }>;
  observe(lease: { leaseId: string }, signal: AbortSignal): Promise<{ policyDigest: string; deniedAttempts: readonly unknown[]; observedRealComponentIds: readonly string[]; observedMockComponentIds: readonly string[]; receiptRefs: readonly z.infer<typeof E2EApplicationEvidenceRefSchema>[] }>;
  seal(lease: { leaseId: string }, input: { admissionDigest: string; binding: unknown }, signal: AbortSignal): Promise<void>;
  close(lease: { leaseId: string }, signal: AbortSignal): Promise<{ confirmed: boolean }>;
}>;
export type E2EApplicationAccountPorts = Readonly<{
  open(input: { binding: E2ERunBinding; applicationId: string; approvedAccountRef: unknown; origin: string }, signal: AbortSignal): Promise<{ sessionRef: string; accountIdDigest: string }>;
  applyToOwnedClient(sessionRef: string, ownedClientRef: string, signal: AbortSignal): Promise<void>;
  close(sessionRef: string, signal: AbortSignal): Promise<{ confirmed: boolean }>;
}>;
export type E2EApplicationSupervisorPorts = Readonly<{
  launch(input: { compiled: unknown; binding: unknown; runnerToolchain: unknown; prepared: E2EApplicationPreparedEnvironment; accountSessionRefs: readonly string[]; modelProxyRef: string | null; deadlineAt: string }, signal: AbortSignal): Promise<{ leaseId: string }>;
  observeEngineIdentity(lease: { leaseId: string }, signal: AbortSignal): Promise<readonly unknown[]>;
  execute(lease: { leaseId: string }, signal: AbortSignal): Promise<E2ECollection>;
  close(lease: { leaseId: string }, signal: AbortSignal): Promise<{ confirmed: boolean }>;
}>;

// The character class rejects NUL and C0 control bytes in an installed path.
// eslint-disable-next-line no-control-regex
const absoluteInstalledPath = z.string().min(1).max(1024).refine((value) => value.startsWith("/") && !value.split("/").includes("..") && !/[\u0000-\u001f]/.test(value), "installed paths must be fixed absolute paths without traversal");
const installedDigest = z.string().regex(/^[a-f0-9]{64}$/);
const installedId = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);

export const E2ELinuxApplicationProfileSchema = z.object({
  profileId: installedId,
  kind: z.enum(["web", "api"]),
  host: z.object({ platform: z.literal("linux"), arch: z.enum(["arm64", "x64"]) }).strict(),
  cliHost: z.object({ entryPointId: installedId, entryPointManifestDigest: installedDigest }).strict(),
  installedRuntimeManifestDigest: installedDigest,
  helperManifestDigest: installedDigest,
  networkPolicyDigest: installedDigest,
  runnerToolchain: ProjectSetupRunnerToolchainSchema,
  images: z.object({
    build: installedDigest,
    service: installedDigest,
    cli: installedDigest,
    browser: installedDigest.nullable(),
  }).strict(),
  tools: z.array(z.object({ toolId: installedId, absolutePath: absoluteInstalledPath, sha256: installedDigest }).strict()).min(1).max(32),
  dependencySet: z.object({ ref: installedId, digest: installedDigest }).strict(),
  browser: z.object({ executablePath: absoluteInstalledPath, version: z.string().trim().min(1).max(120), sha256: installedDigest, seccompDigest: installedDigest }).strict().nullable(),
  limits: z.object({ maxProcesses: z.number().int().positive().max(4096), memoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), storageBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), startupTimeoutMs: z.number().int().positive().max(600_000), operationTimeoutMs: z.number().int().positive().max(3_600_000) }).strict(),
  privateRoots: z.object({ helper: absoluteInstalledPath, state: absoluteInstalledPath, artifacts: absoluteInstalledPath, work: absoluteInstalledPath, browserProfiles: absoluteInstalledPath }).strict(),
  uids: z.object({ companion: z.number().int().nonnegative().max(2_147_483_647), helper: z.number().int().nonnegative().max(2_147_483_647), build: z.number().int().nonnegative().max(2_147_483_647), service: z.number().int().nonnegative().max(2_147_483_647), cli: z.number().int().nonnegative().max(2_147_483_647), browser: z.number().int().nonnegative().max(2_147_483_647) }).strict(),
}).strict().superRefine((profile, context) => {
  const toolIds = profile.tools.map((tool) => tool.toolId);
  if (new Set(toolIds).size !== toolIds.length) context.addIssue({ code: "custom", path: ["tools"], message: "installed tool identities must be unique" });
  const paths = profile.tools.map((tool) => tool.absolutePath);
  if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", path: ["tools"], message: "installed tool paths must be unique" });
  if (profile.kind === "web" && (profile.browser === null || profile.images.browser === null)) context.addIssue({ code: "custom", path: ["browser"], message: "web profiles require pinned browser image and executable metadata" });
  if (profile.kind === "api" && (profile.browser !== null || profile.images.browser !== null)) context.addIssue({ code: "custom", path: ["browser"], message: "API profiles cannot advertise a browser" });
  if (profile.uids.companion === profile.uids.helper || profile.uids.build === profile.uids.service || profile.uids.cli === profile.uids.browser) context.addIssue({ code: "custom", path: ["uids"], message: "privileged and data-plane roles must use distinct identities" });
  const roots = Object.values(profile.privateRoots);
  if (new Set(roots).size !== roots.length) context.addIssue({ code: "custom", path: ["privateRoots"], message: "private roots must have distinct identities" });
});
export type E2ELinuxApplicationProfile = z.infer<typeof E2ELinuxApplicationProfileSchema>;

export type E2EApplicationArtifactStoreBinding = E2EApplicationHostPreparationBinding | E2ERunBinding;
export type E2EApplicationArtifactChunk = Readonly<{ offset: number; totalBytes: number; sha256: string; bytes: Uint8Array }>;
export type E2EApplicationArtifactReader = Readonly<{
  byteLength: number;
  sha256: string;
  formatId: string;
  readChunk(offset: number, signal: AbortSignal): Promise<E2EApplicationArtifactChunk>;
  close(): Promise<void>;
}>;
export type E2EApplicationArtifactStore = Readonly<{
  open(input: { artifact: E2EAppArtifactRef; binding: E2EApplicationArtifactStoreBinding }, signal: AbortSignal): Promise<E2EApplicationArtifactReader>;
}>;

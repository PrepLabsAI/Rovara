// Browser testing in a project's setup: what Rovara reads from the repository, and the stored proposal the owner approves.
//
// Everything is source-backed (owner decision 421). The repository's own files say how the app starts (its `agentx.e2e` contract, else Rovara's usual npm way), which kinds of user it has, and whether it
// declares a sign-in form. Rovara makes a fresh login for every check, so nothing is typed, stored or editable here.
//
// Two stored objects, both content-addressed (a second put of the same bytes is the same object):
//   the SOURCE object   what a refresh read: the captured files and the proposal derived from them, with NO policy. The draft points at it, so the facts the owner saw are the files the check and the approval use.
//   the PROPOSAL object the same files with the policy (proof choices and time limit) the owner chose: exactly the artifact the planning seam re-verifies (`application-planning.ts`), and what approval binds.
import { createHash } from "node:crypto";
import {
  E2EPolicySchema, E2ESetupProposalSchema, E2E_ACCOUNTS_FILE_SEED_PROFILE, E2E_FORM_LOGIN_AUTH_PROFILE, E2E_MODEL_FREE_LIMITS,
  E2EApplicationProjectContractSchema, canonicalJson, e2eApplicationRecipeOrigin, inspectE2ERepository, proposeE2ESetup, readE2EApplicationProjectContract, redactText, verifyE2ESetupProposal,
  verifyE2ESourceSnapshot,
  type E2EAppRecipe, type E2EPolicy, type E2EReadyRuntimeProfile, type E2ESetupProposal, type E2ESourceSnapshot, type ObjectStorage,
} from "@agentx/contracts";
import {
  BROWSER_USER_KINDS_MAX, BrowserFoundSchema,
  type BrowserFound, type BrowserFoundApplication, type BrowserProof, type BrowserUserKind,
} from "./browser-testing-state.js";

export const BROWSER_PROPOSAL_SCHEMA = "project-setup-source-proposal/v1";
export const BROWSER_SOURCE_SCHEMA = "browser-testing-source/v1";
/** The most bytes a stored source or proposal object may be (the planning seam reads one at most this large). */
export const BROWSER_OBJECT_MAX_BYTES = 24 * 1024 * 1024;
export const BROWSER_PROPOSAL_RETENTION = "setup-proposal";
export const BROWSER_SOURCE_RETENTION = "browser-testing-source";

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The project's one repository as the proposal names it. */
export interface BrowserRepository { name: string; url: string; defaultBranch: string; /** Which code host serves it, when the project names one (the host's own routing). */ host?: { kind: string } }

/** `https://github.com/<owner>/<repo>` -> `<owner>/<repo>`; anything else is not a source Rovara can read for the sandbox. */
export function githubRepositoryId(url: string): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(url);
  return match?.[1] !== undefined && match[2] !== undefined ? `${match[1]}/${match[2]}` : undefined;
}

// ---- the sign-in snippet: generated from the contract's own schema, never drawn by hand

const commandLine = (command: { program: string; args: readonly string[] }): string => redactText([command.program, ...command.args].join(" ")).slice(0, 300);

/**
 * The text a repository without a project contract is offered: the `agentx.e2e` value of the app's package.json, as one valid JSON document. It declares one kind of user (`user`) that signs in through a
 * form, and a seed step; both are placeholders a developer adapts (the test ids, the path, the seed script), which is why the page says it is a small change in the repository and not a paste. It is built
 * from `E2EApplicationProjectContractSchema` and parsed against it before it is returned: a snippet the real schema refuses is never offered.
 */
export function signInSnippetFor(input: { applicationId: string; packagePath: string; recipe: E2EAppRecipe; targetIds: readonly string[] }): { path: string; text: string; needsSeedStep: true } | null {
  if (input.recipe.launch.kind !== "service") return null;
  const launch = input.recipe.launch;
  const { recipeDigest: _digest, ...inferred } = input.recipe;
  void _digest;
  const body = {
    ...inferred,
    seedProfileId: E2E_ACCOUNTS_FILE_SEED_PROFILE, accountProfileIds: ["user"], allowedOrigins: ["app-origin"],
    seed: { program: "npm", args: ["run", "rovara-seed"], cwd: ".", timeoutMs: 30_000, env: {} },
  };
  const recipe = { ...body, recipeDigest: sha256Hex(canonicalJson(body)) };
  const portText = launch.start.env["PORT"];
  const listenPort = portText !== undefined && /^\d{4,5}$/u.test(portText) && Number(portText) >= 1024 && Number(portText) <= 65_535 ? Number(portText) : 4317;
  const contract = {
    schemaVersion: "e2e-application-project/v1", recipe,
    service: { listenPort, portEnv: "PORT", originBindings: [{ originRef: "app-origin", envName: "APP_ORIGIN" }] },
    accountProfiles: [{
      profileId: "user", scope: "synthetic-test", authProfileId: E2E_FORM_LOGIN_AUTH_PROFILE, seedProfileId: E2E_ACCOUNTS_FILE_SEED_PROFILE, tenantRef: "tenant-a", roleRef: "user", identityProbeId: "identity/v1",
      login: { kind: "form", path: "/login", usernameTestId: "email", passwordTestId: "password", submitTestId: "login-submit", successTestId: "signed-in" },
    }],
    targetAccounts: input.targetIds.slice(0, 12).map((baseTargetId) => ({ baseTargetId, profileId: "user" })),
  };
  const parsed = E2EApplicationProjectContractSchema.safeParse(contract);
  if (!parsed.success) return null;
  return { path: input.packagePath, text: `${JSON.stringify({ agentx: { e2e: parsed.data } }, null, 2)}\n`, needsSeedStep: true };
}

// ---- what the repository says

const userKindsOf = (snapshot: E2ESourceSnapshot, applicationId: string): { kinds: BrowserUserKind[]; contract: boolean; tooMany: boolean } => {
  let contract: ReturnType<typeof readE2EApplicationProjectContract>;
  try { contract = readE2EApplicationProjectContract(snapshot, applicationId); } catch { return { kinds: [], contract: true, tooMany: false }; }
  if (contract === null) return { kinds: [], contract: false, tooMany: false };
  const kinds = contract.accountProfiles.filter((profile) => profile.scope === "synthetic-test")
    .map((profile): BrowserUserKind => ({ profileId: profile.profileId, roleRef: profile.roleRef, signInPath: profile.login?.path ?? null }));
  return { kinds: kinds.slice(0, BROWSER_USER_KINDS_MAX), contract: true, tooMany: kinds.length > BROWSER_USER_KINDS_MAX };
};

/** The facts the page shows, read from the proposal and the files it came from. Pure. */
export function foundFacts(snapshot: E2ESourceSnapshot, proposal: E2ESetupProposal): BrowserFound {
  const applications: BrowserFoundApplication[] = [];
  let tooMany = false;
  for (const application of proposal.applications) {
    if ((application.kind !== "web" && application.kind !== "api") || application.recipe === null || application.recipe.launch.kind !== "service") continue;
    const recipe = application.recipe;
    const launch = recipe.launch as Extract<E2EAppRecipe["launch"], { kind: "service" }>;
    const users = userKindsOf(snapshot, application.applicationId);
    tooMany ||= users.tooMany;
    const signInDeclared = users.kinds.some((kind) => kind.signInPath !== null);
    const packagePath = application.sourcePaths.find((path) => /(^|\/)package\.json$/iu.test(path));
    const targetIds = proposal.targets.filter((target) => target.applicationId === application.applicationId && (target.kind === "web" || target.kind === "api")).map((target) => target.targetId);
    applications.push({
      applicationId: application.applicationId,
      recipeSource: e2eApplicationRecipeOrigin(snapshot, application.applicationId) === "project-contract" ? "repo" : "inferred",
      build: recipe.build.map(commandLine), start: commandLine(launch.start), healthPath: launch.health.path, healthStatus: launch.health.expectedStatus,
      userKinds: users.kinds, signInDeclared,
      snippet: signInDeclared || users.contract || packagePath === undefined ? null : signInSnippetFor({ applicationId: application.applicationId, packagePath, recipe, targetIds }),
    });
    if (applications.length >= 4) break;
  }
  const problem = tooMany ? "too-many-user-kinds" : applications.length === 0 ? "no-application" : proposal.state === "needs-input" ? "needs-input" : null;
  return BrowserFoundSchema.parse({ applications, problem });
}

// ---- the stored objects

export interface ReadRepository { snapshot: E2ESourceSnapshot; proposal: E2ESetupProposal; found: BrowserFound; commitSha: string; candidateDigest: string }

/** Reads a captured repository: verifies the snapshot, inspects it and proposes the setup against the READY runtime profiles. Throws when the source cannot be verified. */
export function readRepository(snapshot: E2ESourceSnapshot, readyProfiles: readonly E2EReadyRuntimeProfile[]): ReadRepository {
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  const inspection = inspectE2ERepository(snapshot, snapshot.candidate).inspection;
  const proposal = proposeE2ESetup({ inspection, snapshot, expectedCandidate: snapshot.candidate, readyProfiles });
  return { snapshot, proposal, found: foundFacts(snapshot, proposal), commitSha: snapshot.commitSha, candidateDigest: snapshot.candidate.digest };
}

const encodeSnapshot = (snapshot: E2ESourceSnapshot): Record<string, unknown> => ({
  ...snapshot, sources: snapshot.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: source.kind, bytesBase64: Buffer.from(source.bytes).toString("base64") })),
});

/** The files of a stored object, decoded and checked the way the planning seam checks them (`application-planning.ts`). Throws on anything that is not a whole, verifiable snapshot. */
export function decodeSnapshot(raw: unknown): E2ESourceSnapshot {
  const record = isRecord(raw) ? raw : undefined;
  if (record === undefined || !Array.isArray(record["sources"])) throw new Error("the stored files are unreadable");
  const sources = record["sources"].map((value: unknown) => {
    const source = isRecord(value) ? value : undefined;
    if (typeof source?.["path"] !== "string" || typeof source["sha256"] !== "string" || typeof source["bytesBase64"] !== "string" || source["kind"] !== "blob") throw new Error("invalid source");
    return { path: source["path"], sha256: source["sha256"], bytes: Buffer.from(source["bytesBase64"], "base64"), kind: "blob" as const };
  });
  const snapshot = { ...record, sources } as unknown as E2ESourceSnapshot;
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  return snapshot;
}

export interface StoredObject { ref: string; sha256: string; bytes: string }

/** The SOURCE object of a refresh: the files and the proposal derived from them, no policy. */
export function sourceObject(input: { companyId: string; project: string; repository: BrowserRepository; read: ReadRepository }): StoredObject {
  const bytes = canonicalJson({ schemaVersion: BROWSER_SOURCE_SCHEMA, repositoryUrl: input.repository.url, repositoryName: input.repository.name, selectedRef: input.repository.defaultBranch,
    snapshot: encodeSnapshot(input.read.snapshot), proposal: input.read.proposal });
  const sha256 = sha256Hex(bytes);
  return { ref: `browser-testing-source/${input.companyId}/${input.project}/${sha256}.json`, sha256, bytes };
}

/** The proposal artifact the planning seam re-verifies: the files, the proposal and the policy, issued under the registrant of the project's base revision. */
export function proposalObject(input: { companyId: string; project: string; issuerOwnerKey: string; repository: BrowserRepository; read: ReadRepository; policy: E2EPolicy }): StoredObject | undefined {
  const sourceRepositoryId = githubRepositoryId(input.repository.url);
  if (sourceRepositoryId === undefined) return undefined;
  const bytes = canonicalJson({
    schemaVersion: BROWSER_PROPOSAL_SCHEMA, issuerOwnerKey: input.issuerOwnerKey, repositoryUrl: input.repository.url, selectedRef: input.repository.defaultBranch,
    identityMapping: { schemaVersion: "github-source-to-agentx-registration/v1", sourceRepositoryId, registeredRepositoryId: input.repository.name },
    candidate: input.read.snapshot.candidate, snapshot: encodeSnapshot(input.read.snapshot), proposal: input.read.proposal, policy: input.policy,
  });
  const sha256 = sha256Hex(bytes);
  return { ref: `project-setup-proposals/${input.companyId}/${input.project}/${sha256}.json`, sha256, bytes };
}

async function put(objects: ObjectStorage, object: StoredObject, retention: string): Promise<void> {
  if (Buffer.byteLength(object.bytes, "utf8") > BROWSER_OBJECT_MAX_BYTES) throw new Error("the stored proposal is too large");
  try {
    await objects.put(object.ref, Buffer.from(object.bytes, "utf8"), { contentType: "application/json", metadata: { sha256: object.sha256 }, retention });
  } catch (error) {
    // A second put of the same bytes is the same object; anything else at the key is a conflict that must be said.
    if (!(error instanceof Error) || error.name !== "ObjectConflictError") throw error;
    const kept = await objects.get(object.ref, BROWSER_OBJECT_MAX_BYTES);
    if (kept === undefined || Buffer.from(kept).toString("utf8") !== object.bytes) throw new Error("a stored object conflicts with the one being stored", { cause: error });
  }
}
export const storeSourceObject = (objects: ObjectStorage, object: StoredObject): Promise<void> => put(objects, object, BROWSER_SOURCE_RETENTION);
export const storeProposalObject = (objects: ObjectStorage, object: StoredObject): Promise<void> => put(objects, object, BROWSER_PROPOSAL_RETENTION);

/** A stored object read back: its bytes must hash to the digest it is named by. Undefined when it is missing, changed or unreadable. */
export async function readStored(objects: ObjectStorage, ref: string, sha256: string): Promise<Record<string, unknown> | undefined> {
  try {
    const bytes = await objects.get(ref, BROWSER_OBJECT_MAX_BYTES);
    if (bytes === undefined) return undefined;
    const text = Buffer.from(bytes).toString("utf8");
    if (sha256Hex(text) !== sha256) return undefined;
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

/** The SOURCE object read back and re-verified: the files, and the proposal checked against them again. Undefined when anything about it is off. */
export async function readSource(objects: ObjectStorage, ref: string, sha256: string, repository: BrowserRepository): Promise<ReadRepository | undefined> {
  const record = await readStored(objects, ref, sha256);
  if (record === undefined || record["schemaVersion"] !== BROWSER_SOURCE_SCHEMA || record["repositoryUrl"] !== repository.url || record["repositoryName"] !== repository.name) return undefined;
  try {
    const snapshot = decodeSnapshot(record["snapshot"]);
    const proposal = verifyE2ESetupProposal(E2ESetupProposalSchema.parse(record["proposal"]), snapshot, snapshot.candidate);
    return { snapshot, proposal, found: foundFacts(snapshot, proposal), commitSha: snapshot.commitSha, candidateDigest: snapshot.candidate.digest };
  } catch { return undefined; }
}

/** The approved proposal object read back for a project's revision: the files and the proposal, checked as the planning seam checks them. Undefined when anything is off. */
export async function readApproved(objects: ObjectStorage, approval: { proposalRef: string; proposalSha256: string; candidateDigest: string }, repository: BrowserRepository, issuerOwnerKey: string): Promise<(ReadRepository & { policy: unknown }) | undefined> {
  const record = await readStored(objects, approval.proposalRef, approval.proposalSha256);
  if (record === undefined || record["schemaVersion"] !== BROWSER_PROPOSAL_SCHEMA || record["issuerOwnerKey"] !== issuerOwnerKey || record["repositoryUrl"] !== repository.url
    || (isRecord(record["identityMapping"]) ? record["identityMapping"]["registeredRepositoryId"] : undefined) !== repository.name) return undefined;
  try {
    const snapshot = decodeSnapshot(record["snapshot"]);
    if (snapshot.candidate.digest !== approval.candidateDigest) return undefined;
    const proposal = verifyE2ESetupProposal(E2ESetupProposalSchema.parse(record["proposal"]), snapshot, snapshot.candidate);
    if (proposal.candidateDigest !== approval.candidateDigest) return undefined;
    return { snapshot, proposal, found: foundFacts(snapshot, proposal), commitSha: snapshot.commitSha, candidateDigest: snapshot.candidate.digest, policy: record["policy"] };
  } catch { return undefined; }
}

// ---- the policy

/**
 * The policy an owner's choices make: the proposal's targets against the READY runtime profile, Rovara's normal limits with the owner's time limit, and the capture the owner chose. `screenshotMode` is
 * written only when a strip is asked for ("failed" is what a policy without it already means), so a policy that asks for nothing extra reads exactly as the older ones do. No AI route is pinned.
 */
export function browserPolicy(input: { proposal: E2ESetupProposal; proof: BrowserProof; runTimeoutMs: number; policyRevision: number }): E2EPolicy {
  return E2EPolicySchema.parse({
    schemaVersion: 1, policyRevision: input.policyRevision, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: input.proposal.targets,
    defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
    capture: { screenshots: true, traces: false, video: input.proof.video, downloads: true, ...(input.proof.screenshotMode === "all" ? { screenshotMode: "all" as const } : {}) },
    limits: { ...E2E_MODEL_FREE_LIMITS, runTimeoutMs: input.runTimeoutMs },
  });
}

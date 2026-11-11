// The project's test environment as a project setting, on the ports (Cloud's `org/test-environment.ts`, rewritten onto `DocumentStore` and the approval gate). Rovara PROPOSES it, a Prove run checks
// it, the owner approves it once, and each approved change is a new immutable revision. A task keeps the revision it started with (`readApprovedTestEnvironment` with a revision).
//
// What is stored, all under the project's partition (the same keys as Cloud, so Cloud can switch to this code with no data move):
//   TESTENV#PROPOSAL#<digest>  the proposed body (bounded life, 7 days), so an approval names a digest and never carries a body of its own;
//   TESTENV#PROVE#<digest>     the worker's Prove report for exactly that digest (`recordTestEnvProveReport`);
//   TESTENV#REV#<revision>     the approved environment, immutable;
//   TESTENV#LATEST             the pointer to the newest revision (the only item an approval updates).
//
// WHAT CHANGED FROM CLOUD, and why (the stored rows above are the same):
//   - The approval is a subject of the approval gate (`core/decisions/approval-gate.ts`), kind `test-environment`. Cloud's own checks (a maintainer role, a fresh sign-in, a second person for a less-safe change,
//     a confirmation card) are the Approvers seam's rules here: a less-safe change, a proposal a setup run made and any high-risk card are HIGH risk, so only the methods the approvers plug-in names as
//     strong may approve it, and `minApprovers` says whether a second person is needed. Code's own approvers allow the local owner. The gate also gives the single-use proof and the replay of a repeated request.
//   - Who may propose is the surface's check (the local owner's session), not a project role: Code has one owner.
//   - What the approval still refuses itself, in this order (each its own fixed message, none repeats a value): no such proposal or it has expired; the Prove run did not pass for this digest; a seed file the
//     check did not load; the environment names production (or reaches a remote while the company has not listed production); recordings outside the sandbox and preview tiers; a kind of backing that is not
//     available; the revision the person looked at is not the newest.
import { createHash } from "node:crypto";
import {
  SetupValueSourceSchema,
  TestEnvProveReportSchema,
  TestEnvironmentBodySchema,
  TestEnvironmentSchema,
  agentXError,
  catalogEntryById,
  change,
  mediaTierAllowed,
  projectMetaKey,
  projectPk,
  testEnvApprovalRisk,
  testEnvDigest,
  testEnvIsProved,
  testEnvLessSafeChanges,
  testEnvProdDenyViolations,
  when,
  type DecisionRisk,
  type DocumentKey,
  type OrgId,
  type TestEnvLessSafeField,
  type TestEnvSeedTrust,
  type TestEnvironment,
  type TestEnvironmentBody,
  type TransactItem,
  type VerifiedCatalog,
} from "@agentx/contracts";
import { SubjectRefusal, type AppliedDecision, type DecisionSubject, type LoadedSubject } from "../decisions/approval-gate.js";
import { dependenciesStartableNow, emulatorServesAll, isPrepulledEntry } from "./dependency-plan.js";
import { refuseDependenciesWithDevcontainer } from "./devcontainer-check.js";
import { documentOf, expired, expiryOf, type TestEnvDeps } from "./deps.js";
import { approvedFixturesOf, recordsOf } from "./fixture-lookup.js";
import { SEED_COMMAND_PROBLEM_WORDS, dependencySeedCommands, seedCommandProblem } from "./refused-command.js";
import { parseSeedChecks, seedTrustOf, type SeedCheck } from "./seed-lock.js";
import { testServicesEnabled } from "./test-services-switch.js";

/** The contract's less-safe fields (pre-prod, shared, preview, video, traces, schema-synth, a raised budget, a moved target, a shortened deny list). */
export type TestEnvChangeFlag = TestEnvLessSafeField;

/** How long a proposal stays approvable. A later change to the repositories makes an old proposal wrong, so it is not kept long. */
export const TEST_ENV_PROPOSAL_TTL_MS = 7 * 86_400_000;
const REVISION_WIDTH = 8;
const REVISION_PREFIX = "TESTENV#REV#";
const DIGEST = /^[a-f0-9]{64}$/u;

const keyOf = (orgId: OrgId, project: string, sk: string): DocumentKey => ({ pk: projectPk(orgId, project), sk });
export const testEnvRevisionKey = (orgId: OrgId, project: string, revision: number): DocumentKey => keyOf(orgId, project, `${REVISION_PREFIX}${String(revision).padStart(REVISION_WIDTH, "0")}`);
export const testEnvLatestKey = (orgId: OrgId, project: string): DocumentKey => keyOf(orgId, project, "TESTENV#LATEST");
export const testEnvProposalKey = (orgId: OrgId, project: string, digest: string): DocumentKey => keyOf(orgId, project, `TESTENV#PROPOSAL#${digest}`);
export const testEnvProveKey = (orgId: OrgId, project: string, digest: string): DocumentKey => keyOf(orgId, project, `TESTENV#PROVE#${digest}`);
const editedKey = (orgId: OrgId, project: string): DocumentKey => keyOf(orgId, project, "TESTENV#EDITED");

const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const stale = (message: string) => agentXError("CHANGE_STALE", message);
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "the project's test environment could not be read");

type Item = Record<string, unknown>;
async function read(deps: Pick<TestEnvDeps, "store">, key: DocumentKey): Promise<Item | undefined> {
  return deps.store.get(key);
}

/** The body, or CONFIG_INVALID naming the field and what is wrong with it, never the value. */
function parseBody(body: unknown): TestEnvironmentBody {
  const parsed = TestEnvironmentBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`${issue?.path.join(".") || "environment"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

const PROD_WORDS: Record<string, string> = {
  prod_host: "names a production address",
  prod_arn: "names a production resource",
  prod_account: "is in a production account",
  prod_deny_missing: "reaches a real service, but the company has not listed what production is: list it first",
};

/** Refuses an environment that names production. The message names the field and a fixed reason, never the value. */
function refuseProduction(body: TestEnvironmentBody, previous?: TestEnvironmentBody): void {
  const found = testEnvProdDenyViolations(body, previous?.prodDeny)[0];
  if (found !== undefined) throw invalid(`${found.field} ${PROD_WORDS[found.kind] ?? "names production"}`);
}

/**
 * Recordings (video, traces) are kept only where the app and its data die with the round: the sandbox and a per-task preview, never the shared environment. Refused when proposed AND when approved, whatever
 * the account kinds, so an environment that asks for one in the shared tier is never stored as approvable.
 */
function refuseRecordingOnShared(body: TestEnvironmentBody): void {
  if ((body.capture.video || body.capture.traces) && !mediaTierAllowed(body.tier)) throw invalid("capture: video and traces are kept only in the sandbox and per-task preview tiers");
}

/** The fixed words of a fake whose set of answers is not approved. */
const FAKE_NOT_APPROVED = "dependencies: a fake needs an approved set of answers for this company; approve its fixture set first";
/** The fixed words of a dependency that cannot be started yet (real software from the catalog, and S3, SQS and DynamoDB on Rovara local AWS). */
const DEPENDENCIES_NOT_AVAILABLE_YET = "dependencies: this kind of backing is not available yet; Rovara starts real software from its image list, and S3, SQS and DynamoDB on Rovara local AWS, only";

/**
 * Dependencies are proposed and approved only with the switch `tx` on, only as real software from the catalog (a fake, a test account, a project image or a substitute image is "not available yet"; a fake
 * of an approved fixture set is), and not for a project that uses a dev container (the sealed check runners cannot be combined with one). Refused when proposed AND when approved, so a card is never
 * offered that could not be carried out. A body without dependencies reads nothing and is never refused here.
 */
async function refuseDependenciesNotAvailable(deps: TestEnvDeps, orgId: OrgId, project: string, body: TestEnvironmentBody, previous?: TestEnvironmentBody): Promise<void> {
  // Only a dependency that is new or changed since the approved environment is judged: one already approved and left untouched must not make an unrelated change unprovable when, say, the switch was turned
  // off since. A task still refuses to use it (`environmentUnusedReason`), so keeping it is not starting it.
  const approved = new Set((previous?.dependencies ?? []).map((dependency) => JSON.stringify(dependency)));
  const changed = (body.dependencies ?? []).filter((dependency) => !approved.has(JSON.stringify(dependency)));
  if (changed.length === 0) return;
  if (!testServicesEnabled(deps.env ?? process.env)) throw invalid("dependencies: test services are not switched on for this install");
  if (!dependenciesStartableNow(changed)) throw invalid(DEPENDENCIES_NOT_AVAILABLE_YET);
  // A `local` dependency whose catalog entry has no pinned digest is the same "not available yet": refused here too, not only when a task is planned. A catalog that cannot be read leaves the judgment to the
  // task's plan, which refuses it in fixed words.
  const catalog: VerifiedCatalog | undefined = deps.serviceCatalog === undefined ? undefined : await Promise.resolve(deps.serviceCatalog()).catch(() => undefined);
  if (catalog !== undefined) {
    for (const dependency of changed) {
      if (dependency.backing.kind !== "local" && dependency.backing.kind !== "emulated") continue;
      const entry = catalogEntryById(catalog, dependency.backing.catalogId);
      if (!catalog.pinned || entry === undefined || entry.image.digest === undefined || !isPrepulledEntry(catalog, dependency.backing.catalogId)) throw invalid(DEPENDENCIES_NOT_AVAILABLE_YET);
      if (dependency.backing.kind === "emulated" && !emulatorServesAll(entry, dependency.backing.awsServices)) throw invalid(DEPENDENCIES_NOT_AVAILABLE_YET);
    }
  }
  // A fake is approved only for a fixture set that is approved for THIS company, for the dependency's own family (the store is asked; without one no fake is "available").
  const fakes = changed.filter((dependency) => dependency.backing.kind === "fake");
  if (fakes.length > 0) {
    const approvedSets = await approvedFixturesOf(recordsOf(deps.fixtureStore), orgId, project, { dependencies: fakes });
    for (const dependency of fakes) {
      const ref = dependency.backing.kind === "fake" ? dependency.backing.fixtureSetRef : undefined;
      if (ref === undefined || approvedSets.get(ref)?.family !== dependency.family) throw invalid(FAKE_NOT_APPROVED);
    }
  }
  // A seed is a command run with the dependency's network access: it gets the same refusal as any command (a download-and-run, or a secret).
  for (const command of dependencySeedCommands(changed)) {
    const problem = seedCommandProblem(command);
    if (problem !== undefined) throw invalid(`dependencies: ${SEED_COMMAND_PROBLEM_WORDS[problem]}`);
  }
  await refuseDependenciesWithDevcontainer(deps, orgId, project, { dependencies: changed });
}

const changeFlags = (previous: TestEnvironmentBody | undefined, next: TestEnvironmentBody, trust?: TestEnvSeedTrust): TestEnvChangeFlag[] => testEnvLessSafeChanges(previous, next, trust);

/**
 * `setup_run`: the setup helper's "Use this setup" (it ran commands; its check is pinned to the run's commits). `setup_draft`: a setup draft's "Check and apply" (it only read the repositories, so no commit pin).
 * Both are approved only with a strong proof (the approver's fresh sign-in where an adapter asks for one): approval rules depend on the proposal, never on which screen made it.
 */
export type ProposalOrigin = "setup_run" | "setup_draft";
const originOf = (value: unknown): ProposalOrigin | undefined => (value === "setup_run" || value === "setup_draft" ? value : undefined);

export interface ProposedTestEnvironment { digest: string; risk: DecisionRisk; lessSafe: TestEnvChangeFlag[] }

/**
 * Stores a proposal so it can be proved and approved by its digest. Production is refused here, not only at approval, so a person never approves a card that could not be applied. Proposing the same
 * body again is the same proposal (the digest is the id), and renews its life. The caller (a surface) has already checked that the person may propose.
 */
export async function proposeTestEnvironment(
  deps: TestEnvDeps,
  input: {
    orgId: OrgId; project: string; proposedBy: string; body: unknown; valueSources?: unknown;
    /** Who proposed it, as the identity adapter names them, and through which client (`cli`, `mcp`, `page`): the approval then knows the requester, so an approvers adapter that forbids self-approval can refuse the person who proposed. */
    proposer?: { provider: string; personId: string; displayName: string };
    client?: string;
    /** Where the proposal came from: `setup_run` marks it as a setup run's. The mark stays on the record (proposing the same body again cannot make it look ordinary). */
    origin?: ProposalOrigin;
    /** The BROKER's own check of each seed command (`lockLookSeeds`), given only by the look's propose. Absent: every seed command of the proposal is HIGH. */
    seedChecks?: readonly SeedCheck[];
    /** The proposal's commands REPLACE the settings' lists (a person's typed commands), so its check runs exactly them and its approval writes exactly them. */
    replaceLists?: boolean;
  },
): Promise<ProposedTestEnvironment> {
  const body = parseBody(input.body);
  const previous = await readApprovedTestEnvironment(deps, input.orgId, input.project);
  refuseProduction(body, previous?.environment);
  refuseRecordingOnShared(body);
  await refuseDependenciesNotAvailable(deps, input.orgId, input.project, body, previous?.environment);
  const digest = testEnvDigest(body);
  const now = deps.now();
  // A mark that was set stays: a later proposal of the same body (the detectors', a repeat) cannot make a setup run's proposal look like an ordinary one.
  const origin = input.origin ?? originOf((await read(deps, testEnvProposalKey(input.orgId, input.project, digest)))?.["origin"]);
  await deps.store.put({
    item: documentOf({
      ...testEnvProposalKey(input.orgId, input.project, digest), entityType: "TEST_ENV_PROPOSAL", orgId: input.orgId, project: input.project, digest, proposedBy: input.proposedBy,
      proposedAt: new Date(now).toISOString(), environment: body, ...(input.valueSources === undefined ? {} : { valueSources: input.valueSources }), ...(origin === undefined ? {} : { origin }),
      ...(input.proposer === undefined ? {} : { proposer: { provider: input.proposer.provider, personId: input.proposer.personId, displayName: input.proposer.displayName.slice(0, 120) } }), ...(input.client === undefined ? {} : { client: input.client.slice(0, 40) }),
      ...(input.seedChecks === undefined || input.seedChecks.length === 0 ? {} : { seedChecks: input.seedChecks }), ...(input.replaceLists === true ? { replaceLists: true } : {}),
      ...expiryOf(now + TEST_ENV_PROPOSAL_TTL_MS),
    }),
  });
  const trust = seedTrustOf(parseSeedChecks(input.seedChecks), body);
  const lessSafe = changeFlags(previous?.environment, body, trust);
  return { digest, risk: lessSafe.length > 0 ? "high" : testEnvApprovalRisk(body, trust), lessSafe };
}

/** Reads a stored proposal's body, checking that it still hashes to its own key. Undefined when there is none or it has expired. */
export async function readProposal(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string): Promise<TestEnvironmentBody | undefined> {
  const item = await read(deps, testEnvProposalKey(orgId, project, digest));
  if (item === undefined || expired(item, deps.now())) return undefined;
  const body = TestEnvironmentBodySchema.safeParse(item["environment"]);
  if (!body.success || testEnvDigest(body.data) !== digest || item["orgId"] !== orgId || item["project"] !== project) throw unavailable();
  return body.data;
}

/** The value sources a proposal was stored with (where each value came from) and who proposed it. Empty for a proposal that has none (an edit by a person). Never throws on a damaged field: it reads as none. */
export async function readProposalSources(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string): Promise<{ valueSources: Array<{ field: string; source: unknown }>; proposedBy: string | undefined; origin: ProposalOrigin | undefined; seedChecks: SeedCheck[] }> {
  const item = await read(deps, testEnvProposalKey(orgId, project, digest));
  const sources = item?.["valueSources"];
  const valueSources = Array.isArray(sources) ? sources.filter((entry): entry is { field: string; source: unknown } => typeof entry === "object" && entry !== null && typeof (entry as { field?: unknown }).field === "string") : [];
  return {
    valueSources, proposedBy: typeof item?.["proposedBy"] === "string" ? item["proposedBy"] : undefined, origin: originOf(item?.["origin"]),
    // The checks count only on an item that really is this proposal's.
    seedChecks: item?.["digest"] === digest && item?.["orgId"] === orgId && item?.["project"] === project ? parseSeedChecks(item?.["seedChecks"]) : [],
  };
}

/** The seeds of a stored proposal's body the broker verified (its own checks, on the proposal item, for exactly those seeds). Any failure to read is none: every seed command HIGH. */
export async function proposalSeedTrust(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string, body: TestEnvironmentBody): Promise<TestEnvSeedTrust> {
  try {
    return seedTrustOf((await readProposalSources(deps, orgId, project, digest)).seedChecks, body);
  } catch {
    return {};
  }
}

/** Whether any value source is one a setup RUN adds (a worked command, a company recipe, a person's value in the run). A second signal beside the proposal's own mark. */
export function isSetupRunProposal(valueSources: ReadonlyArray<{ source: unknown }>): boolean {
  return valueSources.some((entry) => SetupValueSourceSchema.safeParse(entry.source).success);
}

/** Whether a proposal was made by a setup RUN: the proposal's own mark, or a value source only a run adds. Such a proposal is pinned to the commits its run used. */
export async function proposalIsSetupRun(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string): Promise<boolean> {
  const { origin, valueSources } = await readProposalSources(deps, orgId, project, digest);
  return origin === "setup_run" || isSetupRunProposal(valueSources);
}

/** Whether a stored proposal replaces the settings' lists (a person's typed commands). Unreadable: false (the lists are added to, as every other proposal). */
export async function proposalReplacesLists(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string): Promise<boolean> {
  try { return (await read(deps, testEnvProposalKey(orgId, project, digest)))?.["replaceLists"] === true; } catch { return false; }
}

/** Whether approving a proposal needs a strong proof because of where it came from: a setup run's, or a setup draft's. */
export async function proposalNeedsFreshSignIn(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string): Promise<boolean> {
  const { origin, valueSources } = await readProposalSources(deps, orgId, project, digest);
  return origin === "setup_run" || origin === "setup_draft" || isSetupRunProposal(valueSources);
}

/**
 * The owner's EDITED proposal, if there is one: a pointer to its digest (the body is the stored proposal, which has its own life). The newest edit wins; a new proposal from the setup draft clears it, so
 * "go back to what Rovara found" is one press. The pointer carries no authority: whatever it names is read and checked again like any proposal.
 */
export async function setEditedProposal(deps: TestEnvDeps, input: { orgId: OrgId; project: string; digest: string; editedBy: string }): Promise<void> {
  const now = deps.now();
  await deps.store.put({ item: documentOf({ ...editedKey(input.orgId, input.project), entityType: "TEST_ENV_EDITED", orgId: input.orgId, project: input.project, digest: input.digest, editedBy: input.editedBy, editedAt: new Date(now).toISOString(), ...expiryOf(now + TEST_ENV_PROPOSAL_TTL_MS) }) });
}
export async function readEditedProposal(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<{ digest: string; editedBy: string } | undefined> {
  const item = await read(deps, editedKey(orgId, project));
  if (item === undefined || item["orgId"] !== orgId || item["project"] !== project || typeof item["digest"] !== "string" || !DIGEST.test(item["digest"]) || typeof item["editedBy"] !== "string") return undefined;
  if (expired(item, deps.now())) return undefined;
  return { digest: item["digest"], editedBy: item["editedBy"] };
}
export async function clearEditedProposal(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<void> {
  await deps.store.delete({ key: editedKey(orgId, project) });
}

/**
 * Stores the worker's Prove report for a proposal. A report is accepted only for a proposal that exists (so a worker cannot invent a digest), and the latest report for a digest replaces the earlier one.
 * Whether it passed is read again at approval (`testEnvIsProved`), never trusted from here.
 */
export async function recordTestEnvProveReport(deps: TestEnvDeps, input: { orgId: OrgId; project: string; report: unknown }): Promise<{ proved: boolean }> {
  const report = TestEnvProveReportSchema.safeParse(input.report);
  if (!report.success) throw invalid("the Prove report could not be read");
  const digest = report.data.proposalDigest;
  const now = deps.now();
  const written = await deps.store.transact([
    { kind: "check", key: testEnvProposalKey(input.orgId, input.project, digest), condition: when.present() },
    { kind: "put", item: documentOf({ ...testEnvProveKey(input.orgId, input.project, digest), entityType: "TEST_ENV_PROVE", orgId: input.orgId, project: input.project, digest, report: report.data, recordedAt: new Date(now).toISOString(), ...expiryOf(now + TEST_ENV_PROPOSAL_TTL_MS) }) },
  ]);
  if (!written.applied) throw stale("there is no such proposal to prove; propose the environment again");
  // The proposal itself is read for its dependencies: a report without the two dependency steps does not prove an environment that has some.
  const proposed = await readProposal(deps, input.orgId, input.project, digest).catch(() => undefined);
  // A proposal that cannot be read proves nothing (its dependencies are not known).
  return { proved: proposed !== undefined && testEnvIsProved(report.data, digest, proposed) };
}

/** The stored Prove report for a proposal's digest, read again through the contract (a damaged item reads as none, never as proved). */
export async function readTestEnvProveReport(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string): Promise<ReturnType<typeof TestEnvProveReportSchema.parse> | undefined> {
  const item = await read(deps, testEnvProveKey(orgId, project, digest));
  const parsed = item === undefined ? undefined : TestEnvProveReportSchema.safeParse(item["report"]);
  return parsed?.success === true ? parsed.data : undefined;
}

/** The newest approved environment, or the one at `revision`. Undefined when the project has none. A stored item that does not read back as what was approved throws: a damaged approval is never read as "none". */
export async function readApprovedTestEnvironment(deps: TestEnvDeps, orgId: OrgId, project: string, revision?: number): Promise<TestEnvironment | undefined> {
  let wanted = revision;
  if (wanted === undefined) {
    const pointer = await read(deps, testEnvLatestKey(orgId, project));
    if (pointer === undefined) return undefined;
    const latest = pointer["revision"];
    if (typeof latest !== "number" || !Number.isSafeInteger(latest) || latest < 1) throw unavailable();
    wanted = latest;
  }
  const item = await read(deps, testEnvRevisionKey(orgId, project, wanted));
  if (item === undefined) {
    if (revision === undefined) throw unavailable();
    return undefined;
  }
  const parsed = TestEnvironmentSchema.safeParse({ revision: item["revision"], approvedAt: item["approvedAt"], environment: item["environment"] });
  if (!parsed.success || parsed.data.revision !== wanted || item["orgId"] !== orgId || item["project"] !== project || item["digest"] !== testEnvDigest(parsed.data.environment)) throw unavailable();
  return parsed.data;
}

/** Who approved the environment revision (the person a nightly run is started as). Undefined when there is no such revision or it names nobody. */
export async function readApprovedBy(deps: TestEnvDeps, orgId: OrgId, project: string, revision: number): Promise<string | undefined> {
  const item = await read(deps, testEnvRevisionKey(orgId, project, revision));
  return typeof item?.["approvedBy"] === "string" && item["approvedBy"] !== "" ? item["approvedBy"] : undefined;
}

/** What an approval says when a seed file's content was not loaded by the proposal's check. */
export const SEED_FILE_UNCHECKED = "The check did not load this test environment's test data file, so its content can't be approved. Check it works again, then approve.";

/** The bound hashes for every file seed of the body, or undefined when one has none. Only the body's own file seeds are kept (a hash for anything else is dropped). */
export function boundSeedFilesOf(body: TestEnvironmentBody, hashes: ReadonlyArray<{ id: string; path: string; sha256: string }> | undefined): Array<{ id: string; path: string; sha256: string }> | undefined {
  const out: Array<{ id: string; path: string; sha256: string }> = [];
  for (const dependency of body.dependencies ?? []) {
    for (const seed of dependency.seeds) {
      if (!("fixturePath" in seed)) continue;
      const hash = hashes?.find((entry) => entry.id === dependency.id && entry.path === seed.fixturePath && /^[a-f0-9]{64}$/u.test(entry.sha256));
      if (hash === undefined) return undefined;
      if (!out.some((entry) => entry.id === hash.id && entry.path === hash.path)) out.push({ id: hash.id, path: hash.path, sha256: hash.sha256 });
    }
  }
  return out;
}

/** The seed file hashes an approved revision bound (empty for a revision with no file seed, or one written before the binding: its file seeds then plan as unbound and are refused). */
export async function readApprovedSeedFiles(deps: TestEnvDeps, orgId: OrgId, project: string, revision: number): Promise<Array<{ id: string; path: string; sha256: string }>> {
  const item = await read(deps, testEnvRevisionKey(orgId, project, revision));
  const list = item?.["seedFiles"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    const { id, path, sha256 } = (entry ?? {}) as { id?: unknown; path?: unknown; sha256?: unknown };
    return typeof id === "string" && typeof path === "string" && typeof sha256 === "string" && /^[a-f0-9]{64}$/u.test(sha256) ? [{ id, path, sha256 }] : [];
  }).slice(0, 16);
}

/** A short stable id for a request that has none of its own (a card's approve button): the digest, the revision it looked at and who pressed it. */
export function testEnvRequestId(digest: string, expectedRevision: number, approvedBy: string): string {
  return createHash("sha256").update(JSON.stringify([digest, String(expectedRevision), approvedBy])).digest("hex").slice(0, 32);
}

// ---- the approval, as a subject of the approval gate

/** The gate's name for this subject. */
export const TEST_ENVIRONMENT_KIND = "test-environment";

/** The subject id of one proposal: the project and the digest (neither holds `@`). */
export const testEnvironmentSubjectId = (project: string, digest: string): string => `${project}@${digest}`;
function parseSubjectId(subjectId: string): { project: string; digest: string } | undefined {
  const at = subjectId.lastIndexOf("@");
  if (at < 1) return undefined;
  const digest = subjectId.slice(at + 1);
  return DIGEST.test(digest) ? { project: subjectId.slice(0, at), digest } : undefined;
}

/** What an approval is given besides the outcome (`DecisionAttempt.details`): the hashes of the seed files the proposal's check loaded. */
export interface TestEnvironmentDecisionDetails { seedFileHashes?: ReadonlyArray<{ id: string; path: string; sha256: string }> }

/** The person who proposed, as the proposal item recorded them; undefined for a proposal that has none (an older one), which then has no requester, as before. */
function storedProposer(item: Item | undefined): { provider: string; personId: string; displayName: string } | undefined {
  const value = item?.["proposer"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { provider, personId, displayName } = value as Record<string, unknown>;
  return typeof provider === "string" && provider !== "" && typeof personId === "string" && personId !== "" ? { provider, personId, displayName: typeof displayName === "string" ? displayName : "" } : undefined;
}

interface LoadedState { orgId: OrgId; project: string; digest: string; body: TestEnvironmentBody; current: TestEnvironment | undefined; trust: TestEnvSeedTrust; lessSafe: TestEnvChangeFlag[]; risk: DecisionRisk; prove: ReturnType<typeof TestEnvProveReportSchema.safeParse> | undefined }

/**
 * The approval of a proposed, proved environment as the project's next revision. The only inputs from the person are the digest and the revision they looked at (the gate's `seen`): the body comes from the
 * stored proposal and the report from the stored Prove run. One transaction commits the revision and moves the pointer, only if the pointer is still where the person saw it.
 * `deps` is the same as for the other functions here; the gate adds the audit record, the proof's single use and the replay of a repeated request.
 */
export function createTestEnvironmentSubject(deps: TestEnvDeps, options: { companyId: OrgId }): DecisionSubject {
  const orgId = options.companyId;
  return {
    kind: TEST_ENVIRONMENT_KIND,

    async load(companyId, subjectId): Promise<LoadedSubject | undefined> {
      if (companyId !== orgId) return undefined;
      const parsed = parseSubjectId(subjectId);
      if (parsed === undefined) return undefined;
      const body = await readProposal(deps, orgId, parsed.project, parsed.digest).catch(() => undefined);
      if (body === undefined) return undefined;
      const current = await readApprovedTestEnvironment(deps, orgId, parsed.project).catch(() => undefined);
      // An unreadable approval is not "none": nothing is approved over it.
      if (current === undefined && (await read(deps, testEnvLatestKey(orgId, parsed.project))) !== undefined) return undefined;
      const trust = await proposalSeedTrust(deps, orgId, parsed.project, parsed.digest, body);
      const lessSafe = changeFlags(current?.environment, body, trust);
      const strongOrigin = await proposalNeedsFreshSignIn(deps, orgId, parsed.project, parsed.digest);
      // Anything less safe, anything a setup run or draft made, and every card the contract grades high is HIGH: only a strong proof may approve it.
      const risk: DecisionRisk = lessSafe.length > 0 || strongOrigin ? "high" : testEnvApprovalRisk(body, trust);
      const proveItem = await read(deps, testEnvProveKey(orgId, parsed.project, parsed.digest));
      const prove = proveItem === undefined ? undefined : TestEnvProveReportSchema.safeParse(proveItem["report"]);
      const proposer = storedProposer(await read(deps, testEnvProposalKey(orgId, parsed.project, parsed.digest)));
      const state: LoadedState = { orgId, project: parsed.project, digest: parsed.digest, body, current, trust, lessSafe, risk, prove };
      // What the person approves is the NEXT revision: what they saw is "revision N+1 holds this digest", so an approval made while someone else approved first (the newest moved) is stale.
      const revision = (current?.revision ?? 0) + 1;
      return {
        key: testEnvLatestKey(orgId, parsed.project),
        // The pointer is where the person saw it: absent for the first revision, otherwise at the revision before the one being approved.
        guard: current === undefined ? when.absent() : when.eq("revision", current.revision),
        // Waiting while this digest is not already the newest approved revision.
        waiting: current === undefined || testEnvDigest(current.environment) !== parsed.digest,
        request: {
          kind: "setting", subject: { type: "test-environment", id: parsed.project }, projectName: parsed.project, revision, artifactDigest: parsed.digest, risk,
          // The requester is the person who proposed it, so a rule that forbids approving one's own proposal can fire (the gate checks it against the verified approver, never a name a caller sends).
          ...(proposer === undefined ? {} : { requestedBy: { companyId: orgId, personId: proposer.personId, provider: proposer.provider, displayName: proposer.displayName, roles: [] } }),
        },
        state,
      };
    },

    async apply(loaded, attempt, approvers, at): Promise<AppliedDecision> {
      const state = loaded.state as LoadedState;
      if (attempt.outcome !== "approve") throw new SubjectRefusal("invalid_outcome", "A test environment is approved or left alone: there is nothing to reject or send back.");
      const details = (attempt.details ?? {}) as TestEnvironmentDecisionDetails;
      const proved = testEnvIsProved(state.prove?.success === true ? state.prove.data : undefined, state.digest, state.body);
      if (!proved) throw new SubjectRefusal("invalid", "prove this environment (boot, smoke test and a full run) before approving it");
      // Every seed file is approved as the content its check loaded; one the check did not load is not approved.
      const seedFiles = boundSeedFilesOf(state.body, details.seedFileHashes);
      if (seedFiles === undefined) throw new SubjectRefusal("invalid", SEED_FILE_UNCHECKED);
      try {
        refuseProduction(state.body, state.current?.environment);
        refuseRecordingOnShared(state.body);
        await refuseDependenciesNotAvailable(deps, state.orgId, state.project, state.body, state.current?.environment);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "CONFIG_INVALID") throw new SubjectRefusal("invalid", error.message.replace(/^CONFIG_INVALID: /u, ""));
        throw error;
      }
      const approver = approvers[0]!;
      const revision = loaded.request.revision;
      const approvedAt = at;
      const second = approvers.slice(1).map((entry) => `${entry.provider}:${entry.personId}`);
      const extra: TransactItem[] = [
        // The project is not archived: an archived project accepts no new revision.
        { kind: "check", key: projectMetaKey(state.orgId, state.project), condition: when.not(when.eq("status", "archived")) },
        {
        kind: "put",
        item: documentOf({
          ...testEnvRevisionKey(state.orgId, state.project, revision), entityType: "TEST_ENV_REVISION", orgId: state.orgId, project: state.project, revision, approvedAt, approvedBy: approver.personId,
          digest: state.digest, requestId: attempt.requestId, lessSafe: state.lessSafe, environment: state.body, ...(seedFiles.length === 0 ? {} : { seedFiles }),
          ...(second.length === 0 ? {} : { secondApprovers: second }),
        }),
        condition: when.absent(),
        },
      ];
      return {
        ops: [
          change.set("entityType", "TEST_ENV_LATEST"), change.set("orgId", state.orgId), change.set("project", state.project), change.set("revision", revision), change.set("digest", state.digest),
        ],
        extra,
        result: { revision, digest: state.digest, lessSafe: state.lessSafe },
      };
    },
  };
}


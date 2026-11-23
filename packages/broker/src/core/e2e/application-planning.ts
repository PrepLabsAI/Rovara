// Source-backed application planning, ported from the retired broker. Source and registry ports are company-scoped by the host.
import {
  E2EPolicySchema, E2ESetupProposalSchema, canonicalJson, verifyE2ESetupProposal,
  type E2EPolicy, type E2ESourceSnapshot, type ProjectDefinition,
} from "@agentx/contracts";
import { buildFeatureE2EPlanningContext, isExactFeatureE2ESourceSnapshot, type FeatureE2EPlanningContextResult } from "../../e2e/feature-plan-planning-context.js";
import type { E2EAccountRegistryEntry } from "../../e2e/application-account-registry.js";
import type { ReadyE2ERuntime } from "../../aws/e2e-runtime-readiness.js";
import { sha256Of } from "../plan/store.js";
import type { ApplicationE2ESeams, ApplicationTask } from "./application-seams.js";

export interface ApplicationPlanningProject {
  definition: ProjectDefinition;
  registeredBy: string;
  setupApproval?: { proposalRef: string; proposalSha256: string; candidateDigest: string; decision: "approve" | "decline" };
}
export interface ApplicationPlanningPorts {
  /** Read the task's company-scoped pinned project revision, never the latest revision. */
  project(task: ApplicationTask): Promise<ApplicationPlanningProject | undefined>;
  readText(key: string, maxBytes: number): Promise<string | undefined>;
  capture?(task: ApplicationTask, repositoryUrl: string, commitSha: string): Promise<E2ESourceSnapshot>;
  /** Rows READY for this project's pinned runtime binding, one row per kind. */
  readyRuntimes(task: ApplicationTask): Promise<readonly ReadyE2ERuntime[]>;
  accounts(task: ApplicationTask, snapshot: E2ESourceSnapshot, policy: E2EPolicy): Promise<readonly E2EAccountRegistryEntry[]>;
  agentRouteApproved?(task: ApplicationTask, policy: E2EPolicy): Promise<boolean>;
  /**
   * Browser testing: whether the owner paused the project, so that tasks planned from now on get no browser check. The ONLY reader of Pause among the engine's seams: the approval and the round never
   * read it, which is what keeps a plan that was already approved running its checks (a test lists the readers). A read that fails is "unknown", never "not paused".
   */
  paused?(task: ApplicationTask): Promise<boolean>;
  /**
   * Browser testing: renews the project's test accounts (the 90-day definitions) against the APPROVED setup's own files when they are near their expiry or have lapsed. `blocking` is true when a
   * definition has already lapsed and could not be renewed: the task is then told why instead of failing to sign in later. Never throws.
   */
  renewAccounts?(task: ApplicationTask, approved: { snapshot: E2ESourceSnapshot; proposalSha256: string }): Promise<{ ok: true } | { ok: false; blocking: boolean; reason: string }>;
  now?(): number;
}
const MAX_SETUP_BYTES = 24 * 1024 * 1024;
const unknown = (reason: string): Extract<FeatureE2EPlanningContextResult, { status: "unknown" }> => ({ status: "unknown", reason });
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The approved setup is source only after its bytes, issuer, policy, repository, proposal and candidate have all been verified. */
async function approvedSource(ports: ApplicationPlanningPorts, project: ApplicationPlanningProject, policy: E2EPolicy, repository: ProjectDefinition["repositories"][number], repositoryId: string): Promise<E2ESourceSnapshot | undefined> {
  const approval = project.setupApproval;
  if (approval?.decision !== "approve") return undefined;
  try {
    const text = await ports.readText(approval.proposalRef, MAX_SETUP_BYTES);
    if (text === undefined || Buffer.byteLength(text, "utf8") > MAX_SETUP_BYTES || sha256Of(text) !== approval.proposalSha256) return undefined;
    const record = object(JSON.parse(text));
    if (record?.["schemaVersion"] !== "project-setup-source-proposal/v1" || record["issuerOwnerKey"] !== project.registeredBy
      || record["repositoryUrl"] !== repository.url || canonicalJson(record["policy"]) !== canonicalJson(policy)
      || object(record["identityMapping"])?.["registeredRepositoryId"] !== repository.name) return undefined;
    const raw = object(record["snapshot"]);
    if (!Array.isArray(raw?.["sources"])) return undefined;
    const sources = raw["sources"].map((value: unknown) => {
      const source = object(value);
      if (typeof source?.["path"] !== "string" || typeof source["sha256"] !== "string" || typeof source["bytesBase64"] !== "string" || source["kind"] !== "blob") throw new Error("invalid source");
      return { path: source["path"], sha256: source["sha256"], bytes: Buffer.from(source["bytesBase64"], "base64"), kind: "blob" as const };
    });
    const snapshot = { ...raw, sources } as unknown as E2ESourceSnapshot;
    if (!isExactFeatureE2ESourceSnapshot(snapshot, repositoryId, snapshot.commitSha) || snapshot.candidate.digest !== approval.candidateDigest) return undefined;
    const proposal = verifyE2ESetupProposal(E2ESetupProposalSchema.parse(record["proposal"]), snapshot, snapshot.candidate);
    return proposal.candidateDigest === approval.candidateDigest ? snapshot : undefined;
  } catch { return undefined; }
}

async function planningSource(ports: ApplicationPlanningPorts, task: ApplicationTask, project: ApplicationPlanningProject, policy: E2EPolicy, repository: ProjectDefinition["repositories"][number], repositoryId: string, prepared: { baseCommitSha: string } | undefined): Promise<{ status: "ready"; snapshot: E2ESourceSnapshot; approved?: E2ESourceSnapshot } | Extract<FeatureE2EPlanningContextResult, { status: "unknown" }>> {
  const setup = await approvedSource(ports, project, policy, repository, repositoryId);
  let snapshot = setup !== undefined && (prepared === undefined || setup.commitSha === prepared.baseCommitSha) ? setup : undefined;
  if (snapshot === undefined) {
    if (prepared === undefined || ports.capture === undefined) return unknown("trusted source for the exact prepared commit is unavailable");
    try {
      snapshot = await ports.capture(task, repository.url, prepared.baseCommitSha);
      if (!isExactFeatureE2ESourceSnapshot(snapshot, repositoryId, prepared.baseCommitSha)) return unknown("trusted capture did not match the task's prepared repository commit");
    } catch { return unknown("trusted source capture for the exact prepared commit failed"); }
  }
  return { status: "ready", snapshot, ...(setup === undefined ? {} : { approved: setup }) };
}

/** The answer while the owner has browser testing paused: none (as a project with no policy), or "unknown" when the pause cannot be read (never "not paused"). Undefined: not paused. */
async function pausedAnswer(ports: ApplicationPlanningPorts, task: ApplicationTask): Promise<{ answer: FeatureE2EPlanningContextResult | undefined } | undefined> {
  if (ports.paused === undefined) return undefined;
  try { return (await ports.paused(task)) ? { answer: undefined } : undefined; } catch { return { answer: unknown("the project's browser testing pause could not be read") }; }
}

/** The test accounts' renewal against the approved setup's own files: the refusal to plan when a definition has lapsed and could not be renewed; otherwise nothing. */
async function renewalRefusal(ports: ApplicationPlanningPorts, task: ApplicationTask, project: ApplicationPlanningProject, approved: E2ESourceSnapshot | undefined): Promise<Extract<FeatureE2EPlanningContextResult, { status: "unknown" }> | undefined> {
  if (ports.renewAccounts === undefined || approved === undefined || project.setupApproval === undefined) return undefined;
  const renewed = await ports.renewAccounts(task, { snapshot: approved, proposalSha256: project.setupApproval.proposalSha256 });
  return !renewed.ok && renewed.blocking ? unknown(renewed.reason) : undefined;
}

export function createApplicationPlanningContext(ports: ApplicationPlanningPorts): ApplicationE2ESeams["planning"]["context"] {
  return async (task) => {
    const project = await ports.project(task);
    if (project === undefined || project.definition.name !== task.project || project.definition.revision !== task.startingRevision) return unknown("the task's pinned project revision is unavailable");
    if (project.definition.e2e === undefined) return undefined;
    // Browser testing, paused by the owner: tasks planned from now on get no browser check, exactly as a project with no policy (the plan path is unchanged). A plan already approved never comes through here.
    const held = await pausedAnswer(ports, task);
    if (held !== undefined) return held.answer;
    const policy = E2EPolicySchema.safeParse(project.definition.e2e);
    if (!policy.success) return unknown("the task's pinned E2E policy could not be validated");
    if (project.definition.repositories.length !== 1) return unknown("source-backed planning currently requires one pinned repository");
    const repository = project.definition.repositories[0]!;
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(repository.url);
    if (match === null) return unknown("the registered repository has no supported immutable source identity");
    const repositoryId = `${match[1]!}/${match[2]!}`;
    const prepared = (task.workflow.reviewBase ?? task.preparedBase)?.find((entry) => entry.repositoryId === repository.name);
    const source = await planningSource(ports, task, project, policy.data, repository, repositoryId, prepared);
    if (source.status !== "ready") return source;
    const snapshot = source.snapshot;
    // The test accounts' 90-day definitions are renewed from the approved setup (the same definition, under the approval already in force) before they are read: a lapsed one the renewal could not write is said, not guessed at.
    const unrenewed = await renewalRefusal(ports, task, project, source.approved);
    if (unrenewed !== undefined) return unrenewed;
    const readyRuntimes = await ports.readyRuntimes(task).catch(() => []);
    const accountRegistry = await ports.accounts(task, snapshot, policy.data).catch(() => []);
    const agentRouteApproved = policy.data.modelRouteRevision !== null && ports.agentRouteApproved !== undefined
      ? await ports.agentRouteApproved(task, policy.data).catch(() => false) : false;
    return buildFeatureE2EPlanningContext(policy.data, snapshot, { origin: prepared === undefined ? "approved-setup" : "prepared-commit",
      preparedCommitSha: prepared?.baseCommitSha ?? null, readyRuntimes, accountRegistry, agentRouteApproved, ...(ports.now === undefined ? {} : { now: ports.now() }) });
  };
}

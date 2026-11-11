// the stored result of a proposal's CANDIDATE check. A candidate check prepares a fresh workspace from the commands a test-environment proposal would put in the project's settings (the settings' own commands
// plus the proposal's), so the commands are run BEFORE they are applied. Its record is keyed by (project, proposal digest, settings revision) and holds the workspace (whose status is the result, read live as the
// project's own setup check is) and the exact command lists the check ran. Nothing else reads a candidate: the Prove derives its report from it, and the approval writes into the settings only what it ran.
import { INDEX_EXPIRY_ATTRIBUTE, PreparePinsSchema, TEST_SERVICES_USAGE_RESULT_KEY, ProjectCommandSchema, TestServicesUsageRecordSchema, change, projectPk, queryAll, when, type OrgId, type OrgKey, type PreparePins, type ProjectCommand, type TestServicesUsageRecord } from "@agentx/contracts";
import { z } from "zod";
import { expired, type StoreOnly, type TestEnvDeps } from "./deps.js";
import { TEST_ENV_PROPOSAL_TTL_MS } from "./environment.js";
import { testServicesEnabled } from "./test-services-switch.js";

const REVISION_WIDTH = 8;
export const CANDIDATE_CHECK_ENTITY = "TEST_ENV_CANDIDATE_CHECK";
export const candidateCheckKey = (orgId: OrgId, project: string, digest: string, revision: number): OrgKey => ({ pk: projectPk(orgId, project), sk: `TESTENV#CANDIDATE#${digest}#${String(revision).padStart(REVISION_WIDTH, "0")}` });
/** A candidate record lives as long as the proposal it checks. */
export const candidateExpiry = (nowMs: number): number => Math.floor((nowMs + TEST_ENV_PROPOSAL_TTL_MS) / 1000);


const CommandsSchema = z.array(ProjectCommandSchema).max(64);
const CandidateCheckSchema = z.object({
  workspaceId: z.string().min(1).max(100), revision: z.number().int().positive(), startedAt: z.string().min(1).max(40), startedBy: z.string().min(1).max(200),
  digest: z.string().regex(/^[a-f0-9]{64}$/u), setup: CommandsSchema, readiness: CommandsSchema,
  /** `setup_run`: the proposal this checked was marked as a setup run's when the check started (the mark outlives the proposal item). */
  origin: z.literal("setup_run").optional(),
  /** SU-1 addendum 3: the commit each repository was prepared at (the pins the preparation was sent). A setup run's proposal is proved only by a check made at the commits its run used. */
  pins: PreparePinsSchema.optional(),
  /** Test services: what the check reported of the dependencies it started (the worker's facts, validated). The Prove derives its two dependency steps from it; a record that does not read back is no record. */
  usage: TestServicesUsageRecordSchema.optional(),
});
export interface CandidateCheck { workspaceId: string; revision: number; startedAt: string; startedBy: string; digest: string; setup: ProjectCommand[]; readiness: ProjectCommand[]; origin?: "setup_run" | undefined; pins?: PreparePins | undefined; usage?: TestServicesUsageRecord | undefined }

/**
 * The candidate check of `digest` at settings revision `revision`, or undefined: none was started, it expired, or the stored item does not read back as this project's check for exactly this digest and revision
 * (a damaged item is never read as a result).
 */
export async function readCandidateCheck(deps: Pick<TestEnvDeps, "store" | "now">, orgId: OrgId, project: string, digest: string, revision: number): Promise<CandidateCheck | undefined> {
  const item = (await deps.store.get(candidateCheckKey(orgId, project, digest, revision))) as Record<string, unknown> | undefined;
  if (item === undefined) return undefined;
  if (expired(item, deps.now())) return undefined;
  if (item.entityType !== CANDIDATE_CHECK_ENTITY || item.orgId !== orgId || item.project !== project) return undefined;
  const parsed = CandidateCheckSchema.safeParse(item);
  if (!parsed.success || parsed.data.digest !== digest || parsed.data.revision !== revision) return undefined;
  return parsed.data;
}

/**
 * Keeps the usage record a candidate check reported, on the check's own record. Validated here (bounded, strict, no secret-shaped name): a report that does not parse is not kept. Only the first record is kept
 * (a repeated report changes nothing), and only for a check that exists and has not expired. Returns whether a record was written. Never throws.
 */
export async function recordCandidateUsage(deps: Pick<TestEnvDeps, "store" | "now">, input: { orgId: OrgId; project: string; digest: string; revision: number; usage: unknown }): Promise<boolean> {
  const parsed = TestServicesUsageRecordSchema.safeParse(input.usage);
  if (!parsed.success) return false;
  try {
    const written = await deps.store.update({
      key: candidateCheckKey(input.orgId, input.project, input.digest, input.revision), ops: [change.set("usage", JSON.parse(JSON.stringify(parsed.data)) as never)],
      // The check exists, is a candidate check, has no record yet and has not expired.
      condition: when.and(when.present(), when.eq("entityType", CANDIDATE_CHECK_ENTITY), when.notExists("usage"), when.gt(INDEX_EXPIRY_ATTRIBUTE, Math.floor(deps.now() / 1000))),
    });
    return written.applied;
  } catch {
    return false;
  }
}
// ---- the record a preparation reports

/** The pages of a project's candidate records read to find the one for a workspace (a project has a handful at a time). */
const CANDIDATE_LOOKUP_PAGES = 5;

/** Fixed words for why a reported record was not kept (the log never holds the record). */
export const USAGE_REFUSALS = ["switch_off", "no_such_check", "not_kept"] as const;
export type UsageRefusal = (typeof USAGE_REFUSALS)[number];

/**
 * The candidate check that holds this workspace, scoped by the org: the workspace's own setup-check record names its org and project (and must be this org's), and the project's candidate records name the workspace.
 * Undefined when there is none. Bounded, never throws.
 */
export async function candidateCheckOfWorkspace(deps: StoreOnly, orgId: OrgId, workspaceId: string): Promise<{ project: string; digest: string; revision: number } | undefined> {
  try {
    // The record `commitSetupCheck` writes for every setup check (org/project-setup-check.ts `setupCheckRecordKey`; not imported here, that module imports this one).
    const record = (await deps.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "SETUP_CHECK" })) as Record<string, unknown> | undefined;
    if (record === undefined || record["orgId"] !== orgId || record["workspaceId"] !== workspaceId || typeof record["project"] !== "string") return undefined;
    const project = record["project"];
    const candidates = await queryAll(deps.store, { pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: "TESTENV#CANDIDATE#" }, limit: 50 });
    for (const item of candidates.slice(0, CANDIDATE_LOOKUP_PAGES * 50)) {
      if (item["workspaceId"] === workspaceId && item["orgId"] === orgId && item["entityType"] === CANDIDATE_CHECK_ENTITY && typeof item["digest"] === "string" && typeof item["revision"] === "number") return { project, digest: item["digest"], revision: item["revision"] };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The hook for a preparation's terminal result: if it carries `testServicesUsage` (the worker's usage record of a candidate check), keep it on the check that holds the workspace. Nothing is read or written for a result
 * without the key (so with `tx` off nothing changes). A record that arrives with the switch off, for a workspace that is no candidate check of this org, or that does not parse or was already kept, is refused and logged in
 * fixed words (never the record). Never throws.
 */
export async function keepCandidateUsage(deps: Pick<TestEnvDeps, "store" | "now">, input: { orgId: OrgId | undefined; workspaceId: string; result: unknown; env?: NodeJS.ProcessEnv }): Promise<"none" | "kept" | "refused"> {
  const result = input.result;
  if (typeof result !== "object" || result === null || Array.isArray(result) || !(TEST_SERVICES_USAGE_RESULT_KEY in result)) return "none";
  const refuse = (reason: UsageRefusal): "refused" => {
    console.log(JSON.stringify({ component: "broker", event: "test_services.usage_refused", reason, workspaceId: input.workspaceId }));
    return "refused";
  };
  if (!testServicesEnabled(input.env)) return refuse("switch_off");
  // A workspace with no org (before orgs) holds no candidate check.
  const check = input.orgId === undefined ? undefined : await candidateCheckOfWorkspace(deps, input.orgId, input.workspaceId);
  if (check === undefined) return refuse("no_such_check");
  const kept = await recordCandidateUsage(deps, { orgId: input.orgId!, project: check.project, digest: check.digest, revision: check.revision, usage: (result as Record<string, unknown>)[TEST_SERVICES_USAGE_RESULT_KEY] });
  return kept ? "kept" : refuse("not_kept");
}

// Saved project images: the routes a rebuild job's worker calls, and the fallback report of a preparation that started from an image. The rules (test-env/saved-env.ts `mintPushForJob`, `recordBuild`,
// `markStale`) are applied there; this file decides WHO may call them and what is passed.
//   push login (POST .../operations/<id>/saved-env-push-login) and result (POST .../saved-env-result):
//     - the saved-environments switch is on and the registry is installed;
//     - the request is a callback of the preparation made for the job: the callback capability (signed, bound to this workspace, operation and fence, with only these two actions, valid for hours) was verified before this
//       is reached. The repository grant is NOT used here: it lives 15 minutes, and a push comes long after it; the lease (3 hours) and the capability are what live as long as the build. The job's id and lease token
//       are in the body: either alone is nothing;
//     - the operation is this workspace's ACTIVE PREPARE, live, and it is the operation the broker made FOR that job (`savedEnvJobId`, recorded when the operation was built): another preparation, a task or a
//       publication is never answered, whatever lease it presents;
//     - the org and the project come from the workspace, never from the request; the lease decides everything else (`authorizeLease` inside `mintPushForJob` and `recordBuild`).
//   each push login counts against the operation (at most `SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION`: the worker asks once, a few more cover a retry of the request itself).
//   fallback (POST .../operations/<id>/saved-env-fallback), which stays on the repository grant (a preparation falls back within minutes of its start):
//     - the same switch and grant; the operation is this workspace's active prepare and was told to pull an image (`savedEnvDigest`): the digest is the one the BROKER recorded, never one the request names;
//     - the step is one of the closed list (`markStale` ignores a step that says nothing about the image). It answers `{ ok: true }` whatever markStale decided: the worker learns nothing about the registry.
import { SavedEnvFallbackBodySchema, SavedEnvLeaseBodySchema, SavedEnvResultBodySchema, SavedEnvRegistryAuthSchema, agentXError, type SavedEnvRegistryAuth, type SavedEnvRegistryAuthParser } from "@agentx/contracts";
import { markStale, mintPushForJob, recordBuild, type RecordRefusal, type SavedEnvDeps } from "./saved-env.js";

/** A build asks for the push login once; a few more cover a retry of the request itself. */
export const SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION = 3;
const LIVE_STATUSES = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);

export interface SavedEnvLeaseContext {
  /** What a push login is read through before it is given on. Absent: Code's own; a hosted install passes `HostedSavedEnvRegistryAuthSchema`. */
  registryAuthSchema?: SavedEnvRegistryAuthParser;
  /** The registry's deps, only while the saved-environments switch is on. */
  deps: SavedEnvDeps | undefined;
  /** Verifies the grant's signature and expiry and returns what it is bound to. Throws FORBIDDEN. (The fallback report only.) */
  inspectGrant(grant: string): { workspaceId: string; operationId: string };
  /** Counts one push login against the operation, atomically: false once it has had `SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION`. */
  countPushLogin(workspaceId: string, operationId: string): Promise<boolean>;
  /** The operation, its workspace, the org and project the workspace belongs to, the job it was made for and the image it was told to pull. */
  readOperation(workspaceId: string, operationId: string): Promise<{ kind: string; status: string; savedEnvJobId: string | undefined; savedEnvDigest: string | undefined; orgId: string | undefined; projectName: string; workspace: { status: string; activeOperationId: string | null | undefined } }>;
  log?: (event: Record<string, unknown>) => void;
}

type Operation = Awaited<ReturnType<SavedEnvLeaseContext["readOperation"]>>;

async function activePrepare(context: SavedEnvLeaseContext, input: { workspaceId: string; operationId: string }): Promise<{ deps: SavedEnvDeps; operation: Operation; orgId: string }> {
  const deps = context.deps;
  if (deps === undefined || !deps.session.config.enabled) throw agentXError("FORBIDDEN", "Saved environments are not switched on for this install.");
  const operation = await context.readOperation(input.workspaceId, input.operationId);
  if (operation.kind !== "prepare" || !LIVE_STATUSES.has(operation.status) || operation.workspace.status !== "PREPARING" || operation.workspace.activeOperationId !== input.operationId || operation.orgId === undefined) {
    throw agentXError("FORBIDDEN", "saved environment routes answer a running preparation only");
  }
  return { deps, operation, orgId: operation.orgId };
}

/** The same, for the routes that still answer to the preparation's repository grant. */
async function activePrepareByGrant(context: SavedEnvLeaseContext, input: { grant: string | undefined; workspaceId: string; operationId: string }): Promise<{ deps: SavedEnvDeps; operation: Operation; orgId: string }> {
  const deps = context.deps;
  if (deps === undefined || !deps.session.config.enabled) throw agentXError("FORBIDDEN", "Saved environments are not switched on for this install.");
  if (!input.grant) throw agentXError("FORBIDDEN", "repository grant is required");
  const claims = context.inspectGrant(input.grant);
  if (claims.workspaceId !== input.workspaceId || claims.operationId !== input.operationId) throw agentXError("FORBIDDEN", "saved environment grant does not cover this request");
  return activePrepare(context, input);
}

function bodyOf<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "saved environment request is invalid");
  return parsed.data;
}

/** The job this preparation was made for, held to the lease the request presents. */
function ownJob(operation: Operation, jobId: string): void {
  if (operation.savedEnvJobId === undefined || operation.savedEnvJobId !== jobId) throw agentXError("FORBIDDEN", "saved environment request does not belong to this preparation");
}

export async function savedEnvPushLoginCore(context: SavedEnvLeaseContext, input: { workspaceId: string; operationId: string; body: unknown }): Promise<{ login: SavedEnvRegistryAuth }> {
  const body = bodyOf(SavedEnvLeaseBodySchema, input.body);
  const { deps, operation, orgId } = await activePrepare(context, input);
  ownJob(operation, body.jobId);
  if (!(await context.countPushLogin(input.workspaceId, input.operationId))) throw agentXError("FORBIDDEN", "saved environment push login was already given for this preparation");
  const minted = await mintPushForJob(deps, { orgId, projectId: operation.projectName }, body);
  if (!minted.ok) {
    // The lease reasons are fixed words but say which part failed; the worker is told one sentence for all of them. A session that could not be minted is a fault to retry.
    if (minted.reason === "unavailable") throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not get a login for the saved environment");
    throw agentXError("FORBIDDEN", "saved environment push login was refused");
  }
  const parsed = (context.registryAuthSchema ?? SavedEnvRegistryAuthSchema).safeParse(minted.auth);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not get a login for the saved environment");
  (context.log ?? ((event) => { console.log(JSON.stringify({ component: "broker", ...event })); }))({ event: "saved_env.push_login_issued", workspaceId: input.workspaceId, operationId: input.operationId, repository: parsed.data.repository, expiresAt: parsed.data.expiresAt });
  return { login: parsed.data };
}

export type SavedEnvResultAnswer = { recorded: true; deleted: number } | { recorded: false; reason: RecordRefusal };

export async function savedEnvResultCore(context: SavedEnvLeaseContext, input: { workspaceId: string; operationId: string; body: unknown }): Promise<SavedEnvResultAnswer> {
  const body = bodyOf(SavedEnvResultBodySchema, input.body);
  const { deps, operation, orgId } = await activePrepare(context, input);
  ownJob(operation, body.jobId);
  const recorded = await recordBuild(deps, { orgId, projectId: operation.projectName }, { jobId: body.jobId, leaseToken: body.leaseToken, result: body.result });
  return recorded.ok ? { recorded: true, deleted: recorded.deleted } : { recorded: false, reason: recorded.reason };
}

export async function savedEnvFallbackCore(context: SavedEnvLeaseContext, input: { grant: string | undefined; workspaceId: string; operationId: string; body: unknown }): Promise<{ ok: true }> {
  const body = bodyOf(SavedEnvFallbackBodySchema, input.body);
  const { deps, operation, orgId } = await activePrepareByGrant(context, input);
  if (operation.savedEnvDigest === undefined) throw agentXError("FORBIDDEN", "saved environment request does not belong to this preparation");
  // A failure to mark is the registry's to retry (the next task falls back again); the worker is never held up or told.
  await markStale(deps, { orgId, projectId: operation.projectName }, { digest: operation.savedEnvDigest, step: body.step }).catch(() => undefined);
  return { ok: true };
}

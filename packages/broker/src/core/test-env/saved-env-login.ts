// Saved environments: the exchange the worker calls right before it pulls a saved image (POST .../operations/<id>/saved-env-login). A prepare invocation is stored (outbox, stream, queue,
// dead-letter queue), so it names the image and carries no credential; this is where the login is minted, for one preparation, at the time of the pull. Like the registries' exchange (project-registries/
// exchange.ts), the worker names nothing: the broker decides everything.
//   - the saved-environments switch is on and the registry is installed;
//   - the request carries the operation's repository grant (signed, bound to this workspace and operation, short lived);
//   - the operation is this workspace's ACTIVE PREPARE and live: no other operation (a task, a publication) and no finished preparation is ever given a login;
//   - the image is the digest the broker recorded WITH THE OPERATION when it built the invocation (`savedEnvDigest`), never one the request names; an operation that was told no image gets no login;
//   - the org and project come from the workspace, never from the request. The login is for that one repository, short lived, and is not logged: the line names the workspace, the operation, the digest, the repository and the expiry; the login itself is never in it.
//   - a preparation asks at most `SAVED_ENV_LOGIN_MAX_PER_OPERATION` times (the worker asks once): a counter on the operation, added to with a condition, refuses the rest with FORBIDDEN.
import { SavedEnvRegistryAuthSchema, agentXError, type SavedEnvRegistryAuth, type SavedEnvRegistryAuthParser } from "@agentx/contracts";

export interface SavedEnvLoginContext {
  /** What a login is read through before it is given on. Absent: Code's own (a loopback registry is allowed); a hosted install passes `HostedSavedEnvRegistryAuthSchema`. */
  registryAuthSchema?: SavedEnvRegistryAuthParser;
  /** The saved-environments switch on and the registry installed. */
  enabled: boolean;
  /** Verifies the grant's signature and expiry and returns what it is bound to. Throws FORBIDDEN. */
  inspectGrant(grant: string): { workspaceId: string; operationId: string };
  /** The operation, its workspace, the org and project the workspace belongs to, and the image digest the operation was told to pull. */
  readOperation(workspaceId: string, operationId: string): Promise<{ kind: string; status: string; savedEnvDigest: string | undefined; orgId: string | undefined; projectName: string; workspace: { status: string; activeOperationId: string | null | undefined } }>;
  /** Counts one login against the operation, atomically: false once the operation has had `SAVED_ENV_LOGIN_MAX_PER_OPERATION`. */
  countLogin(workspaceId: string, operationId: string): Promise<boolean>;
  /** The login for that image, or undefined. */
  login(input: { orgId: string; projectName: string; digest: string }): Promise<SavedEnvRegistryAuth | undefined>;
  log?: (event: Record<string, unknown>) => void;
}

/** A preparation's worker asks once; a few more cover a retry of the request itself. */
export const SAVED_ENV_LOGIN_MAX_PER_OPERATION = 3;
const LIVE_STATUSES = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);

export async function exchangeSavedEnvLoginCore(context: SavedEnvLoginContext, input: { grant: string | undefined; workspaceId: string; operationId: string; body: unknown }): Promise<{ login: SavedEnvRegistryAuth }> {
  if (!context.enabled) throw agentXError("FORBIDDEN", "Saved environments are not switched on for this install.");
  if (!input.grant) throw agentXError("FORBIDDEN", "repository grant is required");
  // The request says nothing: an object with no field.
  if (typeof input.body !== "object" || input.body === null || Array.isArray(input.body) || Object.keys(input.body).length > 0) throw agentXError("CONFIG_INVALID", "saved environment login request is invalid");
  const claims = context.inspectGrant(input.grant);
  if (claims.workspaceId !== input.workspaceId || claims.operationId !== input.operationId) throw agentXError("FORBIDDEN", "saved environment login grant does not cover this request");
  const operation = await context.readOperation(input.workspaceId, input.operationId);
  if (operation.kind !== "prepare" || !LIVE_STATUSES.has(operation.status) || operation.workspace.status !== "PREPARING" || operation.workspace.activeOperationId !== input.operationId) {
    throw agentXError("FORBIDDEN", "saved environment logins are given to a running preparation only");
  }
  if (operation.savedEnvDigest === undefined || operation.orgId === undefined) throw agentXError("FORBIDDEN", "saved environment login grant does not cover this request");
  if (!(await context.countLogin(input.workspaceId, input.operationId))) throw agentXError("FORBIDDEN", "saved environment login was already given for this preparation");
  const login = await context.login({ orgId: operation.orgId, projectName: operation.projectName, digest: operation.savedEnvDigest });
  const parsed = (context.registryAuthSchema ?? SavedEnvRegistryAuthSchema).safeParse(login);
  if (!parsed.success) throw agentXError("FORBIDDEN", "saved environment login is not available");
  (context.log ?? ((event) => { console.log(JSON.stringify({ component: "broker", ...event })); }))({ event: "saved_env.login_issued", workspaceId: input.workspaceId, operationId: input.operationId, digest: operation.savedEnvDigest, repository: parsed.data.repository, expiresAt: parsed.data.expiresAt });
  return { login: parsed.data };
}

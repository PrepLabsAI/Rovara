// Saved project images: the two reads and one counter the worker-facing routes (`saved-env-lease.ts`, `saved-env-login.ts`) ask of the stored operation, over the document store. The route layer (a surface
// that mounts the handlers) adds only the grant check; everything else comes from the broker's own records.
//   - the job a rebuild preparation was made for is the `savedEnvBuild.jobId` of the dispatch the BROKER stored with the operation, and the image a task's preparation was told to pull is the `savedEnv.digest` of the
//     same dispatch: never anything the worker says;
//   - a login or a push login is counted on the operation with a conditional add, so two requests at once cannot both pass the last slot.
import { agentXError, change, when, type DocumentStore } from "@agentx/contracts";
import { operationKey, workspaceKey } from "../task-flow/keys.js";
import { SAVED_ENV_LOGIN_MAX_PER_OPERATION, type SavedEnvLoginContext } from "./saved-env-login.js";
import { SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION, type SavedEnvLeaseContext } from "./saved-env-lease.js";
import type { SavedEnvDeps } from "./saved-env.js";

export type SavedEnvOperationView = Awaited<ReturnType<SavedEnvLeaseContext["readOperation"]>>;

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const word = (value: unknown): string => (typeof value === "string" ? value : "");

/** The operation and its workspace as the routes need them. Throws NOT_FOUND for either one that is missing (an unknown id says nothing else). */
export async function readSavedEnvOperation(store: Pick<DocumentStore, "get">, workspaceId: string, operationId: string): Promise<SavedEnvOperationView> {
  const [operation, workspace] = await Promise.all([store.get(operationKey(workspaceId, operationId)), store.get(workspaceKey(workspaceId))]);
  if (operation === undefined || workspace === undefined) throw agentXError("NOT_FOUND", "no such operation");
  const dispatch = (operation["dispatch"] ?? {}) as { payload?: { savedEnvBuild?: { jobId?: unknown }; savedEnv?: { digest?: unknown } } };
  const active = workspace["activeOperationId"];
  return {
    kind: word(operation["kind"]), status: word(operation["status"]),
    savedEnvJobId: text(dispatch.payload?.savedEnvBuild?.jobId), savedEnvDigest: text(dispatch.payload?.savedEnv?.digest),
    orgId: text(workspace["orgId"]) ?? text(workspace["companyId"]), projectName: word(workspace["projectName"]),
    workspace: { status: word(workspace["status"]), activeOperationId: typeof active === "string" ? active : null },
  };
}

/** One more on a counter of the operation's record, only while it is under the limit. False once the limit is reached (or the operation is gone). */
export async function countOperationAttribute(store: Pick<DocumentStore, "update">, workspaceId: string, operationId: string, attribute: string, max: number): Promise<boolean> {
  const written = await store.update({
    key: operationKey(workspaceId, operationId), ops: [change.add(attribute, 1)],
    condition: when.and(when.present(), when.or(when.notExists(attribute), when.lt(attribute, max))),
  });
  return written.applied;
}

/** The context of the push login, result and fallback handlers. `deps` is undefined while the saved-environments switch is off. */
export function savedEnvLeaseContext(input: { deps: SavedEnvDeps | undefined; store: Pick<DocumentStore, "get" | "update">; inspectGrant: SavedEnvLeaseContext["inspectGrant"]; log?: SavedEnvLeaseContext["log"] }): SavedEnvLeaseContext {
  return {
    deps: input.deps,
    inspectGrant: input.inspectGrant,
    countPushLogin: (workspace, operation) => countOperationAttribute(input.store, workspace, operation, "savedEnvPushLoginCount", SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION),
    readOperation: (workspace, operation) => readSavedEnvOperation(input.store, workspace, operation),
    ...(input.log === undefined ? {} : { log: input.log }),
  };
}

/** The context of the pull login handler (the worker asks once, right before it pulls). */
export function savedEnvLoginContext(input: { enabled: boolean; store: Pick<DocumentStore, "get" | "update">; inspectGrant: SavedEnvLoginContext["inspectGrant"]; login: SavedEnvLoginContext["login"]; log?: SavedEnvLoginContext["log"] }): SavedEnvLoginContext {
  return {
    enabled: input.enabled,
    inspectGrant: input.inspectGrant,
    readOperation: (workspace, operation) => readSavedEnvOperation(input.store, workspace, operation),
    countLogin: (workspace, operation) => countOperationAttribute(input.store, workspace, operation, "savedEnvLoginCount", SAVED_ENV_LOGIN_MAX_PER_OPERATION),
    login: input.login,
    ...(input.log === undefined ? {} : { log: input.log }),
  };
}

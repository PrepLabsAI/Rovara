// The Git credential exchange of the core's callback layer (POST .../operations/<id>/repository-credentials): the worker presents its repository grant and gets a clone or push token for a repository the grant names.
// The grant is the proof (signed, 15 minutes, one workspace and operation); this file decides everything else, so a grant kept after the job was stopped, ended or replaced gets nothing:
//   - the operation is LIVE (accepted, dispatching or running): not stopping (a Stop or a money stop sets CANCEL_REQUESTED), not over, not closing;
//   - the operation still holds its workspace: the workspace's fence is the operation's, its active operation is this one and it is not closing, closed or stopped (what the registry and model-access routes
//     already require). That is checked IN the transaction that takes the count's slot, so a close accepted or a fence raised since the read takes no slot;
//   - for a push, the publication or maintenance authority is current (`authority`, the callback layer's own check);
//   - a COUNT: an operation gets at most REPOSITORY_EXCHANGES_PER_REPOSITORY exchanges for each repository its grant names (one number on the operation, `repositoryCredentialCount`, added to with a
//     condition so two requests at once cannot both take the last slot; absent reads as 0). A publish asks twice at most (the revert or the clean tree, then the push) and a replacement machine after a lost
//     one asks again, so 4 covers one whole redelivery; a prepare asks once for each repository;
//   - every exchange is AUDITED before the credential leaves (`repository_credential.requested`): a PUSH that cannot be recorded is refused (fail closed); a clone proceeds when the record fails (it is logged).
//     Once the credential was minted a second row says so (`repository_credential.issued`, best effort), so a ledger row for a request never claims a credential that was not given. A slot spent for a request
//     whose record or mint then failed is given back (nothing left), so a flaky host does not eat the operation's exchanges;
//   - every exchange, given or refused, is one log line: the grant's id (a short hash of its nonce, never the grant), the operation, the repository's name, clone or push, the branch, the count and the outcome.
//     The repository's name comes from the VERIFIED grant, never from the request (the route is reached with no capability, so the body is the caller's); a request the grant does not name logs none.
//     The credential, the grant and the nonce are never in a line.
import { randomUUID } from "node:crypto";
import { AgentXError, agentXError, change, when } from "@agentx/contracts";
import { grantCovers, type RepositoryAccess, type RepositoryCredential, type RepositoryGrantService } from "../repository-access.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { locateWorkspace } from "../core/task-flow/workspace-location.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord } from "../core/task-flow/records.js";
import { iso } from "../core/task-flow/support.js";

/** Exchanges one operation may make for each repository its grant names. */
export const REPOSITORY_EXCHANGES_PER_REPOSITORY = 4;
const LIVE_STATUSES: ReadonlySet<string> = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);
const ENDED_STATUSES: readonly string[] = ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"];

export const EXCHANGE_ENDED_WORDS = "this operation has ended";
export const EXCHANGE_STOPPING_WORDS = "this operation is stopping";
export const EXCHANGE_CLOSING_WORDS = "this operation is closing";
export const EXCHANGE_STALE_WORDS = "callback no longer owns the workspace";
export const EXCHANGE_LIMIT_WORDS = "repository credentials were already given for this operation";
export const EXCHANGE_AUDIT_WORDS = "repository credentials are not available just now; try again shortly";

/** Why an exchange was refused: one word per refusal, in the log line. */
export type ExchangeRefusal = "grant" | "not-covered" | "ended" | "stopping" | "closing" | "stale" | "authority" | "limit" | "audit" | "mint";

export interface GitExchangeContext {
  flow: TaskFlowDeps;
  grants: Pick<RepositoryGrantService, "exchange" | "inspect">;
}

export interface GitExchangeInput {
  grant: string;
  workspaceId: string;
  operationId: string;
  operation: OperationRecord;
  credentialRef: string;
  repositoryUrl: string;
  access: RepositoryAccess;
  /** The callback layer's own check that a push's publication or maintenance authority is current; throws when it is not. */
  authority(): Promise<void>;
  /** The operation is being closed with its workspace. */
  closing(): Promise<boolean>;
}

const refusal = (reason: ExchangeRefusal, error: AgentXError): AgentXError => Object.assign(error, { exchangeRefusal: reason });
const reasonOf = (error: unknown): ExchangeRefusal | undefined => (typeof error === "object" && error !== null ? (error as { exchangeRefusal?: ExchangeRefusal }).exchangeRefusal : undefined);

/** The repository's name only (the last part of the address's path, with no user information, query or fragment), never its address. A string that is not an address has none. */
export function repositoryNameOf(repositoryUrl: string): string | undefined {
  let path: string;
  try { path = new URL(repositoryUrl).pathname; } catch { return undefined; }
  const last = path.replace(/\/+$/u, "").split("/").pop() ?? "";
  const name = last.replace(/\.git$/u, "").slice(0, 100);
  return name === "" ? undefined : name;
}

const headBranchOf = (operation: OperationRecord): string | undefined => operation.publication?.headBranch ?? operation.maintenance?.headBranch;

/** The operation is live (not stopping, not over) and its workspace is there. Whether the workspace still holds it is decided where the slot is taken, in the same transaction. */
function requireLive(operation: OperationRecord, workspace: WorkspaceRecord | undefined): void {
  if (operation.status === "CANCEL_REQUESTED") throw refusal("stopping", agentXError("FORBIDDEN", EXCHANGE_STOPPING_WORDS));
  if (!LIVE_STATUSES.has(operation.status)) throw refusal("ended", agentXError("FORBIDDEN", EXCHANGE_ENDED_WORDS));
  if (workspace === undefined) throw refusal("stale", agentXError("STALE_FENCE", EXCHANGE_STALE_WORDS));
}

/** What taking a slot answered: the count it left, or why it was not taken (the operation's own condition, or the workspace's). */
type Slot = { count: number } | { refused: "operation" | "workspace" };

/**
 * One exchange against the operation's count, taken in ONE transaction with a check of the workspace, so a stop, an end, a newer fence, another active operation or a close accepted since the read
 * takes no slot: the operation is still live and under its cap, and its workspace still holds it at its fence and is not closing.
 */
async function takeSlot(context: GitExchangeContext, location: Located, operation: OperationRecord, cap: number): Promise<Slot> {
  const stored = await context.flow.store.transact([
    { kind: "update", key: location.operationKey(operation.id), ops: [change.add("repositoryCredentialCount", 1)],
      condition: when.and(when.present(), when.not(when.or(...[...ENDED_STATUSES, "CANCEL_REQUESTED"].map((status) => when.eq("status", status)))),
        when.or(when.notExists("repositoryCredentialCount"), when.lt("repositoryCredentialCount", cap))) },
    { kind: "check", key: location.workspaceKey, condition: when.and(when.eq("fence", operation.fence), when.eq("activeOperationId", operation.id), when.notExists("closedAt"),
      ...["CLOSING", "CLOSED", "STOPPED"].map((status) => when.not(when.eq("status", status)))) },
  ]);
  if (!stored.applied) return { refused: stored.failed.includes(1) ? "workspace" : "operation" };
  const count = (await context.flow.store.get(location.operationKey(operation.id)))?.["repositoryCredentialCount"];
  return { count: typeof count === "number" ? count : 1 };
}

/** Gives a slot back when the credential was not minted after all (a record or the mint failed): nothing left, so nothing is spent. Best effort. */
async function giveSlotBack(context: GitExchangeContext, location: Located, operation: OperationRecord): Promise<void> {
  try { await context.flow.store.update({ key: location.operationKey(operation.id), ops: [change.add("repositoryCredentialCount", -1)], condition: when.and(when.present(), when.gt("repositoryCredentialCount", 0)) }); } catch { /* the count stays spent: the cap only gets stricter */ }
}

async function recordUse(context: GitExchangeContext, action: "repository_credential.requested" | "repository_credential.issued", operation: OperationRecord, workspace: WorkspaceRecord, input: GitExchangeInput, grantId: string, count: number, branch: string | undefined): Promise<void> {
  await context.flow.audit.record({
    eventId: (context.flow.newId ?? randomUUID)(), companyId: context.flow.companyId, at: iso(context.flow),
    actor: operation.requester === undefined ? { type: "system", id: "repository-exchange" } : { type: "person", id: operation.requester.personId },
    action,
    details: { repository: repositoryNameOf(input.repositoryUrl) ?? "", kind: input.access, project: workspace.projectName, workspaceId: input.workspaceId, operationId: input.operationId, grantId, count, ...(branch === undefined ? {} : { headBranch: branch }) },
  });
}

type Claims = ReturnType<GitExchangeContext["grants"]["inspect"]>;
type Located = NonNullable<Awaited<ReturnType<typeof locateWorkspace>>>;

/** The grant verifies and names this request. Its id and the repository's name (from the grant, not the request) go into the log line as soon as they are known, so a refusal names the grant too. */
function checkedGrant(context: GitExchangeContext, input: GitExchangeInput, line: Record<string, unknown>): Claims {
  let claims: Claims;
  try { claims = context.grants.inspect(input.grant); } catch (error) { throw refusal("grant", error instanceof AgentXError ? error : agentXError("FORBIDDEN", "invalid repository grant")); }
  line["grantId"] = claims.grantId;
  if (!grantCovers(claims, input)) throw refusal("not-covered", agentXError("FORBIDDEN", "repository credential grant does not cover this request"));
  const name = repositoryNameOf(input.repositoryUrl);
  if (name !== undefined) line["repository"] = name;
  return claims;
}

/** The run is not closing, the operation is live and holds its workspace, and a push's authority is current. */
async function checkedLive(context: GitExchangeContext, input: GitExchangeInput): Promise<{ location: Located; workspace: WorkspaceRecord }> {
  const location = await locateWorkspace({ store: context.flow.store, companyId: context.flow.companyId }, input.workspaceId);
  const workspace = location === undefined ? undefined : fromDocument<WorkspaceRecord>(location.workspace);
  if (await input.closing()) throw refusal("closing", agentXError("FORBIDDEN", EXCHANGE_CLOSING_WORDS));
  requireLive(input.operation, workspace);
  try { await input.authority(); } catch (error) { throw refusal("authority", error instanceof AgentXError ? error : agentXError("STALE_FENCE", "publication authority changed before credential release")); }
  return { location: location!, workspace: workspace! };
}

/** One slot of the operation's count, or a refusal: why it was not taken is told apart (the workspace moved, a stop since the read, or the cap). */
async function slotOrRefusal(context: GitExchangeContext, input: GitExchangeInput, location: Located, workspace: WorkspaceRecord, claims: Claims): Promise<number> {
  const cap = REPOSITORY_EXCHANGES_PER_REPOSITORY * new Set(claims.repositories.map((repository) => repository.repositoryUrl)).size;
  const slot = await takeSlot(context, location, input.operation, cap);
  if ("count" in slot) return slot.count;
  if (slot.refused === "workspace") throw refusal("stale", agentXError("STALE_FENCE", EXCHANGE_STALE_WORDS));
  const now = fromDocument<OperationRecord>(await context.flow.store.get(location.operationKey(input.operation.id)));
  if (now === undefined || !LIVE_STATUSES.has(now.status)) requireLive(now ?? { ...input.operation, status: "INTERRUPTED" }, workspace);
  throw refusal("limit", agentXError("FORBIDDEN", EXCHANGE_LIMIT_WORDS));
}

/** Recorded before the credential is minted. A push that cannot be recorded is refused; a clone goes on (the line says the record failed). Returns whether the clone's record failed. */
async function requestedOrRefusal(context: GitExchangeContext, input: GitExchangeInput, workspace: WorkspaceRecord, grantId: string, count: number): Promise<boolean> {
  const push = input.access === "push";
  try { await recordUse(context, "repository_credential.requested", input.operation, workspace, input, grantId, count, push ? headBranchOf(input.operation) : undefined); } catch {
    if (push) throw refusal("audit", agentXError("RUNTIME_UNAVAILABLE", EXCHANGE_AUDIT_WORDS));
    return true;
  }
  return false;
}

/** The credential. A failure to mint it is a refusal of its own (a host fault is not a bug), in fixed words. */
async function minted(context: GitExchangeContext, input: GitExchangeInput): Promise<RepositoryCredential> {
  try { return await context.grants.exchange(input.grant, { workspaceId: input.workspaceId, operationId: input.operationId, credentialRef: input.credentialRef, repositoryUrl: input.repositoryUrl, access: input.access }); } catch (error) {
    throw refusal("mint", error instanceof AgentXError ? error : agentXError("RUNTIME_UNAVAILABLE", EXCHANGE_AUDIT_WORDS));
  }
}

/** The clone or push credential for the repository the request names, or a refusal in fixed words. Every outcome is one log line. */
export async function exchangeGitCredential(context: GitExchangeContext, input: GitExchangeInput): Promise<RepositoryCredential> {
  const branch = headBranchOf(input.operation);
  const line: Record<string, unknown> = { component: "callbacks", workspaceId: input.workspaceId, operationId: input.operationId, kind: input.access, ...(branch === undefined ? {} : { headBranch: branch }) };
  let taken: { location: Located } | undefined;
  try {
    const claims = checkedGrant(context, input, line);
    const { location, workspace } = await checkedLive(context, input);
    const count = await slotOrRefusal(context, input, location, workspace, claims);
    taken = { location };
    line["count"] = count;
    if (await requestedOrRefusal(context, input, workspace, claims.grantId, count)) line["auditFailed"] = true;
    const credential = await minted(context, input);
    // The credential is out: say so (best effort; the request row above is the one that held the credential back).
    try { await recordUse(context, "repository_credential.issued", input.operation, workspace, input, claims.grantId, count, input.access === "push" ? branch : undefined); } catch { line["auditFailed"] = true; }
    context.flow.log?.({ ...line, event: "repository.credential_issued", outcome: "issued" });
    return credential;
  } catch (error) {
    // A slot spent for a request whose record or mint failed is given back: nothing was handed out.
    const reason = reasonOf(error);
    if (taken !== undefined && (reason === "audit" || reason === "mint")) await giveSlotBack(context, taken.location, input.operation);
    // A grant that did not verify has no id in the line, and a request the grant does not name has no repository.
    context.flow.log?.({ ...line, event: "repository.credential_refused", outcome: "refused", reason: reason ?? "failed" });
    throw error;
  }
}

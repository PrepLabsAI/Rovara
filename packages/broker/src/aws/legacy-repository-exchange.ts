// The LEGACY Git credential exchange (aws/broker.ts, for a workspace the core does not own): the same rules as the core's (services/repository-exchange.ts), over the legacy records.
//   - the operation is live: accepted, dispatching or running. A stop (CANCEL_REQUESTED) and an end both refuse, and so does a closing workspace;
//   - a push's authority is checked by the caller (`authority`): a workflow publication's candidate, and now also a maintain and a publish with no candidate;
//   - the same count, `repositoryCredentialCount` on the operation, 4 per repository the grant names;
//   - every exchange is one log line with the grant's id (a short hash of its nonce), never the grant, its nonce or the credential.
// Audit: the legacy broker has no audit ledger, so no audit row is written here; the line is the record. The route serves only operations of workspaces the core does not own, and goes with the legacy flow.
import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AgentXError, agentXError } from "@agentx/contracts";
import { grantCovers, type RepositoryAccess, type RepositoryCredential, type RepositoryGrantService } from "../repository-access.js";
import { EXCHANGE_AUDIT_WORDS, EXCHANGE_CLOSING_WORDS, EXCHANGE_ENDED_WORDS, EXCHANGE_LIMIT_WORDS, EXCHANGE_STOPPING_WORDS, REPOSITORY_EXCHANGES_PER_REPOSITORY, repositoryNameOf, type ExchangeRefusal } from "../services/repository-exchange.js";
import { isConditional } from "./broker-shared.js";
import { operationKey } from "./cancellation.js";

const LIVE_STATUSES: ReadonlySet<string> = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);
const ENDED_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const;

export interface LegacyExchangeContext {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
  grants: Pick<RepositoryGrantService, "exchange" | "inspect">;
  log(entry: Record<string, unknown>): void;
}

export interface LegacyExchangeInput {
  grant: string;
  workspaceId: string;
  operationId: string;
  operation: { status: string; fence: number; kind: string; publication?: { headBranch?: string } | undefined; maintenance?: { headBranch?: string } | undefined };
  credentialRef: string;
  repositoryUrl: string;
  access: RepositoryAccess;
  /** The workspace is closing or closed. */
  closing(): Promise<boolean>;
  /** The authority the push was started with is still current (and, for a clone, whatever the legacy route always checked). Throws when it is not. */
  authority(): Promise<void>;
  /** The company's GitHub binding for the repository (a clone or a push). Throws when it is not bound. */
  binding(): Promise<void>;
}

const refusal = (reason: ExchangeRefusal, error: AgentXError): AgentXError => Object.assign(error, { exchangeRefusal: reason });
const reasonOf = (error: unknown): ExchangeRefusal | undefined => (typeof error === "object" && error !== null ? (error as { exchangeRefusal?: ExchangeRefusal }).exchangeRefusal : undefined);

/** One exchange against the operation's count, taken only while the operation is still live. Returns the new count, or undefined when the condition did not hold. */
async function takeSlot(context: LegacyExchangeContext, input: LegacyExchangeInput, cap: number): Promise<number | undefined> {
  const stopped = ["CANCEL_REQUESTED", ...ENDED_STATUSES];
  try {
    const answer = await context.documentClient.send(new UpdateCommand({
      TableName: context.tableName,
      Key: operationKey(input.workspaceId, input.operationId),
      UpdateExpression: "ADD #count :one",
      ConditionExpression: `attribute_exists(pk) AND NOT (${stopped.map((_status, index) => `#status = :s${String(index)}`).join(" OR ")}) AND (attribute_not_exists(#count) OR #count < :cap)`,
      ExpressionAttributeNames: { "#count": "repositoryCredentialCount", "#status": "status" },
      ExpressionAttributeValues: { ":one": 1, ":cap": cap, ...Object.fromEntries(stopped.map((status, index) => [`:s${String(index)}`, status])) },
      ReturnValues: "UPDATED_NEW",
    }));
    const count = (answer.Attributes as { repositoryCredentialCount?: unknown } | undefined)?.repositoryCredentialCount;
    return typeof count === "number" ? count : 1;
  } catch (error) {
    if (isConditional(error)) return undefined;
    throw error;
  }
}

/** Gives a slot back when the credential was not minted after all. Best effort. */
async function giveSlotBack(context: LegacyExchangeContext, input: LegacyExchangeInput): Promise<void> {
  try {
    await context.documentClient.send(new UpdateCommand({
      TableName: context.tableName, Key: operationKey(input.workspaceId, input.operationId), UpdateExpression: "ADD #count :minus",
      ConditionExpression: "attribute_exists(pk) AND #count > :zero", ExpressionAttributeNames: { "#count": "repositoryCredentialCount" }, ExpressionAttributeValues: { ":minus": -1, ":zero": 0 },
    }));
  } catch { /* the count stays spent: the cap only gets stricter */ }
}

type Claims = ReturnType<LegacyExchangeContext["grants"]["inspect"]>;

/** The grant verifies and names this request; its id and the repository's name (from the grant, never the request) go into the line as soon as they are known. */
function checkedGrant(context: LegacyExchangeContext, input: LegacyExchangeInput, line: Record<string, unknown>): Claims {
  let claims: Claims;
  try { claims = context.grants.inspect(input.grant); } catch (error) { throw refusal("grant", error instanceof AgentXError ? error : agentXError("FORBIDDEN", "invalid repository grant")); }
  line["grantId"] = claims.grantId;
  if (!grantCovers(claims, input)) throw refusal("not-covered", agentXError("FORBIDDEN", "repository credential grant does not cover this request"));
  const name = repositoryNameOf(input.repositoryUrl);
  if (name !== undefined) line["repository"] = name;
  return claims;
}

/** The operation is live, its workspace is not closing, its authority is current and the company's GitHub binding holds. */
async function checkedLive(input: LegacyExchangeInput): Promise<void> {
  const { operation } = input;
  if (operation.status === "CANCEL_REQUESTED") throw refusal("stopping", agentXError("FORBIDDEN", EXCHANGE_STOPPING_WORDS));
  if (!LIVE_STATUSES.has(operation.status)) throw refusal("ended", agentXError("FORBIDDEN", EXCHANGE_ENDED_WORDS));
  if (await input.closing()) throw refusal("closing", agentXError("FORBIDDEN", EXCHANGE_CLOSING_WORDS));
  try { await input.authority(); } catch (error) { throw refusal("authority", error instanceof AgentXError ? error : agentXError("CALLBACK_FORBIDDEN", "workflow publication authority is stale")); }
  await input.binding();
}

/** The clone or push credential for the repository the request names, or a refusal in fixed words. Every outcome is one log line. */
export async function exchangeLegacyGitCredential(context: LegacyExchangeContext, input: LegacyExchangeInput): Promise<RepositoryCredential> {
  const { operation } = input;
  const branch = operation.publication?.headBranch ?? operation.maintenance?.headBranch;
  const line: Record<string, unknown> = { component: "broker", workspaceId: input.workspaceId, operationId: input.operationId, kind: input.access, engine: "legacy", ...(branch === undefined ? {} : { headBranch: branch }) };
  let taken = false;
  try {
    const claims = checkedGrant(context, input, line);
    await checkedLive(input);
    const cap = REPOSITORY_EXCHANGES_PER_REPOSITORY * new Set(claims.repositories.map((repository) => repository.repositoryUrl)).size;
    const count = await takeSlot(context, input, cap);
    if (count === undefined) throw refusal("limit", agentXError("FORBIDDEN", EXCHANGE_LIMIT_WORDS));
    taken = true;
    line["count"] = count;
    let credential: RepositoryCredential;
    try { credential = await context.grants.exchange(input.grant, { workspaceId: input.workspaceId, operationId: input.operationId, credentialRef: input.credentialRef, repositoryUrl: input.repositoryUrl, access: input.access }); } catch (error) {
      throw refusal("mint", error instanceof AgentXError ? error : agentXError("RUNTIME_UNAVAILABLE", EXCHANGE_AUDIT_WORDS));
    }
    context.log({ ...line, event: "repository.credential_issued", outcome: "issued" });
    return credential;
  } catch (error) {
    // A slot spent for a request whose mint failed is given back: nothing was handed out.
    if (taken && reasonOf(error) === "mint") await giveSlotBack(context, input);
    context.log({ ...line, event: "repository.credential_refused", outcome: "refused", reason: reasonOf(error) ?? "failed" });
    throw error;
  }
}

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { inspectE2ERepository, readE2EApplicationProjectContract, type E2EApplicationAccountDefinition, type E2EApplicationProjectContract, type E2ERuntimeAccountRef, type E2ESourceSnapshot } from "@agentx/contracts";
import {
  E2EAccountRegistryError, accountDefinitionRow, accountLatestRow, e2eAccountDefinitionKey, e2eAccountLatestKey, e2eAccountRevisionPrefix, parseAccountDefinitionRow,
  parseAccountEntry, planSyntheticAccountWrites, type E2EAccountRegistryEntry, type E2EAccountRegistryWrite,
} from "../e2e/application-account-registry.js";
import { getItem, type StateTable } from "./cancellation.js";
import type { TransactItems } from "./developer-task-actions.js";

/**
 * The reads and writes of the account registry (`e2e/application-account-registry.ts` names the rows). It lives in the broker's one table: no table and no index of its own.
 */

/** How many older revisions of an account are read when the latest was registered for a different contract than the caller's. */
const EARLIER_REVISIONS_READ = 6;

/** An account whose rows cannot be read; `setupApprovedAt` is what its pointer still records of the setup that wrote it, when that much is readable. */
export type CorruptAccount = { applicationId: string; profileId: string; setupApprovedAt?: string };

/**
 * The registered accounts for the given (application, profile) pairs, read by key and parsed. A pair with nothing registered is absent from `entries`; a pair whose rows
 * cannot be read is listed in `corrupt` and nowhere else, so one bad row never hides the other accounts. `earlierFor` says whether a latest definition is for a different
 * contract than the caller's, in which case the older revisions are read too (`entry.earlier`).
 */
export async function readAccountRegistryEntries(dependencies: StateTable, projectId: string, pairs: readonly { applicationId: string; profileId: string }[],
  options: { earlierFor?: (latest: E2EApplicationAccountDefinition) => boolean } = {}): Promise<{ entries: E2EAccountRegistryEntry[]; corrupt: CorruptAccount[] }> {
  const unique = [...new Map(pairs.map((pair) => [`${pair.applicationId}\0${pair.profileId}`, pair])).values()];
  const entries: E2EAccountRegistryEntry[] = [];
  const corrupt: CorruptAccount[] = [];
  for (const { applicationId, profileId } of unique) {
    const latestRow = await getItem<Record<string, unknown>>(dependencies, e2eAccountLatestKey(projectId, applicationId, profileId));
    if (latestRow === undefined) continue;
    try {
      const definitionRow = await getItem<Record<string, unknown>>(dependencies, e2eAccountDefinitionKey(projectId, applicationId, profileId, Number(latestRow.revision)));
      const entry = parseAccountEntry(projectId, applicationId, profileId, latestRow, definitionRow);
      if (options.earlierFor?.(entry.definition) !== true) { entries.push(entry); continue; }
      const earlier: E2EApplicationAccountDefinition[] = [];
      for (let revision = entry.definition.revision - 1; revision >= 1 && revision >= entry.definition.revision - EARLIER_REVISIONS_READ; revision -= 1) {
        const definition = parseAccountDefinitionRow(projectId, applicationId, profileId, revision,
          await getItem<Record<string, unknown>>(dependencies, e2eAccountDefinitionKey(projectId, applicationId, profileId, revision)));
        if (definition !== undefined) earlier.push(definition);
      }
      entries.push({ ...entry, earlier });
    } catch (error) {
      if (!(error instanceof E2EAccountRegistryError)) throw error;
      const recorded = latestRow.setupApprovedAt;
      corrupt.push({ applicationId, profileId, ...(typeof recorded === "string" && !Number.isNaN(Date.parse(recorded)) ? { setupApprovedAt: recorded } : {}) });
    }
  }
  return { entries, corrupt };
}

/**
 * The conditions that keep each account ref an approval (or a verdict) stands on as it was read, until the transaction that records it commits: the account's pointer must
 * still name exactly that revision and digest. A ref with no registered account (an M1.2 record) has nothing to fence.
 */
export function accountRegistryFences(input: { tableName: string; projectId: string; refs: readonly E2ERuntimeAccountRef[]; entries: readonly E2EAccountRegistryEntry[] }): TransactItems {
  return input.refs.flatMap((ref) => {
    const entry = input.entries.find((item) => item.definition.applicationId === ref.applicationId && item.definition.profileId === ref.profileId);
    if (entry === undefined) return [];
    return [{ ConditionCheck: { TableName: input.tableName, Key: e2eAccountLatestKey(input.projectId, ref.applicationId, ref.profileId),
      ConditionExpression: "entityType = :entity AND revision = :revision AND definitionDigest = :digest",
      ExpressionAttributeValues: { ":entity": "E2E_ACCOUNT_LATEST", ":revision": entry.latest.revision, ":digest": entry.latest.definitionDigest } } }];
  });
}

function writeItems(tableName: string, projectId: string, write: E2EAccountRegistryWrite, setup: { approvedAt: string; proposalSha256: string }): TransactItems {
  const { definition, latest, previousRevision } = write;
  const row = accountLatestRow(projectId, definition.applicationId, definition.profileId, latest, { approvedAt: write.setupApprovedAt ?? setup.approvedAt, proposalSha256: setup.proposalSha256 });
  const pointer = { Put: { TableName: tableName, Item: row,
      ...(write.repair === true ? {}
        : previousRevision === null ? { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }
          : { ConditionExpression: "revision = :previous", ExpressionAttributeValues: { ":previous": previousRevision } }) } };
  // A raised pointer writes no definition: the one it names is already there.
  if (write.touch === true) return [pointer];
  return [{ Put: { TableName: tableName, Item: accountDefinitionRow(projectId, definition), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } }, pointer];
}

/** The highest revision with a definition row for an account, and the revision an unreadable pointer claims (if it claims a whole number); 0 for neither. */
async function highestRevision(dependencies: StateTable, projectId: string, applicationId: string, profileId: string): Promise<number> {
  const { pk, prefix } = e2eAccountRevisionPrefix(projectId, applicationId, profileId);
  let highest = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const response = await dependencies.documentClient.send(new QueryCommand({ TableName: dependencies.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }));
    for (const item of response.Items ?? []) highest = Math.max(highest, Number(String(item.sk).slice(prefix.length)) || 0);
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  const raw = await getItem<Record<string, unknown>>(dependencies, e2eAccountLatestKey(projectId, applicationId, profileId));
  const claimed = Number(raw?.revision);
  return Math.max(highest, Number.isSafeInteger(claimed) && claimed > 0 ? claimed : 0);
}

/**
 * What registering a setup writes (owner decision D5): the synthetic account definitions of every application whose source carries a project contract, as transaction items
 * for the same transaction that stores the project revision. Per `synthetic-test` profile it is revision n+1 when the definition changed or is close to expiring, nothing
 * when it did not, and never a change from an older setup approval than the one that wrote the current definition (`setup-superseded`). Each write is conditional on the
 * revision it replaces, so two registrations racing for one account write one revision between them; the loser plans again and finds nothing left to write. An account
 * whose rows cannot be read is written over, which is how it is repaired. `planKey` identifies the plan, so a caller can tell a conflict that changed it from one that did not.
 */
export async function planSetupAccountWrites(dependencies: StateTable, input: { projectId: string; snapshot: E2ESourceSnapshot; setup: { approvedAt: string; proposalSha256: string }; now: number }):
  Promise<{ items: TransactItems; written: number; planKey: string }> {
  const inspection = inspectE2ERepository(input.snapshot, input.snapshot.candidate).inspection;
  const items: TransactItems = [];
  const planned: string[] = [];
  for (const application of inspection.applications) {
    let contract: E2EApplicationProjectContract | null;
    // An application whose contract cannot be read gets no accounts; planning and approval then say the account is not registered.
    try { contract = readE2EApplicationProjectContract(input.snapshot, application.applicationId); } catch { continue; }
    if (contract === null) continue;
    const pairs = contract.accountProfiles.filter((profile) => profile.scope === "synthetic-test").map((profile) => ({ applicationId: application.applicationId, profileId: profile.profileId }));
    const read = await readAccountRegistryEntries(dependencies, input.projectId, pairs);
    const repairs: Array<{ applicationId: string; profileId: string; nextRevision: number }> = [];
    for (const pair of read.corrupt) repairs.push({ ...pair, nextRevision: (await highestRevision(dependencies, input.projectId, pair.applicationId, pair.profileId)) + 1 });
    const writes = planSyntheticAccountWrites({ contract, applicationId: application.applicationId, prior: read.entries, now: input.now, setup: { approvedAt: input.setup.approvedAt }, repairs });
    for (const write of writes) {
      items.push(...writeItems(dependencies.tableName, input.projectId, write, input.setup));
      planned.push(`${write.definition.applicationId}\0${write.definition.profileId}\0${write.definition.revision}${write.touch === true ? "\0touch" : ""}`);
    }
  }
  return { items, written: planned.length, planKey: planned.sort().join("\n") };
}

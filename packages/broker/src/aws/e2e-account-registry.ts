import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { inspectE2ERepository, readE2EApplicationProjectContract, type E2EApplicationProjectContract, type E2ERuntimeAccountRef, type E2ESourceSnapshot } from "@agentx/contracts";
import {
  accountDefinitionRow, accountLatestRow, e2eAccountDefinitionKey, e2eAccountLatestKey, parseAccountEntry, planSyntheticAccountWrites,
  type E2EAccountRegistryEntry, type E2EAccountRegistryWrite,
} from "../e2e/application-account-registry.js";
import { getItem, type StateTable } from "./cancellation.js";
import { isConditional } from "./broker-shared.js";
import type { TransactItems } from "./developer-task-actions.js";

/**
 * The reads and writes of the account registry (`e2e/application-account-registry.ts` names the rows). It lives in the broker's one table: no table and no index of its own.
 */

/** The registered accounts for the given (application, profile) pairs, read by key and parsed; a pair with nothing registered is simply absent from the result. */
export async function readAccountRegistryEntries(dependencies: StateTable, projectId: string, pairs: readonly { applicationId: string; profileId: string }[]): Promise<E2EAccountRegistryEntry[]> {
  const unique = [...new Map(pairs.map((pair) => [`${pair.applicationId}\0${pair.profileId}`, pair])).values()];
  const entries: E2EAccountRegistryEntry[] = [];
  for (const { applicationId, profileId } of unique) {
    const latestRow = await getItem<Record<string, unknown>>(dependencies, e2eAccountLatestKey(projectId, applicationId, profileId));
    if (latestRow === undefined) continue;
    const definitionRow = await getItem<Record<string, unknown>>(dependencies, e2eAccountDefinitionKey(projectId, applicationId, profileId, Number(latestRow.revision)));
    entries.push(parseAccountEntry(projectId, applicationId, profileId, latestRow, definitionRow));
  }
  return entries;
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

const WRITES_PER_TRANSACTION = 40;
const WRITE_ATTEMPTS = 3;

function writeItems(tableName: string, projectId: string, write: E2EAccountRegistryWrite): TransactItems {
  const { definition, latest, previousRevision } = write;
  return [
    { Put: { TableName: tableName, Item: accountDefinitionRow(projectId, definition), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    { Put: { TableName: tableName, Item: accountLatestRow(projectId, definition.applicationId, definition.profileId, latest),
      ...(previousRevision === null ? { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }
        : { ConditionExpression: "revision = :previous", ExpressionAttributeValues: { ":previous": previousRevision } }) } },
  ];
}

/**
 * Approving a setup writes the synthetic account definitions of every application whose source carries a project contract (owner decision D5): per `synthetic-test`
 * profile, revision n+1 when its definition changed, nothing when it did not. Each write is conditional on the revision it replaces, so two approvals racing for one
 * account write one revision between them; the loser reads again and finds nothing left to write. It is safe to run again for a setup that was already approved.
 */
export async function writeSetupAccountDefinitions(dependencies: StateTable, input: { projectId: string; snapshot: E2ESourceSnapshot; now: number }): Promise<{ written: number }> {
  const inspection = inspectE2ERepository(input.snapshot, input.snapshot.candidate).inspection;
  let written = 0;
  for (const application of inspection.applications) {
    let contract: E2EApplicationProjectContract | null;
    // An application whose contract cannot be read gets no accounts; planning and approval then say the account is not registered.
    try { contract = readE2EApplicationProjectContract(input.snapshot, application.applicationId); } catch { continue; }
    if (contract === null) continue;
    for (let attempt = 1; ; attempt += 1) {
      const pairs = contract.accountProfiles.filter((profile) => profile.scope === "synthetic-test").map((profile) => ({ applicationId: application.applicationId, profileId: profile.profileId }));
      const writes = planSyntheticAccountWrites({ contract, applicationId: application.applicationId, prior: await readAccountRegistryEntries(dependencies, input.projectId, pairs), now: input.now });
      if (writes.length === 0) break;
      try {
        for (let start = 0; start < writes.length; start += WRITES_PER_TRANSACTION) {
          await dependencies.documentClient.send(new TransactWriteCommand({
            TransactItems: writes.slice(start, start + WRITES_PER_TRANSACTION).flatMap((write) => writeItems(dependencies.tableName, input.projectId, write)) }));
        }
        written += writes.length;
        break;
      } catch (error) {
        if (!isConditional(error) || attempt === WRITE_ATTEMPTS) throw error;
      }
    }
  }
  return { written };
}

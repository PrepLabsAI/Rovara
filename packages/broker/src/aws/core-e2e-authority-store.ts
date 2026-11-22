// Hosted-only physical routing of authority checks. The portable DocumentStore contract stays single-store.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDocumentStore, fromWire, fromWireItem } from "@rovara/aws-adapters";
import { DocumentStoreError, E2ECreatorAuthoritySchema, OrgRoleSchema, when, type DocumentKey, type DocumentStore, type OrgId, type TransactItem } from "@agentx/contracts";
import { combinedChecks } from "../core/task-flow/transaction-checks.js";
import { grantKeyFor } from "./company-layout.js";
import { ownPartitionRow } from "./company-check.js";
import { codeRetentionStore } from "../core-host/retention.js";
import type { HostedCreatorAuthority } from "../core/e2e/hosted-authority.js";

type Inputs = { documentClient: { send(command: unknown): Promise<unknown> }; stateTableName: string; signInTableName: string | undefined };
const identityKey = (key: DocumentKey) => /^(?:DEVELOPER#[^#\s]+)$/u.test(key.pk) && key.sk === "META"
  || /^COMPANY_MEMBER#[^#\s]+$/u.test(key.pk) && key.sk === "COMPANY";
const keyOf = (item: TransactItem): DocumentKey => item.kind === "put" ? item.item : item.key;

/** One TransactWriteItems, including sign-in conditions and State writes. No read-then-write substitute or shadow identity. */
export function hostedAuthorityStore(store: DocumentStore, inputs: Inputs): DocumentStore {
  const transactions = codeRetentionStore(new DynamoDocumentStore({ tableName: inputs.stateTableName, indexes: store.indexes, client: {
    async send(command) {
      if (!(command instanceof TransactWriteItemsCommand)) throw new DocumentStoreError("invalid_request", "the hosted authority adapter accepts transactions only");
      const steps = command.input.TransactItems!.map((step) => {
        const action = step.Put ?? step.Update ?? step.Delete ?? step.ConditionCheck!;
        const key = fromWireItem("Item" in action ? action.Item! : action.Key!);
        const signin = identityKey(key);
        if (signin && (step.ConditionCheck === undefined || !inputs.signInTableName)) throw new DocumentStoreError("unavailable", "the sign-in authority condition cannot be committed");
        const decoded = { ...action, TableName: signin ? inputs.signInTableName! : inputs.stateTableName,
          ...("Item" in action ? { Item: fromWireItem(action.Item!) } : { Key: fromWireItem(action.Key!) }),
          ...(action.ExpressionAttributeValues === undefined ? {} : { ExpressionAttributeValues: Object.fromEntries(Object.entries(action.ExpressionAttributeValues).map(([name, value]) => [name, fromWire(value, name)])) }) };
        return { [step.Put ? "Put" : step.Update ? "Update" : step.Delete ? "Delete" : "ConditionCheck"]: decoded };
      });
      return inputs.documentClient.send(new TransactWriteCommand({ ...command.input, TransactItems: steps }));
    },
  } }));
  return new Proxy(store, { get(target, property) {
    if (property === "transact") return async (items: readonly TransactItem[]) => {
      for (const item of items) if (identityKey(keyOf(item)) && item.kind !== "check") throw new DocumentStoreError("invalid_request", "hosted authority rows are condition-only");
      const combined = combinedChecks(items);
      return combined.some((item) => identityKey(keyOf(item))) ? transactions.transact(combined) : target.transact(combined);
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } });
}

/** Re-read identity, company membership/role and the exact company-scoped project grant used by hosted access. */
export async function hostedCreatorAuthority(inputs: Inputs & { companyId: OrgId }, task: { companyId: string; developerId: string; project: string }): Promise<HostedCreatorAuthority | undefined> {
  if (!inputs.signInTableName || task.companyId !== inputs.companyId || !task.developerId || /[#\s]/u.test(task.developerId)) return undefined;
  const read = async (table: string, key: DocumentKey) => (await inputs.documentClient.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  const developerKey = { pk: `DEVELOPER#${task.developerId}`, sk: "META" };
  const membershipKey = { pk: `COMPANY_MEMBER#${task.developerId}`, sk: "COMPANY" };
  const grantKey = grantKeyFor(inputs.companyId, task.developerId, task.project);
  const [developer, member, grant] = await Promise.all([read(inputs.signInTableName, developerKey), read(inputs.signInTableName, membershipKey), read(inputs.stateTableName, grantKey)]);
  if (developer?.["entityType"] !== "DEVELOPER" || developer["revoked"] !== false || member?.["entityType"] !== "COMPANY_MEMBERSHIP"
    || member["personId"] !== task.developerId || member["companyId"] !== inputs.companyId || member["revokedAt"] !== undefined || !OrgRoleSchema.safeParse(member["role"]).success
    || grant?.["entityType"] !== "MEMBERSHIP" || grant["ownerKey"] !== task.developerId || grant["projectName"] !== task.project || !ownPartitionRow(grant, inputs.companyId)) return undefined;
  const proof = E2ECreatorAuthoritySchema.safeParse({ kind: "direct-membership", developerId: task.developerId, project: task.project, role: grant["role"], grantId: grant["grantId"] });
  if (!proof.success) return undefined;
  return { companyId: inputs.companyId, proof: proof.data, items: [
    { kind: "check", key: developerKey, condition: when.and(when.eq("entityType", "DEVELOPER"), when.eq("revoked", false)) },
    { kind: "check", key: membershipKey, condition: when.and(when.eq("entityType", "COMPANY_MEMBERSHIP"), when.eq("personId", task.developerId), when.eq("companyId", inputs.companyId), when.eq("role", member["role"] as string), when.notExists("revokedAt")) },
    { kind: "check", key: grantKey, condition: when.and(when.eq("entityType", "MEMBERSHIP"), when.eq("ownerKey", task.developerId), when.eq("projectName", task.project), when.eq("role", grant["role"] as string), when.eq("grantId", grant["grantId"] as string), ...(grant["companyId"] === undefined ? [when.notExists("companyId")] : [when.eq("companyId", inputs.companyId)]), ...(grant["orgId"] === undefined ? [when.notExists("orgId")] : [when.eq("orgId", inputs.companyId)])) },
  ] };
}

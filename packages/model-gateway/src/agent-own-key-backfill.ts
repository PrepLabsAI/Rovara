// DEC 254zzz279 (C-1). Operator-only migration, never imported by the serving process.
// Reads parsed connection metadata only: no key row, seal, fingerprint, KMS or provider call.
import { randomUUID } from "node:crypto";
import { DynamoProductKeyTable, productKeyTableKey } from "./dynamo-product-keys.js";
import { TransactionRefused, type Dynamo, type Key, type TransactAction } from "./dynamo.js";
import { COMPANY } from "./model-gateway-token.js";
import { ProductKeyStore } from "./product-keys.js";
import { ProductKeySealer } from "./product-seal.js";

export interface BackfillInput { db: Dynamo; companyTable: string; productTable: string; issuer: string; companies: readonly string[] }
interface Candidate { companyId: string; source: "anthropic_key" | "bedrock_byo"; documents: Array<{ key: Key; version: number }> }
export interface BackfillPlan { issuer: string; companyTable: string; productTable: string; candidates: Candidate[] }
const forbidden = async (): Promise<never> => { throw new Error("backfill cannot access secrets"); };

/** Full read-only preview. A failed read/parse aborts before the caller can apply any of the plan. */
export async function planAgentOwnKeyBackfill(input: BackfillInput): Promise<BackfillPlan> {
  if (!input.issuer.startsWith("https://") || input.companies.some((cid) => !COMPANY.test(cid))) throw new Error("invalid backfill scope");
  const plan: BackfillPlan = { issuer: input.issuer, companyTable: input.companyTable, productTable: input.productTable, candidates: [] };
  const metadata = new DynamoProductKeyTable(input.db, input.productTable);
  for (const companyId of [...new Set(input.companies)].sort()) {
    // Any existing row, including a damaged one, belongs to the company. Never replace it.
    if (await input.db.get(input.companyTable, { pk: `COMPANY#${companyId}`, sk: "AGENT_AI" }) !== undefined) continue;
    const documents: Candidate["documents"] = [];
    const store = new ProductKeyStore({
      table: {
        async get(key) {
          const tableKey = productKeyTableKey(key);
          if (tableKey.sk !== "doc#_learning" && tableKey.sk !== "doc#_company") throw new Error("backfill reads metadata only");
          const row = await metadata.get(key);
          documents.push({ key: tableKey, version: row?.version ?? 0 });
          return row;
        },
        transact: forbidden,
      },
      sealer: new ProductKeySealer({ generateDataKey: forbidden, unwrapDataKey: forbidden }), fingerprint: forbidden,
    });
    // Preserve the former own-key precedence: Anthropic before the company's Bedrock.
    const anthropic = await store.learningSource(input.issuer, companyId, "anthropic");
    const bedrock = anthropic === undefined ? await store.companyBedrock(input.issuer, companyId) : undefined;
    const source = anthropic !== undefined ? "anthropic_key" : bedrock !== undefined ? "bedrock_byo" : undefined;
    if (source !== undefined) plan.candidates.push({ companyId, source, documents });
  }
  return plan;
}

/** Apply exactly the preview's missing choices. Concurrent choice/connection changes lose the condition, never overwrite. */
export async function applyAgentOwnKeyBackfill(input: BackfillInput, plan: BackfillPlan): Promise<{ written: number; conflicted: number }> {
  if (plan.issuer !== input.issuer || plan.companyTable !== input.companyTable || plan.productTable !== input.productTable) throw new Error("backfill scope changed");
  let written = 0, conflicted = 0;
  for (const candidate of plan.candidates) {
    const actions: TransactAction[] = candidate.documents.map(({ key, version }) => ({
      kind: "Check", table: input.productTable, key,
      condition: (e) => version === 0 ? `attribute_not_exists(${e.name("pk")})` : `${e.name("v")} = ${e.value(version)}`,
    }));
    actions.push({
      kind: "Put", table: input.companyTable,
      item: { pk: `COMPANY#${candidate.companyId}`, sk: "AGENT_AI", companyId: candidate.companyId, source: candidate.source, version: 1, updatedAt: new Date().toISOString(), updatedBy: "backfill:DEC254zzz279" },
      condition: (e) => `attribute_not_exists(${e.name("pk")})`,
    });
    try { await input.db.transact(actions, randomUUID()); written++; }
    catch (error) {
      if (!(error instanceof TransactionRefused) || !error.reasons.some((reason) => reason === "ConditionalCheckFailed")) throw error;
      conflicted++;
    }
  }
  return { written, conflicted };
}

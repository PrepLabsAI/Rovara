import { IMPLICIT_COMPANY_ID, type RunPrice } from "@agentx/contracts";
export const runPriceFor = (model: string, now = Date.now()): RunPrice => ({ companyId: IMPLICIT_COMPANY_ID, model, provider: "bedrock", sourceId: "operator-ai", connectionRevision: "r1", catalogModel: "zai.glm-5", snapshotHash: "a".repeat(64), snapshotVersion: 7,
  inputUsdPerMillion: 10, outputUsdPerMillion: 40, cacheWriteUsdPerMillion: 30, cacheReadUsdPerMillion: 2, expiresAt: now + 300_000 });

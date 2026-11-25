import { readFileSync } from "node:fs";
import type { ChargeReceiptV1 } from "../../packages/model-gateway/src/charge-receipt.js";
export function chargeReceipt(patch: Partial<ChargeReceiptV1> = {}): ChargeReceiptV1 {
  const base = (JSON.parse(readFileSync(new URL("../../contracts/shared/charge-receipt.v1.json", import.meta.url), "utf8")) as { examples: ChargeReceiptV1[] }).examples[0]!;
  return { ...base, ...patch };
}

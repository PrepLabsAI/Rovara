// DEC 192a: agent-written replies only retain an existing proof when F9 agrees on every proving item.
import { RealModelCheckSchema, TestProofSchema, realModelPassed, type TestProof } from "@agentx/contracts";

export type AgentRepliesStatus = "confirmed" | "unconfirmed" | "disagreed";

/** Validate shared inputs once, then index exact check/test pairs. All work is bounded by the two 200-item contracts. */
export function agentReplyStatuses(testProof: unknown, realRun: unknown): ReadonlyMap<string, AgentRepliesStatus> {
  const statuses = new Map<string, AgentRepliesStatus>();
  const proof = TestProofSchema.safeParse(testProof);
  const run = RealModelCheckSchema.safeParse(realRun);
  if (!proof.success || proof.data.status !== "checked" || !run.success || proof.data.candidateDigest !== run.data.candidateDigest) return statuses;
  const key = (checkId: string, test: string | undefined) => JSON.stringify([checkId, test]);
  const results = new Map(run.data.items.map((item) => [key(item.checkId, item.test), item]));
  const proving = new Map<string, TestProof["items"]>();
  for (const item of proof.data.items) {
    if (item.verdict !== "proves_change") continue;
    const items = proving.get(item.checkId) ?? [];
    items.push(item);
    proving.set(item.checkId, items);
  }
  for (const [checkId, items] of proving) {
    let missing = false;
    let failed = false;
    for (const item of items) {
      if ((item.granularity === "test") !== (item.test !== undefined)) { missing = true; continue; }
      const result = results.get(key(checkId, item.test));
      if (result?.result === "failed") failed = true;
      // Pass the already indexed singleton to the shared helper: no tests x all-results scan.
      else if (result === undefined || !realModelPassed({ ...run.data, items: [result] }, checkId, item.test)) missing = true;
    }
    statuses.set(checkId, failed ? "disagreed" : missing ? "unconfirmed" : "confirmed");
  }
  return statuses;
}

/** Unknown, missing or unreadable evidence has only this fixed refusal, never an exception or input text. */
export function agentRepliesStatus(input: unknown): AgentRepliesStatus {
  if (typeof input !== "object" || input === null || !("checkId" in input) || typeof input.checkId !== "string") return "unconfirmed";
  return agentReplyStatuses("testProof" in input ? input.testProof : undefined, "realRun" in input ? input.realRun : undefined).get(input.checkId) ?? "unconfirmed";
}

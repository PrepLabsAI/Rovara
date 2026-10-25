import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, type E2EReplayTrace } from "@agentx/contracts";
import { createOrdersExecutorPlan, type OrdersExecutorFixture } from "./e2e-orders-executor-fixture.js";

/**
 * Plans for an audit replay (Task 4.6b) without running anything: a synthetic recording that is valid by the contract and bound by its digest, and a replay plan built twice (a case id is
 * bound to the runtime row, so the first build tells the second which case the recording is for).
 */
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const FIXED_RUNTIME_DATING = Math.floor(Date.now() / 3_600_000) * 3_600_000;

export function syntheticRecording(caseId: string, stepIndex: number, options: { trace?: Record<string, unknown>; keyHash?: string } = {}): E2EReplayTrace {
  const keyHash = options.keyHash ?? sha(`cache key of ${caseId} step ${stepIndex}`);
  const trace = options.trace ?? { actions: [{ name: "tap", summary: "The tap action.", target: { role: "button", name: "Download orders", testId: "download-orders" } }],
    summary: "The recorded AI navigation concluded.", executor: { name: "rovara-e2e-agent", version: "1" }, startPath: "/", endPath: "/" };
  const file = JSON.stringify({ schemaVersion: "rovara-agent-trace-file/v1", keyHash, trace });
  return { caseId, stepIndex, keyHash, traceBase64: Buffer.from(file).toString("base64"),
    binding: { schemaVersion: "rovara-agent-trace/v1", runId: randomUUID(), caseId, stepIndex, traceSha256: sha(canonicalJson(trace)), ledgerSha256: sha("ledger"), actionCount: (trace["actions"] as unknown[]).length } };
}

/** The plan of a replay of a group that is its plan's one agent step, with a synthetic recording for it (or the given ones, built from the case id). */
export function replayPlanOf(build: (replay: { traces: E2EReplayTrace[] } | undefined) => OrdersExecutorFixture, recordings?: (caseId: string) => E2EReplayTrace[]): OrdersExecutorFixture {
  const first = build(undefined);
  const caseId = first.compiled.expectedCases[0]!.caseId;
  return build({ traces: recordings === undefined ? [syntheticRecording(caseId, 0)] : recordings(caseId) });
}
export { createOrdersExecutorPlan };

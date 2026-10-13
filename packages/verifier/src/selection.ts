import { E2EExecutionPlanSchema, canonicalJson, type E2EExecutionPlan, type E2EExpectedCase } from "@agentx/contracts";
import { upstreamE2ECaseIdentity } from "./identity.js";

export type E2ESelectionTuple = Readonly<{ caseId: string; compilerCaseIdentity: string; candidateResponseScope: "contained-candidate-process-response/v1"; requestProtocol: "supervisor-admitted-json-request/v1"; upstreamTestId: string; upstreamResultId: string; title: string; targetId: string; targetName: string; agent: "default"; disposition: "run" | "filtered" }>;
export type E2ESelectionPacket = Readonly<{ schemaVersion: 1; algorithm: "e2e-public-list-selection/v1"; planDigest: string; groupId: string; tuples: readonly E2ESelectionTuple[] }>;

export function createE2ESelectionPacket(planInput: E2EExecutionPlan, groupId: string, titleByCaseId: ReadonlyMap<string, string>, caseBindings: ReadonlyMap<string, { compilerCaseIdentity: string; candidateResponseScope: "contained-candidate-process-response/v1"; requestProtocol: "supervisor-admitted-json-request/v1" }>): E2ESelectionPacket {
  const plan = E2EExecutionPlanSchema.parse(planInput);
  const group = plan.groups.find((item) => item.groupId === groupId);
  if (!group || group.expectedCases.length === 0) throw new Error("selected execution group is absent or empty");
  const selected = group.expectedCases.map((item: E2EExpectedCase) => {
    const title = titleByCaseId.get(item.caseId);
    if (!title) throw new Error("generated title is missing for an expected case");
    const ids = upstreamE2ECaseIdentity(item, title);
    if (ids.upstreamTestId !== item.upstreamTestId) throw new Error("execution plan upstream test ID does not match the pinned public identity algorithm");
    const targetName = `contract-${item.targetId.slice("contract-".length)}`;
    return { item, upstreamTestId: ids.upstreamTestId, title };
  });
  const tuples = selected.flatMap(({ item, upstreamTestId, title }) => group.targetIds.map((targetId) => Object.freeze({ caseId: item.caseId, ...caseBindings.get(item.caseId)!, upstreamTestId, title,
    upstreamResultId: upstreamE2ECaseIdentity({ ...item, targetId }, titleByCaseId.get(item.caseId)!).upstreamResultId,
    targetId, targetName: `contract-${targetId.slice("contract-".length)}`, agent: "default" as const, disposition: targetId === item.targetId ? "run" as const : "filtered" as const })));
  const packet = { schemaVersion: 1 as const, algorithm: "e2e-public-list-selection/v1" as const, planDigest: plan.digest, groupId, tuples };
  const resultIds = tuples.map((tuple) => tuple.upstreamResultId);
  if (new Set(resultIds).size !== resultIds.length) throw new Error("duplicate public-list result identity");
  return Object.freeze({ ...packet, tuples: Object.freeze(tuples) });
}

export function compareE2EPublicList(packet: E2ESelectionPacket, listed: unknown): { selected: readonly E2ESelectionTuple[]; filtered: readonly E2ESelectionTuple[] } {
  if (listed === null || typeof listed !== "object") throw new Error("public list result is not an object");
  const pairs = (listed as { pairs?: unknown }).pairs;
  const unmatched = (listed as { unmatched?: unknown }).unmatched;
  if (!Array.isArray(pairs) || !Array.isArray(unmatched) || unmatched.length !== 0) throw new Error("public list result is malformed or contains unmatched files");
  const expected = new Map(packet.tuples.map((tuple) => [tuple.upstreamResultId, tuple]));
  const seen = new Set<string>();
  const selected: E2ESelectionTuple[] = [];
  const filtered: E2ESelectionTuple[] = [];
  for (const raw of pairs) {
    if (raw === null || typeof raw !== "object") throw new Error("public list pair is malformed");
    const pair = raw as Record<string, unknown>;
    const tuple = expected.get(String(pair.id));
    if (!tuple || seen.has(String(pair.id))) throw new Error("public list contains an extra, foreign, or duplicate tuple");
    if (pair.target !== tuple.targetName || pair.agent !== tuple.agent || pair.file !== ".agentx/e2e/generated-contract.test.ts" || pair.title !== tuple.title || canonicalJson(pair.titlePath) !== canonicalJson([tuple.title]) || pair.kind !== "test" || pair.session !== undefined || !Array.isArray(pair.sessions) || pair.sessions.length !== 0 || pair.serialId !== undefined) throw new Error("public list tuple identity or nonparallel test semantics do not match");
    if (pair.disposition === "run") selected.push(tuple);
    else if (pair.disposition === "filtered") filtered.push(Object.freeze({ ...tuple, disposition: "filtered" }));
    else throw new Error("expected public-list tuple was skipped or has an unknown disposition");
    seen.add(String(pair.id));
  }
  if (seen.size !== expected.size || selected.length !== packet.tuples.filter((item) => item.disposition === "run").length
    || filtered.length !== packet.tuples.filter((item) => item.disposition === "filtered").length) throw new Error("public list did not return every exact selected and filtered tuple");
  return { selected: Object.freeze(selected), filtered: Object.freeze(filtered) };
}

export function assertPlanSubset(plan: E2EExecutionPlan, effectiveTargets: readonly { targetId: string }[], group: E2EExecutionPlan["groups"][number]): void {
  const actualGroup = plan.groups.find((item) => item.groupId === group.groupId);
  if (!actualGroup || canonicalJson(actualGroup) !== canonicalJson(group)) throw new Error("compiler group does not match the selected execution plan");
  const actualTargetIds = plan.effectiveTargets.map((target) => target.targetId).sort();
  const suppliedTargetIds = effectiveTargets.map((target) => target.targetId).sort();
  if (canonicalJson(actualTargetIds) !== canonicalJson(suppliedTargetIds)) throw new Error("compiler effective targets do not match the full execution plan");
  if (group.targetIds.length > 3 || group.expectedCases.length === 0) throw new Error("compiler group is empty or exceeds the target limit");
}

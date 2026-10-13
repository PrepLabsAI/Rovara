import { types } from "node:util";
import { E2EExecutionPlanSchema, canonicalJson, copyBoundedE2EJsonData, type E2EExecutionPlan, type E2EExpectedCase, type E2ETarget } from "@agentx/contracts";
import { upstreamE2ECaseIdentity } from "./identity.js";

export type E2ESelectionTuple = Readonly<{ caseId: string; compilerCaseIdentity: string; candidateResponseScope: "contained-candidate-process-response/v1"; requestProtocol: "contained-candidate-host-request/v1"; upstreamTestId: string; upstreamResultId: string; title: string; targetId: string; targetName: string; agent: "default"; disposition: "run" | "filtered" }>;
export type E2ESelectionPacket = Readonly<{ schemaVersion: 1; algorithm: "e2e-public-list-selection/v1"; planDigest: string; groupId: string; tuples: readonly E2ESelectionTuple[] }>;

export function createE2ESelectionPacket(planInput: E2EExecutionPlan, groupId: string, titleByCaseId: ReadonlyMap<string, string>, caseBindings: ReadonlyMap<string, { compilerCaseIdentity: string; candidateResponseScope: "contained-candidate-process-response/v1"; requestProtocol: "contained-candidate-host-request/v1" }>): E2ESelectionPacket {
  const plan = E2EExecutionPlanSchema.parse(planInput);
  const group = plan.groups.find((item) => item.groupId === groupId);
  if (!group || group.expectedCases.length === 0) throw new Error("selected execution group is absent or empty");
  const selected = group.expectedCases.map((item: E2EExpectedCase) => {
    const title = titleByCaseId.get(item.caseId);
    if (!title) throw new Error("generated title is missing for an expected case");
    const ids = upstreamE2ECaseIdentity(item, title);
    if (ids.upstreamTestId !== item.upstreamTestId) throw new Error("execution plan upstream test ID does not match the pinned public identity algorithm");
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
  const safePacket = copyBoundedE2EJsonData(packet, { maxBytes: 262_144, maxDepth: 64 }) as E2ESelectionPacket;
  if (listed === null || typeof listed !== "object" || types.isProxy(listed) || Array.isArray(listed)) throw new Error("public list result is not an ordinary object");
  const descriptors = Object.getOwnPropertyDescriptors(listed);
  const dataField = (key: "pairs" | "unmatched") => {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new Error("public list result is missing own data fields");
    return descriptor.value as unknown;
  };
  const rawPairs = dataField("pairs");
  if (!Array.isArray(rawPairs)) throw new Error("public list pair collection is invalid");
  const pairsProjection = rawPairs.map((raw) => {
    if (raw === null || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)) throw new Error("public list pair is malformed");
    const pairDescriptors = Object.getOwnPropertyDescriptors(raw);
    const known = new Set(["id", "file", "title", "titlePath", "kind", "session", "sessions", "serialId", "target", "agent", "disposition", "tags", "source", "reason"]);
    const unknown = Reflect.ownKeys(pairDescriptors).filter((key) => typeof key !== "string" || !known.has(key));
    if (unknown.length > 0) throw new Error(`public list pair contains unknown fields: ${unknown.map(String).join(",")}`);
    const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of ["id", "file", "title", "titlePath", "kind", "session", "sessions", "serialId", "target", "agent", "disposition"] as const) {
      const descriptor = pairDescriptors[key];
      if (!descriptor) continue;
      if (!("value" in descriptor) || descriptor.enumerable !== true) throw new Error("public list pair fields must be own data properties");
      if (descriptor.value !== undefined) projected[key] = descriptor.value;
    }
    return projected;
  });
  const safeListed = copyBoundedE2EJsonData({ pairs: pairsProjection, unmatched: dataField("unmatched") }, { maxBytes: 262_144, maxDepth: 64 }) as { pairs?: unknown; unmatched?: unknown };
  const pairs = safeListed.pairs;
  const unmatched = safeListed.unmatched;
  if (!Array.isArray(pairs) || !Array.isArray(unmatched) || unmatched.length !== 0) throw new Error("public list result is malformed or contains unmatched files");
  const expected = new Map(safePacket.tuples.map((tuple) => [tuple.upstreamResultId, tuple]));
  const seen = new Set<string>();
  const selected: E2ESelectionTuple[] = [];
  const filtered: E2ESelectionTuple[] = [];
  for (const raw of pairs) {
    if (raw === null || typeof raw !== "object") throw new Error("public list pair is malformed");
    const pair = raw as Record<string, unknown>;
    if (typeof pair.id !== "string") throw new Error("public list pair ID must be a string");
    const tuple = expected.get(pair.id);
    if (!tuple || seen.has(pair.id)) throw new Error("public list contains an extra, foreign, or duplicate tuple");
    if (pair.target !== tuple.targetName || pair.agent !== tuple.agent || pair.file !== ".agentx/e2e/generated-contract.test.ts" || pair.title !== tuple.title || canonicalJson(pair.titlePath) !== canonicalJson([tuple.title]) || pair.kind !== "test" || pair.session !== undefined || !Array.isArray(pair.sessions) || pair.sessions.length !== 0 || pair.serialId !== undefined) throw new Error("public list tuple identity or nonparallel test semantics do not match");
    if (pair.disposition !== tuple.disposition) throw new Error("public list disposition does not match the exact expected tuple");
    if (tuple.disposition === "run") selected.push(tuple);
    else filtered.push(tuple);
    seen.add(pair.id);
  }
  if (seen.size !== expected.size || selected.length !== safePacket.tuples.filter((item) => item.disposition === "run").length
    || filtered.length !== safePacket.tuples.filter((item) => item.disposition === "filtered").length) throw new Error("public list did not return every exact selected and filtered tuple");
  return { selected: Object.freeze(selected), filtered: Object.freeze(filtered) };
}

export function assertPlanSubset(plan: E2EExecutionPlan, effectiveTargets: readonly E2ETarget[], group: E2EExecutionPlan["groups"][number]): void {
  const actualGroup = plan.groups.find((item) => item.groupId === group.groupId);
  if (!actualGroup || canonicalJson(actualGroup) !== canonicalJson(group)) throw new Error("compiler group does not match the selected execution plan");
  const actualTargets = [...plan.effectiveTargets].sort((a, b) => a.targetId.localeCompare(b.targetId));
  const suppliedTargets = [...effectiveTargets].sort((a, b) => a.targetId.localeCompare(b.targetId));
  if (actualTargets.length !== suppliedTargets.length || new Set(suppliedTargets.map((target) => target.targetId)).size !== suppliedTargets.length || canonicalJson(actualTargets) !== canonicalJson(suppliedTargets)) throw new Error("compiler effective targets do not match the full execution plan");
  if (group.targetIds.length > 3 || group.expectedCases.length === 0) throw new Error("compiler group is empty or exceeds the target limit");
}

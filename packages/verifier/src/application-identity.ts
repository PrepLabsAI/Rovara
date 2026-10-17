import { types } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { APPLICATION_E2E_TEST_PATH, E2EExecutionPlanSchema, canonicalJson,
  e2eApplicationUpstreamTestIdFromIdentity, type E2EExecutionPlan, type E2EExpectedCase } from "@agentx/contracts";
import { copyBoundedE2EJsonData } from "@agentx/contracts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = (max = 120) => z.string().trim().min(1).max(max);
const sourceSchema = z.object({ file: z.literal(APPLICATION_E2E_TEST_PATH), line: z.number().int().positive(), column: z.number().int().positive() }).strict();
const tupleSchema = z.object({ caseId: id(120), executionDescriptorDigest: digest, upstreamTestId: z.string().min(1).max(2048), upstreamResultId: digest,
  title: z.string().min(1).max(256), targetId: id(80), targetName: z.string().regex(/^(?!\.+$)[A-Za-z0-9_.-]+$/).max(120), platform: id(120),
  agent: z.literal("default"), disposition: z.literal("run"), source: sourceSchema, tags: z.array(id(120)).max(64) }).strict();
export const E2EApplicationSelectionPacketSchema = z.object({ schemaVersion: z.literal(1), algorithm: z.literal("e2e-application-public-list-selection/v1"),
  executionPlanDigest: digest, groupId: id(80), shardId: id(120), targetId: id(80), tuples: z.array(tupleSchema).min(1).max(64) }).strict().superRefine((packet, context) => {
  if (new Set(packet.tuples.map((tuple) => tuple.caseId)).size !== packet.tuples.length
    || new Set(packet.tuples.map((tuple) => tuple.upstreamResultId)).size !== packet.tuples.length
    || packet.tuples.some((tuple) => tuple.targetId !== packet.targetId || tuple.targetName !== packet.targetId)) {
    context.addIssue({ code: "custom", path: ["tuples"], message: "application public-list tuples must be unique and bound to their one target" });
  }
});
export type E2EApplicationSelectionPacket = z.infer<typeof E2EApplicationSelectionPacketSchema>;
export type E2EApplicationSourcePosition = z.infer<typeof sourceSchema>;

function upstreamResultId(testId: string, targetId: string): string {
  return createHash("sha256").update(canonicalJson({ testId, targetId, agent: "default" })).digest("hex");
}
function copyMap<K, V>(value: ReadonlyMap<K, V>, max: number, label: string): Map<K, V> {
  if (!(value instanceof Map) || types.isProxy(value) || value.size > max) throw new TypeError(`${label} must be an ordinary bounded map`);
  const result = new Map<K, V>();
  const entries = value.entries() as unknown as IterableIterator<readonly [K, V]>;
  for (const entry of entries) result.set(entry[0], entry[1]);
  return result;
}

export function createE2EApplicationSelectionPacket(input: {
  plan: E2EExecutionPlan; groupId: string; shardId: string; targetId: string;
  targetPlatform: string;
  titleByCaseId: ReadonlyMap<string, string>; sourceByCaseId: ReadonlyMap<string, E2EApplicationSourcePosition>;
}): E2EApplicationSelectionPacket {
  if (input === null || typeof input !== "object" || types.isProxy(input)) throw new TypeError("application selection packet input must be ordinary data");
  const plan = E2EExecutionPlanSchema.parse(copyBoundedE2EJsonData(input.plan, { maxBytes: 1_048_576, maxDepth: 64 }));
  const titles = copyMap(input.titleByCaseId, 64, "application title map");
  const sources = copyMap(input.sourceByCaseId, 64, "application source map");
  const group = plan.groups.find((item) => item.groupId === input.groupId);
  if (!group || !group.targetIds.includes(input.targetId)) throw new Error("application selection group or shard target is absent from the complete plan");
  const expectedCases = group.expectedCases.filter((item) => item.targetId === input.targetId);
  if (expectedCases.length === 0 || expectedCases.length > 64) throw new Error("application target shard has no cases or exceeds its per-target bound");
  const tuples = expectedCases.map((item) => {
    const title = titles.get(item.caseId);
    const source = sources.get(item.caseId);
    if (!title || !source) throw new Error("application generated test source or title is missing for an expected case");
    const expectedTitle = item.upstreamTestId.slice(item.upstreamTestId.lastIndexOf("::") + 2);
    if (title !== expectedTitle || e2eApplicationUpstreamTestIdFromIdentity(item) !== item.upstreamTestId) throw new Error("application test title or pinned upstream identity does not bind the approved expected case");
    return tupleSchema.parse({ caseId: item.caseId, executionDescriptorDigest: item.executionDescriptorDigest,
      upstreamTestId: item.upstreamTestId, upstreamResultId: upstreamResultId(item.upstreamTestId, input.targetId),
      title, targetId: input.targetId, targetName: input.targetId, platform: input.targetPlatform, agent: "default", disposition: "run", source, tags: [] });
  });
  return E2EApplicationSelectionPacketSchema.parse({ schemaVersion: 1, algorithm: "e2e-application-public-list-selection/v1",
    executionPlanDigest: plan.digest, groupId: input.groupId, shardId: input.shardId, targetId: input.targetId, tuples });
}

function ordinaryRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be an ordinary object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) throw new TypeError(`${label} contains symbol properties`);
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => {
    if (!("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError(`${label} must contain enumerable data properties`);
    return [key, descriptor.value as unknown];
  }));
}
function arrayData(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be an ordinary array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)))) throw new TypeError(`${label} contains extra properties`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError(`${label} must be dense own data`);
    return descriptor.value as unknown;
  });
}

export function compareE2EApplicationPublicList(packetInput: E2EApplicationSelectionPacket, listedInput: unknown): { selected: readonly E2EApplicationSelectionPacket["tuples"][number][]; filtered: readonly [] } {
  const packet = E2EApplicationSelectionPacketSchema.parse(copyBoundedE2EJsonData(packetInput, { maxBytes: 262_144, maxDepth: 32 }));
  const listed = ordinaryRecord(listedInput, "application public list result");
  if (Object.keys(listed).sort().join(",") !== "pairs,targets,unmatched") throw new Error("application public list result has missing or unknown fields");
  const pairs = arrayData(listed.pairs, "application public list pairs");
  const unmatched = arrayData(listed.unmatched, "application public list unmatched files");
  const targets = arrayData(listed.targets, "application public list targets");
  if (targets.length !== 1 || targets[0] !== packet.targetId) throw new Error("application public list selected another target or omitted its bound target");
  if (unmatched.length !== 0 || pairs.length !== packet.tuples.length) throw new Error("application public list includes unmatched files or omits approved cases");
  const expected = new Map(packet.tuples.map((tuple) => [tuple.upstreamResultId, tuple]));
  const seen = new Set<string>();
  for (const raw of pairs) {
    const pair = ordinaryRecord(raw, "application public list pair");
    const allowed = new Set(["id", "file", "title", "titlePath", "kind", "session", "sessions", "serialId", "target", "agent", "disposition", "tags", "source", "reason"]);
    if (Object.keys(pair).some((key) => !allowed.has(key))) throw new Error("application public list pair has unknown fields");
    const tuple = typeof pair.id === "string" ? expected.get(pair.id) : undefined;
    if (!tuple || seen.has(pair.id as string)) throw new Error("application public list contains an extra, foreign, or duplicate tuple");
    if (pair.file !== APPLICATION_E2E_TEST_PATH || pair.title !== tuple.title || canonicalJson(pair.titlePath) !== canonicalJson([tuple.title])
      || pair.kind !== "test" || pair.session !== undefined || canonicalJson(pair.sessions) !== "[]" || pair.serialId !== undefined
      || pair.target !== tuple.targetName || pair.agent !== tuple.agent || pair.disposition !== "run" || canonicalJson(pair.tags) !== canonicalJson(tuple.tags)
      || canonicalJson(pair.source) !== canonicalJson(tuple.source)) throw new Error("application public list tuple differs from its exact one-target compiled identity");
    seen.add(pair.id as string);
  }
  if (seen.size !== expected.size) throw new Error("application public list did not return every expected test-target pair");
  return { selected: Object.freeze([...packet.tuples]), filtered: Object.freeze([]) };
}

export type E2EApplicationExpectedCase = E2EExpectedCase;

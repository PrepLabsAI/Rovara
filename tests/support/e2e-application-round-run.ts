import { expect } from "vitest";
import { createHash } from "node:crypto";
import type { E2EApplicationReport } from "../../packages/verifier/src/application-report-schema.js";
import type { ApplicationGroupEvidence, ObservedApiOutcome } from "./e2e-application-evidence-fixture.js";
import type { ApplicationRound } from "./e2e-application-round-harness.js";

/** What the worker does while an application round runs, for the tests of what the broker makes of the evidence (a copy of the steps `workflow-e2e-application-round.test.ts` takes). */
export type Outcome = ObservedApiOutcome | readonly ObservedApiOutcome[];
export const PASS = { kind: "http-status", status: 200 } as const satisfies ObservedApiOutcome;
export const FAIL = { kind: "http-status", status: 503 } as const satisfies ObservedApiOutcome;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function collectAll(round: ApplicationRound, outcomes: readonly Outcome[], reportEdit?: (report: E2EApplicationReport, shard: number, group: number) => void): Promise<ApplicationGroupEvidence[]> {
  const groups: ApplicationGroupEvidence[] = [];
  for (const [index, groupId] of round.groupIds.entries()) groups.push(await round.collectGroup(groupId, outcomes[index]!, reportEdit === undefined ? undefined : (report, shard) => reportEdit(report, shard, index)));
  return groups;
}

/** Each group's evidence as it finishes, then the aggregate; returns the aggregate's reference. `tweak` edits a group run before it is sent (to add operator evidence, say). */
export async function uploadAll(round: ApplicationRound, groups: readonly ApplicationGroupEvidence[], tweak: (groupRun: Record<string, unknown>, index: number) => void = () => undefined) {
  round.markRunning();
  const runs: Record<string, unknown>[] = [];
  for (const [index, group] of groups.entries()) {
    const groupRun = clone(group.groupRun);
    tweak(groupRun, index);
    runs.push(groupRun);
    const uploaded = await round.upload(round.groupEnvelope(groupRun), { groupRunId: group.runId });
    expect(uploaded.response.status, JSON.stringify(uploaded.response.body)).toBe(200);
  }
  const aggregate = await round.upload(round.aggregateEnvelope(runs));
  expect(aggregate.response.status, JSON.stringify(aggregate.response.body)).toBe(200);
  return aggregate.response.body as { key: string; sha256: string };
}

export async function runRound(round: ApplicationRound, outcomes: readonly Outcome[], options: { tweak?: Parameters<typeof uploadAll>[2] } = {}): Promise<{ groups: ApplicationGroupEvidence[]; aggregate: { key: string; sha256: string } }> {
  const groups = await collectAll(round, outcomes);
  const aggregate = await uploadAll(round, groups, options.tweak);
  await round.finishChecks(aggregate);
  return { groups, aggregate };
}

/** The case ids of the round's groups, in admission order. */
export const caseIdsOf = (round: ApplicationRound) => round.admission.groups.flatMap((group) => group.outerBinding.expectedCases.map((item) => item.caseId));

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The operator evidence a worker packs with screenshots (`captures`), for the cases given, plus a log head. */
export function operatorEvidenceWith(screenshots: ReadonlyArray<{ caseId: string; bytes: Uint8Array }>, extra: { executorLogHead?: string; omitted?: ReadonlyArray<string> } = {}) {
  return {
    notice: "Raw output of the run, kept for operators only.", rawReportIn: "collection", observationsIn: "collection", observations: [],
    executorLogHead: extra.executorLogHead ?? null,
    captures: { artifacts: screenshots.map((item) => ({ caseId: item.caseId, kind: "screenshot", sha256: sha(item.bytes), bytes: item.bytes.byteLength,
      ...(extra.omitted?.includes(item.caseId) === true ? { omitted: "budget" } : {}) })),
    files: screenshots.filter((item) => extra.omitted?.includes(item.caseId) !== true).map((item, index) => ({ name: `case-${index}-screenshot.jpg`, sha256: sha(item.bytes),
      bytes: item.bytes.byteLength, base64: Buffer.from(item.bytes).toString("base64") })) },
  };
}

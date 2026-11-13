// Fixtures for the TE-F10 side-by-side tests: a fake `model-egress` world (F1-a), eval cases, a recording judge. Nothing here opens a socket; every canary is built at runtime.
import { createHash } from "node:crypto";
import { detectPromptChanges, detectPromptChangesInDiff, evalSetCaseSource, sideBySideScoringPromptSha256, type ModelEgress, type ModelEgressScope, type PromptChangeReport, type SideBySideCaseSource, type SideBySideJudge, type SideBySideJudgePin, type SideBySideJudgeCall } from "../../packages/contracts/src/index.js";
import { fakeModelEgressWorld } from "../../packages/testing/src/ports/model-egress-world.js";
import { COMPANY_A, COMPANY_B, type IsolationCompany } from "../../packages/testing/src/isolation/two-company.js";

/** A string no real text holds, built at runtime and different for every label. */
export const canary = (label: string): string => `cnry${createHash("sha256").update(`te-f10/${label}`).digest("hex").slice(0, 16)}`;

/** A Gemini answer body holding `text`, with usage. */
export const geminiBody = (text: string, usage = { promptTokenCount: 10, candidatesTokenCount: 5 }): string => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage });

export interface SbsWorld {
  readonly world: ReturnType<typeof fakeModelEgressWorld>;
  /** The adapter and scope as the lane's own (source) types see them; `rawEgress` and `rawScope` are the testing package's, which was built against the contracts' dist and is a distinct type for the compiler. */
  readonly egress: ModelEgress;
  readonly scope: ModelEgressScope;
  readonly rawEgress: ReturnType<typeof fakeModelEgressWorld>["adapter"];
  readonly rawScope: ReturnType<ReturnType<typeof fakeModelEgressWorld>["scope"]>;
  /** Scripts the provider: one answer per call, in order. */
  answers(...texts: string[]): void;
}
export function sbsWorld(company: IsolationCompany = COMPANY_A): SbsWorld {
  const world = fakeModelEgressWorld();
  const rawScope = world.scope(company, "gemini");
  return { world, egress: world.adapter as unknown as ModelEgress, scope: rawScope as unknown as ModelEgressScope, rawEgress: world.adapter, rawScope, answers: (...texts) => world.provider.script(...texts.map((text) => ({ body: geminiBody(text) }))) };
}

export const MODEL = "gemini-2.5-flash";
export const evalCases = (count: number, prefix = "case"): Array<{ caseId: string; input: string }> => Array.from({ length: count }, (_, index) => ({ caseId: `${prefix}-${String(index + 1)}`, input: `question number ${String(index + 1)}` }));

export function source(company: IsolationCompany, count: number, options: { prefix?: string; oldSystem?: string; newSystem?: string; oldModel?: string; newModel?: string; inputs?: Array<{ caseId: string; input: string }> } = {}): SideBySideCaseSource {
  return evalSetCaseSource({
    company: company.orgId,
    cases: options.inputs ?? evalCases(count, options.prefix),
    old: { system: options.oldSystem ?? "You answer briefly.", model: options.oldModel ?? MODEL },
    new: { system: options.newSystem ?? "You answer briefly and politely.", model: options.newModel ?? MODEL },
    row: "gemini",
    family: "gemini",
  });
}

/** The judge's pin: made before the task, from a different family than the product (Gemini). */
export const PIN: SideBySideJudgePin = { model: "claude-judge", version: "2026-10-01", family: "claude", scoringPromptSha256: sideBySideScoringPromptSha256(), pinnedAt: "2026-11-01T00:00:00Z" };
/** What every run is also given: when the task started and the model family of the product under test. */
export const RUN_DEFAULTS = { taskStartedAt: "2026-11-13T09:00:00Z", productModelFamily: "gemini" } as const;

/** A judge for a company that records exactly what it was handed (a deep copy) and answers with `answer`. */
export function recordingJudge(company: IsolationCompany, answer: (call: SideBySideJudgeCall, index: number) => string | { text: string; costMicros: number }, pin: SideBySideJudgePin = PIN): SideBySideJudge & { readonly received: unknown[] } {
  const received: unknown[] = [];
  return {
    company: company.orgId,
    pin,
    received,
    async judge(call) {
      received.push(JSON.parse(JSON.stringify(call)));
      const made = answer(call, received.length - 1);
      return typeof made === "string" ? { text: made, costMicros: 7 } : made;
    },
  };
}
/** A verdict text for a one-case call. */
export const verdictText = (call: SideBySideJudgeCall, verdict: string): string => JSON.stringify({ verdicts: call.cases.map((item) => ({ caseId: item.caseId, verdict })) });

export const reportNeeded = (): PromptChangeReport => detectPromptChanges({ files: [{ path: "prompts/a.prompt", before: "old", after: "new", wholeFile: true }] }).report;
export const reportNone = (): PromptChangeReport => detectPromptChanges({ files: [{ path: "src/readme.txt", before: "a", after: "b", wholeFile: true }] }).report;
export const reportIncomplete = (): PromptChangeReport => detectPromptChangesInDiff('diff --git "a/missing b/missing\n').report;
export const reportModelOnly = (): PromptChangeReport => detectPromptChanges({ files: [{ path: "ai/model.ts", before: "const m = { model: 'gemini-2.0-flash' };", after: "const m = { model: 'gemini-2.5-flash' };", wholeFile: true }] }).report;

export { COMPANY_A, COMPANY_B };

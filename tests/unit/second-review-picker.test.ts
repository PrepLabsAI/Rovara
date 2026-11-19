// The second reviewer's model picker and plan (the list is the install's own models; same-company entries are greyed out; suggestions come only from the list; the default is used while nobody has chosen;
// a chosen model that stops qualifying is never swapped), the evidence `on` needs, and the merge wait.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  configuredSecondReviewMode, narrowedSecondReviewModels, secondReviewDidNotRunLine, secondReviewModelKey, TaskUsageTelemetrySchema, createTaskUsageTelemetry,
  type ModelIdentifier, type SecondReviewReplayCase, type SecondReviewReplayRun, type SecondReviewVerdict, type WorkflowReviewReport,
} from "@agentx/contracts";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow-node.js";
import { acceptSecondReport, planSecondReview, secondOpinionUnavailable, secondReviewAcknowledgement, secondReviewUnavailableDecision, type SecondReviewPlanInput } from "../../packages/broker/src/core/second-review/plan.js";
import { noticeWhyText } from "../../packages/broker/src/core/second-review/notice.js";
import { defaultModelLine, secondReviewPicker, secondReviewTrackRecord } from "../../packages/broker/src/core/second-review/picker.js";
import { secondReviewMergeWait } from "../../packages/broker/src/core/second-review/store.js";
import { reviewUsageArtifactName } from "../../packages/worker/src/usage.js";

const NOW = "2026-11-02T12:00:00.000Z";
const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const second = (operationId: string, status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = [], over: Partial<WorkflowReviewReport> = {}): WorkflowReviewReport => ({
  operationId, candidateDigest: code.digest, role: "CRITIC", provider: "openrouter", version: "openai/gpt-5.5", status, findings, readOnly: true, recordedAt: NOW, ...over,
});

const OPUS: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const GPT: ModelIdentifier = { provider: "openrouter", modelId: "openai/gpt-5.5" };
const GPT_FREE: ModelIdentifier = { provider: "openrouter", modelId: "openai/gpt-5.5:free" };
const GEMINI: ModelIdentifier = { provider: "openrouter", modelId: "google/gemini-3-pro" };
const NOVA: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" };
const MYSTERY: ModelIdentifier = { provider: "openrouter", modelId: "x-ai/grok-9" };

const base = (over: Partial<SecondReviewPlanInput> = {}): SecondReviewPlanInput => ({
  switchOn: true, mode: "shadow", against: [SONNET], project: {}, forbidden: [], sources: [OPUS, SONNET, GPT, GEMINI, NOVA], verdicts: [], replayRuns: [], ...over,
});
const planned = (over: Partial<SecondReviewPlanInput> = {}) => {
  const result = planSecondReview(base(over));
  if (!result.run) throw new Error(`no plan: ${result.reason}`);
  return result;
};
const keys = (models: readonly ModelIdentifier[]) => models.map(secondReviewModelKey);

// ---- evidence that lets a model run in `on`
const replayCases = (): SecondReviewReplayCase[] => {
  const out: SecondReviewReplayCase[] = [];
  const shapes: Array<[boolean, boolean, number]> = [[true, true, 32], [true, false, 8], [false, true, 5], [false, false, 5]];
  for (const [baselineCaught, candidateCaught, count] of shapes) for (let i = 0; i < count; i += 1) out.push({ caseId: `c${String(out.length + 1)}`, kind: "known_defect", baselineCaught, candidateCaught, candidateBlockingFindings: 0, candidateDismissedBlocking: 0 });
  return out.map((entry, index) => ({ ...entry, kind: index < 30 ? "known_defect" as const : "planted_bug" as const }));
};
const proof = (model: ModelIdentifier): { verdicts: SecondReviewVerdict[]; replayRuns: SecondReviewReplayRun[] } => ({
  replayRuns: [{ runId: "run-1", ranAt: "2026-11-01T00:00:00.000Z", candidate: model, baseline: OPUS, cases: replayCases() }],
  verdicts: [{ model: secondReviewModelKey(model), replayRunId: "run-1", baseline: OPUS, shadow: { startedAt: "2026-11-02T00:00:00.000Z", endedAt: "2026-11-16T00:00:00.000Z", findings: 10, agreed: 4, reviews: 10 }, createdAt: "2026-11-20T00:00:00.000Z", createdBy: "staff:alice" }],
});

describe("a task started before the frontier tier keeps its second reviewer's default (legacyRanking)", () => {
  const FABLE: ModelIdentifier = { provider: "anthropic", modelId: "claude-fable-5-1" };
  const OPUS_NEW: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-5-5" };
  const GPT5: ModelIdentifier = { provider: "openai", modelId: "gpt-5" };
  const tops = (legacyRanking: boolean) => secondReviewPicker({ sources: [OPUS_NEW, FABLE, GPT5, GEMINI], project: {}, forbidden: [], against: [GPT5], legacyRanking }).suggested.map((entry) => entry.model.modelId);
  it("an older task ranks Fable above Opus above Gemini Pro; a new one puts the cheaper Opus first", () => {
    expect(tops(true)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "google/gemini-3-pro"]);
    expect(tops(false)[0]).toBe("claude-opus-5-5");
  });
});

describe("the model picker", () => {
  const picked = secondReviewPicker({ sources: [OPUS, SONNET, GPT, GPT_FREE, GEMINI, NOVA, MYSTERY], project: {}, forbidden: [], against: [SONNET], price: () => ({ inputUsdPerMTok: 2, outputUsdPerMTok: 10 }) });

  it("lists only the models the company can actually use, and none it forbids or its project does not approve", () => {
    expect(keys(picked.entries.map((entry) => entry.model)).sort()).toEqual(keys([OPUS, SONNET, GPT, GPT_FREE, GEMINI, NOVA, MYSTERY]).sort());
    const without = secondReviewPicker({ sources: [OPUS, GPT, GEMINI], project: { approved: [OPUS, GPT] }, forbidden: [GPT], against: [SONNET] });
    expect(keys(without.entries.map((entry) => entry.model))).toEqual(keys([OPUS]));
    // A model the company has no source for is not offered, however strong.
    expect(picked.entries.some((entry) => entry.model.modelId === "gpt-6.1-sol")).toBe(false);
  });

  it("LP-11: never lists an OpenRouter ':batch' variant (the Batch API's id, not one for chat calls), nor suggests it; the ordinary model beside it stays", () => {
    const BATCH: ModelIdentifier = { provider: "openrouter", modelId: "openai/gpt-4.1-nano:batch" };
    const PLAIN: ModelIdentifier = { provider: "openrouter", modelId: "openai/gpt-4.1-nano" };
    const withBatch = secondReviewPicker({ sources: [SONNET, PLAIN, BATCH], project: {}, forbidden: [], against: [SONNET] });
    expect(withBatch.entries.map((entry) => entry.model.modelId)).toContain(PLAIN.modelId);
    expect(withBatch.entries.map((entry) => entry.model.modelId)).not.toContain(BATCH.modelId);
    expect(withBatch.suggested.map((entry) => entry.model.modelId)).not.toContain(BATCH.modelId);
    // A project's approved list that names only the batch id (no sources) lists nothing.
    expect(secondReviewPicker({ sources: [], project: { approved: [BATCH] }, forbidden: [], against: [SONNET] }).entries).toEqual([]);
  });

  it("greys out a model from the same company as the builder, with the reason, and one whose maker is unknown", () => {
    const sonnet = picked.entries.find((entry) => entry.model.modelId === SONNET.modelId)!;
    expect(sonnet).toMatchObject({ eligible: false, ineligibleWhy: "same-company", suggested: false });
    expect(picked.entries.find((entry) => entry.model.modelId === OPUS.modelId)).toMatchObject({ eligible: false, ineligibleWhy: "same-company" });
    expect(picked.entries.find((entry) => entry.model.modelId === MYSTERY.modelId)).toMatchObject({ eligible: false, ineligibleWhy: "company-unknown" });
    expect(picked.entries.find((entry) => entry.model.modelId === GPT.modelId)).toMatchObject({ eligible: true, company: "openai" });
  });

  it("suggests two or three eligible entries, with a one-line reason of fixed words, and only from the list", () => {
    expect(picked.suggested.length).toBeGreaterThanOrEqual(2);
    expect(picked.suggested.length).toBeLessThanOrEqual(3);
    for (const entry of picked.suggested) {
      expect(entry.eligible).toBe(true);
      expect(picked.entries).toContain(entry);
      expect(entry.suggestionReason).toMatch(/different AI company/u);
      expect(entry.suggestionReason).not.toMatch(/\n/u);
    }
    // The strongest eligible one first (the critic's capability tiers; inside the frontier tier cheaper first: Gemini has no catalog price, so it counts as the middle price of the priced frontier models and
    // comes before the dearer GPT-5.5, instead of after it as when a missing price counted as dearest).
    expect(picked.suggested[0]!.model.modelId).toBe(GEMINI.modelId);
    expect(picked.suggested.map((entry) => entry.model.modelId)).toContain(GPT.modelId);
    expect(picked.suggested.every((entry) => entry.notes.length === 0)).toBe(true);
  });

  it("notes a free variant (the provider may train on the code) and never suggests it", () => {
    const free = picked.entries.find((entry) => entry.model.modelId === GPT_FREE.modelId)!;
    expect(free.notes).toEqual(["the provider may train on the code sent to a free model"]);
    expect(free.suggested).toBe(false);
  });

  it("shows an estimated cost per review from the catalog price and one typical review size", () => {
    const entry = picked.entries.find((candidate) => candidate.model.modelId === GPT.modelId)!;
    expect(entry.costUsd).toBeCloseTo((60_000 * 2 + 4_000 * 10) / 1_000_000, 8);
    expect(secondReviewPicker({ sources: [GPT], project: {}, forbidden: [], against: [SONNET] }).entries[0]!.costUsd).toBeUndefined();
  });

  it("with nothing eligible it suggests nothing (the preview says so)", () => {
    const none = secondReviewPicker({ sources: [OPUS, SONNET], project: {}, forbidden: [], against: [SONNET] });
    expect(none.suggested).toEqual([]);
    expect(none.entries.every((entry) => !entry.eligible)).toBe(true);
  });

  it("says what a model's track record is, from what the team agreed with in shadow", () => {
    const evidence = proof(GPT);
    expect(secondReviewTrackRecord(evidence.verdicts[0]!)).toBe("agreed with your team on 4 of 10 findings over 14 days");
    const withRecord = secondReviewPicker({ sources: [GPT], project: {}, forbidden: [], against: [SONNET], ...evidence });
    expect(withRecord.entries[0]!.trackRecord).toBe("agreed with your team on 4 of 10 findings over 14 days");
  });
});

describe("the plan: choice, default and the company's sources", () => {
  it("uses the top suggestion while nobody has chosen, records it as the default, and says so", () => {
    const plan = planned();
    expect(plan.choice).toBe("default");
    expect(plan.model).toEqual({ provider: GEMINI.provider, modelId: GEMINI.modelId });
    expect(defaultModelLine(plan.model, false)).toBe("Using default: google/gemini-3-pro (change)");
    expect(plan.candidates.length).toBeLessThanOrEqual(2);
  });

  it("a company that chose runs exactly its primary then its backup, in that order, whatever is stronger", () => {
    const plan = planned({ companyModels: [GEMINI, NOVA] });
    expect(plan.choice).toBe("company");
    expect(keys(plan.candidates)).toEqual(keys([GEMINI, NOVA]));
  });

  it("a chosen model that stops qualifying is not swapped for another: nothing runs and it is flagged as such", () => {
    // The builder's company changed: the chosen model (Anthropic) is now the builder's company, though GPT would qualify.
    const result = planSecondReview(base({ companyModels: [SONNET] }));
    expect(result).toMatchObject({ run: false, reason: "choice-not-qualifying", skipped: [{ why: "same-company" }] });
    // Only the backup left: it is the company's own backup, so it runs; the primary is reported as left out.
    const backup = planned({ companyModels: [SONNET, GEMINI] });
    expect(keys(backup.candidates)).toEqual(keys([GEMINI]));
    expect(backup.skipped).toEqual([{ model: { provider: SONNET.provider, modelId: SONNET.modelId }, why: "same-company" }]);
    // A chosen model the company has no source for any more is the same: not swapped.
    expect(planSecondReview(base({ companyModels: [{ provider: "openrouter", modelId: "mistral/large-9" }] }))).toMatchObject({ run: false, reason: "choice-not-qualifying", skipped: [{ why: "not-routable" }] });
    // A saved choice of an OpenRouter ':batch' model says why in plain words, not "no connected source serves it".
    const batch = planSecondReview(base({ companyModels: [{ provider: "openrouter", modelId: "openai/gpt-4.1-nano:batch" }] }));
    expect(batch).toMatchObject({ run: false, reason: "choice-not-qualifying", skipped: [{ why: "batch-only" }] });
    expect(noticeWhyText("batch-only")).toBe("it is a batch-only model, not for reviews");
    // A choice that could not be read holds nothing: it never falls back to the default.
    expect(planSecondReview(base({ companyModels: [] }))).toMatchObject({ run: false, reason: "choice-not-qualifying" });
  });

  it("when the default stops qualifying the next default is used and the plan says so", () => {
    const first = planned();
    expect(first.defaultChanged).toBeUndefined();
    // GPT is no longer served: the previous default does not fit any more.
    const next = planned({ sources: [OPUS, SONNET, GEMINI, NOVA], previousDefault: { provider: GPT.provider, modelId: GPT.modelId } });
    expect(next.model.modelId).toBe(GEMINI.modelId);
    expect(next.defaultChanged).toBe(true);
    expect(defaultModelLine(next.model, true)).toBe("Using default: google/gemini-3-pro (previous no longer fits)");
    expect(planned({ previousDefault: { provider: GPT.provider, modelId: GPT.modelId } }).defaultChanged).toBeUndefined();
  });

  it("a project may narrow the company's choice to a subset and never widen it", () => {
    expect(narrowedSecondReviewModels({ company: [GPT, GEMINI], project: [GEMINI] }).models).toEqual([GEMINI]);
    expect(narrowedSecondReviewModels({ company: [GPT, GEMINI], project: [GEMINI, GPT] }).models).toEqual([GPT, GEMINI]);
    // A model the company did not name is dropped; naming only such models leaves nothing (never the company's whole list).
    expect(narrowedSecondReviewModels({ company: [GPT], project: [GPT, NOVA] }).models).toEqual([GPT]);
    expect(narrowedSecondReviewModels({ company: [GPT], project: [NOVA] }).models).toEqual([]);
    expect(planSecondReview(base({ companyModels: [GPT], projectModels: [NOVA] }))).toMatchObject({ run: false, reason: "choice-not-qualifying" });
    expect(keys(planned({ companyModels: [GPT, GEMINI], projectModels: [GEMINI, NOVA] }).candidates)).toEqual(keys([GEMINI]));
    // With no company choice the project's list is a subset of the default pool, not a way to name a model outside it.
    expect(keys(planned({ projectModels: [GEMINI, MYSTERY] }).candidates)).toEqual(keys([GEMINI]));
  });

  it("an OpenRouter-only company gets a second reviewer; one with no source from a different company gets 'did not run: no candidate'", () => {
    expect(planned({ against: [SONNET], sources: [SONNET, GPT, GEMINI] }).model.provider).toBe("openrouter");
    const none = planSecondReview(base({ sources: [SONNET, OPUS] }));
    expect(none).toMatchObject({ run: false, reason: "no-candidate" });
    expect(secondReviewDidNotRunLine("no-candidate")).toBe("Second review did not run: no allowed model from a different AI company could be used");
    expect(secondReviewUnavailableDecision({ mode: "on", reason: "no-candidate" })).toMatchObject({ blocks: false, showOnTaskPage: true, showOnPullRequest: true, askOwnerToAcknowledge: true });
    expect(secondReviewUnavailableDecision({ mode: "shadow", reason: "no-candidate" })).toMatchObject({ blocks: false, showOnTaskPage: false, showOnPullRequest: false, askOwnerToAcknowledge: false });
  });

  it("any source, not only Bedrock; a forbidden model and one outside the project's approved list never run", () => {
    expect(planned({ sources: [SONNET, GPT] }).model.provider).toBe("openrouter");
    expect(keys(planned({ forbidden: [GPT] }).candidates)).not.toContain(secondReviewModelKey(GPT));
    expect(keys(planned({ project: { approved: [SONNET, GEMINI] } }).candidates)).toEqual(keys([GEMINI]));
  });

  it("shadow runs at once, with no driving test; `on` needs the track record, else it runs as shadow and says so", () => {
    expect(planned({ mode: "shadow" })).toMatchObject({ mode: "shadow" });
    const unproven = planned({ mode: "on" });
    expect(unproven).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed" });
    const proven = planned({ mode: "on", ...proof(GPT) });
    expect(proven).toMatchObject({ mode: "on", model: { modelId: GPT.modelId } });
    expect(proven.downgraded).toBeUndefined();
    // Evidence for another model, or for another revision, does not let this one block.
    expect(planned({ mode: "on", ...proof(GEMINI) })).toMatchObject({ mode: "on", model: { modelId: GEMINI.modelId } });
    expect(planned({ mode: "on", ...proof({ provider: GPT.provider, modelId: "openai/gpt-5.4" }) })).toMatchObject({ mode: "shadow" });
  });

  it("with the switch off or the mode off, nothing is planned", () => {
    expect(planSecondReview(base({ switchOn: false, mode: "on" }))).toEqual({ run: false, reason: "switch-off" });
    expect(planSecondReview(base({ mode: "off" }))).toEqual({ run: false, reason: "mode-off" });
    expect(configuredSecondReviewMode({})).toBe("off");
  });
});


describe("a routed model's report must also come from the route provider", () => {
  it("an alias on another provider is not the route", () => {
    const plan = planned();
    const aliases = { [secondReviewModelKey(plan.model)]: "org-route-1" };
    const check = (provider: string) => acceptSecondReport({ plan, report: second(randomUUID(), "PASS", [], { provider, version: "org-route-1" }), currentCandidateDigest: code.digest, routeAliases: aliases });
    expect(check("rovara-route")).toEqual({ accepted: true });
    expect(check("openai")).toEqual({ accepted: false, reason: "wrong-model" });
  });
});

describe("the usage event stays the telemetry the activity index reads", () => {
  it("is exactly the telemetry shape for the second reviewer's tries too, which are told apart by their artifact names", () => {
    const usage = createTaskUsageTelemetry({ tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.01 }, { provider: "openrouter", modelId: "openai/gpt-5.5" }, "SUCCEEDED");
    expect(TaskUsageTelemetrySchema.safeParse(usage).success).toBe(true);
    expect(reviewUsageArtifactName("CRITIC", undefined)).toBe("workflow-review-critic-usage.json");
    expect(reviewUsageArtifactName("CRITIC", 2)).toBe("workflow-second-review-2-usage.json");
  });
});

describe("the merge waits for the owner's acknowledgement", () => {
  const flagged = secondOpinionUnavailable({ mode: "on", company: "openai" }, "no-answer");
  const task = (over: Record<string, unknown> = {}) => ({ secondOpinion: { candidateDigest: code.digest, opinion: flagged, recordedAt: NOW }, workflow: { candidate: { digest: code.digest } }, ...over });

  it("says why, only for an `on` review that did not run, for this code, until acknowledged; cr off waits for nothing", () => {
    expect(secondReviewMergeWait(task())).toMatch(/^Second review did not run: the reviewer gave no usable answer after retrying\. The task owner has to acknowledge it on the task page/u);
    const ack = secondReviewAcknowledgement(flagged, code.digest);
    if (!ack.required) throw new Error("expected an ask");
    expect(secondReviewMergeWait(task({ secondReviewAcknowledged: [ack.key] }))).toBeUndefined();
    expect(secondReviewMergeWait(task({ secondReviewAcknowledged: ["0".repeat(64)] }))).toBeDefined();
    expect(secondReviewMergeWait(task({ secondOpinion: { candidateDigest: code.digest, opinion: secondOpinionUnavailable({ mode: "shadow", company: "openai" }, "no-answer"), recordedAt: NOW } }))).toBeUndefined();
    expect(secondReviewMergeWait(task({ workflow: { candidate: { digest: "d".repeat(64) } } }))).toBeUndefined();
    expect(secondReviewMergeWait({ workflow: { candidate: { digest: code.digest } } })).toBeUndefined();
  });
});

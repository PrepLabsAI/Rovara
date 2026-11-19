// The second review's stored side on the document store: the settings (the shared key layout), the mode writer (raise at once, lower through the approvers port), the evidence writers, the notice, the
// track record and the owner's acknowledgement. Run on the memory store and the policy seams.
import { describe, expect, it } from "vitest";
import { SecondOpinionSchema, secondReviewModelKey, workflowFindingFingerprint, type DocumentChange, type SecondOpinion } from "@agentx/contracts";
import {
  TRACK_RECORD_DAYS, applyTrackChange, fileHash, findingKey, modeApprovalRequest, noteQualification, noticeLines, observationOf, planSecondReview, readNotice, readSecondReviewSettings, readTrackRecord,
  secondReviewPartition, secondReviewSettingsKey, trackChangeOf, verdictHoldsFor, trackRowKey, type TrackChange,
} from "../../packages/broker/src/core/second-review/index.js";
import { prepareVerdict, commitVerdict, withdrawVerdict } from "../../packages/broker/src/core/second-review/evidence.js";
import { BASELINE, COMPANY, recordingAudit, GEMINI, GPT, MEMBER, OPUS, OTHER, OWNER, SONNET, createWorld, passingCases, proofFor, replayRun, secondPersonApprovers, plain } from "../support/second-review-world.js";

const KEY = secondReviewModelKey(GPT);
const sha = (n: number): string => n.toString(16).padStart(64, "0");

describe("the settings are stored under the shared key layout", () => {
  it("writes the company's choice, context and mode where the shared key layout puts them, field by field", async () => {
    const world = createWorld();
    await world.review.apply(OWNER, { action: "choose", primary: GPT, backup: GEMINI });
    await world.review.apply(OWNER, { action: "context", context: "same_as_first" });
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "shadow" });
    const row = await world.store.get(secondReviewSettingsKey(COMPANY));
    expect(row).toMatchObject({ pk: `ORG#${COMPANY}`, sk: "SECONDREVIEW#SETTINGS", models: [GPT, GEMINI], context: "same_as_first", default: "shadow", lock: "shadow", entityType: "SECOND_REVIEW_SETTINGS" });
    expect(await readSecondReviewSettings(world.store, COMPANY, "")).toMatchObject({ companyModels: [GPT, GEMINI], context: "same_as_first", companyDefault: "shadow", companyLock: "shadow" });
    // Clearing the choice touches only `models`.
    await world.review.apply(OWNER, { action: "clear" });
    const cleared = await world.store.get(secondReviewSettingsKey(COMPANY));
    expect(cleared).not.toHaveProperty("models");
    expect(cleared).toMatchObject({ context: "same_as_first", default: "shadow" });
  });

  it("every change commits with its audit event, and with no ledger step the change still stands (the sink writes elsewhere)", async () => {
    const world = createWorld();
    await world.review.apply(OWNER, { action: "choose", primary: GPT });
    expect(world.audit.map((event) => event.action)).toEqual(["company.second_review_choice_changed"]);
    expect(await world.store.get({ pk: `AUDIT#${COMPANY}`, sk: `EVENT#${world.audit[0]!.eventId}` })).toBeDefined();
    expect(world.audit[0]!.details).toEqual({ change: "choose", count: 1 });
    const quiet = createWorld({ auditStages: false });
    await quiet.review.apply(OWNER, { action: "choose", primary: GPT });
    expect((await readSecondReviewSettings(quiet.store, COMPANY, "")).companyModels).toEqual([GPT]);
  });

  it("refuses a model the install cannot use, a person who may not administer, and a project it does not have; nothing is written", async () => {
    const world = createWorld({ sources: [SONNET, GPT] });
    await expect(world.review.apply(OWNER, { action: "choose", primary: GEMINI })).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    await expect(world.review.apply(MEMBER, { action: "choose", primary: GPT })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(world.review.apply(OWNER, { action: "mode", scope: "project", project: "nowhere", mode: "shadow" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(world.review.apply(OWNER, { action: "choose", primary: GPT, backup: GPT })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await world.store.get(secondReviewSettingsKey(COMPANY))).toBeUndefined();
    expect(world.audit).toEqual([]);
  });

  it("a project narrows the company's choice and never widens it; two project names never share a key", async () => {
    const world = createWorld();
    await world.review.apply(OWNER, { action: "choose", primary: GPT, backup: GEMINI });
    await world.review.apply(OWNER, { action: "narrow", project: "web", models: [GEMINI] });
    expect((await readSecondReviewSettings(world.store, COMPANY, "web")).projectModels).toEqual([GEMINI]);
    await expect(world.review.apply(OWNER, { action: "narrow", project: "web", models: [OPUS] })).rejects.toMatchObject({ code: (expect.stringMatching(/FORBIDDEN|MODEL_NOT_ALLOWED/u) as string) });
    expect(() => secondReviewPartition("a#b")).toThrow();
    await expect(readSecondReviewSettings(world.store, COMPANY, "a#b")).rejects.toThrow();
  });

  it("is off, and not found, when the install switch is off", async () => {
    const world = createWorld({ enabled: () => false });
    await expect(world.review.apply(OWNER, { action: "clear" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(world.review.mergeWait({ secondOpinion: undefined })).toBeUndefined();
    expect(await world.review.prepare({ task: { taskId: "t", project: "web", workflow: { candidate: { digest: sha(1) } } } })).toEqual({});
  });
});

describe("the mode", () => {
  it("raising applies at once, audited; `on` needs the evidence for the chosen model, recomputed from the stored run", async () => {
    const world = createWorld();
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "shadow" });
    // Nobody chose: no model for the evidence to be about.
    await expect(world.review.apply(OWNER, { action: "mode", scope: "company", mode: "on" })).rejects.toMatchObject({ code: "FORBIDDEN", message: (expect.stringContaining("trial record") as string) });
    await world.review.apply(OWNER, { action: "choose", primary: GPT });
    await expect(world.review.apply(OWNER, { action: "mode", scope: "company", mode: "on" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await world.seedHoldingEvidence(GPT);
    expect(await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "on" })).toEqual({ status: "applied", mode: "on" });
    expect((await world.review.state()).modes.company).toBe("on");
    expect(world.audit.filter((event) => event.action === "company.second_review_mode_changed").map((event) => event.details)).toEqual([
      { scope: "company", from: "off", to: "shadow", mode: "direct" }, { scope: "company", from: "shadow", to: "on", mode: "direct" },
    ]);
  });

  it("a withdrawn verdict, or a replay run that fails the bar, stops `on` at once", async () => {
    const world = createWorld();
    await world.review.apply(OWNER, { action: "choose", primary: GPT });
    await world.seedHoldingEvidence(GPT);
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "on" });
    const withdrawn = await world.review.apply(OWNER, { action: "withdraw", model: GPT });
    expect(withdrawn).toMatchObject({ status: "applied", evidence: { holds: false, verdict: { withdrawn: true } } });
    await expect(world.review.apply(OWNER, { action: "withdraw", model: GPT })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(world.review.apply(OWNER, { action: "withdraw", model: SONNET })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The review plans `on` only on evidence that holds now: a withdrawn model runs as shadow and says why.
    const plan = planSecondReview({ switchOn: true, mode: "on", against: [SONNET], project: {}, forbidden: [], sources: [GPT], ...(await readSecondReviewSettings(world.store, COMPANY, "")), companyModels: [GPT] });
    expect(plan).toMatchObject({ run: true, mode: "shadow", downgraded: "replay-not-passed" });
  });

  it("with Code's default approvers (the owner), lowering applies at once and is audited as the owner's", async () => {
    const world = createWorld();
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "shadow" });
    expect(await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "off" })).toEqual({ status: "applied", mode: "off" });
    expect(world.audit.at(-1)!.details).toMatchObject({ from: "shadow", to: "off", mode: "owner" });
    // A project pinned `on` before the company was lowered stops counting.
    await world.review.apply(OWNER, { action: "choose", primary: GPT });
    await world.seedHoldingEvidence(GPT);
    world.clock.now += 1_000;
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "shadow" });
    world.clock.now += 1_000;
    await world.review.apply(OWNER, { action: "mode", scope: "project", project: "web", mode: "on" });
    expect((await readSecondReviewSettings(world.store, COMPANY, "web")).projectMode).toBe("on");
    world.clock.now += 1_000;
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "off" });
    expect((await readSecondReviewSettings(world.store, COMPANY, "web")).projectMode).toBeUndefined();
  });

  it("lowering needs a fresh page session (ten minutes); raising does not", async () => {
    const world = createWorld();
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "shadow" }, { fresh: false });
    await expect(world.review.apply(OWNER, { action: "mode", scope: "company", mode: "off" }, { fresh: false })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect((await world.review.state()).modes.company).toBe("shadow");
    expect(await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "off" }, { fresh: true })).toEqual({ status: "applied", mode: "off" });
  });

  it("a project can be as strict as the company or stricter, never less strict; `inherit` clears it", async () => {
    const world = createWorld();
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "shadow" });
    await expect(world.review.apply(OWNER, { action: "mode", scope: "project", project: "web", mode: "off" })).rejects.toMatchObject({ code: "FORBIDDEN", message: (expect.stringContaining("never less strict") as string) });
    await world.review.apply(OWNER, { action: "mode", scope: "project", project: "web", mode: "shadow" });
    expect(await world.review.apply(OWNER, { action: "mode", scope: "project", project: "web", mode: "inherit" })).toMatchObject({ status: "applied", mode: "shadow" });
    expect((await readSecondReviewSettings(world.store, COMPANY, "web")).projectModeStored).toBeUndefined();
  });

  describe("when the approvers port needs a different person", () => {
    const lowered = async () => {
      const world = createWorld({ approvers: secondPersonApprovers() });
      await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "shadow" });
      const proposed = await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "off" });
      return { world, proposed };
    };

    it("lowering is a proposal that changes nothing; its proposer cannot approve it; a different person approves it with a proof the port verifies, audited", async () => {
      const { world, proposed } = await lowered();
      expect(proposed).toMatchObject({ status: "needs_approval" });
      const changeId = (proposed as { changeId: string }).changeId;
      expect((await world.review.state()).modes.company).toBe("shadow");
      expect((await world.review.state()).pending).toMatchObject([{ changeId, scope: "company", from: "shadow", to: "off" }]);
      const request = modeApprovalRequest({ companyId: COMPANY }, { id: changeId, scope: { kind: "company" }, from: "shadow", to: "off", expiresAt: Date.parse("2026-11-17T10:00:00.000Z") });
      // The proposer, even with a proof the port would accept for someone else's name, is refused.
      await expect(world.review.apply(OWNER, { action: "approve-mode", changeId, proof: proofFor(request, OWNER.personId) })).rejects.toMatchObject({ code: "FORBIDDEN" });
      // A proof for another request, or a person it does not name, is refused.
      await expect(world.review.apply(OTHER, { action: "approve-mode", changeId, proof: { ...proofFor(request, OTHER.personId), requestId: "second-review-mode:other" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await world.review.apply(OTHER, { action: "approve-mode", changeId, proof: proofFor(request, OTHER.personId) })).toEqual({ status: "applied", mode: "off" });
      expect((await world.review.state()).modes.company).toBe("off");
      expect(world.audit.map((event) => event.action).slice(-2)).toEqual(["company.second_review_mode_proposed", "company.second_review_mode_changed"]);
      // It was used up: approving again is not pending.
      await expect(world.review.apply(OTHER, { action: "approve-mode", changeId, proof: proofFor(request, OTHER.personId) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    });

    it("a second proposal for the same scope is refused while one waits; it can be withdrawn; a proposal the mode moved away from goes stale", async () => {
      const { world, proposed } = await lowered();
      await expect(world.review.apply(OWNER, { action: "mode", scope: "company", mode: "off" })).rejects.toMatchObject({ code: "CHANGE_STALE", message: (expect.stringContaining("already waiting") as string) });
      const changeId = (proposed as { changeId: string }).changeId;
      expect(await world.review.apply(OWNER, { action: "cancel-mode", changeId })).toEqual({ status: "cancelled" });
      await expect(world.review.apply(OWNER, { action: "cancel-mode", changeId })).rejects.toMatchObject({ code: "CHANGE_STALE" });
      expect((await world.review.state()).pending).toEqual([]);
      // A new proposal, then the company is raised to `on` before it is approved: the proposal is no longer what the scope has.
      const again = await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "off" }) as { changeId: string };
      await world.review.apply(OWNER, { action: "choose", primary: GPT });
      await world.seedHoldingEvidence(GPT);
      await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "on" });
      const request = modeApprovalRequest({ companyId: COMPANY }, { id: again.changeId, scope: { kind: "company" }, from: "shadow", to: "off", expiresAt: 0 });
      await expect(world.review.apply(OTHER, { action: "approve-mode", changeId: again.changeId, proof: proofFor({ ...request, expiresAt: undefined } as never, OTHER.personId) })).rejects.toMatchObject({ code: (expect.stringMatching(/CHANGE_STALE|FORBIDDEN/u) as string) });
      expect((await world.review.state()).modes.company).toBe("on");
    });

    it("an expired proposal cannot be approved", async () => {
      const { world, proposed } = await lowered();
      const changeId = (proposed as { changeId: string }).changeId;
      world.clock.now += 8 * 86_400_000;
      await expect(world.review.apply(OTHER, { action: "approve-mode", changeId, proof: proofFor({ requestId: `second-review-mode:${changeId}`, revision: 1, artifactDigest: "x" } as never, OTHER.personId) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    });
  });
});

describe("the evidence writers", () => {
  const withRows = async (world: ReturnType<typeof createWorld>) => {
    // Ten answered opinions over 16 days, 5 of 10 findings agreed with, written as the track record would.
    for (let n = 1; n <= 10; n += 1) {
      const at = `2026-10-${String(n * 2 + 1).padStart(2, "0")}T12:00:00.000Z`;
      const row = { model: KEY, mode: "shadow" as const, taskId: `t${String(n)}`, project: "web", candidateDigest: sha(n), recordedAt: at, firstCleared: false, rev: 0,
        findings: n === 1 ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => ({ fp: sha(100 + index), outcome: index < 5 ? "fixed" as const : "wrong" as const })) : [] };
      await applyTrackChange(world.store, COMPANY, { create: row, moves: [] });
    }
  };

  it("a replay run is stored once, audited and carries no pass; the summary is scored when asked", async () => {
    const world = createWorld();
    const stored = await world.evidence.replay(replayRun(GPT));
    expect(stored).toMatchObject({ ok: true, summary: { passed: true } });
    expect(await world.evidence.replay(replayRun(GPT))).toEqual({ ok: false, code: "run_exists" });
    expect(await world.evidence.replay({ runId: "bad" })).toEqual({ ok: false, code: "invalid" });
    expect(await world.store.get({ pk: `ORG#${COMPANY}`, sk: "SECONDREVIEW#REPLAY#run-1" })).not.toHaveProperty("passed");
    // The refused second try staged an event in a transaction that did not commit: only the committed one is in the ledger.
    expect((await world.store.query({ pk: `AUDIT#${COMPANY}`, sk: { op: "beginsWith", prefix: "EVENT#company.second_review_replay_recorded" } })).items).toHaveLength(1);
  });

  it("a verdict stores evidence only: the shadow counts are the company's own track record for the window, and the span is what was counted", async () => {
    const world = createWorld();
    await withRows(world);
    await world.evidence.replay(replayRun(GPT));
    const stored = await world.evidence.verdict({ model: GPT, replayRunId: "run-1", startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-11-01T00:00:00.000Z" });
    expect(stored).toMatchObject({ ok: true, holds: true, shadow: { reviews: 10, findings: 10, agreed: 5, passed: true } });
    const verdict = (await world.store.get({ pk: `ORG#${COMPANY}`, sk: `SECONDREVIEW#VERDICT#${KEY}` }))?.["verdict"] as { shadow: { startedAt: string; endedAt: string }; holds?: boolean };
    expect(verdict.shadow).toMatchObject({ startedAt: "2026-10-03T12:00:00.000Z", endedAt: "2026-10-21T12:00:00.000Z" });
    expect(verdict).not.toHaveProperty("holds");
    expect((await world.review.state()).evidence).toMatchObject({ holds: false });
  });

  it("is refused for a run that is missing or another model's, a window before the run or in the future, and a window with no second opinions", async () => {
    const world = createWorld();
    await withRows(world);
    const ask = (over: Partial<Parameters<typeof world.evidence.verdict>[0]> = {}) =>
      world.evidence.verdict({ model: GPT, replayRunId: "run-1", startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-11-01T00:00:00.000Z", ...over });
    expect(await ask()).toEqual({ ok: false, code: "run_missing" });
    await world.evidence.replay(replayRun(GEMINI));
    expect(await ask()).toEqual({ ok: false, code: "model_mismatch" });
    await world.evidence.replay(replayRun(GPT, { runId: "run-2", ranAt: "2026-10-05T00:00:00.000Z" }));
    expect(await ask({ replayRunId: "run-2" })).toEqual({ ok: false, code: "window_invalid" });
    expect(await ask({ replayRunId: "run-2", startedAt: "2026-10-06T00:00:00.000Z", endedAt: "2026-12-01T00:00:00.000Z" })).toEqual({ ok: false, code: "window_invalid" });
    await world.evidence.replay(replayRun(GPT, { runId: "run-3", ranAt: "2026-09-01T00:00:00.000Z" }));
    expect(await ask({ replayRunId: "run-3", startedAt: "2026-09-02T00:00:00.000Z", endedAt: "2026-09-20T00:00:00.000Z" })).toEqual({ ok: false, code: "no_shadow_evidence" });
    expect(world.audit.filter((event) => event.action === "company.second_review_verdict_recorded")).toEqual([]);
  });

  it("a short or disagreeing window is stored as it is and does NOT hold: the bar decides, not the writer", async () => {
    const world = createWorld();
    for (let n = 1; n <= 3; n += 1) await applyTrackChange(world.store, COMPANY, { create: { model: KEY, mode: "shadow", taskId: `t${String(n)}`, project: "web", candidateDigest: sha(n), recordedAt: `2026-10-0${String(n + 1)}T12:00:00.000Z`, firstCleared: false, rev: 0, findings: [] }, moves: [] });
    await world.evidence.replay(replayRun(GPT));
    expect(await world.evidence.verdict({ model: GPT, replayRunId: "run-1", startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-11-01T00:00:00.000Z" })).toMatchObject({ ok: true, holds: false, shadow: { passed: false } });
  });

  const failingRun = (over: Partial<ReturnType<typeof replayRun>> = {}) => replayRun(GPT, { runId: "run-2", ranAt: "2026-10-01T00:00:00.000Z", cases: passingCases().map((entry) => ({ ...entry, candidateCaught: false })), ...over });
  const window = { startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-11-01T00:00:00.000Z" };

  it("a verdict the owner WITHDREW is never written again, by the service or beneath it", async () => {
    const world = createWorld();
    await withRows(world);
    await world.review.apply(OWNER, { action: "replay", run: replayRun(GPT) });
    await world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-1", ...window });
    await world.review.apply(OWNER, { action: "choose", primary: GPT });
    expect(verdictHoldsFor(await readSecondReviewSettings(world.store, COMPANY, ""), GPT)).toBe(true);
    await world.review.apply(OWNER, { action: "withdraw", model: GPT });
    expect(verdictHoldsFor(await readSecondReviewSettings(world.store, COMPANY, ""), GPT)).toBe(false);
    // The same run and window, again: refused, and nothing comes back.
    await expect(world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-1", ...window })).rejects.toMatchObject({ code: "FORBIDDEN", message: (expect.stringContaining("withdrawn") as string) });
    expect(await world.evidence.verdict({ model: GPT, replayRunId: "run-1", ...window })).toEqual({ ok: false, code: "withdrawn" });
    // Even a write that raced the withdrawal cannot land: the put itself is conditional.
    const stored = (await world.store.get({ pk: `ORG#${COMPANY}`, sk: `SECONDREVIEW#VERDICT#${KEY}` }))!;
    expect((stored["verdict"] as { withdrawnAt?: string }).withdrawnAt).toBeDefined();
    expect(verdictHoldsFor(await readSecondReviewSettings(world.store, COMPANY, ""), GPT)).toBe(false);
  });

  it("a withdrawal that lands between the checks and the write still wins: the write is conditional, so a verdict prepared before the withdrawal is never stored over it", async () => {
    const world = createWorld();
    await withRows(world);
    await world.evidence.replay(replayRun(GPT));
    const deps = { store: world.store, audit: recordingAudit(world.audit), companyId: COMPANY, now: () => world.clock.now };
    const prepared = await prepareVerdict(deps, { model: GPT, replayRunId: "run-1", by: OWNER.personId, ...window });
    expect(prepared.ok).toBe(true);
    // The owner withdraws (the evidence stored earlier), then the prepared write is attempted.
    await world.evidence.verdict({ model: GPT, replayRunId: "run-1", ...window });
    expect(await withdrawVerdict(deps, { model: GPT, by: OWNER.personId })).toEqual({ ok: true });
    expect(await commitVerdict(deps, (prepared as { prepared: Parameters<typeof commitVerdict>[1] }).prepared, OWNER.personId)).toEqual({ ok: false, code: "withdrawn" });
    expect(verdictHoldsFor(await readSecondReviewSettings(world.store, COMPANY, ""), GPT)).toBe(false);
    expect(((await world.store.get({ pk: `ORG#${COMPANY}`, sk: `SECONDREVIEW#VERDICT#${KEY}` }))!["verdict"] as { withdrawnAt?: string }).withdrawnAt).toBeDefined();
  });

  it("replacing evidence that holds with evidence that does not, while blocking is on, is a lowering: the approvers port is asked, and a port that needs a different person refuses it", async () => {
    const world = createWorld({ approvers: secondPersonApprovers() });
    await withRows(world);
    await world.review.apply(OWNER, { action: "replay", run: replayRun(GPT) });
    await world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-1", ...window });
    await world.review.apply(OWNER, { action: "choose", primary: GPT });
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "on" });
    await world.review.apply(OWNER, { action: "replay", run: failingRun() });
    await expect(world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-2", ...window })).rejects.toMatchObject({ code: "FORBIDDEN", message: (expect.stringContaining("turn blocking off") as string) });
    // The holding verdict stands, the mode is still on and still blocks.
    const settings = await readSecondReviewSettings(world.store, COMPANY, "");
    expect(verdictHoldsFor(settings, GPT)).toBe(true);
    expect(planSecondReview({ switchOn: true, mode: "on", against: [SONNET], project: {}, forbidden: [], sources: [GPT], ...settings, companyModels: [GPT] })).toMatchObject({ run: true, mode: "on" });
    expect(world.audit.filter((event) => event.action === "company.second_review_verdict_recorded")).toHaveLength(1);
  });

  it("with Code's default approvers (the owner): the same change is allowed once, audited as one that lowers blocking; with blocking off it is an ordinary write", async () => {
    const world = createWorld();
    await withRows(world);
    await world.review.apply(OWNER, { action: "replay", run: replayRun(GPT) });
    await world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-1", ...window });
    await world.review.apply(OWNER, { action: "replay", run: failingRun() });
    // Blocking is off: nothing is lowered, no flag.
    const quiet = await world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-2", ...window });
    expect(quiet).toMatchObject({ status: "stored", holds: false });
    expect(world.audit.at(-1)!.details).not.toHaveProperty("lowersBlocking");
    // Put the holding evidence back (a new run id, since the verdict row is replaced), turn blocking on, and replace it again.
    await world.review.apply(OWNER, { action: "replay", run: replayRun(GPT, { runId: "run-3" }) });
    await world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-3", ...window });
    await world.review.apply(OWNER, { action: "choose", primary: GPT });
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "on" });
    await world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-2", ...window });
    expect(world.audit.at(-1)).toMatchObject({ action: "company.second_review_verdict_recorded", details: { holds: false, lowersBlocking: true } });
  });

  it("the evidence is the owner's, on a fresh page session: a stale one, and a person who may not administer, write nothing", async () => {
    const world = createWorld();
    await withRows(world);
    await expect(world.review.apply(OWNER, { action: "replay", run: replayRun(GPT) }, { fresh: false })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await expect(world.review.apply(MEMBER, { action: "replay", run: replayRun(GPT) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await world.store.get({ pk: `ORG#${COMPANY}`, sk: "SECONDREVIEW#REPLAY#run-1" })).toBeUndefined();
    await world.review.apply(OWNER, { action: "replay", run: replayRun(GPT) });
    await expect(world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-1", ...window }, { fresh: false })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(await world.store.get({ pk: `ORG#${COMPANY}`, sk: `SECONDREVIEW#VERDICT#${KEY}` })).toBeUndefined();
    await world.review.apply(OWNER, { action: "verdict", model: GPT, replayRunId: "run-1", ...window });
    await expect(world.review.apply(OWNER, { action: "withdraw", model: GPT }, { fresh: false })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(verdictHoldsFor(await readSecondReviewSettings(world.store, COMPANY, ""), GPT)).toBe(true);
  });

  it("a verdict can be read past the first page of models", async () => {
    const world = createWorld();
    for (let n = 0; n < 60; n += 1) await world.seedHoldingEvidence({ provider: "openrouter", modelId: `vendor/model-${String(n)}` });
    const settings = await readSecondReviewSettings(world.store, COMPANY, "");
    expect(settings.verdicts).toHaveLength(60);
  });
});

describe("the notice that the reviewer stopped qualifying", () => {
  const plan = (over: Partial<Parameters<typeof planSecondReview>[0]> = {}) => planSecondReview({ switchOn: true, mode: "shadow", against: [SONNET], project: {}, forbidden: [], sources: [OPUS, GPT], verdicts: [], replayRuns: [], ...over });
  const stopped = () => observationOf(plan({ companyModels: [GEMINI] }));

  it("is told once per change: the same problem writes nothing, a different one replaces it, and it holds model names and fixed words only", async () => {
    const world = createWorld();
    const first = stopped();
    expect(first).not.toBe("neutral");
    expect(await noteQualification(world.store, COMPANY, first, 1_000)).toBe("written");
    expect(await noteQualification(world.store, COMPANY, first, 2_000)).toBe("same");
    const notice = await readNotice(world.store, COMPANY);
    expect(notice).toMatchObject({ code: "choice-not-qualifying", status: "open" });
    expect(noticeLines(notice!)[0]).toContain("no longer qualifies");
    expect(JSON.stringify(notice)).not.toMatch(/sk-|secret/u);
    expect(await noteQualification(world.store, COMPANY, observationOf(plan({ sources: [SONNET] })), 3_000)).toBe("written");
    expect((await readNotice(world.store, COMPANY))!.code).toBe("no-candidate");
  });

  it("closes only after the reviewer qualified for 3 starts in a row, or 24 hours, and a problem seen again in between starts the count over", async () => {
    const world = createWorld();
    await noteQualification(world.store, COMPANY, stopped(), 0);
    expect(await noteQualification(world.store, COMPANY, undefined, 1_000)).toBe("recovering");
    expect(await noteQualification(world.store, COMPANY, stopped(), 2_000)).toBe("same");
    expect(await noteQualification(world.store, COMPANY, undefined, 3_000)).toBe("recovering");
    expect(await noteQualification(world.store, COMPANY, "neutral", 4_000)).toBe("none");
    expect(await noteQualification(world.store, COMPANY, undefined, 5_000)).toBe("recovering");
    expect(await noteQualification(world.store, COMPANY, undefined, 6_000)).toBe("closed");
    expect(await readNotice(world.store, COMPANY)).toBeUndefined();
    // By time: the first start that qualified was a day ago.
    await noteQualification(world.store, COMPANY, stopped(), 10_000);
    expect(await noteQualification(world.store, COMPANY, undefined, 11_000)).toBe("recovering");
    expect(await noteQualification(world.store, COMPANY, undefined, 11_000 + 24 * 3_600_000)).toBe("closed");
  });

  it("'seen' puts it away without closing the problem; only the notice with that key; the same problem coming back within a week is written already seen", async () => {
    const world = createWorld();
    const problem = stopped();
    await noteQualification(world.store, COMPANY, problem, 0);
    const key = (await readNotice(world.store, COMPANY))!.key;
    await expect(world.review.apply(OWNER, { action: "notice-seen", key: "0".repeat(32) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await world.review.apply(OWNER, { action: "notice-seen", key })).toEqual({ status: "applied" });
    expect(await readNotice(world.store, COMPANY)).toMatchObject({ status: "seen" });
    expect(await noteQualification(world.store, COMPANY, problem, 5_000)).toBe("same");
    // The cards for the owner: none once seen.
    expect(await world.review.noticeCards(OWNER)).toEqual([]);
  });

  it("a card for the owner (not a member) until seen, opening the settings page", async () => {
    const world = createWorld();
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "shadow" });
    await noteQualification(world.store, COMPANY, stopped(), 0);
    const [card] = await world.review.noticeCards(OWNER);
    expect(card).toMatchObject({ kind: "second_review_notice", project: "Company", openPath: "/app/second-review" });
    expect(await world.review.noticeCards(MEMBER)).toEqual([]);
    expect((await world.review.state()).notice).toMatchObject({ code: "choice-not-qualifying", seen: false });
    // With the mode off the page shows no notice.
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode: "off" });
    expect((await world.review.state()).notice).toBeNull();
  });

  it("a notice that cannot be written is logged by error name and never thrown", async () => {
    const world = createWorld();
    const logs: Array<Record<string, unknown>> = [];
    const broken = { ...world.store, get: async () => { throw Object.assign(new Error("secret detail"), { name: "Boom" }); } } as unknown as typeof world.store;
    expect(await noteQualification(broken, COMPANY, stopped(), 0, (entry) => logs.push(entry))).toBe("failed");
    expect(JSON.stringify(logs)).toContain("Boom");
    expect(JSON.stringify(logs)).not.toContain("secret detail");
  });
});

// ---- the track record

const FILE = "src/app.ts";
const finding = (text: string, file: string | undefined = FILE) => ({ text, origin: "INTRODUCED" as const, severity: "HIGH" as const, ...(file === undefined ? {} : { file }) });
const fp = (text: string) => workflowFindingFingerprint("CRITIC", { text, file: FILE });
const opinion = (texts: string[], round: number, model = GPT): SecondOpinion => SecondOpinionSchema.parse({
  mode: "shadow", company: model.provider === "openai" ? "openai" : "google", choice: "company", blockingCount: texts.length, blocked: false, wouldHaveBlocked: texts.length > 0, unavailable: false,
  report: { operationId: "00000000-0000-4000-8000-000000000001", candidateDigest: sha(round), role: "CRITIC", provider: model.provider, version: model.modelId, status: texts.length === 0 ? "PASS" : "FINDINGS", findings: texts.map((text) => finding(text)), readOnly: true, recordedAt: "2026-10-05T00:00:00.000Z" },
});
const storedOpinion = (round: number, texts: string[], at: string, model = GPT) => ({ candidateDigest: sha(round), recordedAt: at, opinion: opinion(texts, round, model) });
interface TaskDoc { entityType: string; taskId: string; project: string; workflow: { stage: string; reviews: unknown[]; acceptedFindings: unknown[] }; secondOpinion?: unknown; [key: string]: unknown }
const taskDoc = (over: Partial<TaskDoc> = {}): TaskDoc => ({ entityType: "DEVELOPER_TASK", taskId: "task-1", project: "web", workflow: { stage: "REVIEW", reviews: [], acceptedFindings: [] }, ...over });
const changing = (change: TrackChange, ...files: string[]): TrackChange => { for (const move of change.moves) if (move.to === "fixed") move.changed = new Set(files.map(fileHash)); return change; };

describe("the track record", () => {
  it("a new answered opinion creates one row (fingerprints only); an opinion that gave no answer writes nothing", () => {
    const next = taskDoc({ secondOpinion: storedOpinion(1, ["a", "b"], "2026-10-05T00:00:00.000Z") });
    const change = trackChangeOf(undefined, next);
    expect(change.create).toMatchObject({ model: KEY, mode: "shadow", taskId: "task-1", candidateDigest: sha(1), rev: 0 });
    expect(change.create!.findings.map((entry) => entry.fp)).toEqual([fp("a"), fp("b")]);
    expect(JSON.stringify(change)).not.toContain('"text"');
    const unavailable = SecondOpinionSchema.parse({ mode: "on", unavailableReason: "no-answer", blockingCount: 0, blocked: false, wouldHaveBlocked: false, unavailable: true });
    expect(trackChangeOf(undefined, taskDoc({ secondOpinion: { candidateDigest: sha(1), recordedAt: "2026-10-05T00:00:00.000Z", opinion: unavailable } }))).toEqual({ moves: [] });
    expect(trackChangeOf(undefined, { entityType: "OPERATION", secondOpinion: next["secondOpinion"] })).toEqual({ moves: [] });
  });

  it("the next round fixes what the same model no longer raises when the new code changed the cited file, and nothing else", async () => {
    const world = createWorld();
    const before = taskDoc({ secondOpinion: storedOpinion(1, ["a", "b"], "2026-10-05T00:00:00.000Z") });
    await applyTrackChange(world.store, COMPANY, trackChangeOf(undefined, before));
    const after = taskDoc({ secondOpinion: storedOpinion(2, ["b", "c"], "2026-10-06T00:00:00.000Z") });
    const change = trackChangeOf(before, after);
    // Nobody can say what the new code changed: nothing is fixed.
    await applyTrackChange(world.store, COMPANY, trackChangeOf(before, after));
    const key = trackRowKey(COMPANY, { model: KEY, recordedAt: "2026-10-05T00:00:00.000Z", taskId: "task-1", candidateDigest: sha(1) });
    expect((await world.store.get(key))!["findings"]).toMatchObject([{ outcome: "open" }, { outcome: "open" }]);
    await applyTrackChange(world.store, COMPANY, changing(change, FILE));
    const row = (await world.store.get(key))!["findings"] as Array<{ fp: string; outcome: string }>;
    expect(row.find((entry) => entry.fp === fp("a"))!.outcome).toBe("fixed");
    expect(row.find((entry) => entry.fp === fp("b"))!.outcome).toBe("open");
    // A different model's silence says nothing.
    const other = taskDoc({ secondOpinion: storedOpinion(3, [], "2026-10-07T00:00:00.000Z", GEMINI) });
    expect(trackChangeOf(after, other).moves).toEqual([]);
  });

  it("a reworded finding is the same finding; a finding that only moved lines is not fixed; the same words in another file are another finding", () => {
    expect(findingKey({ text: "Off by one in the LOOP bound (line 12)!", file: "./src/app.ts" })).toBe(findingKey({ text: "off by one in the loop bound line 40", file: "src/app.ts" }));
    expect(findingKey({ text: "same words", file: "src/a.ts" })).not.toBe(findingKey({ text: "same words", file: "src/b.ts" }));
  });

  it("an accepted risk is wrong for that finding only; a merge with findings standing marks them wrong, once", async () => {
    const world = createWorld();
    const opened = taskDoc({ secondOpinion: storedOpinion(1, ["a", "b"], "2026-10-05T00:00:00.000Z") });
    await applyTrackChange(world.store, COMPANY, trackChangeOf(undefined, opened));
    const accepted = taskDoc({ secondOpinion: opened["secondOpinion"], workflow: { stage: "REVIEW", reviews: [], acceptedFindings: [{ candidateDigest: sha(1), role: "CRITIC", fingerprint: fp("a") }] } });
    await applyTrackChange(world.store, COMPANY, trackChangeOf(opened, accepted));
    const key = trackRowKey(COMPANY, { model: KEY, recordedAt: "2026-10-05T00:00:00.000Z", taskId: "task-1", candidateDigest: sha(1) });
    expect(((await world.store.get(key))!["findings"] as Array<{ fp: string; outcome: string }>).map((entry) => entry.outcome)).toEqual(["wrong", "open"]);
    const merged = taskDoc({ secondOpinion: opened["secondOpinion"], workflow: { stage: "MERGED", reviews: [], acceptedFindings: accepted["workflow"].acceptedFindings } });
    const result = await applyTrackChange(world.store, COMPANY, trackChangeOf(accepted, merged));
    expect(result.moved).toBe(1);
    expect(((await world.store.get(key))!["findings"] as Array<{ outcome: string }>).map((entry) => entry.outcome)).toEqual(["wrong", "wrong"]);
  });

  it("the change feed keeps the rows: task records only, a failing write is logged by name, and a replay writes nothing twice", async () => {
    const world = createWorld();
    const changes: DocumentChange[] = [
      { sequence: "1", kind: "insert", cause: "write", key: { pk: "DEVTASK#1", sk: "META" }, after: { pk: "DEVTASK#1", sk: "META", ...(plain(taskDoc({ secondOpinion: storedOpinion(1, ["a"], "2026-10-05T00:00:00.000Z") })) as Record<string, never>) } },
      { sequence: "2", kind: "insert", cause: "write", key: { pk: "OP", sk: "1" }, after: { pk: "OP", sk: "1", entityType: "OPERATION" } },
    ];
    expect(await world.review.indexTrack(changes)).toEqual({ created: 1, moved: 0, failed: 0 });
    expect(await world.review.indexTrack(changes)).toMatchObject({ failed: 0 });
    expect((await readTrackRecord(world.store, COMPANY, KEY, { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" })).reviews).toBe(1);
    const failing = { ...world.store, put: async () => { throw Object.assign(new Error("nope"), { name: "Down" }); } } as unknown as typeof world.store;
    const logs: Array<Record<string, unknown>> = [];
    const { indexSecondReviewTrack } = await import("../../packages/broker/src/core/second-review/index.js");
    expect(await indexSecondReviewTrack(changes, failing, (entry) => logs.push(entry), COMPANY)).toMatchObject({ failed: 1 });
    expect(JSON.stringify(logs)).toContain("Down");
  });

  it("is read per company and per model; the default window is the last 90 days", async () => {
    const world = createWorld();
    await applyTrackChange(world.store, COMPANY, { create: { model: KEY, mode: "shadow", taskId: "t1", project: "web", candidateDigest: sha(1), recordedAt: "2026-11-01T00:00:00.000Z", firstCleared: false, rev: 0, findings: [] }, moves: [] });
    await applyTrackChange(world.store, COMPANY, { create: { model: KEY, mode: "shadow", taskId: "t0", project: "web", candidateDigest: sha(2), recordedAt: "2026-01-01T00:00:00.000Z", firstCleared: false, rev: 0, findings: [] }, moves: [] });
    await applyTrackChange(world.store, "org_11111111111111111111", { create: { model: KEY, mode: "shadow", taskId: "t9", project: "web", candidateDigest: sha(3), recordedAt: "2026-11-02T00:00:00.000Z", firstCleared: false, rev: 0, findings: [] }, moves: [] });
    const now = Date.parse("2026-11-10T00:00:00.000Z");
    expect((await readTrackRecord(world.store, COMPANY, KEY, undefined, now)).reviews).toBe(1);
    expect(TRACK_RECORD_DAYS).toBe(90);
    expect((await readTrackRecord(world.store, COMPANY, KEY, { from: "2025-12-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" })).reviews).toBe(2);
    expect((await readTrackRecord(world.store, COMPANY, secondReviewModelKey(GEMINI), undefined, now)).reviews).toBe(0);
  });
});

describe("the settings page's state", () => {
  it("lists the models the install can serve with their maker and cost, greys out the builder's company, and says who reviews now", async () => {
    const world = createWorld();
    const state = await world.review.state({ builder: [`${SONNET.provider}:${SONNET.modelId}`] });
    expect(state.fitKnown).toBe(true);
    expect(state.models.find((entry) => entry.model.modelId === SONNET.modelId)).toMatchObject({ eligible: false, ineligibleWhy: "same-company" });
    expect(state.models.find((entry) => entry.model.modelId === GPT.modelId)).toMatchObject({ eligible: true, company: "openai", costUsd: (expect.any(Number) as number) });
    expect(state.suggested.length).toBeGreaterThan(0);
    expect(state.current).toMatchObject({ source: "default" });
    expect(state.current.line).toContain("Using default");
    // Without the builder, fit is only "its maker is known".
    expect((await world.review.state()).fitKnown).toBe(false);
  });

  it("a chosen model that stops qualifying is not swapped: the state says nothing qualifies, naming why", async () => {
    const world = createWorld({ sources: [SONNET, GPT] });
    await world.review.apply(OWNER, { action: "choose", primary: GPT });
    world.seams.sources = async () => [SONNET];
    const state = await world.review.state({ builder: [`${SONNET.provider}:${SONNET.modelId}`] });
    expect(state.current).toMatchObject({ source: "choice", models: [], reason: "choice-not-qualifying" });
  });

  it("reads only: BASELINE and passing cases are fixtures, not settings", () => {
    expect(passingCases()).toHaveLength(50);
    expect(BASELINE.provider).toBe("amazon-bedrock");
  });
});

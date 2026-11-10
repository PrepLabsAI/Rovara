// Second review: the evidence that lets a model block, and the writers of it.
//   - The replay run (what the quality suite measured) and the verdict (which run a model rests on, and the shadow window) are written ONLY by the install's administrator: on the hosted service that is Rovara staff, on
//     a laptop it is the owner, on the local page in a page session opened within ten minutes (never with the API token, which every local tool holds). Never by a project or a member.
//   - The shadow window a verdict stores is the SPAN OF THE ROWS ACTUALLY COUNTED (the first and the last answered opinion in the window the writer named), not the window the writer typed.
//   - A verdict stores EVIDENCE, never a pass: `holds` is recomputed on every read from the stored replay run (`summarizeSecondReviewReplay`) and the shadow window (`secondReviewShadowPassed`), by
//     `secondReviewVerdictHolds`. The shadow counts are not typed in by the writer: they are counted from the company's own track record (track.ts) for the window the writer names.
//   - The company's owner can only WITHDRAW a verdict (the model then stops blocking at once), and cannot bring one back: a withdrawn model's verdict is never written again.
// Every write is one transaction with its audit event, so evidence never changes unaudited.
import {
  SecondReviewReplayRunSchema, SecondReviewVerdictSchema, change, secondReviewModelKey, secondReviewShadowPassed, secondReviewVerdictHolds, summarizeSecondReviewReplay, when,
  type AuditSink, type SecondReviewModelRef, type SecondReviewReplayRun, type SecondReviewReplaySummary, type SecondReviewVerdict, type TransactItem,
} from "@agentx/contracts";
import { stagedAudit } from "./mode.js";
import { secondReviewReplayKey, secondReviewVerdictKey, type SecondReviewSettings, type SecondReviewStore } from "./settings.js";
import { readTrackRecord } from "./track.js";

/** Whether the evidence on record lets `model` run in `on` NOW (recomputed; a withdrawn, missing or failing verdict is false). */
export function verdictHoldsFor(settings: Pick<SecondReviewSettings, "verdicts" | "replayRuns">, model: SecondReviewModelRef): boolean {
  const key = secondReviewModelKey(model);
  return settings.verdicts.some((verdict) => verdict.model === key && secondReviewVerdictHolds(verdict, settings.replayRuns.find((run) => run.runId === verdict.replayRunId)));
}

export type EvidenceFailure = "invalid" | "run_exists" | "run_missing" | "model_mismatch" | "window_invalid" | "no_shadow_evidence" | "not_found" | "already_withdrawn" | "withdrawn" | "conflict";
export interface EvidenceDeps { store: SecondReviewStore; audit: AuditSink; companyId: string; now(): number }
const companyTarget = (companyId: string) => ({ type: "company", id: companyId.slice(0, 100) });

async function commit(deps: EvidenceDeps, items: TransactItem[]): Promise<"ok" | "cancelled"> {
  return (await deps.store.transact(items)).applied ? "ok" : "cancelled";
}

/** Stores a replay run, once: a run id is never written twice (it is the evidence a verdict names, so it cannot change under it). The pass is not stored; the summary returned is scored now. */
export async function recordReplayRun(deps: EvidenceDeps, input: { run: unknown; by: string }): Promise<{ ok: true; summary: SecondReviewReplaySummary } | { ok: false; code: EvidenceFailure }> {
  const parsed = SecondReviewReplayRunSchema.safeParse(input.run);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const run = parsed.data;
  const summary = summarizeSecondReviewReplay(run.cases);
  const at = deps.now();
  const audit = stagedAudit(deps, { action: "company.second_review_replay_recorded", subject: companyTarget(deps.companyId), details: { runId: run.runId, cases: run.cases.length, passed: summary.passed } }, input.by, at);
  const result = await commit(deps, [{ kind: "put", item: { ...secondReviewReplayKey(deps.companyId, run.runId), entityType: "SECOND_REVIEW_REPLAY", run: JSON.parse(JSON.stringify(run)) as never, createdAt: at, createdBy: input.by }, condition: when.absent() }, ...audit]);
  return result === "ok" ? { ok: true, summary } : { ok: false, code: "run_exists" };
}

export interface VerdictRecord { verdict: SecondReviewVerdict; holds: boolean; replay: SecondReviewReplaySummary; shadow: { days: number; findings: number; agreed: number; reviews: number; passed: boolean } }

export interface PreparedVerdict { key: string; run: SecondReviewReplayRun; verdict: SecondReviewVerdict; record: VerdictRecord }

/**
 * Checks and builds the evidence for one model without writing it: the replay run it rests on (already stored) and a shadow window. The shadow counts are the broker's own, from the company's track record for that
 * window. The window must start after the run and must not end in the future. A model whose verdict the owner WITHDREW has none brought back: that is refused (`withdrawn`). The answer carries what holds NOW,
 * computed for the writer's information; it is not stored.
 */
export async function prepareVerdict(deps: EvidenceDeps, input: { model: SecondReviewModelRef; replayRunId: string; startedAt: string; endedAt: string; by: string }): Promise<{ ok: true; prepared: PreparedVerdict } | { ok: false; code: EvidenceFailure }> {
  const key = secondReviewModelKey(input.model);
  const at = deps.now();
  const started = Date.parse(input.startedAt), ended = Date.parse(input.endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started || ended > at) return { ok: false, code: "window_invalid" };
  const existing = await deps.store.get(secondReviewVerdictKey(deps.companyId, key));
  if (existing !== undefined && (existing["verdict"] as { withdrawnAt?: unknown } | undefined)?.withdrawnAt !== undefined) return { ok: false, code: "withdrawn" };
  // Write the verdict only against a run that exists and is this model's.
  const stored = await deps.store.get(secondReviewReplayKey(deps.companyId, input.replayRunId));
  const parsedRun = SecondReviewReplayRunSchema.safeParse(stored?.["run"]);
  if (!parsedRun.success) return { ok: false, code: "run_missing" };
  const run: SecondReviewReplayRun = parsedRun.data;
  if (secondReviewModelKey(run.candidate) !== key) return { ok: false, code: "model_mismatch" };
  if (started <= Date.parse(run.ranAt)) return { ok: false, code: "window_invalid" };
  const counted = await readTrackRecord(deps.store, deps.companyId, key, { from: new Date(started).toISOString(), to: new Date(ended).toISOString() });
  if (counted.reviews === 0 || counted.firstAt === undefined || counted.lastAt === undefined) return { ok: false, code: "no_shadow_evidence" };
  // The window the evidence rests on is what was counted: from the first to the last row, never the span the writer typed.
  const verdict = SecondReviewVerdictSchema.safeParse({
    model: key, replayRunId: run.runId, baseline: run.baseline,
    shadow: { startedAt: counted.firstAt, endedAt: counted.lastAt, findings: counted.findings, agreed: counted.agreed, reviews: counted.reviews },
    createdAt: new Date(at).toISOString(), createdBy: input.by,
  });
  if (!verdict.success) return { ok: false, code: "invalid" };
  const shadow = { days: counted.days, findings: counted.findings, agreed: counted.agreed, reviews: counted.reviews };
  return { ok: true, prepared: { key, run, verdict: verdict.data, record: { verdict: verdict.data, holds: secondReviewVerdictHolds(verdict.data, run), replay: summarizeSecondReviewReplay(run.cases), shadow: { ...shadow, passed: secondReviewShadowPassed(shadow) } } } };
}

/** Writes a prepared verdict with its audit event, in one transaction. A verdict withdrawn since it was prepared is not overwritten. */
export async function commitVerdict(deps: EvidenceDeps, prepared: PreparedVerdict, by: string, extra: { lowering?: true } = {}): Promise<({ ok: true } & VerdictRecord) | { ok: false; code: EvidenceFailure }> {
  const at = deps.now();
  const { shadow } = prepared.record;
  const audit = stagedAudit(deps, { action: "company.second_review_verdict_recorded", subject: companyTarget(deps.companyId), details: { model: prepared.key.slice(0, 128), runId: prepared.run.runId, days: shadow.days, findings: shadow.findings, agreed: shadow.agreed, holds: prepared.record.holds, ...(extra.lowering === true ? { lowersBlocking: true } : {}) } }, by, at);
  const result = await commit(deps, [{
    kind: "put", item: { ...secondReviewVerdictKey(deps.companyId, prepared.key), entityType: "SECOND_REVIEW_VERDICT", verdict: JSON.parse(JSON.stringify(prepared.verdict)) as never },
    condition: when.or(when.absent(), when.notExists(["verdict", "withdrawnAt"])),
  }, ...audit]);
  if (result !== "ok") {
    const there = await deps.store.get(secondReviewVerdictKey(deps.companyId, prepared.key));
    return { ok: false, code: (there?.["verdict"] as { withdrawnAt?: unknown } | undefined)?.withdrawnAt !== undefined ? "withdrawn" : "conflict" };
  }
  return { ok: true, ...prepared.record };
}

/** Stores the evidence for one model (`prepareVerdict`, then `commitVerdict`). The service asks the approvers port in between when the change would turn blocking off. */
export async function recordVerdict(deps: EvidenceDeps, input: { model: SecondReviewModelRef; replayRunId: string; startedAt: string; endedAt: string; by: string }): Promise<({ ok: true } & VerdictRecord) | { ok: false; code: EvidenceFailure }> {
  const prepared = await prepareVerdict(deps, input);
  return prepared.ok ? commitVerdict(deps, prepared.prepared, input.by) : prepared;
}

/** The owner withdraws a model's verdict: the model stops blocking at once. Withdrawing twice is refused; nothing here can bring a verdict back. */
export async function withdrawVerdict(deps: EvidenceDeps, input: { model: SecondReviewModelRef; by: string }): Promise<{ ok: true } | { ok: false; code: EvidenceFailure }> {
  const key = secondReviewModelKey(input.model);
  const at = deps.now();
  const audit = stagedAudit(deps, { action: "company.second_review_verdict_withdrawn", subject: companyTarget(deps.companyId), details: { model: key.slice(0, 128) } }, input.by, at);
  const when_ = new Date(at).toISOString();
  const result = await commit(deps, [{
    kind: "update", key: secondReviewVerdictKey(deps.companyId, key), ops: [change.set(["verdict", "withdrawnAt"], when_), change.set(["verdict", "withdrawnBy"], input.by)],
    condition: when.and(when.exists("verdict"), when.notExists(["verdict", "withdrawnAt"])),
  }, ...audit]);
  if (result === "ok") return { ok: true };
  // Refused: no such verdict, or it is withdrawn already.
  const there = await deps.store.get(secondReviewVerdictKey(deps.companyId, key));
  return { ok: false, code: there === undefined ? "not_found" : "already_withdrawn" };
}

/** What the settings page shows about the evidence for one model: whether it holds now (recomputed), and the numbers behind it. No person's id and no text. */
export interface EvidenceView {
  model: SecondReviewModelRef;
  holds: boolean;
  verdict: { recordedAt: string; withdrawn: boolean; shadowDays: number; shadowFindings: number; shadowAgreed: number; shadowPassed: boolean } | null;
  replay: SecondReviewReplaySummary | null;
}
export function evidenceViewOf(settings: Pick<SecondReviewSettings, "verdicts" | "replayRuns">, model: SecondReviewModelRef): EvidenceView {
  const key = secondReviewModelKey(model);
  const verdict = settings.verdicts.find((entry) => entry.model === key);
  const run = verdict === undefined ? undefined : settings.replayRuns.find((entry) => entry.runId === verdict.replayRunId);
  const days = verdict === undefined ? 0 : Math.max(0, Math.floor((Date.parse(verdict.shadow.endedAt) - Date.parse(verdict.shadow.startedAt)) / 86_400_000));
  return {
    model: { provider: model.provider, modelId: model.modelId }, holds: verdictHoldsFor(settings, model),
    verdict: verdict === undefined ? null : { recordedAt: verdict.createdAt, withdrawn: verdict.withdrawnAt !== undefined, shadowDays: days, shadowFindings: verdict.shadow.findings, shadowAgreed: verdict.shadow.agreed,
      shadowPassed: secondReviewShadowPassed({ days, findings: verdict.shadow.findings, agreed: verdict.shadow.agreed, ...(verdict.shadow.reviews === undefined ? {} : { reviews: verdict.shadow.reviews }) }) },
    replay: run === undefined ? null : summarizeSecondReviewReplay(run.cases),
  };
}

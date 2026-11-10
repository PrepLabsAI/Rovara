// Second review: the service the surfaces (the local pages, the owner routes, the MCP tools and the CLI) and the task flow call. It is the settings and state of the second review, and the glue its
// call sites carry (the review dispatch, the review end, the merge gate, the pull request body, the task view), written once over the document store and the policy seams.
//
// What a change here needs (and why it is not a route): choosing the model, setting the mode, withdrawing evidence and acknowledging that a second review did not run are the OWNER's acts, made on the local page in
// the owner's own browser session. A caller that only holds the API token (the CLI, an MCP tool) may read the state and open the page; it can never change them.
import {
  agentXError, configuredSecondReviewMode, narrowedSecondReviewModels, SecondReviewModelListSchema, secondReviewModelKey,
  type AcceptedFindingRef, type ApprovalProof, type ModelIdentifier, type Principal, type SecondReviewContext, type SecondReviewMode, type SecondReviewModelRef, type SecondReviewState,
} from "@agentx/contracts";
import { commitVerdict, evidenceViewOf, prepareVerdict, recordReplayRun, verdictHoldsFor, withdrawVerdict, type EvidenceDeps, type EvidenceFailure } from "./evidence.js";
import {
  approveSecondReviewModeChange, cancelSecondReviewModeChange, effectiveMode, getModeChange, needsAnotherPerson, openModeChanges, requestSecondReviewMode, stagedAudit, type ModeDeps, type ModeFailure, type ModeScope,
} from "./mode.js";
import { markNoticeSeen, noticeLines, readNotice, secondReviewNoticeItemsFor } from "./notice.js";
import { defaultModelLine, secondReviewPicker, SECOND_REVIEW_TYPICAL_REVIEW_TOKENS } from "./picker.js";
import { planSecondReview, secondReviewAcknowledgement } from "./plan.js";
import { acknowledgeSecondReview, type AcknowledgeResult, type AcknowledgeTask } from "./ack.js";
import { prepareSecondReview, type SecondReviewStart, type SecondReviewStartInput } from "./start.js";
import { anyScopeOn, companyChoiceUpdate, companyContextUpdate, projectNarrowingUpdate, readSecondReviewSettings } from "./settings.js";
import {
  secondOpinionFromReviewResult, secondOpinionOfTask, secondReviewMergeWait, secondReviewPullRequestLines, secondReviewTaskView, type SecondOpinionFromResultInput, type StoredSecondOpinion,
} from "./store.js";
import { SECOND_REVIEW_TRACK_CONSUMER, indexSecondReviewTrack, readTrackRecord, type ChangedFilesPort } from "./track.js";
import { defaultMayAdminister, isSecondReviewEnabled, secondReviewNow, type SecondReviewDeps } from "./seams.js";
import type { DocumentChange , summarizeSecondReviewReplay} from "@agentx/contracts";

/** What a change of the settings answers. `needs_approval`: the lowering waits for a different person (the approvers port needs one). */
export type SecondReviewActionResult =
  | { status: "applied"; mode?: SecondReviewMode; choice?: { models: SecondReviewModelRef[] } | null; context?: SecondReviewContext; projectNarrowing?: { models: SecondReviewModelRef[] } | null; evidence?: ReturnType<typeof evidenceViewOf> }
  | { status: "needs_approval"; changeId: string }
  | { status: "cancelled" }
  | { status: "stored"; replay?: ReturnType<typeof summarizeSecondReviewReplay>; holds?: boolean; shadow?: { days: number; findings: number; agreed: number; reviews: number; passed: boolean } };

export type SecondReviewAction =
  | { action: "choose"; primary: SecondReviewModelRef; backup?: SecondReviewModelRef | undefined }
  | { action: "clear" }
  | { action: "context"; context: SecondReviewContext }
  | { action: "narrow"; project: string; models: SecondReviewModelRef[] | null }
  | { action: "mode"; scope: "company" | "project"; project?: string | undefined; mode: SecondReviewMode | "inherit" }
  | { action: "approve-mode"; changeId: string; proof: ApprovalProof }
  | { action: "cancel-mode"; changeId: string }
  | { action: "withdraw"; model: SecondReviewModelRef }
  /** The install's administrator (on a laptop, the owner, on the page): the evidence that lets a model block. */
  | { action: "replay"; run: unknown }
  | { action: "verdict"; model: SecondReviewModelRef; replayRunId: string; startedAt: string; endedAt: string }
  | { action: "notice-seen"; key: string };

/** What each refusal of the mode writer says, in fixed words (the code decides the error, never a message from below). */
export function modeRefusal(code: ModeFailure): Error {
  switch (code) {
    case "not_eligible": return agentXError("FORBIDDEN", "Only the company's owner can change this.");
    case "reauth_required": return reauthRequired();
    case "second_person_required": return agentXError("FORBIDDEN", "A different person has to approve lowering this.");
    case "approval_unavailable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not check who may change this. Try again.");
    case "already_open": return agentXError("CHANGE_STALE", "A proposal to lower this is already waiting for a different person.");
    case "expired": return agentXError("CHANGE_STALE", "That proposal expired. Ask again.");
    case "not_found": return agentXError("NOT_FOUND", "No such proposal.");
    case "below_company_mode": return agentXError("FORBIDDEN", "A project can be as strict as the company's setting or stricter, never less strict.");
    case "verdict_missing": return agentXError("FORBIDDEN", "Blocking can be turned on only for a reviewer model whose trial record and replay check hold. Choose the model first, then wait for its record.");
    case "settings_unreadable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not read this setting. Try again.");
    default: return agentXError("CHANGE_STALE", "This setting changed. Reload and try again.");
  }
}

const REAUTH_MESSAGE = "That change needs a recent sign-in: open the page again with `rovara open second-review` and make the change within ten minutes.";
const reauthRequired = (): Error => agentXError("REAUTH_REQUIRED", REAUTH_MESSAGE);

/** What each refusal of an evidence writer says, in fixed words. */
function evidenceRefusal(code: EvidenceFailure): Error {
  switch (code) {
    case "run_exists": return agentXError("CHANGE_STALE", "A replay run with that id is stored already; runs are never changed.");
    case "run_missing": return agentXError("NOT_FOUND", "No such replay run for this company.");
    case "model_mismatch": return agentXError("CONFIG_INVALID", "That replay run is for another model.");
    case "window_invalid": return agentXError("CONFIG_INVALID", "The shadow window must start after the replay run and must not end in the future.");
    case "no_shadow_evidence": return agentXError("CONFIG_INVALID", "This company's track record has no second opinions from that model in that window.");
    case "withdrawn": return agentXError("FORBIDDEN", "The evidence for that model was withdrawn, and a withdrawn verdict is never brought back.");
    case "conflict": return agentXError("CHANGE_STALE", "The evidence could not be stored. Try again.");
    default: return agentXError("CONFIG_INVALID", "The evidence is not valid.");
  }
}

const builderOf = (values: readonly string[]): ModelIdentifier[] => values.flatMap((value) => {
  const at = value.indexOf(":");
  return at > 0 && at < value.length - 1 ? [{ provider: value.slice(0, at), modelId: value.slice(at + 1) }] : [];
});

export interface SecondReview {
  readonly deps: SecondReviewDeps;
  enabled(): boolean;
  /** The REVIEW dispatch asks: does this review carry a second reviewer? */
  prepare(input: SecondReviewStartInput): Promise<SecondReviewStart>;
  /** An operation reached a terminal status: gives back the allowance held for its second review, if any. Never throws. */
  operationEnded(operation: { secondReviewPlan?: { reservationId?: string | undefined } | undefined }): Promise<void>;
  /** The REVIEW step did not start after all (the task moved on, or the workspace was busy): gives the allowance back at once. */
  releaseHold(reservationId: string | undefined): Promise<void>;
  /** The REVIEW end asks: what the stored opinion of the code is now (undefined: nothing planned). */
  opinionOf(input: SecondOpinionFromResultInput): StoredSecondOpinion | undefined;
  /** The words a merge waits for, or undefined. */
  mergeWait(task: Parameters<typeof secondReviewMergeWait>[0]): string | undefined;
  /** The lines a pull request body carries. */
  prLines(task: { secondOpinion?: unknown }, candidateDigest: string | undefined, accepted?: readonly AcceptedFindingRef[]): string[];
  /** What the task page shows. */
  taskView(task: Parameters<typeof secondReviewTaskView>[0], candidateDigest: string | undefined): ReturnType<typeof secondReviewTaskView>;
  /** The state the settings page, the CLI and the MCP tool read. `builder`: the models that write the code (`provider:modelId`); absent: fit is only "its maker is known". */
  state(input?: { project?: string | undefined; builder?: readonly string[] | undefined }): Promise<SecondReviewState>;
  /**
   * One change of the settings or the evidence, by the owner (a person who may administer). Throws a fixed-word `AgentXError` for a refusal. `fresh`: the page session is recent (ten minutes); lowering, withdrawing and
   * every evidence write need it (REAUTH_REQUIRED otherwise). A caller that is not a page (in-process, tests) leaves it out and is taken as fresh: the page is the gate.
   */
  apply(principal: Principal, body: SecondReviewAction, options?: { fresh?: boolean }): Promise<SecondReviewActionResult>;
  /** The decision cards for the owner (the notice that the reviewer model stopped qualifying). */
  noticeCards(principal: Principal, openPath?: string): ReturnType<typeof secondReviewNoticeItemsFor>;
  /** Starts the track record's indexer on the store's change feed; returns what stops it. Absent feed: nothing runs (the record is not kept). */
  startTrackIndexer(options?: { changedFiles?: ChangedFilesPort }): Promise<{ stop(): Promise<void> } | undefined>;
  /** For a feed-less caller and for tests: index these changes now. */
  indexTrack(changes: readonly DocumentChange[], changedFiles?: ChangedFilesPort): ReturnType<typeof indexSecondReviewTrack>;
  /** The owner acknowledges that an `on` second review did not run (their own act, in their own browser session; the caller checked who may decide the task). */
  acknowledge(principal: Principal, task: AcknowledgeTask): Promise<AcknowledgeResult>;
  /** The acknowledgement an `on` second review that did not run needs, and its key: undefined when none is needed. */
  acknowledgement(task: { secondOpinion?: unknown; workflow?: { candidate?: { digest: string } | undefined } | undefined }): { key: string; text: string; cause: string } | undefined;
}

export function createSecondReview(deps: SecondReviewDeps): SecondReview {
  const log = deps.log ?? (() => undefined);
  const now = (): number => secondReviewNow(deps);
  const may = deps.mayAdminister ?? defaultMayAdminister;
  const modeDeps = (): ModeDeps => ({ store: deps.store, audit: deps.audit, approvers: deps.approvers, companyId: deps.companyId, now });
  const evidenceDeps = (): EvidenceDeps => ({ store: deps.store, audit: deps.audit, companyId: deps.companyId, now });
  const price = (model: ModelIdentifier) => deps.seams.price?.(model);

  async function listOf(project: string | undefined, against: readonly ModelIdentifier[], fitUnknown = false) {
    const sources = await deps.seams.sources(project ?? "");
    const forbidden = (await deps.seams.forbidden?.()) ?? [];
    const settings = await readSecondReviewSettings(deps.store, deps.companyId, project ?? "");
    const picker = secondReviewPicker({ sources, project: {}, forbidden, against, fitUnknown, price, verdicts: settings.verdicts, replayRuns: settings.replayRuns });
    return { picker, settings, sources, forbidden };
  }

  const service: SecondReview = {
    deps,
    enabled: () => isSecondReviewEnabled(deps),
    prepare: (input) => prepareSecondReview(deps, input),
    async operationEnded(operation) {
      const id = operation.secondReviewPlan?.reservationId;
      if (id !== undefined) await deps.admission.release(id).catch((error: unknown) => log({ event: "second_review.release_failed", errorName: error instanceof Error ? error.name : "unknown" }));
    },
    async releaseHold(reservationId) {
      if (reservationId !== undefined) await deps.admission.release(reservationId).catch(() => undefined);
    },
    opinionOf: (input) => (isSecondReviewEnabled(deps) ? secondOpinionFromReviewResult(input) : undefined),
    mergeWait: (task) => (isSecondReviewEnabled(deps) ? secondReviewMergeWait(task) : undefined),
    prLines: (task, digest, accepted) => (isSecondReviewEnabled(deps) ? secondReviewPullRequestLines(task, digest, accepted) : []),
    taskView: (task, digest) => (isSecondReviewEnabled(deps) ? secondReviewTaskView(task, digest) : undefined),
    acknowledgement(task) {
      if (!isSecondReviewEnabled(deps)) return undefined;
      const digest = task.workflow?.candidate?.digest;
      const opinion = secondOpinionOfTask(task, digest);
      const ack = opinion === undefined || digest === undefined ? { required: false as const } : secondReviewAcknowledgement(opinion, digest);
      return ack.required ? { key: ack.key, text: ack.text, cause: opinion?.unavailableReason ?? "no-answer" } : undefined;
    },

    async state(input = {}) {
      const project = input.project;
      const against = builderOf(input.builder ?? []);
      // Without the model that writes the code (the settings page: it differs per task) fit is only "its maker is known", and `fitKnown` says so; a task checks the real fit when it starts.
      const fitKnown = against.length > 0;
      const { picker, settings, sources, forbidden } = await listOf(project, against, !fitKnown);
      const mode = configuredSecondReviewMode({ project: settings.projectMode, companyDefault: settings.companyDefault, companyLock: settings.companyLock });
      const plan = !fitKnown ? undefined : planSecondReview({ switchOn: true, mode: mode === "off" ? "shadow" : mode, against, project: {}, forbidden, sources, verdicts: settings.verdicts, replayRuns: settings.replayRuns,
        companyModels: settings.companyModels, projectModels: settings.projectModels, price });
      const chosen = narrowedSecondReviewModels({ company: settings.companyModels, project: settings.projectModels });
      // The model the "turn on" decision is about: the company's (or the project's narrowed) primary, else the one that would review now. Its evidence and its track record on this company.
      const topSuggestion = picker.suggested[0]?.model;
      const primary = chosen.models?.[0] ?? (plan?.run === true ? plan.model : plan === undefined ? topSuggestion : undefined);
      const evidence = primary === undefined ? null : evidenceViewOf(settings, primary);
      const trackRecord = primary === undefined ? null : await readTrackRecord(deps.store, deps.companyId, secondReviewModelKey(primary), undefined, now()).catch(() => null);
      const pending = await openModeChanges(modeDeps(), now()).catch(() => []);
      const notice = await readNotice(deps.store, deps.companyId).catch(() => undefined);
      return {
        mode,
        modes: { company: effectiveMode(settings, { kind: "company" }), project: project === undefined ? null : settings.projectMode ?? null, effective: mode },
        pendingLowering: pending.some((change) => project === undefined || change.scope.kind === "company" || change.scope.project === project),
        pending: pending.map((change) => ({ changeId: change.id, scope: change.scope.kind, ...(change.scope.kind === "project" ? { project: change.scope.project } : {}), from: change.from, to: change.to, proposedByYou: false, expiresAt: new Date(change.expiresAt).toISOString() })),
        evidence: evidence,
        trackRecord: trackRecord,
        notice: notice === undefined || mode === "off" ? null : { key: notice.key, code: notice.code, seen: notice.status === "seen", lines: noticeLines(notice), createdAt: notice.createdAt },
        context: settings.context,
        alsoSees: settings.context === "same_as_first" ? "Second reviewer also sees what the first reviewer sees: the connected sources, lessons and step instructions." : null,
        models: picker.entries,
        suggested: picker.suggested.map((entry) => ({ provider: entry.model.provider, modelId: entry.model.modelId })),
        typicalReview: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS,
        choice: settings.companyModels === undefined ? null : { models: settings.companyModels },
        projectNarrowing: settings.projectModels === undefined ? null : { models: settings.projectModels },
        fitKnown,
        current: plan === undefined
          ? (chosen.choice === "company" && chosen.models !== undefined && chosen.models.length > 0
            ? { source: "company", models: chosen.models, line: `Reviewed by ${chosen.models[0]!.modelId} (company choice)` }
            : topSuggestion !== undefined ? { source: "default", models: [topSuggestion], line: defaultModelLine(topSuggestion, false) } : { source: "none", models: [], reason: "no-candidate" })
          : plan.run
          ? { source: plan.choice, models: plan.candidates, line: plan.choice === "default" ? defaultModelLine(plan.model, false) : `Reviewed by ${plan.model.modelId} (company choice)`, ...(plan.skipped.length === 0 ? {} : { skipped: plan.skipped }) }
          : { source: chosen.choice === "company" ? "choice" : "none", models: [], reason: plan.reason, ...(plan.skipped === undefined ? {} : { skipped: plan.skipped }) },
      } as SecondReviewState;
    },

    async apply(principal, body, options = {}) {
      const fresh = options.fresh !== false;
      if (!isSecondReviewEnabled(deps)) throw agentXError("NOT_FOUND", "route not found");
      const admin = may(principal);
      // Everything here is the owner's: Code has one company and one person who administers it (a project's maintainer is that person).
      if (!admin) throw agentXError("FORBIDDEN", "Only the company's owner can change this.");
      if ((body.action === "narrow" || (body.action === "mode" && body.scope === "project")) && (await deps.seams.projectExists?.(body.action === "narrow" ? body.project : body.project ?? "")) === false) throw agentXError("NOT_FOUND", "Not found.");
      const at = now();
      const by = principal.personId;
      const target = { type: "company", id: deps.companyId.slice(0, 100) };
      /** The change and its audit event in ONE transaction: a change is never unaudited, and an audit event never names a change that was not made. */
      const commit = async (item: Parameters<SecondReviewDeps["store"]["transact"]>[0][number], event: Parameters<typeof stagedAudit>[1]): Promise<void> => {
        const result = await deps.store.transact([item, ...stagedAudit(deps, event, by, at)]);
        if (!result.applied) throw agentXError("CHANGE_STALE", "This setting changed. Reload and try again.");
      };
      if (body.action === "clear") {
        await commit(companyChoiceUpdate({ companyId: deps.companyId, models: undefined, by, at }), { action: "company.second_review_choice_changed", subject: target, details: { change: "clear", count: 0 } });
        return { status: "applied", choice: null };
      }
      if (body.action === "context") {
        // Not a loosening that needs a second person, but it widens what is shared with the second reviewer's company when it goes to `same_as_first`, so the audit event says so.
        const current = (await readSecondReviewSettings(deps.store, deps.companyId, "")).context;
        await commit(companyContextUpdate({ companyId: deps.companyId, context: body.context, by, at }),
          { action: "company.second_review_context_changed", subject: target, details: { to: body.context, widens: current === "change_only" && body.context === "same_as_first" } });
        return { status: "applied", context: body.context };
      }
      if (body.action === "mode") {
        const scope: ModeScope = body.scope === "company" ? { kind: "company" } : { kind: "project", project: body.project ?? "" };
        if (body.scope === "company" && (body.project !== undefined || body.mode === "inherit")) throw agentXError("CONFIG_INVALID", "scope: a company mode names no project and is not inherited");
        if (body.scope === "project" && (body.project === undefined || body.project === "")) throw agentXError("CONFIG_INVALID", "project: required");
        // `on` needs the evidence for the model the company (or the project's narrowed list) chose first; with nobody having chosen there is no model for the evidence to be about.
        const settings = await readSecondReviewSettings(deps.store, deps.companyId, scope.kind === "project" ? scope.project : "");
        const chosen = scope.kind === "company" ? settings.companyModels : narrowedSecondReviewModels({ company: settings.companyModels, project: settings.projectModels }).models;
        const onAllowed = chosen?.[0] !== undefined && verdictHoldsFor(settings, chosen[0]);
        const result = await requestSecondReviewMode(modeDeps(), { scope, to: body.mode, requestedBy: principal, onAllowed, requesterIsAdmin: admin, fresh });
        if (!result.ok) throw modeRefusal(result.code);
        log({ event: "second_review.mode_set", status: result.status });
        return result.status === "needs_approval" ? { status: "needs_approval", changeId: result.changeId } : { status: "applied", mode: result.mode };
      }
      if (body.action === "approve-mode") {
        const result = await approveSecondReviewModeChange(modeDeps(), { changeId: body.changeId, approver: principal, proof: body.proof, fresh });
        if (!result.ok) throw modeRefusal(result.code);
        return { status: "applied", mode: result.mode };
      }
      if (body.action === "cancel-mode") {
        if ((await getModeChange(deps.store, deps.companyId, body.changeId).catch(() => undefined)) === undefined) throw agentXError("NOT_FOUND", "No such proposal.");
        const result = await cancelSecondReviewModeChange(modeDeps(), { changeId: body.changeId, actor: principal });
        if (!result.ok) throw modeRefusal(result.code);
        return { status: "cancelled" };
      }
      if (body.action === "notice-seen") {
        if (!(await markNoticeSeen(deps.store, deps.companyId, body.key, at))) throw agentXError("CHANGE_STALE", "That notice changed or was seen already. Reload.");
        return { status: "applied" };
      }
      if (body.action === "replay") {
        if (!fresh) throw reauthRequired();
        const stored = await recordReplayRun(evidenceDeps(), { run: body.run, by });
        if (!stored.ok) throw evidenceRefusal(stored.code);
        return { status: "stored", replay: stored.summary };
      }
      if (body.action === "verdict") {
        if (!fresh) throw reauthRequired();
        const prepared = await prepareVerdict(evidenceDeps(), { model: body.model, replayRunId: body.replayRunId, startedAt: body.startedAt, endedAt: body.endedAt, by });
        if (!prepared.ok) throw evidenceRefusal(prepared.code);
        // Replacing evidence that holds with evidence that does not turns blocking off for a model that is blocking now: that is a lowering, so it asks the approvers port as one does. A port that needs a different
        // person is refused here (lower the mode first, which makes the proposal); the owner on a laptop may do it, audited as a lowering.
        const before = verdictHoldsFor(await readSecondReviewSettings(deps.store, deps.companyId, ""), body.model);
        const lowering = before && !prepared.prepared.record.holds && await anyScopeOn(deps.store, deps.companyId);
        if (lowering) {
          const another = await needsAnotherPerson(modeDeps(), { kind: "company" }, "on", "shadow", principal);
          if (another !== false) throw agentXError("FORBIDDEN", "Replacing evidence that holds with evidence that does not would turn blocking off. Lower the mode first: that needs a different person where your company asks for one.");
        }
        const stored = await commitVerdict(evidenceDeps(), prepared.prepared, by, lowering ? { lowering: true } : {});
        if (!stored.ok) throw evidenceRefusal(stored.code);
        return { status: "stored", holds: stored.holds, replay: stored.replay, shadow: stored.shadow };
      }
      if (body.action === "withdraw") {
        if (!fresh) throw reauthRequired();
        const result = await withdrawVerdict(evidenceDeps(), { model: body.model, by });
        if (!result.ok) throw result.code === "not_found" ? agentXError("NOT_FOUND", "No such verdict.") : agentXError("CHANGE_STALE", "That verdict was withdrawn already.");
        return { status: "applied", evidence: evidenceViewOf(await readSecondReviewSettings(deps.store, deps.companyId, ""), body.model) };
      }
      // A model must be one the install can use today (its providers, allowed, not forbidden); fit against a particular builder is checked when a review starts, not here.
      const { picker, settings } = await listOf(body.action === "narrow" ? body.project : undefined, []);
      const usable = new Set(picker.entries.map((entry) => secondReviewModelKey(entry.model)));
      const requested: SecondReviewModelRef[] = body.action === "choose" ? [body.primary, ...(body.backup === undefined ? [] : [body.backup])] : body.models ?? [];
      if (!SecondReviewModelListSchema.safeParse(requested).success) throw agentXError("CONFIG_INVALID", "models: a model appears twice");
      if (requested.some((model) => !usable.has(secondReviewModelKey(model)))) throw agentXError("MODEL_NOT_ALLOWED", "That model is not one this install can use.");
      if (body.action === "choose") {
        await commit(companyChoiceUpdate({ companyId: deps.companyId, models: requested, by, at }), { action: "company.second_review_choice_changed", subject: target, details: { change: "choose", count: requested.length } });
        return { status: "applied", choice: { models: requested } };
      }
      // Narrowing: a subset of the company's choice, never wider. With no company choice it is a subset of the models the install can use.
      if (settings.companyModels !== undefined) {
        const allowed = new Set(settings.companyModels.map(secondReviewModelKey));
        if (requested.some((model) => !allowed.has(secondReviewModelKey(model)))) throw agentXError("FORBIDDEN", "A project can narrow the company's choice but never widen it.");
      }
      await commit(projectNarrowingUpdate({ companyId: deps.companyId, project: body.project, models: body.models === null ? undefined : requested, by, at }),
        { action: "project.second_review_narrowed", subject: { type: "project", id: body.project }, details: { change: body.models === null ? "clear" : "choose", count: requested.length } });
      return { status: "applied", projectNarrowing: body.models === null ? null : { models: requested } };
    },

    async acknowledge(principal, task) {
      if (!isSecondReviewEnabled(deps)) return { ok: false, reason: "not_required" };
      const digest = task.workflow?.candidate?.digest;
      if (digest === undefined) return { ok: false, reason: "stale" };
      return acknowledgeSecondReview({ store: deps.store, audit: deps.audit, companyId: deps.companyId, now }, task, { candidateDigest: digest, by: principal });
    },

    noticeCards: (principal, openPath) => secondReviewNoticeItemsFor({ store: deps.store, companyId: deps.companyId, mayAct: () => isSecondReviewEnabled(deps) && may(principal), ...(openPath === undefined ? {} : { openPath }) }),

    async startTrackIndexer(options = {}) {
      const feed = (deps.store as { changes?: { subscribe: (consumer: string, handler: (changes: readonly DocumentChange[]) => Promise<void>) => Promise<{ stop(): Promise<void> }> } }).changes;
      if (feed === undefined) return undefined;
      return feed.subscribe(SECOND_REVIEW_TRACK_CONSUMER, async (changes) => {
        if (!isSecondReviewEnabled(deps)) return;
        await indexSecondReviewTrack(changes, deps.store, log, deps.companyId, options.changedFiles);
      });
    },
    indexTrack: (changes, changedFiles) => indexSecondReviewTrack(changes, deps.store, log, deps.companyId, changedFiles),
  };
  return service;
}

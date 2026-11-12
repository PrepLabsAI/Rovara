// Fix with agent (light tier) on the core's ports: a person who may drive a task asks for a diagnosis of the error the task page showed. The owner's own model answers it, with no tools, from the task's own data.
//
// The flow is the hosted one with the chat service folded in. `start` checks the person, that the error is the one shown, the open place and the rates, asks `Admission`, keeps the context text on the waiting request (never in
// a queue) and starts the answer turn in this process; the turn asks the `DiagnosisAnswerer` (the install's model call: a seam, so no provider is named here), reads the answer again (`sanitizeDiagnosis`), stores the
// proposals and audits them in the same transaction. A diagnosis can never act: what it writes is its own records (the request, the result, the person link, the rate counters and the audit), and its proposals are text for a
// person. Anything a proposal suggests is done by the owner on the page, by the ordinary forms.
//
// Who pays: the owner, on their own key (the shared rule: Rovara never pays for a diagnosis). With no key, or a model whose price is not known, a diagnosis is not offered, in fixed words, before anything is spent.
import {
  DIAGNOSIS_TURN_QUESTION, DiagnosisIdSchema, DiagnosisRecordSchema, DiagnosisStartBodySchema, DiagnosisStatusSchema, agentXError, errorRefKey,
  type Admission, type AuditSink, type DiagnosisFailureReason, type DiagnosisRecord, type DiagnosisStatus, type DocumentStore, type ErrorRef, type OrgId, type Principal,
} from "@agentx/contracts";
import { admissionRefusal } from "../task-flow/admission.js";
import { developerIdOf } from "../sessions/create.js";
import { SessionStore } from "../sessions/store.js";
import type { TaskRecord } from "../task-flow/records.js";
import { diagnosisProposedEvent, diagnosisStartedEvent } from "./audit.js";
import { currentFacts, nonceFor, renderDiagnosisContext, type DiagnosisContextPorts } from "./context.js";
import { proposalCounts, sanitizeDiagnosis } from "./sanitize.js";
import { REQUEST_STALE_MS, admitDiagnosis, diagnosisIdFor, latestDiagnosisFor, openDiagnosisFor, readDiagnosisRecord, readDiagnosisRequest, readDiagnosisRequester, settleDiagnosis, type DiagnosisRequest } from "./store.js";
import { DIAGNOSIS_LAPTOP_INSTRUCTIONS, DIAGNOSIS_LAPTOP_WORDS, DIAGNOSIS_MAX_OUTPUT_TOKENS, diagnosisWordsChecked, type DiagnosisWords } from "./words.js";

/** The error kinds a diagnosis is offered for: the ones whose current state this install can read again. */
export const DIAGNOSABLE_KINDS: ReadonlySet<string> = new Set(["workflow_block", "operation_failed"]);
/** The longest an answer turn runs before it is given up. */
export const DIAGNOSIS_TURN_TIMEOUT_MS = 90_000;

/** Why a model could not be used, as a fixed word: `no_model` (no key set up), `not_priced` (the model's price is not known), or why the call failed. */
export type DiagnosisModelFailure = DiagnosisFailureReason | "no_model" | "not_priced" | "too_dear" | "other";
export class DiagnosisModelProblem extends Error {
  /**
   * `sent`: whether the request may have reached the provider. False only for a failure known to come before it (no model, no price, a refusal by the proxy before it forwards): the held allowance is then given back.
   * Anything else (the default, and any error that is not this one) may have been charged by the provider, so the allowance is settled.
   */
  constructor(readonly reason: DiagnosisModelFailure, readonly sent: boolean = true) {
    super(reason);
    this.name = "DiagnosisModelProblem";
  }
}

/**
 * What answers a diagnosis: one model turn with no tools, given the rules and the error's data as `context` and a fixed question. The adapter chooses the model and is the only code that holds a key (the model proxy signs
 * the call). It must honour `signal`, and says which model answered and what the call used.
 */
export interface DiagnosisAnswerer {
  /**
   * Whether a diagnosis can run now. Asked at the start, so an install with no key says so before anything is spent. With the context it would be given, it also says whether the most that call could cost is over the
   * diagnosis's spending limit (`too_dear`), so a call that could only be refused costs no rate slot.
   */
  prepare(request?: { context: string; question: string; maxOutputTokens: number }): Promise<{ ok: true } | { ok: false; reason: "no_model" | "not_priced" | "too_dear" }>;
  answer(input: { context: string; question: string; maxOutputTokens: number; signal: AbortSignal; diagnosisId: string; taskId?: string | undefined; project: string }): Promise<{
    text: string; model: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
  }>;
}

export interface DiagnosisDependencies {
  store: DocumentStore;
  audit: AuditSink;
  companyId: OrgId;
  /** Off (the flip-back setting): every diagnosis route answers "not found" as if it did not exist. Default on. */
  enabled?: boolean | undefined;
  /** Asked before a diagnosis spends (`model.call`, with an estimate); its reservation is settled with the usage or released. Absent: no check. */
  admission?: Admission | undefined;
  answerer?: DiagnosisAnswerer | undefined;
  context: DiagnosisContextPorts;
  /** The task the person may drive, or undefined (a task of someone else, or one that is not there, reads the same: nothing). */
  taskOf(principal: Principal, taskId: string): Promise<TaskRecord | undefined>;
  /** What a person is told when a diagnosis is refused or cannot run (every refusal and next step). Absent: a laptop's words (`DIAGNOSIS_LAPTOP_WORDS`). A host with other screens and commands passes its own whole set. */
  words?: DiagnosisWords | undefined;
  now?: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export type DiagnosisCaller = { principal: Principal };

/** What the task page and the tools read of a task's error: whether a diagnosis is offered, why not, and the diagnosis of this error if there is one. */
export interface TaskDiagnosisView {
  /** The reference of the error the task shows now, when it shows one. */
  errorRef?: ErrorRef | undefined;
  offered: boolean;
  /** Why it is not offered (fixed words), when it is not. */
  why?: string | undefined;
  diagnosis: DiagnosisStatus | null;
}

const notFound = () => agentXError("NOT_FOUND", "route not found");

/** A fixed reason from a failed turn: what the model problem says, else the generic words (a failure's own text is never kept). */
const reasonOf = (error: unknown): DiagnosisFailureReason | undefined => {
  const reason = error instanceof DiagnosisModelProblem ? error.reason : undefined;
  return reason === "model_rejected" || reason === "key_invalid" || reason === "limit_reached" || reason === "provider_unavailable" ? reason : undefined;
};

export function createDiagnosis(deps: DiagnosisDependencies) {
  const words = diagnosisWordsChecked(deps.words ?? DIAGNOSIS_LAPTOP_WORDS);
  const refusals = words.refusals;
  const whyNot = (reason: "no_model" | "not_priced" | "too_dear"): string => (reason === "not_priced" ? refusals.notPriced : reason === "too_dear" ? refusals.tooDear : refusals.noProvider);
  const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", refusals.couldNot);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const store = { store: deps.store, now, log };
  const orgId = deps.companyId;
  const sessions = new SessionStore(deps.store);
  const running = new Set<Promise<void>>();
  const enabled = (): boolean => deps.enabled !== false;

  /** The project and, for a task error, the task, when the person may diagnose this error now. Fails closed: anything unreadable answers undefined. */
  async function subjectFor(principal: Principal, ref: ErrorRef): Promise<{ project: string; task: TaskRecord } | undefined> {
    const subject = ref.subject;
    try {
      let taskId: string | undefined;
      if ("taskId" in subject) taskId = subject.taskId;
      else if ("sessionId" in subject) {
        const session = await sessions.get(orgId, subject.sessionId);
        taskId = session?.subject.kind === "task" ? session.subject.taskId : undefined;
      }
      if (taskId === undefined) return undefined;
      const task = await deps.taskOf(principal, taskId);
      return task === undefined || task.closedAt !== undefined ? undefined : { project: task.project, task };
    } catch {
      return undefined;
    }
  }

  async function statusOf(request: DiagnosisRequest): Promise<DiagnosisStatus> {
    const base = { diagnosisId: request.diagnosisId, tier: request.tier, errorRef: request.errorRef } as const;
    // A request nobody answered in time reads as failed, never as waiting for ever; the open place is freed so the error can be asked about again.
    if (request.state === "queued" && now() - Date.parse(request.createdAt) > REQUEST_STALE_MS) {
      await settleDiagnosis(store, orgId, request, { state: "failed" }).catch(() => undefined);
      return DiagnosisStatusSchema.parse({ ...base, state: "failed", failure: refusals.couldNot });
    }
    if (request.state === "ready") {
      const record = await readDiagnosisRecord(store, orgId, request.diagnosisId);
      if (record !== undefined) return DiagnosisStatusSchema.parse({ ...base, state: "ready", proposals: record.proposals, droppedProposals: record.droppedProposals, needsCode: record.needsCode });
      return DiagnosisStatusSchema.parse({ ...base, state: "failed", failure: refusals.couldNot });
    }
    if (request.state === "failed") return DiagnosisStatusSchema.parse({ ...base, state: "failed", failure: request.failureReason === undefined ? refusals.couldNot : words.failure[request.failureReason] });
    return DiagnosisStatusSchema.parse({ ...base, state: "queued" });
  }

  /** The answer turn: the model call, the stored result. Never throws; a failure ends the diagnosis `failed` in fixed words. */
  async function turn(request: DiagnosisRequest, context: string, requester: string, held: { reservationId?: string | undefined; estimateTokens: number }, taskId: string | undefined): Promise<void> {
    // The allowance this diagnosis holds is given back or settled ONCE. Once the request may have reached the provider it is only ever SETTLED (with what the call used, else the estimate): the model may have been paid,
    // whatever happens to the answer next (no suggestion survived, the write failed, the turn timed out or was aborted after the send).
    let reservation = held.reservationId;
    const resolve = async (how: "release" | "settle", tokens?: number): Promise<void> => {
      const id = reservation;
      reservation = undefined;
      if (id === undefined || deps.admission === undefined) return;
      await (how === "release" ? deps.admission.release(id) : deps.admission.settle(id, { tokens: tokens ?? held.estimateTokens })).catch(() => undefined);
    };
    const fail = async (error: unknown): Promise<void> => {
      const reason = reasonOf(error);
      log({ event: "diagnosis.failed", reason: error instanceof DiagnosisModelProblem ? error.reason : "turn_failed", error: error instanceof Error ? error.name : undefined });
      await resolve(error instanceof DiagnosisModelProblem && !error.sent ? "release" : "settle");
      await settleDiagnosis(store, orgId, request, { state: "failed", ...(reason === undefined ? {} : { reason }) }).catch(() => undefined);
    };
    try {
      if (deps.answerer === undefined) return await fail(new DiagnosisModelProblem("no_model", false));
      const outcome = await deps.answerer.answer({
        context, question: DIAGNOSIS_TURN_QUESTION, maxOutputTokens: DIAGNOSIS_MAX_OUTPUT_TOKENS, signal: AbortSignal.timeout(DIAGNOSIS_TURN_TIMEOUT_MS), diagnosisId: request.diagnosisId, taskId, project: request.project,
      });
      // The provider answered: settle now, before anything below can fail. A response that said nothing of what it used is charged the most it could have cost, never nothing.
      await resolve("settle", outcome.usage === undefined ? held.estimateTokens : outcome.usage.input + outcome.usage.output);
      const sanitized = sanitizeDiagnosis(outcome.text);
      if (sanitized.proposals.length === 0) return await fail(new Error("no_proposals"));
      const nowMs = now();
      const record: DiagnosisRecord = DiagnosisRecordSchema.parse({
        diagnosisId: request.diagnosisId, errorRef: request.errorRef, tier: "light", proposals: sanitized.proposals, droppedProposals: sanitized.dropped, needsCode: sanitized.needsCode,
        // The cost is not kept on the record: the proxy meters the call against the task, so the cost is read there.
        model: outcome.model.slice(0, 200), costCents: 0, createdAt: new Date(nowMs).toISOString(), ttl: Math.floor(nowMs / 1000) + 30 * 86_400,
      });
      const audit = deps.audit.stage(diagnosisProposedEvent({
        companyId: orgId, developerId: requester, at: new Date(nowMs).toISOString(), diagnosisId: request.diagnosisId, proposals: sanitized.proposals, dropped: sanitized.dropped,
      }));
      const settled = await settleDiagnosis(store, orgId, request, { state: "ready", record }, audit);
      if (!settled) log({ event: "diagnosis.already_ended", diagnosis: request.diagnosisId, counts: proposalCounts(sanitized.proposals).explain });
    } catch (error) {
      await fail(error);
    }
  }

  async function startFor(principal: Principal, value: unknown): Promise<DiagnosisStatus> {
    if (!enabled()) throw notFound();
    const body = DiagnosisStartBodySchema.safeParse(value);
    if (!body.success) throw agentXError("CONFIG_INVALID", "a diagnosis needs a request ID and the error reference the page showed");
    const { errorRef } = body.data;
    if (!DIAGNOSABLE_KINDS.has(errorRef.kind)) throw agentXError("NOT_FOUND", refusals.notAvailable);
    if (principal.companyId !== orgId) throw agentXError("FORBIDDEN", refusals.notAllowed);
    const subject = await subjectFor(principal, errorRef);
    if (subject === undefined) throw agentXError("FORBIDDEN", refusals.notAllowed);
    const developerId = developerIdOf(principal);
    const tier = "light" as const;

    // The same request again, or the same error while its diagnosis is open: the existing diagnosis, with nothing spent and nothing built.
    const own = await readDiagnosisRequest(store, orgId, diagnosisIdFor(orgId, developerId, body.data.requestId, tier));
    if (own !== undefined) return statusOf(own);
    const open = await openDiagnosisFor(store, orgId, tier, errorRef);
    if (open !== undefined) {
      const existing = await readDiagnosisRequest(store, orgId, open);
      if (existing !== undefined) return statusOf(existing);
    }

    // The owner's own model, with a key and a known price, or nothing is offered (before anything is spent or built).
    const answerer = deps.answerer;
    const first = answerer === undefined ? { ok: false as const, reason: "no_model" as const } : await answerer.prepare().catch(() => { throw unavailable(); });
    if (answerer === undefined || !first.ok) throw agentXError("MODEL_NOT_ALLOWED", whyNot(first.ok ? "no_model" : first.reason));
    const facts = await currentFacts(deps.context, { orgId, developerId }, errorRef, subject);
    if (facts === undefined) throw agentXError("CONFIG_INVALID", refusals.notCurrent);
    const diagnosisId = diagnosisIdFor(orgId, developerId, body.data.requestId, tier);
    const rendered = renderDiagnosisContext(facts, nonceFor(deps.context.tagKey, diagnosisId));
    const context = `${DIAGNOSIS_LAPTOP_INSTRUCTIONS}\n\n${rendered.text}`;
    // The most this call could cost is checked now, before a rate slot or an allowance is taken: a model that is too dear for this much context could only be refused after the press.
    const fits = await answerer.prepare({ context, question: DIAGNOSIS_TURN_QUESTION, maxOutputTokens: DIAGNOSIS_MAX_OUTPUT_TOKENS }).catch(() => { throw unavailable(); });
    if (!fits.ok) throw agentXError("MODEL_NOT_ALLOWED", whyNot(fits.reason));

    // Admission (budgets and forbidden models of a hosted install plug in here; Code's default allows everything): a diagnosis costs model money, so it asks like any other call.
    const estimateTokens = Math.ceil(Buffer.byteLength(context, "utf8") / 4) + DIAGNOSIS_MAX_OUTPUT_TOKENS;
    let reservationId: string | undefined;
    if (deps.admission !== undefined) {
      const decision = await deps.admission.admit({
        companyId: orgId, idempotencyKey: `diagnosis:${diagnosisId}`, action: "model.call", actor: principal, projectName: subject.project,
        subject: { type: "task", id: subject.task.taskId }, estimate: { tokens: estimateTokens },
      });
      if (!decision.allowed) throw admissionRefusal(decision);
      reservationId = decision.reservationId;
    }
    const giveBack = async (): Promise<void> => { if (reservationId !== undefined) await deps.admission?.release(reservationId).catch(() => undefined); };
    let admitted: { diagnosisId: string; created: boolean };
    try {
      admitted = await admitDiagnosis(store, {
        orgId, developerId, requestId: body.data.requestId, tier, errorRef: facts.errorRef, project: subject.project, context, rateLimitedWords: refusals.rateLimited,
        extraItems: deps.audit.stage(diagnosisStartedEvent({ companyId: orgId, developerId, at: new Date(now()).toISOString(), diagnosisId, errorKind: facts.errorRef.kind, errorCode: facts.errorRef.code, tier })),
      });
    } catch (error) {
      await giveBack();
      throw error;
    }
    const request = await readDiagnosisRequest(store, orgId, admitted.diagnosisId);
    if (request === undefined) { await giveBack(); throw unavailable(); }
    // A repeat, or a race another call won, took its own reservation: this one goes back.
    if (!admitted.created) { await giveBack(); return statusOf(request); }
    const going = turn(request, context, developerId, { reservationId, estimateTokens }, subject.task.taskId).finally(() => { running.delete(going); });
    running.add(going);
    return statusOf(request);
  }

  return {
    /** What this diagnosis says to a person (the host's own words, or a laptop's): a host's routes and pages say the same sentences. */
    words,
    /** Whether the diagnosis routes are served at all (the flip-back setting). */
    enabled,

    /** The diagnosis of an error the page showed. A repeat of the same request is the same diagnosis and spends nothing. */
    start: startFor,

    /** Where a diagnosis is, for the person who may diagnose its error now (anyone else: not found, so its existence never leaks). */
    async status(principal: Principal, diagnosisId: string): Promise<DiagnosisStatus> {
      if (!enabled()) throw notFound();
      if (!DiagnosisIdSchema.safeParse(diagnosisId).success || principal.companyId !== orgId) throw notFound();
      const request = await readDiagnosisRequest(store, orgId, diagnosisId);
      if (request === undefined || await subjectFor(principal, request.errorRef) === undefined) throw notFound();
      return statusOf(request);
    },

    /** What a task's page and the tools read: the error the task shows now, whether a diagnosis is offered for it, and the diagnosis that is open or was answered for it. */
    async forTask(principal: Principal, taskId: string): Promise<TaskDiagnosisView | undefined> {
      if (!enabled() || principal.companyId !== orgId) return undefined;
      const task = await deps.taskOf(principal, taskId);
      if (task === undefined) return undefined;
      const view = await deps.context.taskView(task);
      const errorRef = view.errorRef;
      if (errorRef === undefined || !DIAGNOSABLE_KINDS.has(errorRef.kind) || task.closedAt !== undefined) return { offered: false, diagnosis: null };
      const request = await latestDiagnosisFor(store, orgId, developerIdOf(principal), errorRef);
      const diagnosis = request === undefined ? null : await statusOf(request);
      // A diagnosis that failed leaves the error free to be asked about again; one that is waiting or answered is the answer.
      const ready = deps.answerer === undefined ? { ok: false as const, reason: "no_model" as const } : await deps.answerer.prepare().catch(() => undefined);
      if (ready === undefined) return { errorRef, offered: false, why: refusals.couldNot, diagnosis };
      if (!ready.ok) return { errorRef, offered: false, why: whyNot(ready.reason), diagnosis };
      // A button that could only be refused is not drawn: with the context this error would send, the most the call could cost is checked against the diagnosis's spending limit.
      if (diagnosis === null || diagnosis.state === "failed") {
        const subject = { project: task.project, task };
        const facts = await currentFacts(deps.context, { orgId, developerId: developerIdOf(principal) }, errorRef, subject).catch(() => undefined);
        if (facts !== undefined && deps.answerer !== undefined) {
          const context = `${DIAGNOSIS_LAPTOP_INSTRUCTIONS}\n\n${renderDiagnosisContext(facts, nonceFor(deps.context.tagKey, "dgn_00000000000000000000")).text}`;
          const fits = await deps.answerer.prepare({ context, question: DIAGNOSIS_TURN_QUESTION, maxOutputTokens: DIAGNOSIS_MAX_OUTPUT_TOKENS }).catch(() => undefined);
          if (fits !== undefined && !fits.ok) return { errorRef, offered: false, why: whyNot(fits.reason), diagnosis };
        }
      }
      return { errorRef, offered: true, diagnosis };
    },

    /** The page's "Fix with agent": the error the page showed is named by its key, and must still be the one the task shows. */
    async startForTask(principal: Principal, taskId: string, input: { requestId: string; errorKey: string }): Promise<DiagnosisStatus> {
      if (!enabled()) throw notFound();
      if (principal.companyId !== orgId) throw agentXError("FORBIDDEN", refusals.notAllowed);
      const task = await deps.taskOf(principal, taskId);
      if (task === undefined) throw agentXError("FORBIDDEN", refusals.notAllowed);
      const errorRef = (await deps.context.taskView(task)).errorRef;
      if (errorRef === undefined || errorRefKey(errorRef) !== input.errorKey) throw agentXError("CONFIG_INVALID", refusals.notCurrent);
      return startFor(principal, { requestId: input.requestId, errorRef });
    },

    /** Who asked (for a test or an erase); undefined once the person link is gone. */
    requesterOf: (diagnosisId: string): Promise<string | undefined> => readDiagnosisRequester(store, orgId, diagnosisId),

    /** Resolves when every turn this process started has ended (a test waits on it; the process never needs to). */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}

export type Diagnosis = ReturnType<typeof createDiagnosis>;

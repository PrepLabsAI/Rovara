// "Ask about this task" (the hosted product's `agent-sessions/ask.ts`, `ask-store.ts` and `ask-audit.ts`, written on the document store). The owner asks a question about a task's session, and a
// model with no tools answers it from the task's own data. Read-only: an Ask changes nothing but its own records (the request item, the rate items, the lock, the answer). The answer is never sent to the agent: "Tell the
// agent" is a message the owner sends as themselves.
//
// The flow is the hosted one with the chat service folded in: `submit` spends the rates (20 an hour for the person, 100 a day for the task), takes the one-at-a-time lock, records the waiting Ask (ids and a state, never the
// question) and starts the answer turn; the turn builds the context for the web tier (`loadAskContext`), asks the `AskAnswerer` (the install's model call: a seam, so no provider is named here), and `complete` stores the
// answer (30 days, with the asker's words scrubbed like every stored text), audits it (ids, sizes and the model; never the words) and lets the lock go. The asker reads the state and the answer with `status`; anyone else
// reads "not found". The words a refusal says are fixed and repeat nothing of the question.
//
// Keys are the hosted product's: `ASKREQ#`, `ASKLOCK#`, `ASK#` in the session's partition and the `SESSION_RATE#` items, so a Cloud install can read what this one wrote.
import { createHash, createHmac } from "node:crypto";
import {
  ASK_ANSWER_LABEL, ASK_ANSWER_MAX_CHARS, ASK_LIMITS, ASK_RATE, ASK_TURN_RULES, AskBodySchema, AskRecordSchema, AskStatusSchema, INDEX_EXPIRY_ATTRIBUTE, ASK_RETENTION_DAYS, agentXError, companyScoped, askLockKey, askRequestKey,
  hideEmailAddresses, redactText, sessionAskKey, sessionRateKey, when,
  type Admission, type AgentSessionRecord, type AskRecord, type AskStatus, type AuditSink, type DocumentStore, type OrgId, type Principal, type SessionId, type TransactItem,
} from "@agentx/contracts";
import { admissionRefusal } from "../task-flow/admission.js";
import { createSessionAccess, requireAsk, requireLevelOf, type SessionMembers } from "./access.js";
import { developerIdOf } from "./create.js";
import { loadAskContext, storeAskReaders, type AskContextReaders, type AskLoadDeps } from "./ask-context-load.js";
import { neutralizeSlackMentions } from "./slack-mentions.js";
import { SessionStore } from "./store.js";

/** The words a refusal says. Fixed: no refusal repeats the question or anything of the task. */
export const ASK_RATE_TEXT = "You've asked a lot of questions lately. Try again a little later.";
export const ASK_BUSY_TEXT = "One question at a time: wait for the answer to your last one.";
export const ASK_CLOSED_TEXT = "This task is closed, so it can't be asked about.";
export const ASK_UNAVAILABLE_TEXT = "Couldn't answer that just now.";
/** Most Asks one person may make in an hour across every task (Cloud's older per-person cap), beside the per-session rates. */
export const ASK_PER_PERSON_ALL_TASKS_PER_HOUR = 30;
export const ASK_NOT_SET_UP_TEXT = "Ask needs a model, and none is set up on this computer.";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** How long a waiting Ask holds its person's lock; a turn is given far less. */
export const ASK_LOCK_SECONDS = 15 * 60;
/** A request item is kept a day: long enough to answer a repeat, short enough that nothing about the Ask lingers. */
const REQUEST_TTL_SECONDS = 86_400;
/** How many times an Ask reads the shared counters and tries again after losing a race to another Ask. */
export const RATE_RACE_ATTEMPTS = 4;
/** The longest an answer turn runs before it is given up. */
export const ASK_TURN_TIMEOUT_MS = 90_000;
const ASK_TTL_SECONDS = ASK_RETENTION_DAYS * 86_400;

/**
 * What answers an Ask: one model turn with no tools, given the rules and the task's data as `context` and the owner's words as `question`. The adapter chooses the model and is the only code that holds a key; it says
 * which model answered and what the call used (so the task's cost holds it). It must honour `signal`.
 */
export interface AskAnswerer {
  /** Whether a model is set up now. Absent: always (a failure then ends the Ask `failed`). Asked at submit, so an install with no model says so before anything is spent. */
  available?(): Promise<boolean>;
  answer(input: { context: string; question: string; maxOutputTokens: number; signal: AbortSignal; taskId: string }): Promise<{ text: string; model: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; provider: string; modelId: string } | undefined }>;
}

export interface AskDependencies extends AskLoadDeps {
  store: DocumentStore;
  audit: AuditSink;
  /** Off (the flip-back setting): the Ask routes answer "not found" as if they did not exist. Default on. */
  enabled?: boolean | undefined;
  /** Asked before an Ask spends (`model.call`, with an estimate); its reservation is settled with the usage or released. Absent: no check (Code's default admission allows everything). */
  admission?: Admission | undefined;
  /** Absent: Ask is not set up, and an Ask says so. */
  answerer?: AskAnswerer | undefined;
  /** Where a call's usage is recorded against the task's cost (the cost ledger); absent: nothing is recorded. Never throws into the Ask. */
  recordUsage?: ((entry: { taskId: string; entryId: string; usage: NonNullable<Awaited<ReturnType<AskAnswerer["answer"]>>["usage"]> }) => Promise<unknown>) | undefined;
  /** The readers of the context beyond the task row (the diff and the check output); the timeline and the notes come from the store. */
  readers?: ((session: AgentSessionRecord) => Pick<AskContextReaders, "diff" | "checkTails">) | undefined;
  /** Where the company's people come from for the session levels (decisions 103, 104: `use`, or `view` with a working role on the project). Default: the local owner alone. */
  members?: SessionMembers | undefined;
  /** Replaces the session levels with a yes or no of its own (a test, or an adapter with its own rules); a no reads as a missing session. */
  authorize?: ((principal: Principal, session: AgentSessionRecord) => boolean | Promise<boolean>) | undefined;
  /** Keys the hash that recognises the same question again (at least 16 bytes: the broker's signing key). */
  questionHashKey: string | Uint8Array;
  now?: () => Date;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The Ask's id: the same person and request give the same id, so a repeat is the same Ask. */
export function askIdFor(orgId: string, developerId: string, requestId: string): string {
  return `ask_${sha(`ask\u0000${orgId}\u0000${developerId}\u0000${requestId}`).slice(0, 20)}`;
}

/** A keyed hash of the question: it only recognises the same Ask again, and cannot be looked up in a table of questions without the key. */
export function askQuestionHash(key: string | Uint8Array, askId: string, question: string): string {
  if ((typeof key === "string" ? Buffer.byteLength(key, "utf8") : key.byteLength) < 16) throw new Error("the question hash key is too short");
  return createHmac("sha256", key).update(`ask-question\0${askId}\0${question}`, "utf8").digest("hex");
}

/** The words as they are stored: secrets redacted, mentions and email addresses made neutral. */
export const scrubAskText = (text: string): string => hideEmailAddresses(neutralizeSlackMentions(redactText(text)));

type Document = Record<string, unknown>;

/** The fixed word an error carries as its `reason` (`provider_status_401`, `request_not_allowed`), or undefined: only a short lower-case word is ever logged, never the provider's text. */
const causeOf = (error: unknown): string | undefined => {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && /^[a-z0-9_]{1,40}$/u.test(reason) ? reason : undefined;
};
/** Failures that are Rovara's own (not the asker's and not the provider's): the Ask did not run, so it does not use up a rate slot. */
const OWN_FAILURES: ReadonlySet<string> = new Set(["access_lost", "no_answerer", "no_context", "no_model", "provider_not_set_up", "no_credential", "sign_in_failed", "request_not_allowed"]);

/** A shared counter in a window (a person's hour, a task's day): whether there is room, and the write that takes one place, conditioned on the counter as it was read. */
async function rateStep(store: DocumentStore, key: { pk: string; sk: string }, scope: { orgId: OrgId; sessionId?: string }, limit: number, windowMs: number, nowMs: number): Promise<{ room: boolean; item: TransactItem }> {
  const window = Math.floor(nowMs / windowMs) * windowMs;
  const stored = await store.get(key);
  const seenWindow = stored?.["windowStart"];
  const seenCount = stored?.["count"];
  if (stored !== undefined && (typeof seenWindow !== "number" || typeof seenCount !== "number")) throw agentXError("RUNTIME_UNAVAILABLE", ASK_UNAVAILABLE_TEXT);
  const count = typeof seenWindow === "number" && seenWindow === window && typeof seenCount === "number" ? seenCount : 0;
  return {
    room: count < limit,
    item: {
      kind: "put",
      item: { ...key, entityType: "SESSION_RATE", orgId: scope.orgId, ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }), windowStart: window, count: count + 1, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((window + 2 * windowMs) / 1000) },
      condition: stored === undefined ? when.absent() : when.and(when.eq("windowStart", seenWindow as number), when.eq("count", seenCount as number)),
    },
  };
}

const personAllTasksKey = (orgId: OrgId, askerKey: string): { pk: string; sk: string } => ({ pk: companyScoped(orgId, "ASK_PERSON_RATE"), sk: askerKey });

export function createAsk(deps: AskDependencies) {
  const now = deps.now ?? (() => new Date());
  const sessions = new SessionStore(deps.store);
  const log = deps.log ?? (() => undefined);
  const running = new Set<Promise<void>>();
  const access = createSessionAccess({ store: deps.store, members: deps.members });

  const notFound = () => agentXError("NOT_FOUND", "There is no such session.");

  /**
   * The session the person may ask about (`ask`) or read an Ask of (`read`, which needs `view`). A person with no level reads what a missing session reads; a person who may view but not ask is told so
   * (the hosted product's SESSION_LEVEL_REQUIRED).
   */
  async function sessionFor(principal: Principal, orgId: OrgId, sessionId: SessionId, purpose: "ask" | "read"): Promise<AgentSessionRecord> {
    if (principal.companyId !== orgId) throw notFound();
    const session = await sessions.get(orgId, sessionId);
    if (session === undefined) throw notFound();
    if (deps.authorize !== undefined) {
      if (!(await deps.authorize(principal, session))) throw notFound();
      return session;
    }
    const found = await access.of(principal, session);
    return (purpose === "ask" ? requireAsk(found) : requireLevelOf(found, "view", "read it")).session;
  }

  /** Whether the asker may still ask, checked again when the answer turn starts (a person whose access ended since asking gets nothing). */
  async function mayStillAsk(principal: Principal, session: AgentSessionRecord): Promise<boolean> {
    try {
      const now1 = await sessions.get(session.orgId, session.sessionId);
      if (now1 === undefined) return false;
      if (deps.authorize !== undefined) return await deps.authorize(principal, now1);
      return (await access.of(principal, now1)).mayAsk;
    } catch {
      return false;
    }
  }

  const statusOf = async (orgId: OrgId, sessionId: SessionId, askId: string, request: Document): Promise<AskStatus> => {
    const state = request["state"];
    // A waiting Ask that nobody answered within the lock's time was dropped: it reads as failed, never as waiting for ever.
    if (state === "queued" && typeof request["createdAt"] === "string" && now().getTime() - Date.parse(request["createdAt"]) > ASK_LOCK_SECONDS * 1000) return AskStatusSchema.parse({ askId, state: "failed" });
    if (state === "answered") {
      const record = await readAsk(orgId, sessionId, askId, String(request["askerKey"]));
      return AskStatusSchema.parse({ askId, state: "answered", ...(record?.answer === undefined ? {} : { answer: record.answer }) });
    }
    return AskStatusSchema.parse({ askId, state: state === "failed" ? "failed" : "queued" });
  };

  /** A web Ask as its asker reads it. Only the person who asked sees an answer, and not one that has expired but is not yet removed. */
  async function readAsk(orgId: OrgId, sessionId: SessionId, askId: string, viewer: string): Promise<AskRecord | undefined> {
    const item = await deps.store.get(sessionAskKey(orgId, sessionId, askId));
    if (item === undefined || item["orgId"] !== orgId) return undefined;
    const parsed = AskRecordSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([name]) => !["pk", "sk", "entityType", "orgId", "sessionId", INDEX_EXPIRY_ATTRIBUTE].includes(name))));
    if (!parsed.success || parsed.data.audience !== "web" || parsed.data.askedBy !== viewer || parsed.data.ttl * 1000 <= now().getTime()) return undefined;
    return parsed.data;
  }

  /** Ends a waiting Ask in `state` and lets its person's lock go. Conditional on the state it was in, so only the first ending counts. Answers whether this call ended it. */
  async function settle(orgId: OrgId, sessionId: SessionId, askId: string, askerKey: string, state: "answered" | "failed", extra: readonly TransactItem[] = []): Promise<boolean> {
    const result = await deps.store.transact([
      { kind: "update", key: askRequestKey(orgId, sessionId, askId), ops: [{ op: "set", path: ["state"], value: state }, { op: "set", path: ["settledAt"], value: now().toISOString() }], condition: when.eq("state", "queued") },
      ...extra,
    ]);
    if (!result.applied) return false;
    // The lock is let go only if it is still this Ask's.
    await deps.store.update({ key: askLockKey(orgId, sessionId, askerKey), ops: [{ op: "set", path: ["expiresAt"], value: 0 }], condition: when.eq("askId", askId) }).catch(() => undefined);
    return true;
  }

  /** Gives the three rate slots of an Ask that never ran back (best effort: a counter that moved on to another window is left alone). */
  async function refund(orgId: OrgId, sessionId: SessionId, askerKey: string, submittedMs: number): Promise<void> {
    const slots: Array<[{ pk: string; sk: string }, number]> = [
      [sessionRateKey(orgId, sessionId, askerKey, "ask"), HOUR_MS], [sessionRateKey(orgId, sessionId, "task", "ask_day"), DAY_MS], [personAllTasksKey(orgId, askerKey), HOUR_MS],
    ];
    for (const [key, windowMs] of slots) {
      await deps.store.update({ key, ops: [{ op: "add", path: ["count"], amount: -1 }], condition: when.and(when.eq("windowStart", Math.floor(submittedMs / windowMs) * windowMs), when.gt("count", 0)) }).catch(() => undefined);
    }
  }

  /** The answer turn: the context, one model call, the stored answer. Never throws; a failure ends the Ask `failed` in fixed words. */
  async function turn(principal: Principal, session: AgentSessionRecord, askId: string, askerKey: string, question: string, held: { reservationId?: string | undefined; submittedMs: number; estimateTokens: number }): Promise<void> {
    const { orgId, sessionId } = session;
    // The allowance this Ask holds is given back or settled ONCE. Once the request may have reached the provider, it is only ever SETTLED (with what the call used, else the estimate): the model may have been paid.
    let reservation = held.reservationId;
    const resolve = async (how: "release" | "settle", tokens?: number): Promise<void> => {
      const id = reservation;
      reservation = undefined;
      if (id === undefined || deps.admission === undefined) return;
      await (how === "release" ? deps.admission.release(id) : deps.admission.settle(id, { tokens: tokens ?? held.estimateTokens })).catch(() => undefined);
    };
    const fail = async (reason: string, error?: unknown): Promise<void> => {
      const cause = causeOf(error);
      log({ event: "ask.failed", reason, ...(cause === undefined ? {} : { cause }), error: error instanceof Error ? error.name : undefined });
      // A failure that is Rovara's own (no model, a request the guard refused) is one where nothing was sent: the allowance goes back and the slots too. Any other failure of the call (a timeout, an abort, the
      // provider's own error, an answer thrown away) is settled at the estimate, since the provider may have charged for it.
      const never = reason !== "turn_failed" ? OWN_FAILURES.has(reason) : cause !== undefined && OWN_FAILURES.has(cause);
      await resolve(never ? "release" : "settle");
      if (!(await settle(orgId, sessionId, askId, askerKey, "failed").catch(() => false))) return;
      if (never) await refund(orgId, sessionId, askerKey, held.submittedMs);
    };
    try {
      if (deps.answerer === undefined || session.subject.kind !== "task") return await fail("no_answerer");
      // The context is built for the asker's access NOW: one whose access ended since asking gets nothing, and nothing is sent.
      if (!(await mayStillAsk(principal, session))) return await fail("access_lost");
      const context = await loadAskContext(deps, session, storeAskReaders(deps, session, deps.readers?.(session)));
      if (context === undefined) return await fail("no_context");
      const outcome = await deps.answerer.answer({ context: `${ASK_TURN_RULES}\n\n${context.text}`, question, maxOutputTokens: ASK_LIMITS.answerMaxOutputTokens, signal: AbortSignal.timeout(ASK_TURN_TIMEOUT_MS), taskId: session.subject.taskId });
      // The provider answered: the call is paid whatever happens to the answer next (an empty answer, a failing write, an Ask that ended meanwhile). It is settled and counted against the task now, before any of that can fail.
      // A response that said nothing of what it used is charged the most it could have cost (the context as input, the output limit), never nothing.
      const [provider, ...modelParts] = outcome.model.split("/");
      const usage = outcome.usage ?? { input: Math.ceil(context.bytes / 4), output: ASK_LIMITS.answerMaxOutputTokens, cacheRead: 0, cacheWrite: 0, provider: modelParts.length === 0 ? "unknown" : provider!, modelId: (modelParts.length === 0 ? outcome.model : modelParts.join("/")).slice(0, 200) };
      if (outcome.usage === undefined) log({ event: "ask.unmetered", code: "charged_maximum" });
      await resolve("settle", usage.input + usage.output);
      if (deps.recordUsage !== undefined) await deps.recordUsage({ taskId: session.subject.taskId, entryId: `ask:${askId}`, usage }).catch((error: unknown) => log({ event: "ask.usage_not_recorded", error: error instanceof Error ? error.name : "unknown" }));
      const answer = scrubAskText(outcome.text).trim().slice(0, ASK_ANSWER_MAX_CHARS).trim();
      if (answer === "") return await fail("empty_answer");
      const nowMs = now().getTime();
      const record = AskRecordSchema.parse({
        askId, audience: "web", askedBy: askerKey, question: scrubAskText(question), answer, questionSha256: askQuestionHash(deps.questionHashKey, askId, question), contextBytes: context.bytes,
        answerBytes: Buffer.byteLength(answer, "utf8"), model: outcome.model.slice(0, 200), createdAt: new Date(nowMs).toISOString(), ttl: Math.floor(nowMs / 1000) + ASK_TTL_SECONDS,
      });
      const expiry = { [INDEX_EXPIRY_ATTRIBUTE]: record.ttl };
      // The answer and its audit (ids, the audience, sizes and the model; never the words) are stored with the request's ending, in one transaction: an Ask is answered and audited, or neither.
      const stored: TransactItem[] = [
        { kind: "put", item: { ...sessionAskKey(orgId, sessionId, askId), entityType: "ASK", orgId, sessionId, ...JSON.parse(JSON.stringify(record)) as Record<string, never>, ...expiry }, condition: when.absent() },
        ...deps.audit.stage({ eventId: `session:${sessionId}:asked:${askId}`, companyId: orgId, at: new Date(nowMs).toISOString(), actor: { type: "person", id: askerKey }, action: "task.asked", subject: { type: "session", id: sessionId } }),
      ];
      if (!(await settle(orgId, sessionId, askId, askerKey, "answered", stored))) return;
    } catch (error) {
      await fail("turn_failed", error);
    }
  }

  return {
    /** A person who may ask (decisions 103, 104) asks about a task's session. Answers the Ask's id and that it is queued; the answer is read with `status`. A repeat of the same request is the same Ask and spends nothing. */
    async submit(principal: Principal, orgId: OrgId, sessionId: SessionId, value: unknown): Promise<AskStatus> {
      if (deps.enabled === false) throw agentXError("NOT_FOUND", "route not found");
      const body = AskBodySchema.safeParse(value);
      if (!body.success) throw agentXError("CONFIG_INVALID", "an ask needs a request ID and a question of 1 to 1,000 characters");
      const session = await sessionFor(principal, orgId, sessionId, "ask");
      if (session.subject.kind !== "task") throw agentXError("CONFIG_INVALID", "You can ask about a task's session.");
      if (deps.answerer === undefined || (deps.answerer.available !== undefined && !(await deps.answerer.available().catch(() => false)))) throw agentXError("RUNTIME_UNAVAILABLE", ASK_NOT_SET_UP_TEXT);
      const task = await deps.store.get({ pk: `DEVTASK#${session.subject.taskId}`, sk: "META" });
      if (task === undefined) throw notFound();
      if (task["closedAt"] !== undefined) throw agentXError("SESSION_ENDED", ASK_CLOSED_TEXT);
      const askerKey = developerIdOf(principal);
      const askId = askIdFor(orgId, askerKey, body.data.requestId);
      const requestKey = askRequestKey(orgId, sessionId, askId);
      const earlier = await deps.store.get(requestKey);
      if (earlier !== undefined) return statusOf(orgId, sessionId, askId, earlier);

      const nowMs = now().getTime();
      const scope = { orgId, sessionId };
      // Admission first (Cloud's budgets, hard cap and forbidden models plug in here; Code's default allows everything): an Ask costs model money, so it asks like any other call.
      let reservationId: string | undefined;
      const estimateTokens = Math.ceil(ASK_LIMITS.contextMaxBytes / 4) + ASK_LIMITS.answerMaxOutputTokens;
      if (deps.admission !== undefined) {
        const decision = await deps.admission.admit({
          companyId: orgId, idempotencyKey: `ask:${askId}`, action: "model.call", actor: principal, ...(typeof task["project"] === "string" ? { projectName: task["project"] } : {}),
          subject: { type: "task", id: session.subject.taskId }, estimate: { tokens: estimateTokens },
        });
        if (!decision.allowed) throw admissionRefusal(decision);
        reservationId = decision.reservationId;
      }
      try {
      const lockKey = askLockKey(orgId, sessionId, askerKey);
      // The counters are shared (the task's day count is every ask's), so a transaction can lose a race to another Ask at the same moment: that is retried, a bounded number of times, with the counters read again.
      for (let attempt = 1; ; attempt += 1) {
        const person = await rateStep(deps.store, sessionRateKey(orgId, sessionId, askerKey, "ask"), scope, ASK_RATE.perPersonPerHour, HOUR_MS, nowMs);
        const everyone = await rateStep(deps.store, sessionRateKey(orgId, sessionId, "task", "ask_day"), scope, ASK_RATE.perTaskPerDay, DAY_MS, nowMs);
        const acrossTasks = await rateStep(deps.store, personAllTasksKey(orgId, askerKey), { orgId }, ASK_PER_PERSON_ALL_TASKS_PER_HOUR, HOUR_MS, nowMs);
        if (!person.room || !everyone.room || !acrossTasks.room) throw agentXError("TOO_MANY_REQUESTS", ASK_RATE_TEXT);
        const lock = await deps.store.get(lockKey);
        if (lock !== undefined && typeof lock["expiresAt"] === "number" && lock["expiresAt"] > nowMs) throw agentXError("TASK_BUSY", ASK_BUSY_TEXT);
        const result = await deps.store.transact([
          person.item, everyone.item, acrossTasks.item,
          { kind: "put", item: { ...lockKey, entityType: "ASK_LOCK", orgId, sessionId, askId, expiresAt: nowMs + ASK_LOCK_SECONDS * 1000, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + ASK_LOCK_SECONDS * 2 }, condition: when.or(when.absent(), when.lte("expiresAt", nowMs)) },
          { kind: "put", item: { ...requestKey, entityType: "ASK_REQUEST", orgId, sessionId, askId, taskId: session.subject.taskId, audience: "web", askerKey, askedBy: askerKey, state: "queued", createdAt: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + REQUEST_TTL_SECONDS }, condition: when.absent() },
        ]);
        if (result.applied) break;
        // Another call won a place at the same moment: if it was this very request, that is the answer.
        const now2 = await deps.store.get(requestKey);
        if (now2 !== undefined) return statusOf(orgId, sessionId, askId, now2);
        // The lock (item 3) or the request (item 4) refused: a question of this person's is waiting.
        if (result.failed.includes(3) || result.failed.includes(4)) throw agentXError("TASK_BUSY", ASK_BUSY_TEXT);
        // Only the counters moved (another Ask): read them again. Out of attempts, say so without blaming the asker.
        if (attempt >= RATE_RACE_ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", ASK_UNAVAILABLE_TEXT);
      }
      } catch (error) {
        // Nothing was started on this reservation: it goes back (a repeat of a request that is already running returned above and keeps its own).
        if (reservationId !== undefined) await deps.admission?.release(reservationId).catch(() => undefined);
        throw error;
      }
      // The question travels in this process only: it is in no record while the Ask waits.
      const running1 = turn(principal, session, askId, askerKey, body.data.question, { reservationId, submittedMs: nowMs, estimateTokens }).finally(() => { running.delete(running1); });
      running.add(running1);
      return AskStatusSchema.parse({ askId, state: "queued" });
    },

    /** Where an Ask is, for the person who asked: queued, answered (with the answer, to them alone) or failed. Anyone else gets "not found". */
    async status(principal: Principal, orgId: OrgId, sessionId: SessionId, askId: string): Promise<AskStatus> {
      if (deps.enabled === false) throw agentXError("NOT_FOUND", "route not found");
      const session = await sessionFor(principal, orgId, sessionId, "read");
      const request = await deps.store.get(askRequestKey(orgId, session.sessionId, askId));
      if (request === undefined || request["askerKey"] !== developerIdOf(principal) || request["orgId"] !== orgId || request["audience"] !== "web") throw notFound();
      return statusOf(orgId, session.sessionId, askId, request);
    },

    /** Resolves when every Ask this process started has ended (a test waits on it; the process never needs to). */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}

export { ASK_ANSWER_LABEL };

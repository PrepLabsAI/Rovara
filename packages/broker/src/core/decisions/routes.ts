// Decision cards (Decisions D2): the routes and the SERVER-SIDE friction. A card is a projection (project.ts); these routes are where its rules are enforced, so no client can skip them:
//   GET  /v1/app/decisions                                   the caller's cards, with the tabs, the evidence detail and a DIGEST per card (what the server shows now)
//   POST /v1/app/decisions/{kind}/{subject}/evidence-opened  records that the caller opened the evidence of what they were SHOWN (`shownDigest`); medium only
//   POST /v1/app/decisions/{kind}/{subject}/approve          the digest must be what is shown now (else 409 CHANGE_STALE); medium: and the evidence of that digest must have been opened; high: 404
//   POST /v1/app/decisions/{kind}/{subject}/reject           a reason in one tap; never a way to approve
// One card, one request: there is no bulk route and a body with a list of ids is refused by the strict schema. The approve and reject DO NOT decide anything themselves: they call the existing
// endpoint through the injected `performer` (a plan decision, a merge press, a spend decision, ...), which checks the caller's live authority again and answers what really happened:
// decided, needs the confirmation page (a fresh sign-in), or refused. Only a decided answer is recorded and reported as approved; a surface never says "Approved" for anything else.
// Mounting is one call (routeDecisionCards).
import {
  DECISION_CARDS_MAX, DECISION_RUN_LIMIT_KINDS, DecisionApproveBodySchema, DecisionCardIdSchema, DecisionOpenedBodySchema, DecisionRejectBodySchema, DecisionRequestChangesBodySchema, agentXError, approveReasonProblem, planChoicesProblem, type DecisionPlanAnswer,
  type DecisionAnswered, type DecisionCard, type DecisionCardsView, type DecisionEvidenceOpenedAnswer, type DecisionNeedsConfirmation, type DecisionRefusalReason, type DecisionRejectReason, type DecisionTab, type DecisionTabId,
} from "@agentx/contracts";
import { StatusReply } from "./status-reply.js";
import { decisionMadeMeasure, type DecisionMeasure } from "./measures.js";
import { projectDecisionCards, type DecisionItem, type Projection, type Subject } from "./project.js";
import type { DecisionLocks } from "./risk-tier.js";
import type { DecisionRecord, DecisionStore } from "./store.js";

export interface DecisionCaller { orgId: string; developerId: string }

/** Where the pending items come from. `list` answers only what THIS caller may decide now (the source checks their live authority); a card that is not in it does not exist for them. */
export interface DecisionSources<C extends DecisionCaller = DecisionCaller> {
  list(caller: C): Promise<readonly DecisionItem[]>;
  locks(caller: C): Promise<DecisionLocks>;
}

/** What the existing endpoint really answered. */
export type PerformOutcome =
  | { kind: "done" }
  /** The endpoint did not decide: the person decides on its confirmation page (an https address), with a fresh sign-in. */
  | { kind: "needs_confirmation"; confirmUrl: string; /** A merge: what is about to be merged and into which branch. */ merging?: DecisionNeedsConfirmation["merging"] | undefined }
  | { kind: "refused"; reason: DecisionRefusalReason };

/** The thing to act on: the card's own subject, or for a tab the document's own card and item (`kind` is the document's kind, never the pair's). */
export interface PerformInput {
  card: DecisionCard; item: DecisionItem; requestId: string; tab?: DecisionTabId | undefined; /** The approve body's one-line reason: present only on an `approve_design` card (the route refuses it elsewhere). */ reason?: string | undefined;
  /** A coding plan's card only: the run limit the person ticked (slice 2); the workflow decision checks it. */
  acknowledgedRunLimitUsd?: number | undefined;
  /** The card and the digest the person was SHOWN (the evidence-opened record is keyed by them): set by the approve route, read by the design handler's medium friction. */
  shown?: { cardId: string; digest: string } | undefined;
  /**
   * OWNER DECISION 7 (requirements and coding plan cards only; the route refuses it on any other kind): what the old review page sent with a decision, passed to the one workflow decision, which checks each
   * answer against the document, each check against the plan and each comment against the open ones.
   */
  plan?: { answers?: DecisionPlanAnswer[] | undefined; selectedOptionalCheckIds?: string[] | undefined; includedCommentIds?: string[] | undefined; note?: string | undefined } | undefined;
}

/** The plan fields of an approve or request-changes body, or undefined when it sends none. */
function planFieldsOf(body: { answers?: DecisionPlanAnswer[] | undefined; selectedOptionalCheckIds?: string[] | undefined; includedCommentIds?: string[] | undefined; note?: string | undefined }): PerformInput["plan"] {
  const plan = {
    ...(body.answers === undefined ? {} : { answers: body.answers }), ...(body.selectedOptionalCheckIds === undefined ? {} : { selectedOptionalCheckIds: body.selectedOptionalCheckIds }),
    ...(body.includedCommentIds === undefined ? {} : { includedCommentIds: body.includedCommentIds }), ...(body.note === undefined ? {} : { note: body.note }),
  };
  return Object.keys(plan).length === 0 ? undefined : plan;
}

/** An approve or a reject goes through the existing endpoint's own function, which re-checks the caller's live authority. */
export interface DecisionPerformer<C extends DecisionCaller = DecisionCaller> {
  approve(caller: C, input: PerformInput): Promise<PerformOutcome>;
  reject(caller: C, input: PerformInput & { reason: DecisionRejectReason }): Promise<PerformOutcome>;
  /** Slice 2: send a document back with the person's reason, through the existing workflow decision (REQUEST_CHANGES). Absent: no card can do it. */
  requestChanges?(caller: C, input: PerformInput & { reason: string }): Promise<PerformOutcome>;
}

export interface DecisionRouteDependencies<C extends DecisionCaller = DecisionCaller> {
  sources: DecisionSources<C>;
  performer: DecisionPerformer<C>;
  store: DecisionStore;
  now: () => number;
  /** Measure lines go here (METRIC style); a failure to log never changes an answer. */
  log?: ((measure: DecisionMeasure) => void) | undefined;
  /**
   * Slice 2: the kinds whose HIGH-risk card is approved on the card itself, on its task page, because their handler asks for a browser session and a recent sign-in itself (REAUTH_REQUIRED otherwise). For any
   * other kind a high card still has no approve route. Absent: none.
   */
  highOnCard?: ReadonlySet<string> | undefined;
  /** Security review 2026-11-06: the high-on-card kinds whose evidence is still opened first (and recorded for the digest shown) before Approve: an outside approval's. */
  evidenceFirstOnHigh?: ReadonlySet<string> | undefined;
  /** Called once the evidence of a card was recorded as opened: an outside approval's kind records that its page was read (`opened`). Errors are the caller's to absorb. */
  onEvidenceOpened?: ((caller: C, subject: Subject) => Promise<void>) | undefined;
}

export interface DecisionRequest { method: string; pathname: string; searchParams: URLSearchParams; body: unknown }

const PATH = /^\/v1\/app\/decisions(?:\/([a-z_]+\/[A-Za-z0-9_-]{1,150})\/(approve|reject|evidence-opened|request-changes))?$/u;
const ISSUE = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): never => {
  const issue = error.issues[0];
  // Field names only: the values are the caller's.
  throw agentXError("CONFIG_INVALID", `${issue?.path.map(String).join(".") || "body"}: ${issue?.message ?? "invalid"}`);
};

/** What a Request changes is recorded as in the card history (its outcome is "rejected": the document was not approved). */
export const CHANGES_REASON = "request_changes";
export const DECISION_OPEN_FIRST_MESSAGE = "Open the evidence first. It has changed or has not been opened.";
export const DECISION_CHANGED_MESSAGE = "This changed since you loaded it. Reload to see the current version.";
export const DECISION_FULL_PAGE_MESSAGE = "This decision is made on its own page. Open it to decide.";
export const DECISION_GONE_MESSAGE = "This decision is no longer waiting for you.";
export const DECISION_REFUSALS: Record<DecisionRefusalReason, { code: "FORBIDDEN" | "CHANGE_STALE" | "MERGE_NOT_READY" | "CONFIG_INVALID"; message: string }> = {
  forbidden: { code: "FORBIDDEN", message: "You can't decide this." },
  stale: { code: "CHANGE_STALE", message: DECISION_CHANGED_MESSAGE },
  second_person_required: { code: "FORBIDDEN", message: "Someone else has to decide this." },
  not_ready: { code: "MERGE_NOT_READY", message: "This isn't ready to be decided yet." },
  unsupported: { code: "CONFIG_INVALID", message: DECISION_FULL_PAGE_MESSAGE },
};

async function project<C extends DecisionCaller>(deps: DecisionRouteDependencies<C>, caller: C): Promise<Projection> {
  const [items, locks] = await Promise.all([deps.sources.list(caller), deps.sources.locks(caller)]);
  return projectDecisionCards(items, { locks });
}

/** UX2 slice 2 item 2: the caller's pending cards as Home counts them (id, kind, task): the one "needs you" count and Home's de-duplication read them. Only what THIS caller may decide now. */
export async function pendingDecisionRefs<C extends DecisionCaller>(deps: DecisionRouteDependencies<C>, caller: C): Promise<Array<{ cardId: string; kind: string; taskId?: string }>> {
  const projection = await project(deps, caller);
  return projection.cards.filter((card) => card.status === "pending").map((card) => ({ cardId: card.id, kind: card.kind, ...(card.taskId === undefined ? {} : { taskId: card.taskId }) }));
}

interface Pending { card: DecisionCard; subject: Subject; tabs: DecisionTab[] | undefined; digest: string; projection: Projection }

/** The caller's pending card, with its tabs; NOT_FOUND for a card that is not theirs, not there, or not waiting. */
function pendingCard(projection: Projection, cardId: string): Pending {
  const card = projection.cards.find((candidate) => candidate.id === cardId);
  const subject = projection.subjects[cardId];
  const digest = projection.digests[cardId];
  if (card === undefined || card.status !== "pending" || subject === undefined || digest === undefined) throw agentXError("NOT_FOUND", DECISION_GONE_MESSAGE);
  return { card, subject, tabs: projection.tabs[card.id], digest, projection };
}

const tabsPending = (tabs: readonly DecisionTab[] | undefined): DecisionTabId[] => (tabs ?? []).filter((tab) => !tab.approved).map((tab) => tab.id);

function emit(deps: { log?: ((measure: DecisionMeasure) => void) | undefined }, measure: DecisionMeasure | undefined): void {
  if (measure === undefined) return;
  try { deps.log?.(measure); } catch { /* a measure never changes an answer */ }
}

/** The decision already happened (the existing endpoint decided it), so a failure to write its history row never turns the answer into an error. */
async function remember(deps: { store: DecisionStore }, record: DecisionRecord): Promise<void> {
  try { await deps.store.recordDecision(record); } catch { /* history is best effort */ }
}

/** The subject to act on for a request: the card's own, or for a card with tabs the named document's own card and item. */
function actingSubject(pending: Pending, tab: DecisionTabId | undefined): Subject {
  if (tab === undefined) return pending.subject;
  const own = pending.projection.tabSubjects[pending.card.id]?.[tab];
  if (own === undefined) throw agentXError("CONFIG_INVALID", "tab: name one of the card's tabs");
  return own;
}

function tabOf(raw: string | null, tabs: readonly DecisionTab[] | undefined): DecisionTabId | undefined {
  if (tabs === undefined) {
    if (raw !== null) throw agentXError("CONFIG_INVALID", "tab: this card has no tabs");
    return undefined;
  }
  const found = tabs.find((tab) => tab.id === raw);
  if (found === undefined) throw agentXError("CONFIG_INVALID", "tab: name one of the card's tabs");
  return found.id;
}

/** What a finished decision answers, from the record (a retry after success gets the earlier answer, not "no longer waiting"). */
function answerOfRecord(record: DecisionRecord): DecisionAnswered {
  return { cardId: record.cardId, outcome: record.outcome, ...(record.tab === undefined ? {} : { tab: record.tab }), remainingTabs: record.tab === "requirements" && record.outcome === "approved" ? ["design"] : [] };
}

/** `merging` is additive: a client that can read it asks with `?merging=1` (an older bundle, whose reader is strict, never does and gets the earlier shape). */
const asksForMerging = (request: DecisionRequest): boolean => request.searchParams.get("merging") === "1";

function outcomeReply(cardId: string, outcome: PerformOutcome, withMerging = false): StatusReply | undefined {
  if (outcome.kind === "done") return undefined;
  if (outcome.kind === "needs_confirmation") {
    const body: DecisionNeedsConfirmation = { cardId: DecisionCardIdSchema.parse(cardId), outcome: "needs_confirmation", confirmUrl: outcome.confirmUrl, ...(!withMerging || outcome.merging === undefined ? {} : { merging: outcome.merging }) };
    return new StatusReply(202, body);
  }
  const refusal = DECISION_REFUSALS[outcome.reason];
  throw agentXError(refusal.code, refusal.message);
}

/** Handles the card routes; undefined for any other path (the caller goes on to its own routes). */
export async function routeDecisionCards<C extends DecisionCaller>(deps: DecisionRouteDependencies<C>, caller: C, request: DecisionRequest): Promise<StatusReply | undefined> {
  const match = PATH.exec(request.pathname);
  if (match === null) return undefined;
  const [, rawId, action] = match;
  if (rawId === undefined || action === undefined) {
    if (request.method !== "GET") return undefined;
    const projection = await project(deps, caller);
    const cards = projection.cards.slice(0, DECISION_CARDS_MAX);
    const view: DecisionCardsView = { cards, total: projection.cards.length, tabs: {}, details: {}, digests: {}, dropped: projection.dropped, unconfirmed: projection.unconfirmed.slice(0, DECISION_CARDS_MAX) };
    for (const card of cards) {
      const tabs = projection.tabs[card.id];
      if (tabs !== undefined) view.tabs[card.id] = tabs;
      const choices = projection.choices[card.id];
      if (choices !== undefined) (view.choices ??= {})[card.id] = choices;
      view.details[card.id] = projection.details[card.id] ?? [];
      view.digests[card.id] = projection.digests[card.id]!;
    }
    return new StatusReply(200, view);
  }
  if (request.method !== "POST") return undefined;
  const parsedId = DecisionCardIdSchema.safeParse(rawId.replace("/", ":"));
  if (!parsedId.success) throw agentXError("NOT_FOUND", DECISION_GONE_MESSAGE);
  const cardId = parsedId.data;
  const nowIso = (): string => new Date(deps.now()).toISOString();
  const who = { orgId: caller.orgId, developerId: caller.developerId };

  if (action === "evidence-opened") {
    const body = DecisionOpenedBodySchema.safeParse(request.body);
    if (!body.success) return ISSUE(body.error);
    const pending = pendingCard(await project(deps, caller), cardId);
    if (pending.card.risk === "high" && deps.evidenceFirstOnHigh?.has(pending.card.kind) !== true) throw agentXError("NOT_FOUND", DECISION_FULL_PAGE_MESSAGE);
    // What the person was shown must be what the server shows now: a stale view never creates a fresh record.
    if (body.data.shownDigest !== pending.digest) throw agentXError("CHANGE_STALE", DECISION_CHANGED_MESSAGE);
    const tab = tabOf(request.searchParams.get("tab"), pending.tabs);
    const recorded = pending.card.friction.expandEvidenceFirst;
    if (recorded) await deps.store.recordEvidenceOpened({ ...who, cardId, tab }, pending.digest, nowIso());
    if (recorded && deps.onEvidenceOpened !== undefined) await deps.onEvidenceOpened(caller, actingSubject(pending, tab));
    const answer: DecisionEvidenceOpenedAnswer = { cardId, opened: true, recorded };
    return new StatusReply(200, answer);
  }

  if (action === "approve") {
    const body = DecisionApproveBodySchema.safeParse(request.body);
    if (!body.success) return ISSUE(body.error);
    const earlier = await deps.store.findDecision(who, body.data.requestId);
    if (earlier !== undefined) {
      if (earlier.outcome !== "approved" || (earlier.cardId !== cardId && earlier.tab === undefined)) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
      return new StatusReply(200, answerOfRecord(earlier));
    }
    const pending = pendingCard(await project(deps, caller), cardId);
    const { card, tabs } = pending;
    // High: there is no approve route for it, whatever the card or a client says; except a kind whose handler asks for the recent sign-in itself (`highOnCard`), decided on its card on the task page.
    const highOnCard = card.risk === "high" && deps.highOnCard?.has(card.kind) === true;
    if ((card.risk === "high" && !highOnCard) || (!highOnCard && !card.actions.some((action2) => action2.kind === "approve"))) throw agentXError("NOT_FOUND", DECISION_FULL_PAGE_MESSAGE);
    if (tabs === undefined && body.data.tab !== undefined) throw agentXError("CONFIG_INVALID", "tab: this card has no tabs");
    if (tabs !== undefined) {
      if (body.data.tab === undefined || !tabsPending(tabs).includes(body.data.tab)) throw agentXError("CONFIG_INVALID", "tab: name a document that is still waiting");
      // The design is approved after the requirements: while the requirements wait, only they can be approved.
      if (body.data.tab === "design" && tabsPending(tabs).includes("requirements")) throw agentXError("CONFIG_INVALID", "tab: approve the requirements first");
    }
    if (body.data.shownDigest !== pending.digest) throw agentXError("CHANGE_STALE", DECISION_CHANGED_MESSAGE);
    const acting = actingSubject(pending, body.data.tab);
    // A reason belongs to a design approved with an open blocker and nowhere else: the body is refused before any friction step or anything is performed, never dropped.
    // A design under design review is approved by its review's own handler, which takes none of the plan fields: they are refused there, never dropped.
    const reasonProblem = approveReasonProblem(acting.item.kind, body.data.reason) ?? planChoicesProblem(acting.item.kind === "approve_design" && acting.item.review !== undefined ? "approve_design_reviewed" : acting.item.kind, body.data);
    if (reasonProblem !== undefined) throw agentXError("CONFIG_INVALID", reasonProblem);
    if (body.data.acknowledgedRunLimitUsd !== undefined && !DECISION_RUN_LIMIT_KINDS.includes(acting.item.kind)) throw agentXError("CONFIG_INVALID", "acknowledgedRunLimitUsd: this card sets no run limit");
    let openedAt: string | undefined;
    // A high card decided on its card has the recent sign-in as its check (its handler asks for it), not the evidence record a medium card needs.
    if (card.friction.expandEvidenceFirst && (!highOnCard || deps.evidenceFirstOnHigh?.has(card.kind) === true)) {
      openedAt = await deps.store.evidenceOpenedAt({ ...who, cardId, tab: body.data.tab }, pending.digest);
      if (openedAt === undefined) throw agentXError("CHANGE_STALE", DECISION_OPEN_FIRST_MESSAGE);
    }
    const outcome = await deps.performer.approve(caller, { card: acting.card, item: acting.item, requestId: body.data.requestId, tab: body.data.tab, shown: { cardId, digest: pending.digest }, ...(planFieldsOf(body.data) === undefined ? {} : { plan: planFieldsOf(body.data) }), ...(body.data.reason === undefined ? {} : { reason: body.data.reason }), ...(body.data.acknowledgedRunLimitUsd === undefined ? {} : { acknowledgedRunLimitUsd: body.data.acknowledgedRunLimitUsd }) });
    const notDecided = outcomeReply(cardId, outcome, asksForMerging(request));
    if (notDecided !== undefined) return notDecided;
    const decidedAt = nowIso();
    await remember(deps, { ...who, cardId: acting.card.id, kind: acting.card.kind, risk: acting.card.risk, outcome: "approved", tab: body.data.tab, requestId: body.data.requestId, createdAt: acting.card.createdAt, openedAt, decidedAt });
    emit(deps, decisionMadeMeasure(who, acting.card, { outcome: "approved", createdAt: acting.card.createdAt, at: decidedAt }));
    const answer: DecisionAnswered = { cardId, outcome: "approved", ...(body.data.tab === undefined ? {} : { tab: body.data.tab }), remainingTabs: tabsPending(tabs).filter((tab) => tab !== body.data.tab) };
    return new StatusReply(200, answer);
  }

  if (action === "request-changes") {
    const body = DecisionRequestChangesBodySchema.safeParse(request.body);
    if (!body.success) return ISSUE(body.error);
    const earlier = await deps.store.findDecision(who, body.data.requestId);
    if (earlier !== undefined) {
      // The same rule as approve: the record names the acting document's card (a pair's tab records its document's own card, with the tab).
      if (earlier.outcome !== "rejected" || earlier.reason !== CHANGES_REASON || (earlier.cardId !== cardId && earlier.tab === undefined)) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
      return new StatusReply(200, answerOfRecord(earlier));
    }
    const pending = pendingCard(await project(deps, caller), cardId);
    const { card, tabs } = pending;
    if (!card.actions.some((action2) => action2.kind === "request_changes") || deps.performer.requestChanges === undefined) throw agentXError("NOT_FOUND", DECISION_FULL_PAGE_MESSAGE);
    if (body.data.shownDigest !== pending.digest) throw agentXError("CHANGE_STALE", DECISION_CHANGED_MESSAGE);
    // A card with tabs sends back the first document still waiting.
    const tab = tabs === undefined ? undefined : tabsPending(tabs)[0];
    const acting = actingSubject(pending, tab);
    const commentsProblem = planChoicesProblem(acting.item.kind === "approve_design" && acting.item.review !== undefined ? "approve_design_reviewed" : acting.item.kind, { includedCommentIds: body.data.includedCommentIds });
    if (commentsProblem !== undefined) throw agentXError("CONFIG_INVALID", commentsProblem);
    const outcome = await deps.performer.requestChanges(caller, { card: acting.card, item: acting.item, requestId: body.data.requestId, reason: body.data.reason, tab, ...(body.data.includedCommentIds === undefined ? {} : { plan: { includedCommentIds: body.data.includedCommentIds } }) });
    const notDecided = outcomeReply(cardId, outcome);
    if (notDecided !== undefined) return notDecided;
    const decidedAt = nowIso();
    await remember(deps, { ...who, cardId: acting.card.id, kind: acting.card.kind, risk: acting.card.risk, outcome: "rejected", reason: CHANGES_REASON, tab, requestId: body.data.requestId, createdAt: acting.card.createdAt, decidedAt });
    emit(deps, decisionMadeMeasure(who, acting.card, { outcome: "rejected", createdAt: acting.card.createdAt, at: decidedAt }));
    const answer: DecisionAnswered = { cardId, outcome: "rejected", ...(tab === undefined ? {} : { tab }), remainingTabs: [] };
    return new StatusReply(200, answer);
  }

  // reject
  const body = DecisionRejectBodySchema.safeParse(request.body);
  if (!body.success) return ISSUE(body.error);
  const earlier = await deps.store.findDecision(who, body.data.requestId);
  if (earlier !== undefined) {
    if (earlier.outcome !== "rejected" || (earlier.cardId !== cardId && earlier.tab === undefined)) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    return new StatusReply(200, answerOfRecord(earlier));
  }
  const pending = pendingCard(await project(deps, caller), cardId);
  const { card, tabs } = pending;
  if (!card.actions.some((action2) => action2.kind === "reject") || !card.rejectReasons.includes(body.data.reason)) throw agentXError("NOT_FOUND", DECISION_FULL_PAGE_MESSAGE);
  // A card with tabs is rejected at the first document still waiting.
  const tab = tabs === undefined ? undefined : tabsPending(tabs)[0];
  const acting = actingSubject(pending, tab);
  const outcome = await deps.performer.reject(caller, { card: acting.card, item: acting.item, requestId: body.data.requestId, reason: body.data.reason, tab });
  const notDecided = outcomeReply(cardId, outcome, asksForMerging(request));
  if (notDecided !== undefined) return notDecided;
  const decidedAt = nowIso();
  await remember(deps, { ...who, cardId: acting.card.id, kind: acting.card.kind, risk: acting.card.risk, outcome: "rejected", reason: body.data.reason, tab, requestId: body.data.requestId, createdAt: acting.card.createdAt, decidedAt });
  emit(deps, decisionMadeMeasure(who, acting.card, { outcome: "rejected", createdAt: acting.card.createdAt, at: decidedAt }));
  const answer: DecisionAnswered = { cardId, outcome: "rejected", ...(tab === undefined ? {} : { tab }), remainingTabs: tabsPending(tabs).filter((other) => other !== tab) };
  return new StatusReply(200, answer);
}

// TE-B5: the change proof holds the draft, and "mark ready anyway" (testing plan O2, O30, O43, O59; DECISIONS 161).
//
// Before the tracking pass takes a draft out of draft it asks this module (`judgeProofHold`) whether the change was proven. The facts come from a `ProofHoldSource` the host supplies (the same-task before-run, coverage,
// `absentOnNew`, scripted-reply origins); the rule is contracts' pure `proofHolds`; the mode is the preset's. A held draft stays a draft, says why on the session timeline, and waits for a person: the task's owner or a
// maintainer (`canDecide`, read live) may press "mark ready anyway" (`markReadyAnyway`), which records the override once, with the audit fact in the same transaction. An override is for ONE head: a new push is a
// new change and is judged again. Without a source nothing here runs and the pass behaves as it did.
//
// Three small records, none of them part of the tracking item (so its digest and stored shape are untouched):
//   DEVTASK#<task> / PROOF_HOLD#<repo>#<n>      what the last judgement was (head, reasons, mode, whether it relaxed)
//   DEVTASK#<task> / PROOF_OVERRIDE#<repo>#<n>  the override: who, when, the optional reason, the head; created once (a condition that it is absent)
//   ORG#<co>#PROOF_HOLD_HISTORY / <project>      the last 20 pull requests' raw verdicts, for O43's 10% rule
import { createHash } from "node:crypto";
import {
  agentXError, canDecide, change, companyScoped, proofHoldLine, proofHolds, redactText, sessionEventId, when,
  type AuditSink, type DocumentStore, type OrgId, type ProofHoldDecision, type ProofHoldFacts, type ProofHoldHistory, type ProofHoldMode, type ProofHoldReason, type ProofOverride, type TransactItem,
} from "@agentx/contracts";
import { plain } from "./store.js";
import type { MergeTask, SessionTimeline } from "./seams.js";

/** What the host supplies so a draft can be judged. Absent, the pass never holds. */
export interface ProofHoldSource {
  /** The preset's rule for this task's project: `off` when the gate is off, `warn` (Lightweight), `hold` (Balanced, Careful). */
  mode(task: MergeTask): Promise<ProofHoldMode> | ProofHoldMode;
  /** What is known about this change for the head: the same-task before-run, coverage, tests absent on the new code, scripted-reply origins. `undefined` when nothing could be read (never a hold). */
  facts(input: { task: MergeTask; repositoryId: string; number: number; headSha: string }): Promise<ProofHoldFacts | undefined>;
}

export const PROOF_HOLD_ENTITY = "PROOF_HOLD";
export const PROOF_OVERRIDE_ENTITY = "PROOF_OVERRIDE";
/** The reason an override may carry, in characters: the pack's `proof.override.reason` bound. */
export const OVERRIDE_REASON_MAX = 300;

const part = (value: string, what: string): string => {
  if (value.length === 0 || value.length > 200 || /[#\p{Cc}]/u.test(value)) throw new Error(`${what} is not a usable key part`);
  return value;
};
export const proofHoldKey = (taskId: string, repositoryId: string, number: number): { pk: string; sk: string } => ({ pk: `DEVTASK#${part(taskId, "a task id")}`, sk: `${PROOF_HOLD_ENTITY}#${part(repositoryId, "a repository id")}#${String(number)}` });
export const proofOverrideKey = (taskId: string, repositoryId: string, number: number): { pk: string; sk: string } => ({ pk: `DEVTASK#${part(taskId, "a task id")}`, sk: `${PROOF_OVERRIDE_ENTITY}#${part(repositoryId, "a repository id")}#${String(number)}` });
const historyKey = (orgId: OrgId, project: string): { pk: string; sk: string } => ({ pk: companyScoped(orgId, "PROOF_HOLD_HISTORY"), sk: part(project, "a project") });

// ---- the records

/** What the last judgement of one pull request was. */
export interface ProofHoldRecord {
  orgId: OrgId;
  taskId: string;
  repositoryId: string;
  number: number;
  headSha: string;
  mode: ProofHoldMode;
  /** The pull request stays a draft because of this. */
  holds: boolean;
  /** The rule would hold but only says so (the preset warns, or the hold relaxed). */
  warns: boolean;
  relaxed: boolean;
  reasons: ProofHoldReason[];
  provenCount: number;
  decidedAt: string;
}
/** The override of one head of one pull request. */
export interface ProofOverrideRecord extends ProofOverride {
  orgId: OrgId;
  taskId: string;
  repositoryId: string;
  number: number;
  headSha: string;
}

const isReasons = (value: unknown): value is ProofHoldReason[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
/** A stored hold record, or undefined (never one of another org or task). */
export function holdRecordOf(stored: Record<string, unknown> | undefined, orgId: OrgId, taskId: string): ProofHoldRecord | undefined {
  if (stored === undefined || stored["orgId"] !== orgId || stored["taskId"] !== taskId) return undefined;
  const { repositoryId, number, headSha, mode, holds, warns, relaxed, reasons, provenCount, decidedAt } = stored;
  if (typeof repositoryId !== "string" || typeof number !== "number" || typeof headSha !== "string" || typeof holds !== "boolean" || typeof warns !== "boolean" || typeof relaxed !== "boolean") return undefined;
  if ((mode !== "off" && mode !== "warn" && mode !== "hold") || !isReasons(reasons) || typeof provenCount !== "number" || typeof decidedAt !== "string") return undefined;
  return { orgId, taskId, repositoryId, number, headSha, mode, holds, warns, relaxed, reasons, provenCount, decidedAt };
}
/** A stored override, or undefined (never one of another org or task). */
export function overrideRecordOf(stored: Record<string, unknown> | undefined, orgId: OrgId, taskId: string): ProofOverrideRecord | undefined {
  if (stored === undefined || stored["orgId"] !== orgId || stored["taskId"] !== taskId) return undefined;
  const { repositoryId, number, headSha, actorId, at, reason } = stored;
  if (typeof repositoryId !== "string" || typeof number !== "number" || typeof headSha !== "string" || typeof actorId !== "string" || typeof at !== "string") return undefined;
  return { orgId, taskId, repositoryId, number, headSha, actorId, at, ...(typeof reason === "string" && reason !== "" ? { reason } : {}) };
}

/** The task page's view of a pull request's hold: what was judged for the head the pull request has now, and the override if one stands for that head. Undefined when nothing was judged for it. */
export async function readProofHold(
  store: Pick<DocumentStore, "get">, task: { taskId: string; orgId: OrgId }, pullRequest: { repositoryId: string; number: number; headSha: string },
): Promise<{ record: ProofHoldRecord; override?: ProofOverrideRecord } | undefined> {
  const record = holdRecordOf(await store.get(proofHoldKey(task.taskId, pullRequest.repositoryId, pullRequest.number)), task.orgId, task.taskId);
  if (record === undefined || record.headSha !== pullRequest.headSha) return undefined;
  const override = overrideRecordOf(await store.get(proofOverrideKey(task.taskId, pullRequest.repositoryId, pullRequest.number)), task.orgId, task.taskId);
  return { record, ...(override !== undefined && override.headSha === pullRequest.headSha ? { override } : {}) };
}

// ---- the history (O43)

interface HistoryEntry { k: string; held: boolean }
const HISTORY_FIELD = "entries";
const WINDOW = 20;
function entriesOf(stored: Record<string, unknown> | undefined): HistoryEntry[] {
  const raw = stored?.[HISTORY_FIELD];
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === "object" && typeof (entry as { k?: unknown }).k === "string" && typeof (entry as { held?: unknown }).held === "boolean") out.push({ k: (entry as HistoryEntry).k, held: (entry as HistoryEntry).held });
  }
  return out.slice(-WINDOW);
}
/** How many of the project's last 20 judged pull requests the rule would have held. */
export async function readProofHoldHistory(store: Pick<DocumentStore, "get">, orgId: OrgId, project: string, exclude?: string): Promise<ProofHoldHistory> {
  // `exclude`: the pull request being judged. Its own earlier verdict is not evidence about the project's hold rate, or a held draft would count itself and relax on the next sweep.
  const entries = entriesOf(await store.get(historyKey(orgId, project))).filter((entry) => entry.k !== exclude);
  return { held: entries.filter((entry) => entry.held).length, total: entries.length };
}
/** Records the rule's own verdict for one pull request (the latest verdict for a pull request replaces the one before it, so a pass that runs again does not count twice). Best effort: a lost race only delays it to the next pass. */
async function noteProofHoldOutcome(store: DocumentStore, orgId: OrgId, project: string, key: string, held: boolean): Promise<void> {
  const at = historyKey(orgId, project);
  const stored = await store.get(at);
  const before = entriesOf(stored);
  const next = [...before.filter((entry) => entry.k !== key), { k: key, held }].slice(-WINDOW);
  if (stored !== undefined && next.length === before.length && next.every((entry, index) => entry.k === before[index]?.k && entry.held === before[index]?.held)) return;
  if (stored === undefined) {
    await store.put({ item: plain({ ...at, entityType: "PROOF_HOLD_HISTORY", orgId, version: 1, [HISTORY_FIELD]: next }), condition: when.absent() }).catch(() => undefined);
    return;
  }
  const version = typeof stored["version"] === "number" ? stored["version"] : 0;
  await store.update({ key: at, ops: [change.set([HISTORY_FIELD], next as never), change.add(["version"], 1)], condition: when.eq("version", version) }).catch(() => undefined);
}

// ---- judging a draft

export type ProofHoldGate =
  /** Nothing to hold the draft for: no source, the gate is off, or the change is proven. */
  | { kind: "proceed"; decision?: ProofHoldDecision | undefined; overridden?: boolean | undefined }
  /** The draft stays a draft; `line` is what the timeline says. */
  | { kind: "held"; decision: ProofHoldDecision; line: string }
  /** The judgement could not be made (a fault): the draft stays this pass and the next pass tries again. Marking ready on a guess is the unsafe direction. */
  | { kind: "unreadable" };

export interface JudgeDependencies {
  store: DocumentStore;
  timeline: SessionTimeline;
  proofHold: ProofHoldSource;
  log?(event: string, fields: Record<string, unknown>): void;
}

/** Said after a warning that is a hold the 10% rule relaxed (O43). */
export const PROOF_HOLD_RELAXED_NOTE = "More than 10% of this project's recent pull requests were held, so this is a warning, not a hold.";
/** The words for a warning (a `warn` preset, or a hold that relaxed above 10%). */
export function proofWarningLine(decision: ProofHoldDecision): string {
  const words = proofHoldLine(decision.reasons).replace(/^Held as a draft:/u, "Not proven:");
  return decision.relaxed ? `${words} ${PROOF_HOLD_RELAXED_NOTE}` : words;
}

/**
 * Judges one draft pull request on its current head. Writes the judgement (once for each change of it) and, when there is a session, one timeline line saying why the draft is held or that the change is not proven.
 * A pull request that is not a draft is never judged here: it cannot be kept back, and the caller does not ask.
 */
export async function judgeProofHold(
  deps: JudgeDependencies, task: MergeTask & { orgId: OrgId }, pullRequest: { repositoryId: string; number: number }, headSha: string, now: number,
): Promise<ProofHoldGate> {
  let decision: ProofHoldDecision;
  let mode: ProofHoldMode;
  let override: ProofOverrideRecord | undefined;
  try {
    mode = await deps.proofHold.mode(task);
    if (mode === "off") return { kind: "proceed" };
    const facts = (await deps.proofHold.facts({ task, repositoryId: pullRequest.repositoryId, number: pullRequest.number, headSha })) ?? {};
    const recent = await readProofHoldHistory(deps.store, task.orgId, task.project, `${pullRequest.repositoryId}#${String(pullRequest.number)}`);
    decision = proofHolds({ facts, mode, recent });
    // M2: unknown never releases. A draft that was held (on any head) and whose proof cannot be read now (no facts, no proof, or one that was not checked) stays held with the reasons it had.
    const unknown = facts.proof === undefined || facts.proof.status !== "checked";
    const before = holdRecordOf(await deps.store.get(proofHoldKey(task.taskId, pullRequest.repositoryId, pullRequest.number)), task.orgId, task.taskId);
    if (mode === "hold" && unknown && !decision.holds && !decision.relaxed && before?.holds === true) {
      decision = { ...decision, holds: true, warns: false, wouldHold: true, reasons: before.reasons.length > 0 ? before.reasons : ["proof_failed"] };
    }
    const stored = overrideRecordOf(await deps.store.get(proofOverrideKey(task.taskId, pullRequest.repositoryId, pullRequest.number)), task.orgId, task.taskId);
    override = stored !== undefined && stored.headSha === headSha ? stored : undefined;
  } catch (error) {
    deps.log?.("proof_hold.unreadable", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return { kind: "unreadable" };
  }

  const at = new Date(now).toISOString();
  const record: ProofHoldRecord = {
    orgId: task.orgId, taskId: task.taskId, repositoryId: pullRequest.repositoryId, number: pullRequest.number, headSha, mode,
    holds: decision.holds, warns: decision.warns, relaxed: decision.relaxed, reasons: decision.reasons, provenCount: decision.provenCount, decidedAt: at,
  };
  const spoken = decision.holds || decision.warns;
  const stateKey = createHash("sha256").update(JSON.stringify([headSha, decision.reasons, decision.holds, decision.warns, decision.relaxed, override?.at ?? null])).digest("hex").slice(0, 24);
  try {
    const stored = await deps.store.get(proofHoldKey(task.taskId, pullRequest.repositoryId, pullRequest.number));
    const changed = stored?.["stateKey"] !== stateKey;
    if (changed) {
      const recordItem = plain({ ...proofHoldKey(task.taskId, pullRequest.repositoryId, pullRequest.number), entityType: PROOF_HOLD_ENTITY, stateKey, ...record });
      const items: TransactItem[] = [{ kind: "put", item: recordItem }];
      if (spoken && override === undefined && task.sessionId !== undefined) {
        items.push(deps.timeline.statusLine({ orgId: task.orgId, sessionId: task.sessionId }, {
          eventId: sessionEventId("proof_hold", `${task.taskId}\n${pullRequest.repositoryId}\n${String(pullRequest.number)}\n${stateKey}`), at,
          text: decision.holds ? `${proofHoldLine(decision.reasons)} A person can mark it ready anyway on the task page.` : proofWarningLine(decision),
        }));
      }
      const written = await deps.store.transact(items);
      // The timeline line was said before (the judgement came back to an earlier state, so its line's id exists): the record is still written.
      if (!written.applied && items.length > 1) await deps.store.put({ item: recordItem });
    }
    await noteProofHoldOutcome(deps.store, task.orgId, task.project, `${pullRequest.repositoryId}#${String(pullRequest.number)}`, decision.wouldHold);
  } catch (error) {
    // The record is for the person reading the page: a failure to write it is logged. What the pass decides below does not depend on it.
    deps.log?.("proof_hold.record_failed", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
  if (decision.holds && override === undefined) return { kind: "held", decision, line: proofHoldLine(decision.reasons) };
  return { kind: "proceed", decision, overridden: decision.holds && override !== undefined };
}

// ---- "mark ready anyway"

/** A person's roles, read live at the moment of the press: never cached, never taken from the task. */
export interface LiveRoles {
  read(companyId: string, project: string, personId: string): Promise<{ orgRole?: string | undefined; projectRole?: string | undefined } | undefined>;
}
export interface OverrideDependencies {
  store: DocumentStore;
  audit: AuditSink;
  roles: LiveRoles;
  now: () => number;
  /** The task, read fresh. */
  loadTask(taskId: string): Promise<MergeTask | undefined>;
  /** Wakes the task's tracking pass so the draft is taken out of draft now rather than on the next sweep. Best effort. */
  nudge?(taskId: string): Promise<unknown>;
}
export interface MarkReadyInput {
  /** The company of the signed-in person who pressed (from their session, never the request body). A task of another company is refused. */
  companyId: string;
  taskId: string;
  repositoryId: string;
  number: number;
  /** The head the person was shown when they pressed. The press is refused unless it is the head tracked now, so an override can never land on code the person did not see. */
  expectedHeadSha: string;
  /** The person who pressed. Taken from the signed-in session by the caller, never from the request body. */
  actorId: string;
  /** Optional (O59). Untrusted text: stored without control or hidden characters, secrets redacted, cut to 300 characters. */
  reason?: string | undefined;
}
export type MarkReadyResult = { overridden: true; already: boolean; override: ProofOverrideRecord };

/** One plain line of a person's words: secrets redacted, control, format and invisible characters and line breaks gone, cut to the pack's bound. Rendering makes it inert again. */
export function plainReason(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const plainText = redactText(text.slice(0, OVERRIDE_REASON_MAX * 4)).replace(/[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\s]+/gu, " ").trim();
  const points = Array.from(plainText).slice(0, OVERRIDE_REASON_MAX).join("").trim();
  return points === "" ? undefined : points;
}

/**
 * Records "mark ready anyway" for a held draft, once. The task's owner or a maintainer may (`canDecide`, with the roles read now), in this company only; the pull request must be this task's, still open, still a draft and
 * held for the head it has now. The override row and the audit fact commit together; pressing twice records one and the second press is told so. The tracking pass takes the draft out of draft after it (the nudge).
 */
export async function markReadyAnyway(deps: OverrideDependencies, input: MarkReadyInput): Promise<MarkReadyResult> {
  const task = await deps.loadTask(input.taskId);
  const orgId = task?.orgId;
  // A task that is missing, closed, or another company's is one answer, so nothing is learned from which.
  if (task === undefined || orgId === undefined || orgId !== input.companyId || task.closedAt !== undefined || task.releasedAt !== undefined) throw agentXError("TASK_ACCESS_DENIED", "That task is not available.");
  // Who may: read the roles now. A person with no role in the company, or one who cannot be read, is refused.
  const roles = await deps.roles.read(input.companyId, task.project, input.actorId).catch(() => undefined);
  const decided = canDecide(
    { personId: input.actorId, companyId: input.companyId, orgRole: roles?.orgRole, ...(roles?.projectRole === undefined ? {} : { projectRole: { project: task.project, role: roles.projectRole } }) },
    "mark_ready_anyway", { companyId: orgId, project: task.project, ownerId: task.ownerId }, { companyId: input.companyId },
  );
  if (!decided.allowed) throw agentXError("TASK_ACCESS_DENIED", "Only the person who asked for this task, or a maintainer, can mark it ready anyway.");
  const pullRequest = (task.workflow?.pullRequests ?? []).find((entry) => entry.repositoryId === input.repositoryId && entry.number === input.number);
  if (pullRequest === undefined) throw agentXError("TASK_ACCESS_DENIED", "That pull request is not on this task.");
  const tracked = await deps.store.get({ pk: `DEVTASK#${task.taskId}`, sk: `MERGE_TRACKING#${input.repositoryId}#${String(input.number)}` });
  if (tracked !== undefined && tracked["orgId"] === orgId && tracked["taskId"] === task.taskId && tracked["state"] === "open" && tracked["draft"] === false && typeof tracked["headSha"] === "string") {
    const earlier = overrideRecordOf(await deps.store.get(proofOverrideKey(task.taskId, input.repositoryId, input.number)), orgId, task.taskId);
    if (earlier !== undefined && earlier.headSha === tracked["headSha"]) throw agentXError("MERGE_NOT_READY", "This pull request was already marked ready.");
  }
  if (tracked === undefined || tracked["orgId"] !== orgId || tracked["taskId"] !== task.taskId || tracked["state"] !== "open" || tracked["draft"] !== true || typeof tracked["headSha"] !== "string") {
    throw agentXError("MERGE_NOT_READY", "This pull request is not a draft that is being held.");
  }
  const headSha = tracked["headSha"];
  if (input.expectedHeadSha !== headSha) throw agentXError("MERGE_NOT_READY", "The pull request changed since you looked at it. Look at it again, then mark it ready.");
  const judged = holdRecordOf(await deps.store.get(proofHoldKey(task.taskId, input.repositoryId, input.number)), orgId, task.taskId);
  if (judged === undefined || judged.headSha !== headSha || !judged.holds) throw agentXError("MERGE_NOT_READY", "This pull request is not being held, so there is nothing to mark ready.");

  const at = new Date(deps.now()).toISOString();
  const reason = plainReason(input.reason);
  const override: ProofOverrideRecord = { orgId, taskId: task.taskId, repositoryId: input.repositoryId, number: input.number, headSha, actorId: input.actorId, at, ...(reason === undefined ? {} : { reason }) };
  const eventId = createHash("sha256").update(`proof.override\n${task.taskId}\n${input.repositoryId}\n${String(input.number)}\n${headSha}`).digest("hex");
  const staged = deps.audit.stage({
    eventId, companyId: orgId, at, actor: { type: "person", id: input.actorId }, action: "pull_request.proof_overridden", subject: { type: "change_request", id: `${input.repositoryId}#${String(input.number)}` },
    details: { taskId: task.taskId, repositoryId: input.repositoryId, number: input.number, headSha, reasons: judged.reasons, decidedBy: decided.reason, ...(reason === undefined ? {} : { reasonGiven: true }) },
  });
  const result = await deps.store.transact([
    { kind: "put", item: plain({ ...proofOverrideKey(task.taskId, input.repositoryId, input.number), entityType: PROOF_OVERRIDE_ENTITY, ...override }), condition: when.absent() },
    ...staged,
  ]);
  if (!result.applied) {
    // The row is there already: the same head is a second press (idempotent); another head's override is replaced by a fresh press on the new head.
    const existing = overrideRecordOf(await deps.store.get(proofOverrideKey(task.taskId, input.repositoryId, input.number)), orgId, task.taskId);
    if (existing !== undefined && existing.headSha === headSha) return { overridden: true, already: true, override: existing };
    const replaced = await deps.store.transact([
      { kind: "put", item: plain({ ...proofOverrideKey(task.taskId, input.repositoryId, input.number), entityType: PROOF_OVERRIDE_ENTITY, ...override }), condition: existing === undefined ? when.absent() : when.eq("headSha", existing.headSha) },
      ...staged,
    ]);
    if (!replaced.applied) throw agentXError("RUNTIME_UNAVAILABLE", "The override could not be recorded. Try again.");
  }
  await deps.nudge?.(task.taskId).catch(() => undefined);
  return { overridden: true, already: false, override };
}

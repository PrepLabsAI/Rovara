// The lessons library's audit events written to the install's `audit-sink` point. The library names more actions than a ledger keeps (`lesson.*`), each with a fixed list of facts. This maps the ones that
// have a ledger name and keeps only the facts that action allows, and never writes an event under another action's name.
// An action with no ledger name is either listed in BOOKKEEPING (counters, pauses, votes: it grants nothing, and is skipped for `emitAudit`) or unknown. Under `requireAudit` (the event grants something:
// an approval, a go-live, a rollback, a promotion, a setting loosened) an action with no ledger name THROWS, so the change is refused instead of passing with no record. A test holds that every
// action of the library is either mapped or listed, so a new action cannot be added without a decision.
//
// `rovara up` registers the document audit sink, which keeps every event this maps; an adapter that keeps a ledger commits the event with the change (`stage`).
import { createHash } from "node:crypto";
import type { AuditActor, AuditEvent, AuditSink, TransactItem } from "@agentx/contracts";

type AuditAction = string;
import type { LessonAuditEvent, LessonAuditSink } from "./ports.js";
import type { LessonAuditAction } from "./types.js";

type Mapped = { action: AuditAction; facts: (event: LessonAuditEvent) => Record<string, string | number | boolean> };
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const word = (value: unknown, fallback: string): string => (typeof value === "string" && /^[a-z_]{1,40}$/u.test(value) ? value : fallback);

const modelWord = (value: unknown): string => (typeof value === "string" && /^[A-Za-z0-9:_\-.#@/]{1,128}$/u.test(value) ? value : "default");

const MAP: Partial<Record<LessonAuditEvent["action"], Mapped>> = {
  "lesson.candidate_created": { action: "lesson.proposed", facts: (e) => ({ lessonType: word(e.facts["type"], "unknown"), tier: 1 }) },
  "lesson.pending": { action: "lesson.proposed", facts: (e) => ({ lessonType: "unknown", tier: num(e.facts["tier"]) }) },
  "lesson.approved": { action: "lesson.approved", facts: (e) => ({ tier: num(e.facts["tier"]), approvals: num(e.facts["count"]), soleOwner: false }) },
  "lesson.sole_owner_exception": { action: "lesson.approved", facts: (e) => ({ tier: num(e.facts["tier"]), approvals: 1, soleOwner: true }) },
  "lesson.activated": { action: "lesson.activated", facts: (e) => ({ lessonType: word(e.facts["type"], "unknown"), tier: num(e.facts["tier"]), auto: false }) },
  "lesson.auto_applied": { action: "lesson.activated", facts: (e) => ({ lessonType: word(e.facts["type"], "unknown"), tier: num(e.facts["tier"]), auto: true }) },
  "lesson.updated": { action: "lesson.edited", facts: (e) => ({ tier: num(e.facts["tier"]), fromTier: num(e.facts["fromTier"]) }) },
  "lesson.rejected": { action: "lesson.rejected", facts: (e) => ({ tier: num(e.facts["tier"]) }) },
  // A person asked, in a pull request comment, for a lesson to be retired: the ledger names who. The owner retires it on their page (`lesson.retired`).
  "lesson.retire_requested": { action: "lesson.retire_requested", facts: (e) => ({ pullRequest: num(e.facts["pullRequest"]) }) },
  "lesson.retired": { action: "lesson.retired", facts: (e) => ({ cause: word(e.facts["cause"], "person"), tier: num(e.facts["tier"]) }) },
  "lesson.auto_retired": { action: "lesson.retired", facts: (e) => ({ cause: "harmful", tier: num(e.facts["tier"]) }) },
  "lesson.expired": { action: "lesson.expired", facts: (e) => ({ tier: num(e.facts["tier"]) }) },
  "lesson.withdrawn": { action: "lesson.withdrawn", facts: (e) => ({ cause: word(e.facts["cause"], "source_deleted") }) },
  "lesson.refused": { action: "lesson.refused", facts: (e) => ({ refusal: word(e.facts["reason"], "refused") }) },
  "lesson.promoted": { action: "lesson.promoted", facts: (e) => ({ tier: num(e.facts["tier"]) }) },
  "lesson.rolled_back": { action: "lesson.rolled_back", facts: (e) => ({ fromSetVersion: num(e.facts["from"]), toSetVersion: num(e.facts["to"]) }) },
  // A citation that moved, and a duplicate that was merged in, each commit a new version of the lesson's text or lines: recorded as an edit by the system.
  "lesson.citation_moved": { action: "lesson.edited", facts: (e) => ({ tier: num(e.facts["tier"]), fromTier: num(e.facts["tier"]) }) },
  "lesson.merged": { action: "lesson.edited", facts: (e) => ({ tier: num(e.facts["tier"]), fromTier: num(e.facts["tier"]) }) },
  // Loosening the tier-0 approval setting and the company sole-owner switch (a proposal for a second person, then the change; the exception is audited as such).
  "lesson.tier0_setting_proposed": { action: "lesson.tier0_setting_proposed", facts: (e) => ({ scope: word(e.facts["scope"], "project"), fromLevel: word(e.facts["from"], "unknown"), toLevel: word(e.facts["to"], "unknown") }) },
  "lesson.tier0_setting_changed": { action: "lesson.tier0_setting_changed", facts: (e) => ({ scope: word(e.facts["scope"], "project"), fromLevel: word(e.facts["from"], "unknown"), toLevel: word(e.facts["to"], "unknown"), mode: word(e.facts["mode"], "second_person") }) },
  // A fenced refusal that leaves the proposal open: recorded as a refusal (the contract's `lesson.refused`) with a fixed word.
  "lesson.tier0_setting_refused_retryable": { action: "lesson.refused", facts: () => ({ refusal: "membership_changed_retry" }) },
  // Approve by exception: a lesson that went live on trial is a go-live with no person (`auto: true`); a trial lesson retired by a thumbs-down or a contradicting correction is a retire with a fixed cause.
  "lesson.trial_started": { action: "lesson.activated", facts: (e) => ({ lessonType: word(e.facts["type"], "unknown"), tier: num(e.facts["tier"]), auto: true }) },
  "lesson.trial_retired": { action: "lesson.retired", facts: (e) => ({ cause: word(e.facts["reason"], "thumbs_down"), tier: num(e.facts["tier"]) }) },
  "lesson.preset_changed": { action: "lesson.preset_changed", facts: (e) => ({ scope: word(e.facts["scope"], "project"), fromPreset: word(e.facts["from"], "unknown"), toPreset: word(e.facts["to"], "unknown"), mode: word(e.facts["mode"], "direct") }) },
  "lesson.preset_proposed": { action: "lesson.preset_proposed", facts: (e) => ({ scope: word(e.facts["scope"], "project"), fromPreset: word(e.facts["from"], "unknown"), toPreset: word(e.facts["to"], "unknown") }) },
  // Erasing a commenter took back the harmful mark that retired a lesson, and the rest no longer justify it: the lesson goes back to a person as a pending card (never live by itself), recorded as a proposal.
  "lesson.harm_reversed": { action: "lesson.proposed", facts: (e) => ({ lessonType: word(e.facts["type"], "unknown"), tier: num(e.facts["tier"]) }) },
  // A weekly pull request about to be opened (counts), one Rovara closes (a fixed cause and the number), and a repository's switch. Written BEFORE the host is asked.
  "lesson.repo_file_pr_opened": { action: "lesson.repo_file_pr_opened", facts: (e) => ({ removals: num(e.facts["removals"]), edits: num(e.facts["edits"]), adds: num(e.facts["adds"]) }) },
  "lesson.repo_file_pr_closed": { action: "lesson.repo_file_pr_closed", facts: (e) => ({ cause: word(e.facts["cause"], "replaced"), pullRequest: num(e.facts["pullRequest"]) }) },
  "lesson.repo_file_switched": { action: "lesson.repo_file_switched", facts: (e) => ({ enabled: e.facts["enabled"] === true }) },
  "lesson.local_tools_switched": { action: "lesson.local_tools_switched", facts: (e) => ({ scope: word(e.facts["scope"], "project"), enabled: e.facts["enabled"] === true }) },
  // A person's answer on lessons that went missing from the file (retire or keep, and how many).
  "lesson.repo_file_retire_decided": { action: "lesson.repo_file_retire_decided", facts: (e) => ({ verdict: word(e.facts["verdict"], "keep"), missing: num(e.facts["missing"]) }) },
  // An operator starts a replay copy of a past task (ids, fixed words and counts only; written BEFORE the copy is started), and a frozen snapshot is created for it.
  "lesson.replay_started": { action: "lesson.replay_started", facts: (e) => ({ operator: modelWord(e.facts["operator"]), memory: word(e.facts["memory"], "off"), snapshotLessons: num(e.facts["snapshotLessons"]), maxCents: num(e.facts["maxCents"]), sourceTask: modelWord(e.facts["sourceTask"]) }) },
  "lesson.replay_read": { action: "lesson.replay_read", facts: (e) => ({ operator: modelWord(e.facts["operator"]), what: word(e.facts["what"], "subject"), maxCents: num(e.facts["maxCents"]), target: modelWord(e.facts["target"]) }) },
  "lesson.snapshot_created": { action: "lesson.snapshot_created", facts: (e) => ({ lessonSetVersion: num(e.facts["lessonSetVersion"]), lessonCount: num(e.facts["lessonCount"]) }) },
  // Stable makes a lesson publishable to a repository, so it is on the ledger.
  "lesson.trial_stable": { action: "lesson.trial_stable", facts: (e) => ({ tier: num(e.facts["tier"]) }) },
  "lesson.sole_owner_switch_proposed": { action: "lesson.sole_owner_switch_proposed", facts: (e) => ({ fromEnabled: e.facts["from"] === true, toEnabled: e.facts["to"] === true }) },
  "lesson.sole_owner_switch_changed": { action: "lesson.sole_owner_switch_changed", facts: (e) => ({ fromEnabled: e.facts["from"] === true, toEnabled: e.facts["to"] === true, mode: word(e.facts["mode"], "second_person") }) },
  // The company's choice of the model its lesson learning runs on (or back to the default). Model names are `provider/modelId`, which the safe-fact filter already allows.
  "lesson.model_set": { action: "lesson.model_set", facts: (e) => ({ fromModel: modelWord(e.facts["from"]), toModel: modelWord(e.facts["to"]) }) },
};

/** Actions with no ledger name on purpose: bookkeeping that grants nothing. Under `emitAudit` they are skipped; under `requireAudit` they would fail, so a grant never uses one. */
export const BOOKKEEPING: readonly LessonAuditAction[] = [
  "lesson.stale", "lesson.retire_proposed", "lesson.wrong_here", "lesson.helpful", "lesson.source_paused", "lesson.source_resumed", "lesson.volume_spike",
  "lesson.contradiction", "lesson.promote_failed", "lesson.held_source_paused", "lesson.tier0_setting_cancelled", "lesson.proposal_withdrawn",
];
/** The actions that have a ledger name. */
export const LEDGERED: readonly LessonAuditAction[] = Object.keys(MAP) as LessonAuditAction[];

/** The ids the ledger accepts for an actor: a person's id as it is, anything else is the system. */
const actorOf = (actor: string | undefined): AuditActor => (actor !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u.test(actor) ? { type: "person", id: actor } : { type: "system", id: "rovara" });

/** A stable event id: the same occurrence names the same id, a different one never does. */
const eventIdOf = (...parts: readonly string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);

/** The lessons audit sink over the `audit-sink` point. `stage` hands the caller the steps for its own `DocumentStore.transact`, so a change and its record commit together. */
export function lessonAuditSink(sink: AuditSink, now: () => number, companyId: string): LessonAuditSink {
  let counter = 0;
  /** The ledger event for a lessons event, or undefined for bookkeeping that is skipped. */
  const eventOf = (event: LessonAuditEvent, required: boolean): AuditEvent | undefined => {
    const mapped = MAP[event.action];
    if (mapped === undefined) {
      // An event that grants something and cannot be recorded must not pass; bookkeeping may be skipped.
      if (required || !BOOKKEEPING.includes(event.action)) throw new Error(`the ledger has no name for ${event.action}`);
      return undefined;
    }
    const at = new Date(now()).toISOString();
    // One event per occurrence: the time and a process counter keep two approvals of one lesson apart.
    counter += 1;
    const lessonId = event.lessonId ?? `${event.project}`;
    return {
      eventId: eventIdOf(mapped.action, event.workspaceId, lessonId, at, String(counter), event.actor ?? "system"), companyId, at, actor: actorOf(event.actor), action: mapped.action,
      subject: { type: "lesson", id: lessonId.slice(0, 100) }, details: { project: event.project, ...mapped.facts(event) },
    };
  };
  return {
    async emit(event, options) {
      const built = eventOf(event, options?.required === true);
      if (built !== undefined) await sink.record(built);
    },
    stage(event) {
      const built = eventOf(event, true);
      const items: readonly TransactItem[] = built === undefined ? [] : sink.stage(built);
      return { items, async sent() { /* the steps committed with the change; nothing is sent afterwards */ } };
    },
  };
}

// how an item of a tracker that ASKS FOR WORK becomes a start, whichever tracker it is. The intake engine (`intake/engine.ts`) already holds the one rule for a
// ticket (a task starts only from a member's act; anyone else waits for a member to say "Start"), and says: "an adapter turns its tracker's words into an IntakeCandidate; this file decides".
// This is that adapter for the Tracker port: a verified delivery becomes neutral events (the tracker's `events.normalise`), each event's item is read fresh (`readItem`), and the pair becomes
// the engine's candidate. The engine's request carries the source `tracker` and a `tracker_item` binding naming the tracker, which is how every tracker without a source of its own starts.
//
// Rules held here, each fail closed (a candidate is returned only when all hold; otherwise the event is skipped and nothing starts):
//   - the event and the item name the same tracker and the same item (an event can only point at an item; what the item says is read from the tracker, not from the event);
//   - the item has an https link without credentials (a ticket is bound by its link);
//   - Jira and GitHub Issues are not started through this door: they have channels and sources of their own, and the intent schema refuses a `tracker` intent that names them;
//   - the tracker must be able to start tasks (its capability), and the text of the item is outsider text that the engine frames, redacts and cuts.
import { IntakeExternalRefSchema, agentXError, type OrgId, type RawDelivery, type Tracker, type TrackerEvent, type TrackerItem, type HostScope } from "@agentx/contracts";
import { ingestIntake, type IntakeCandidate, type IntakeOutcome, type IntakePorts } from "./engine.js";

/** The systems that have an intake channel of their own, and so never start through the neutral `tracker` channel. */
const SYSTEMS_WITH_THEIR_OWN_CHANNEL: ReadonlySet<string> = new Set(["jira", "github"]);

/**
 * The engine's candidate for one event and the item it points at, or undefined when they do not make a ticket that may be started (see the rules above). `actor` is the tracker's stable
 * account id of the person who made the act (`assignedBy`, `labelledBy`): only an account a member has linked can make a start, and an event with none leaves the ticket waiting.
 */
export function intakeCandidateOfTrackerEvent(input: { orgId: OrgId; project: string; tracker: Pick<Tracker, "kind" | "capabilities">; event: TrackerEvent; item: TrackerItem }): IntakeCandidate | undefined {
  const { orgId, project, tracker, event, item } = input;
  if (!tracker.capabilities.startTasks) return undefined;
  if (event.tracker !== tracker.kind || item.ref.tracker !== tracker.kind || event.item.tracker !== tracker.kind || event.item.id !== item.ref.id) return undefined;
  if (SYSTEMS_WITH_THEIR_OWN_CHANNEL.has(tracker.kind)) return undefined;
  const externalRef = IntakeExternalRefSchema.safeParse({ system: tracker.kind, id: item.ref.id, url: item.ref.url ?? "" });
  if (!externalRef.success) return undefined;
  const person = event.type === "item.assigned_to_rovara" ? event.assignedBy : event.labelledBy;
  return {
    orgId, project, channel: "tracker", externalRef: externalRef.data,
    title: item.title, body: item.body,
    ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
    eventId: event.eventId,
    act: event.type === "item.assigned_to_rovara" ? { kind: "assignee", value: "rovara" } : { kind: "label", value: event.label },
    actor: person === undefined || person === "" ? { kind: "unknown" } : { kind: "person", account: { provider: tracker.kind, tenant: "", accountId: person } },
  };
}

/** What happened to one event of a delivery. */
export type TrackerStartResult = { event: TrackerEvent; outcome: IntakeOutcome } | { event: TrackerEvent; outcome: "skipped" };

/**
 * A tracker's delivery, from the signature to the engine. A delivery that does not verify throws before anything is read (the tracker's `normalise` refuses it). Each event's item is read
 * fresh; an item that cannot be read leaves that event unstarted and throws, so the tracker's retry delivers it again (the engine holds each event once by its id).
 */
export async function startFromTrackerDelivery(input: { ports: IntakePorts; orgId: OrgId; project: string; tracker: Tracker; scope: HostScope; delivery: RawDelivery }): Promise<TrackerStartResult[]> {
  const { tracker } = input;
  if (tracker.events?.normalise === undefined) return [];
  // The hook that verifies a delivery belongs to one project, and the delivery may start work in that project only. A tracker that cannot say which project its hook is for starts nothing.
  const bound = await tracker.events.projectOf?.(input.scope);
  if (bound === undefined || bound !== input.project) throw agentXError("CALLBACK_FORBIDDEN", "the tracker's hook is not for this project");
  const events = await tracker.events.normalise(input.delivery, input.scope);
  const results: TrackerStartResult[] = [];
  for (const event of events) {
    const item = await tracker.readItem(event.item, input.scope);
    const candidate = intakeCandidateOfTrackerEvent({ orgId: input.orgId, project: input.project, tracker, event, item });
    results.push({ event, outcome: candidate === undefined ? "skipped" : await ingestIntake(input.ports, candidate) });
  }
  return results;
}

// A tracker's `askedFor` as the poll's search: what a registered tracker says is asked for in a place becomes the engine's candidates (without the parts the source fixes: the company, the project and
// the channel). Nothing a tracker returns is trusted here: a result that names another tracker than the one asked is dropped by the poll, and the engine treats every string as an outsider's text.
import type { HostScope, Tracker } from "@agentx/contracts";
import { TrackerSearchError } from "@agentx/contracts";
import type { IntakeSearch } from "./poll.js";

/** The poll's search over one tracker, or undefined when the tracker cannot be asked (no `askedFor`). */
export function intakeSearchOfTracker(tracker: Tracker | undefined, scope: HostScope): IntakeSearch | undefined {
  const ask = tracker?.askedFor?.bind(tracker);
  if (tracker === undefined || ask === undefined) return undefined;
  return async ({ source, signal, limit }) => {
    const { when, connection } = source.ref;
    const found = await ask({ when: { ...(when.label === undefined ? {} : { label: when.label }), ...(when.assignedToRovara === true ? { assignedToRovara: true as const } : {}) }, ...(connection === undefined ? {} : { connection }), limit, signal }, scope);
    // An adapter is outside code: a result that is not a list is a failed read.
    const answer: unknown = found;
    if (!Array.isArray(answer)) throw new TrackerSearchError("SEARCH_FAILED");
    return found.map((item) => ({
      externalRef: { system: item.ref.tracker, id: item.ref.id, url: item.ref.url ?? "" },
      title: item.title,
      body: item.body,
      ...(item.reporter === undefined ? {} : { reporter: { display: item.reporter } }),
      ...(item.actor === undefined ? {} : { actor: { kind: item.actor.kind, ...(item.actor.account === undefined ? {} : { account: item.actor.account }), ...(item.actor.display === undefined ? {} : { display: item.actor.display }) } }),
      ...(item.change === undefined ? {} : { change: item.change }),
      ...(item.occurredAt === undefined ? {} : { occurredAt: item.occurredAt }),
      ...(item.alternateIds === undefined || item.alternateIds.length === 0 ? {} : { alternateIds: item.alternateIds }),
    }));
  };
}

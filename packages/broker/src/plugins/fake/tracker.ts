// A Tracker over an in-memory set of items. Writes are recorded so a test can see exactly what went out; reads give the text as stored (untrusted).
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  agentXError, HostScopeSchema, TrackerSearchError, NeutralStatusSchema, TrackerEventSchema, TrackerItemRefSchema,
  type ChangeRequestRef, type HostScope, type TrackerAskedItem, type TrackerAskedQuery, type TrackerCommentOptions, type NeutralStatus, type RawDelivery, type Tracker, type TrackerCapabilities, type TrackerEvent, type TrackerEvents, type TrackerItem,
  type TrackerItemRef, type UntrustedText,
} from "@agentx/contracts";

export const FAKE_TRACKER_KIND = "fake-tracker";
export const FAKE_TRACKER_SECRET = "fake-tracker-secret-not-a-real-secret";

export type FakeTrackerRawEvent =
  | { delivery: string; event: "assigned"; item: string; assignedBy?: string }
  | { delivery: string; event: "labelled"; item: string; label: string; labelledBy?: string };

export function fakeTrackerDelivery(event: FakeTrackerRawEvent, secret = FAKE_TRACKER_SECRET): RawDelivery {
  const rawBody = JSON.stringify(event);
  return { rawBody, headers: { "x-fake-signature": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`, "x-fake-delivery": event.delivery } };
}

export interface FakeTrackerOptions {
  /** The statuses Rovara may move an item to (an admin-chosen set). Default: all. */
  allowedStatuses?: readonly NeutralStatus[];
  secret?: string;
  /** The project the fake's "hook" is bound to (a delivery may start work in that project only). Default: none, so a start through it is refused. */
  project?: string;
}

export class FakeTracker implements Tracker {
  readonly kind = FAKE_TRACKER_KIND;
  readonly capabilities: TrackerCapabilities = { startTasks: true, comment: true, status: true, link: true, events: "webhook" };
  readonly events: TrackerEvents;
  readonly items = new Map<string, TrackerItem>();
  /** What Rovara wrote, in order. A comment carries its key and whether it was asked to be private. */
  readonly writes: Array<{ kind: "comment" | "status" | "link"; item: string; value: string; key?: string | undefined; requirePrivate?: boolean | undefined }> = [];
  /** Test driver: what the tracker says is asked for now (`askedFor`), or an error code the next read fails with. */
  asked: readonly TrackerAskedItem[] = [];
  askedFailure: ConstructorParameters<typeof TrackerSearchError>[0] | undefined;
  /** The queries `askedFor` was called with. */
  readonly queries: Array<Omit<TrackerAskedQuery, "signal">> = [];
  /** The status names this fake's items can be moved to by name (`setStatusByName`). */
  statusNames: readonly string[] = ["In Progress", "In Review", "Done"];
  private readonly allowed: ReadonlySet<NeutralStatus>;
  private readonly secret: string;

  constructor(options: FakeTrackerOptions = {}) {
    this.allowed = new Set(options.allowedStatuses ?? NeutralStatusSchema.options);
    this.secret = options.secret ?? FAKE_TRACKER_SECRET;
    this.events = { mode: "webhook", projectOf: async () => options.project, normalise: (delivery, scope) => this.normalise(delivery, scope) };
  }

  /** Test driver: an item exists. */
  addItem(id: string, input: Partial<Omit<TrackerItem, "ref">> = {}): TrackerItem {
    const item: TrackerItem = { ref: { tracker: FAKE_TRACKER_KIND, id, url: `https://host.example.test/items/${encodeURIComponent(id)}` }, title: input.title ?? `Item ${id}`, body: input.body ?? "", status: input.status ?? "open", labels: input.labels ?? [], ...(input.assignee === undefined ? {} : { assignee: input.assignee }) };
    this.items.set(id, item);
    return item;
  }

  protected scope(scope: HostScope): void {
    if (!HostScopeSchema.safeParse(scope).success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
  }

  protected item(ref: TrackerItemRef): TrackerItem {
    const parsed = TrackerItemRefSchema.parse(ref);
    if (parsed.tracker !== FAKE_TRACKER_KIND) throw agentXError("CONFIG_INVALID", "the item belongs to another tracker");
    const found = this.items.get(parsed.id);
    if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the tracker has no such item");
    return found;
  }

  async readItem(ref: TrackerItemRef, scope: HostScope): Promise<TrackerItem> {
    this.scope(scope);
    return ({ ...this.item(ref), labels: [...this.item(ref).labels] });
  }

  async comment(ref: TrackerItemRef, body: UntrustedText, scope: HostScope, options?: TrackerCommentOptions): Promise<void> {
    this.scope(scope);
    const item = this.item(ref);
    if (body.length === 0 || body.length > 65_536) throw agentXError("CONFIG_INVALID", "the comment is empty or too long");
    // The same key again is the same comment (a retry is never a second post).
    if (options?.key !== undefined && this.writes.some((write) => write.kind === "comment" && write.key === options.key)) return;
    this.writes.push({ kind: "comment", item: item.ref.id, value: body, ...(options?.key === undefined ? {} : { key: options.key }), ...(options?.requirePrivate === undefined ? {} : { requirePrivate: options.requirePrivate }) });
    return;
  }

  async setStatusByName(ref: TrackerItemRef, name: string, scope: HostScope): Promise<"moved" | "no_such_status"> {
    this.scope(scope);
    const item = this.item(ref);
    if (!this.statusNames.some((known) => known.toLowerCase() === name.toLowerCase())) return "no_such_status";
    this.writes.push({ kind: "status", item: item.ref.id, value: name });
    return "moved";
  }

  async askedFor(query: TrackerAskedQuery, scope: HostScope): Promise<readonly TrackerAskedItem[]> {
    this.scope(scope);
    this.queries.push({ when: query.when, ...(query.connection === undefined ? {} : { connection: query.connection }), limit: query.limit });
    if (this.askedFailure !== undefined) throw new TrackerSearchError(this.askedFailure);
    return this.asked.slice(0, query.limit);
  }

  async setStatus(ref: TrackerItemRef, status: NeutralStatus, scope: HostScope): Promise<void> {
    this.scope(scope);
    const item = this.item(ref);
    if (!NeutralStatusSchema.safeParse(status).success || !this.allowed.has(status)) throw agentXError("FORBIDDEN", "Rovara may not move items to that status");
    this.items.set(item.ref.id, { ...item, status });
    this.writes.push({ kind: "status", item: item.ref.id, value: status });
    return;
  }

  async link(ref: TrackerItemRef, changeRequest: ChangeRequestRef, scope: HostScope): Promise<void> {
    this.scope(scope);
    const item = this.item(ref);
    this.writes.push({ kind: "link", item: item.ref.id, value: changeRequest.url });
    return;
  }

  private async normalise(delivery: RawDelivery, scope: HostScope): Promise<TrackerEvent[]> {
    this.scope(scope);
    const given = /^sha256=([0-9a-f]{64})$/.exec(delivery.headers["x-fake-signature"] ?? "")?.[1];
    const expected = createHmac("sha256", this.secret).update(delivery.rawBody).digest();
    if (given === undefined || !timingSafeEqual(Buffer.from(given, "hex"), expected)) throw agentXError("CALLBACK_FORBIDDEN", "the delivery's signature does not verify");
    let raw: FakeTrackerRawEvent;
    try {
      raw = JSON.parse(delivery.rawBody) as FakeTrackerRawEvent;
    } catch {
      throw agentXError("CONFIG_INVALID", "the delivery is not JSON");
    }
    const base = { eventId: raw.delivery, tracker: FAKE_TRACKER_KIND, item: { tracker: FAKE_TRACKER_KIND, id: raw.item } } as const;
    if (raw.event === "assigned") return ([TrackerEventSchema.parse({ ...base, type: "item.assigned_to_rovara", ...(raw.assignedBy === undefined ? {} : { assignedBy: raw.assignedBy }) })]);
    if (raw.event === "labelled") return ([TrackerEventSchema.parse({ ...base, type: "item.labelled", label: raw.label, ...(raw.labelledBy === undefined ? {} : { labelledBy: raw.labelledBy }) })]);
    throw agentXError("CONFIG_INVALID", "the delivery names an event this tracker does not send");
  }
}

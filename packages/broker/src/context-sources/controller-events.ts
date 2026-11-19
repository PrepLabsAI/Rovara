// What the broker does with the MCP host's events (a host writes them; Code runs none of its own yet).
//   - it records each as an audit event (once: the event's own key is the audit occurrence, so a retry is the same event);
//   - it pauses a server whose tools changed after approval (`changed_needs_review`), if the entry still carries the approved hash;
//   - it keeps the last few for the "recent starts" line on the server card.
// Draining is bounded (a page at a time, at most `max` events per call) and never throws: it runs when an admin looks at the list, and can also be called from a schedule.
import { McpControllerEventSchema, change, orgScoped, when, type DocumentStore, type McpControllerEvent, type McpTaskStopReason, type OrgId, type StoredDocument } from "@agentx/contracts";
import type { McpServerStore } from "./mcp-servers.js";

export interface StoredControllerEvent { sk: string; event: McpControllerEvent; audited: boolean }

export interface ControllerEventStore {
  /** The org's newest events, newest first (at most `limit`). */
  recent(orgId: OrgId, limit: number): Promise<StoredControllerEvent[]>;
  /** Events not yet recorded in the audit trail, oldest first (at most `limit`). */
  unaudited(orgId: OrgId, limit: number): Promise<StoredControllerEvent[]>;
  markAudited(orgId: OrgId, sk: string): Promise<void>;
}

const PREFIX = "EVT#";
const MAX_PAGES = 5;

export function documentControllerEventStore(deps: { store: DocumentStore }): ControllerEventStore {
  const partition = (orgId: OrgId): string => orgScoped(orgId, "MCPEVT");
  /** An item that does not parse is not served: it can never pause a server or become an audit event. */
  const parse = (item: StoredDocument): StoredControllerEvent | undefined => {
    const { pk: _pk, sk, audited, ...rest } = item;
    void _pk;
    const parsed = McpControllerEventSchema.safeParse(rest);
    return parsed.success && typeof sk === "string" && sk.startsWith(PREFIX) ? { sk, event: parsed.data, audited: audited === true } : undefined;
  };
  return {
    async recent(orgId, limit) {
      const out = await deps.store.query({ pk: partition(orgId), sk: { op: "beginsWith", prefix: PREFIX }, descending: true, limit: Math.min(Math.max(1, limit), 200) });
      return out.items.map(parse).filter((item): item is StoredControllerEvent => item !== undefined);
    },
    async unaudited(orgId, limit) {
      const found: StoredControllerEvent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && found.length < limit; page += 1) {
        const out = await deps.store.query({ pk: partition(orgId), sk: { op: "beginsWith", prefix: PREFIX }, filter: when.notExists("audited"), limit: 100, ...(cursor === undefined ? {} : { cursor }) });
        for (const item of out.items) { const parsed = parse(item); if (parsed !== undefined && found.length < limit) found.push(parsed); }
        cursor = out.cursor;
        if (cursor === undefined) break;
      }
      return found;
    },
    async markAudited(orgId, sk) {
      await deps.store.update({ key: { pk: partition(orgId), sk }, ops: [change.set("audited", true)], condition: when.present() });
    },
  };
}

export interface DrainDependencies {
  events: ControllerEventStore;
  servers: Pick<McpServerStore, "pause">;
  /** Records one event in the audit trail. Throws when it could not (the event is then left for the next drain). Absent: nothing is recorded (an install with no ledger). */
  audit?: ((orgId: OrgId, sk: string, event: McpControllerEvent) => Promise<void>) | undefined;
  now: () => number;
}

/**
 * Records the org's new events and applies the one that pauses a server. Oldest first, at most `max`, and it stops at the first event it cannot record, so the trail stays in order.
 * Returns how many it handled. Never throws.
 */
export async function drainControllerEvents(deps: DrainDependencies, orgId: OrgId, max = 25): Promise<number> {
  let handled = 0;
  try {
    for (const { sk, event } of await deps.events.unaudited(orgId, Math.max(1, Math.min(max, 100)))) {
      if (deps.audit !== undefined) await deps.audit(orgId, sk, event);
      if (event.type === "changed_needs_review") {
        // Only an entry that is still approved with the very tools hash that was approved: if the admin already looked again, this is old news and changes nothing.
        // the pause is recorded as its own time; the approving admin stays on the entry.
        await deps.servers.pause({ orgId, serverId: event.serverId, toolsHash: event.approved, at: new Date(deps.now()).toISOString() });
      }
      await deps.events.markAudited(orgId, sk);
      handled += 1;
    }
  } catch { /* the rest waits for the next drain */ }
  return handled;
}

/** What the server card says about a server's recent life. Counted from the events the controller wrote. */
export interface ServerActivity {
  /** Starts in the last 24 hours. */
  starts24h: number;
  lastStartAt?: string;
  lastStop?: { at: string; reason: McpTaskStopReason };
  /** Three crashes within ten minutes: the controller has stopped trying for a while. */
  keepsStopping: boolean;
}

const DAY_MS = 24 * 3_600_000;
const CRASH_WINDOW_MS = 10 * 60_000;

/** The activity of each server, from the newest events (newest first). */
export function serverActivities(events: readonly StoredControllerEvent[], nowMs: number): Record<string, ServerActivity> {
  const out: Record<string, ServerActivity> = {};
  const crashes = new Map<string, number>();
  for (const { event } of events) {
    if (event.type !== "task_started" && event.type !== "task_stopped") continue;
    const at = Date.parse(event.at);
    const activity = (out[event.serverId] ??= { starts24h: 0, keepsStopping: false });
    if (event.type === "task_started") {
      if (nowMs - at < DAY_MS) activity.starts24h += 1;
      activity.lastStartAt ??= event.at;
    } else {
      activity.lastStop ??= { at: event.at, reason: event.reason };
      if (event.reason === "crash" && nowMs - at < CRASH_WINDOW_MS) crashes.set(event.serverId, (crashes.get(event.serverId) ?? 0) + 1);
    }
  }
  for (const [serverId, count] of crashes) if (count >= 3) out[serverId]!.keepsStopping = true;
  return out;
}

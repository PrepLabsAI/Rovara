// The audit trail of registered MCP servers and project Sources: the adapters that turn the hooks of mcp-servers.ts and settings.ts into audit events on the `audit-sink` port. The decision has
// already committed when its hook runs, so this is the "record after" pattern used where the store cannot join the sink's transaction; a failure is the caller's to log and never undoes the
// decision (`told` in the callers). Ids, fixed words and flags only: the server's label is a fact for the reader; its address, its token and a source's name never are.
import { createHash } from "node:crypto";
import type { AuditActor, AuditSink, JsonObject, JsonValue, McpControllerEvent, OrgId } from "@agentx/contracts";
import type { DrainDependencies } from "./controller-events.js";
import type { McpServerDependencies } from "./mcp-servers.js";
import type { SettingsDependencies } from "./settings.js";

/** A stable id for one occurrence: recording it twice records it once. */
const occurrence = (...parts: string[]): string => createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32);

const person = (id: string): AuditActor => ({ type: "person", id });
const system: AuditActor = { type: "system", id: "rovara" };

/** An event's own fields as audit details: the ones that are plain data, without the actor and the action. */
function detailsOf(event: object, omit: readonly string[]): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(event)) {
    if (omit.includes(name) || value === undefined) continue;
    out[name] = JSON.parse(JSON.stringify(value)) as JsonValue;
  }
  return out;
}

/** The `audit` hook of the MCP servers flow; undefined where the install has no sink. */
export function mcpServerAudit(sink: AuditSink | undefined, now: () => number): McpServerDependencies["audit"] | undefined {
  if (sink === undefined) return undefined;
  return async (event) => {
    const at = new Date(now()).toISOString();
    // One occurrence per kind of fact: the same server can be installed, tested and approved at the same moment under one clock reading.
    await sink.record({
      eventId: occurrence(event.serverId, at, event.action), companyId: event.actor.orgId, at, actor: person(event.actor.developerId), action: event.action,
      subject: { type: "mcp-server", id: event.serverId }, details: detailsOf(event, ["actor", "action"]),
    });
  };
}

/** The `audit` hook of the Sources settings. */
export function contextSourceAudit(sink: AuditSink | undefined, now: () => number): SettingsDependencies["audit"] | undefined {
  if (sink === undefined) return undefined;
  return async (event) => {
    const at = new Date(now()).toISOString();
    await sink.record({
      eventId: occurrence(event.changeId, event.action), companyId: event.actor.orgId, at, actor: person(event.actor.developerId), action: event.action,
      subject: { type: "project", id: event.project }, details: { sourceId: event.sourceId, change: event.change, changeId: event.changeId },
    });
  };
}

/**
 * The `audit` hook of the host's events: each is recorded as the system's own fact about a package-run server. The event's sort key is the occurrence, so draining the same event twice
 * (after a failure between recording and marking) is one event in the trail.
 */
export function controllerEventAudit(sink: AuditSink | undefined): DrainDependencies["audit"] | undefined {
  if (sink === undefined) return undefined;
  return async (orgId: OrgId, sk: string, event: McpControllerEvent) => {
    await sink.record({
      eventId: occurrence(orgId, sk), companyId: orgId, at: event.at, actor: system, action: `mcp_server.${event.type}`,
      subject: { type: "mcp-server", id: event.serverId }, details: detailsOf(event, ["type", "serverId", "at"]),
    });
  };
}

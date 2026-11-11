// The PagerDuty connector's tools. PagerDuty is read with an org connection's REST API key at `https://api.pagerduty.com/` (US) or
// `https://api.eu.pagerduty.com/` (EU). A scope is a set of 1 to 10 services: every incident list is bound to them (`service_ids[]` is the server's, never the
// model's), an incident is shown only if it is on one of them, and the on-calls are those of their escalation policies.
//
// Endpoints, confirmed against docs.pagerduty.com/developer/api/reference/rest (2026-10-22): `Authorization: Token token=<key>` and
// `Accept: application/vnd.pagerduty+json;version=2` on every request.
//   list_incidents             GET /incidents (statuses[], service_ids[], since, until, limit up to 100)
//   get_incident               GET /incidents/{id}                       (incident.service.id, assignments, escalation_policy)
//   list_incident_log_entries  GET /incidents/{id}/log_entries           (limit; log_entries[].type, summary, created_at, agent.summary)
//   list_oncalls               GET /oncalls (escalation_policy_ids[])    (oncalls[].user, escalation_policy, escalation_level, start, end)
//   check                      GET /abilities
// Not read from the documentation pages: `GET /services/{id}` (used to learn a service's escalation policy; it is PagerDuty's long-standing service route).
import { PagerDutyConnectorSchema, type OrgConnection, type PagerDutyConnectorConfig } from "@agentx/contracts";
import { NativeCheckFailed, NativeToolRefusal, type NativeConnectorSpec, type NativeTool, type NativeToolContext } from "./runtime.js";
import { VendorFetchError } from "./vendor-fetch.js";

export interface PagerDutyEngineScope { alias: string; serviceIds: string[] }
export interface PagerDutyRunScope { alias: string; serviceIds: string[] }

export const PAGERDUTY_KEY_REFUSED = "PagerDuty refused the API key. Check that it is a valid REST API key for this region.";

const ACCEPT = "application/vnd.pagerduty+json;version=2";
const INCIDENT_ID = "^[A-Za-z0-9]{1,30}$";
const CLIP = 300;
const clip = (value: unknown, max = CLIP): string => {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const headersFor = (token: string): Record<string, string> => ({ authorization: `Token token=${token}`, accept: ACCEPT });

async function pdGet(ctx: NativeToolContext<PagerDutyRunScope>, path: string, query: Array<[string, string]> = [], notFound = "PagerDuty has no such item"): Promise<unknown> {
  const search = new URLSearchParams(query).toString();
  const response = await ctx.fetch(`${path}${search === "" ? "" : `?${search}`}`, { headers: headersFor(ctx.credential.token) });
  if (response.status === 200) {
    if (response.json === undefined) throw new NativeToolRefusal("PagerDuty answered something this connector cannot read", "vendor_error");
    return response.json;
  }
  if (response.status === 401 || response.status === 403) throw new NativeToolRefusal(PAGERDUTY_KEY_REFUSED, "vendor_error");
  if (response.status === 404) throw new NativeToolRefusal(notFound, "vendor_error");
  if (response.status === 429) throw new NativeToolRefusal("PagerDuty is limiting requests; try again later", "vendor_error");
  throw new NativeToolRefusal(`PagerDuty answered HTTP ${String(response.status)}`, "vendor_error");
}

/** An incident on one of the scope's services, or a refusal: the incident route answers for any service the key can see. */
async function incidentInScope(ctx: NativeToolContext<PagerDutyRunScope>, incidentId: string): Promise<Record<string, unknown>> {
  const incident = recordOf(recordOf(await pdGet(ctx, `incidents/${encodeURIComponent(incidentId)}`, [], "PagerDuty has no such incident"))["incident"]);
  const serviceId = recordOf(incident["service"])["id"];
  if (typeof serviceId !== "string" || !ctx.scope.serviceIds.includes(serviceId)) throw new NativeToolRefusal(`that incident is not in ${ctx.scope.alias}`);
  return incident;
}

const incidentLine = (incident: Record<string, unknown>): string =>
  `#${clip(incident["incident_number"], 12)} ${clip(incident["id"], 30)} [${clip(incident["status"], 20)}, ${clip(incident["urgency"], 10)}] ${clip(incident["title"])} (${clip(recordOf(incident["service"])["summary"], 80)}, ${clip(incident["created_at"], 30)}) ${clip(incident["html_url"], 200)}`;

const listIncidents: NativeTool<PagerDutyRunScope> = {
  name: "list_incidents",
  description: "List the incidents of this PagerDuty scope's services, newest first. Optionally choose statuses and how many hours back to look (default: the last month).",
  inputSchema: {
    type: "object",
    properties: {
      statuses: { type: "array", maxItems: 3, items: { type: "string", enum: ["triggered", "acknowledged", "resolved"] }, description: "Only incidents in these statuses" },
      sinceHoursAgo: { type: "integer", minimum: 1, maximum: 720, description: "How far back to look, in hours" },
    },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const query: Array<[string, string]> = ctx.scope.serviceIds.map((id): [string, string] => ["service_ids[]", id]);
    for (const status of listOf(args["statuses"])) if (typeof status === "string") query.push(["statuses[]", status]);
    if (typeof args["sinceHoursAgo"] === "number") query.push(["since", new Date(Date.now() - args["sinceHoursAgo"] * 3_600_000).toISOString()]);
    query.push(["limit", "25"], ["sort_by", "created_at:desc"]);
    // The filter is the server's, but the answer is not trusted to have kept to it.
    const incidents = listOf(recordOf(await pdGet(ctx, "incidents", query))["incidents"]).filter(isRecord)
      .filter((incident) => ctx.scope.serviceIds.includes(String(recordOf(incident["service"])["id"])));
    return { text: incidents.length === 0 ? `No incidents in ${ctx.scope.alias}.` : `${String(incidents.length)} incident${incidents.length === 1 ? "" : "s"} in ${ctx.scope.alias}:\n${incidents.map(incidentLine).join("\n")}` };
  },
};

const getIncident: NativeTool<PagerDutyRunScope> = {
  name: "get_incident",
  description: "Read one incident of this PagerDuty scope's services by its id: status, urgency, service, assignees and escalation policy.",
  inputSchema: { type: "object", properties: { incidentId: { type: "string", pattern: INCIDENT_ID, description: "The PagerDuty incident id (or number)" } }, required: ["incidentId"], additionalProperties: false },
  async run(args, ctx) {
    const incident = await incidentInScope(ctx, String(args["incidentId"]));
    const assignees = listOf(incident["assignments"]).filter(isRecord).slice(0, 10).map((assignment) => clip(recordOf(assignment["assignee"])["summary"], 80));
    return {
      text: [
        incidentLine(incident),
        `Assigned to: ${assignees.join(", ") || "nobody"}`,
        `Escalation policy: ${clip(recordOf(incident["escalation_policy"])["summary"], 100)}`,
        `Created: ${clip(incident["created_at"], 30)}`,
      ].join("\n"),
    };
  },
};

const listIncidentLogEntries: NativeTool<PagerDutyRunScope> = {
  name: "list_incident_log_entries",
  description: "Read the timeline of one incident of this PagerDuty scope's services: what happened and who did it, newest first.",
  inputSchema: { type: "object", properties: { incidentId: { type: "string", pattern: INCIDENT_ID, description: "The PagerDuty incident id (or number)" } }, required: ["incidentId"], additionalProperties: false },
  async run(args, ctx) {
    const incidentId = String(args["incidentId"]);
    await incidentInScope(ctx, incidentId);
    const entries = listOf(recordOf(await pdGet(ctx, `incidents/${encodeURIComponent(incidentId)}/log_entries`, [["limit", "50"]]))["log_entries"]).filter(isRecord).slice(0, 50);
    if (entries.length === 0) return { text: "No log entries." };
    // The channel, contexts and event details are the senders' own data and may hold routing keys: only what happened and who did it is shown.
    const lines = entries.map((entry) => `${clip(entry["created_at"], 30)} ${clip(entry["type"], 40)}: ${clip(entry["summary"], 200)}${clip(recordOf(entry["agent"])["summary"], 80) === "" ? "" : ` (by ${clip(recordOf(entry["agent"])["summary"], 80)})`}`);
    return { text: `${String(entries.length)} log entr${entries.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}` };
  },
};

const listOncalls: NativeTool<PagerDutyRunScope> = {
  name: "list_oncalls",
  description: "List who is on call now for this PagerDuty scope's services, by escalation policy and level.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    const policies: string[] = [];
    for (const id of ctx.scope.serviceIds) {
      const policy = recordOf(recordOf(recordOf(await pdGet(ctx, `services/${encodeURIComponent(id)}`, [], "PagerDuty has no such service"))["service"])["escalation_policy"])["id"];
      if (typeof policy === "string" && !policies.includes(policy)) policies.push(policy);
    }
    if (policies.length === 0) return { text: `No escalation policies for ${ctx.scope.alias}.` };
    const query: Array<[string, string]> = [...policies.map((id): [string, string] => ["escalation_policy_ids[]", id]), ["limit", "50"]];
    const oncalls = listOf(recordOf(await pdGet(ctx, "oncalls", query))["oncalls"]).filter(isRecord)
      .filter((entry) => policies.includes(String(recordOf(entry["escalation_policy"])["id"]))).slice(0, 50);
    if (oncalls.length === 0) return { text: `Nobody is on call for ${ctx.scope.alias}.` };
    const lines = oncalls.map((entry) => `${clip(recordOf(entry["escalation_policy"])["summary"], 100)} level ${clip(entry["escalation_level"], 4)}: ${clip(recordOf(entry["user"])["summary"], 80)} (${clip(entry["start"], 30)} to ${clip(entry["end"], 30)})`);
    return { text: `${String(oncalls.length)} on call:\n${lines.join("\n")}` };
  },
};

export const PAGERDUTY_TOOLS: readonly NativeTool<PagerDutyRunScope>[] = [listIncidents, getIncident, listIncidentLogEntries, listOncalls];
/** The tools a project may approve on a pagerduty connector (`PROJECT_CONNECTOR_TOOLS.pagerduty`). */
export const PAGERDUTY_TOOL_NAMES: readonly string[] = PAGERDUTY_TOOLS.map((tool) => tool.name);

type PagerDutyConnection = Extract<OrgConnection, { type: "pagerduty" }>;

export const PAGERDUTY_SPEC: NativeConnectorSpec<PagerDutyConnectorConfig, PagerDutyEngineScope, PagerDutyRunScope, PagerDutyConnection> = {
  type: "pagerduty",
  connectionType: "pagerduty",
  schema: PagerDutyConnectorSchema,
  label: "PagerDuty",
  vendor: "PagerDuty",
  scopeNoun: "service set",
  scopes: (config) => config.scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, serviceIds: [...scope.serviceIds] } })),
  endpoint: (connection) => new URL(connection.region === "eu" ? "https://api.eu.pagerduty.com/" : "https://api.pagerduty.com/"),
  permissionsHint: "the PagerDuty REST API key (a read-only key is enough)",
  tools: PAGERDUTY_TOOLS,
  itemArguments: [],
  routing: {
    properties: {
      scopeAlias: { type: "string", minLength: 1, maxLength: 63 },
      serviceIds: { type: "string", minLength: 1, maxLength: 200 },
    },
    scopeOf: (values) => ({ alias: values["scopeAlias"]!, serviceIds: values["serviceIds"]!.split(",") }),
    fromScope: (scope) => ({ scopeAlias: scope.alias, serviceIds: scope.serviceIds.join(",") }),
    fromConnection: () => ({}),
  },
  checkHeaders: (secret) => headersFor((secret as { apiKey: string }).apiKey),
  async check(fetch) {
    const response = await fetch("abilities");
    if (response.status === 200) return;
    if (response.status === 401 || response.status === 403) throw new NativeCheckFailed(PAGERDUTY_KEY_REFUSED);
    throw new VendorFetchError(`PagerDuty answered HTTP ${String(response.status)}`);
  },
};

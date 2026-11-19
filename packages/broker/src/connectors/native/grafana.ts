// The Grafana connector's tools. Grafana is read with an org connection's service account token at the base URL a person typed, so every
// connection goes through the endpoint guard (`hostTyped` in the spec): the host is checked again, the connection is pinned to the addresses that check returned
// and a redirect is refused. A scope may name folders (alerts, rules and dashboards outside them are refused) and one data source (the only one a metric query
// goes to; without one the query tool is not offered).
//
// Endpoints, from Grafana's HTTP API documentation (grafana.com/docs, 2026-10-22):
//   list_firing_alerts  GET  /api/alertmanager/grafana/api/v2/alerts?active=true   (the Grafana-managed Alertmanager; alerts carry the label __alert_rule_uid__)
//                       GET  /api/v1/provisioning/alert-rules                      (to learn which rules are in the scope's folders; each has uid and folderUID)
//   get_alert_rule      GET  /api/v1/provisioning/alert-rules/{uid}                (folderUID)
//   get_dashboard       GET  /api/dashboards/uid/{uid}                             (meta.folderUid)
//   query_prometheus    POST /api/ds/query                                         (queries[].datasource.uid, expr, range; from and to in epoch milliseconds)
//   check               GET  /api/health, then GET /api/user
// Not confirmed in the documentation pages that were readable: the response shapes of the legacy dashboard, /api/ds/query and alertmanager routes (they are the
// long-standing ones the plan names), and the provisioning alert-rule routes are marked deprecated there in favour of the App Platform ones.
import { GrafanaConnectorSchema, type GrafanaConnectorConfig, type OrgConnection } from "@agentx/contracts";
import { NativeCheckFailed, NativeToolRefusal, type NativeConnectorSpec, type NativeTool, type NativeToolContext } from "./runtime.js";
import { VendorFetchError } from "./vendor-fetch.js";

export interface GrafanaEngineScope { alias: string; folderUids?: string[] | undefined; datasourceUid?: string | undefined }
export interface GrafanaRunScope { alias: string; folderUids: string[]; datasourceUid: string }

export const GRAFANA_TOKEN_REFUSED = "Grafana refused the token. Check that the service account token is valid and its role can read alerts, dashboards and data sources.";

const UID = "^[A-Za-z0-9_-]{1,40}$";
const CLIP = 300;
const clip = (value: unknown, max = CLIP): string => {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const segment = encodeURIComponent;

async function grafanaRequest(ctx: NativeToolContext<GrafanaRunScope>, path: string, options: { query?: Record<string, string>; body?: unknown; notFound?: string } = {}): Promise<unknown> {
  const search = new URLSearchParams(options.query ?? {}).toString();
  const response = await ctx.fetch(`${path}${search === "" ? "" : `?${search}`}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${ctx.credential.token}`, accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 200) {
    if (response.json === undefined) throw new NativeToolRefusal("Grafana answered something this connector cannot read", "vendor_error");
    return response.json;
  }
  if (response.status === 401 || response.status === 403) throw new NativeToolRefusal(GRAFANA_TOKEN_REFUSED, "vendor_error");
  if (response.status === 404) throw new NativeToolRefusal(options.notFound ?? "Grafana has no such alert rule or dashboard", "vendor_error");
  if (response.status === 429) throw new NativeToolRefusal("Grafana is limiting requests; try again later", "vendor_error");
  throw new NativeToolRefusal(`Grafana answered HTTP ${String(response.status)}`, "vendor_error");
}

/** Whether a folder uid is one the scope reaches (every folder when the scope names none). */
const inScope = (scope: GrafanaRunScope, folderUid: unknown): boolean => scope.folderUids.length === 0 || (typeof folderUid === "string" && scope.folderUids.includes(folderUid));

const listFiringAlerts: NativeTool<GrafanaRunScope> = {
  name: "list_firing_alerts",
  description: "List the alerts firing now in this Grafana scope: name, severity, since when and the summary.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    let allowed: Set<string> | undefined;
    if (ctx.scope.folderUids.length > 0) {
      const rules = listOf(await grafanaRequest(ctx, "api/v1/provisioning/alert-rules")).filter(isRecord);
      allowed = new Set(rules.filter((rule) => inScope(ctx.scope, rule["folderUID"])).map((rule) => String(rule["uid"])));
    }
    const alerts = listOf(await grafanaRequest(ctx, "api/alertmanager/grafana/api/v2/alerts", { query: { active: "true", silenced: "false", inhibited: "false" } })).filter(isRecord)
      .filter((alert) => allowed === undefined || allowed.has(String(recordOf(alert["labels"])["__alert_rule_uid__"]))).slice(0, 50);
    if (alerts.length === 0) return { text: `No alerts are firing in ${ctx.scope.alias}.` };
    const lines = alerts.map((alert) => {
      const labels = recordOf(alert["labels"]);
      return `${clip(labels["alertname"], 120)} [${clip(labels["severity"], 20) || "no severity"}] since ${clip(alert["startsAt"], 40)}: ${clip(recordOf(alert["annotations"])["summary"], 200)}`;
    });
    return { text: `${String(alerts.length)} firing alert${alerts.length === 1 ? "" : "s"} in ${ctx.scope.alias}:\n${lines.join("\n")}` };
  },
};

const getAlertRule: NativeTool<GrafanaRunScope> = {
  name: "get_alert_rule",
  description: "Read one Grafana alert rule of this scope by its uid: its title, folder, group, timing, labels, annotations and queries.",
  inputSchema: { type: "object", properties: { uid: { type: "string", pattern: UID, description: "The alert rule uid" } }, required: ["uid"], additionalProperties: false },
  async run(args, ctx) {
    const rule = recordOf(await grafanaRequest(ctx, `api/v1/provisioning/alert-rules/${segment(String(args["uid"]))}`));
    if (!inScope(ctx.scope, rule["folderUID"])) throw new NativeToolRefusal(`that alert rule is not in ${ctx.scope.alias}`);
    const queries = listOf(rule["data"]).filter(isRecord).slice(0, 5).map((query) => `${clip(query["refId"], 10)}: ${clip(recordOf(query["model"])["expr"], 300)}`);
    return {
      text: [
        `Alert rule ${clip(rule["uid"], 60)}: ${clip(rule["title"])}`,
        `Folder: ${clip(rule["folderUID"], 60)}, group ${clip(rule["ruleGroup"], 100)}`,
        `For: ${clip(rule["for"], 20)}, condition ${clip(rule["condition"], 10)}, no data ${clip(rule["noDataState"], 20)}, error ${clip(rule["execErrState"], 20)}`,
        `Labels: ${Object.entries(recordOf(rule["labels"])).slice(0, 10).map(([key, value]) => `${clip(key, 40)}=${clip(value, 80)}`).join(", ")}`,
        `Summary: ${clip(recordOf(rule["annotations"])["summary"], 300)}`,
        ...queries.map((query) => `Query ${query}`),
      ].join("\n"),
    };
  },
};

const getDashboard: NativeTool<GrafanaRunScope> = {
  name: "get_dashboard",
  description: "Read one Grafana dashboard of this scope by its uid: its title, tags, folder and panels with their queries.",
  inputSchema: { type: "object", properties: { uid: { type: "string", pattern: UID, description: "The dashboard uid" } }, required: ["uid"], additionalProperties: false },
  async run(args, ctx) {
    const answer = recordOf(await grafanaRequest(ctx, `api/dashboards/uid/${segment(String(args["uid"]))}`));
    const meta = recordOf(answer["meta"]);
    if (!inScope(ctx.scope, meta["folderUid"])) throw new NativeToolRefusal(`that dashboard is not in ${ctx.scope.alias}`);
    const dashboard = recordOf(answer["dashboard"]);
    const panels = listOf(dashboard["panels"]).filter(isRecord).slice(0, 30).map((panel) => {
      const exprs = listOf(panel["targets"]).filter(isRecord).map((target) => clip(target["expr"], 200)).filter((expr) => expr !== "").slice(0, 3);
      return `- ${clip(panel["title"], 100)} (${clip(panel["type"], 30)})${exprs.length === 0 ? "" : `: ${exprs.join(" | ")}`}`;
    });
    return {
      text: [
        `Dashboard ${clip(dashboard["uid"], 60)}: ${clip(dashboard["title"])}`,
        `Folder: ${clip(meta["folderTitle"], 100)} (${clip(meta["folderUid"], 60)}), version ${clip(meta["version"], 10)}`,
        `Tags: ${listOf(dashboard["tags"]).map((tag) => clip(tag, 40)).join(", ")}`,
        ...panels,
      ].join("\n"),
    };
  },
};

const queryPrometheus: NativeTool<GrafanaRunScope> = {
  name: "query_prometheus",
  description: "Run one PromQL range query against this scope's Prometheus data source over a recent period, and summarise each series.",
  inputSchema: {
    type: "object",
    properties: {
      expr: { type: "string", minLength: 1, maxLength: 500, description: "A PromQL expression" },
      fromMinutesAgo: { type: "integer", minimum: 5, maximum: 1440, description: "How far back to look, in minutes" },
      stepSeconds: { type: "integer", minimum: 15, maximum: 3600, description: "The query step in seconds (default 60)" },
    },
    required: ["expr", "fromMinutesAgo"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    if (ctx.scope.datasourceUid === "") throw new NativeToolRefusal("that scope has no data source");
    const step = typeof args["stepSeconds"] === "number" ? args["stepSeconds"] : 60;
    const to = Date.now();
    const from = to - Number(args["fromMinutesAgo"]) * 60_000;
    const body = {
      queries: [{ refId: "A", datasource: { uid: ctx.scope.datasourceUid }, expr: String(args["expr"]), range: true, instant: false, intervalMs: step * 1000, maxDataPoints: 500 }],
      from: String(from),
      to: String(to),
    };
    const answer = recordOf(await grafanaRequest(ctx, "api/ds/query", { body }));
    const result = recordOf(recordOf(answer["results"])["A"]);
    // What Grafana says about a bad query is its own text; only a fixed sentence goes on.
    if (result["error"] !== undefined) throw new NativeToolRefusal("Grafana could not run that query", "vendor_error");
    const frames = listOf(result["frames"]).filter(isRecord).slice(0, 20);
    if (frames.length === 0) return { text: `No data for that query in ${ctx.scope.alias}.` };
    const lines = frames.map((frame) => {
      const fields = listOf(recordOf(frame["schema"])["fields"]).filter(isRecord);
      const values = listOf(recordOf(frame["data"])["values"]);
      const labels = Object.entries(recordOf(fields[1]?.["labels"])).slice(0, 8).map(([key, value]) => `${clip(key, 40)}=${clip(value, 80)}`).join(",");
      const numbers = listOf(values[1]).filter((value): value is number => typeof value === "number");
      const last = numbers.at(-1);
      return `{${labels}}: ${String(numbers.length)} points${last === undefined ? "" : `, last ${String(last)}, min ${String(Math.min(...numbers))}, max ${String(Math.max(...numbers))}`}`;
    });
    return { text: `${String(frames.length)} series:\n${lines.join("\n")}` };
  },
};

export const GRAFANA_TOOLS: readonly NativeTool<GrafanaRunScope>[] = [listFiringAlerts, getAlertRule, getDashboard, queryPrometheus];
/** The tools a project may approve on a grafana connector (`PROJECT_CONNECTOR_TOOLS.grafana`). */
export const GRAFANA_TOOL_NAMES: readonly string[] = GRAFANA_TOOLS.map((tool) => tool.name);

type GrafanaConnection = Extract<OrgConnection, { type: "grafana" }>;

export const GRAFANA_SPEC: NativeConnectorSpec<GrafanaConnectorConfig, GrafanaEngineScope, GrafanaRunScope, GrafanaConnection> = {
  type: "grafana",
  connectionType: "grafana",
  schema: GrafanaConnectorSchema,
  label: "Grafana",
  vendor: "Grafana",
  scopeNoun: "scope",
  scopes: (config) => config.scopes.map((scope) => ({
    alias: scope.alias,
    scope: { alias: scope.alias, ...(scope.folderUids === undefined ? {} : { folderUids: [...scope.folderUids] }), ...(scope.datasourceUid === undefined ? {} : { datasourceUid: scope.datasourceUid }) },
  })),
  // The base URL with a trailing slash, so a path under it ("https://tools.examplehost.com/grafana") is kept when the tools' relative paths are read against it.
  endpoint: (connection) => new URL(connection.baseUrl.endsWith("/") ? connection.baseUrl : `${connection.baseUrl}/`),
  permissionsHint: "the Grafana service account token's role (Viewer or more) and the base URL",
  tools: GRAFANA_TOOLS,
  itemArguments: [],
  hostTyped: true,
  routing: {
    properties: {
      scopeAlias: { type: "string", minLength: 1, maxLength: 63 },
      folderUids: { type: "string", maxLength: 500 },
      datasourceUid: { type: "string", maxLength: 40 },
    },
    scopeOf: (values) => ({ alias: values["scopeAlias"]!, folderUids: values["folderUids"]!.split(",").filter((uid) => uid !== ""), datasourceUid: values["datasourceUid"]! }),
    fromScope: (scope) => ({ scopeAlias: scope.alias, folderUids: (scope.folderUids ?? []).join(","), datasourceUid: scope.datasourceUid ?? "" }),
    fromConnection: () => ({}),
  },
  unavailableTools: (scope) => (scope.datasourceUid === undefined ? [{ tool: "query_prometheus", reason: "this scope has no data source (datasourceUid)" }] : []),
  async check(fetch) {
    const health = await fetch("api/health");
    if (health.status !== 200) throw new VendorFetchError(`Grafana answered HTTP ${String(health.status)}`);
    const user = await fetch("api/user");
    if (user.status === 200) return;
    if (user.status === 401 || user.status === 403) throw new NativeCheckFailed("Grafana refused the token. Check that the service account token is valid and not expired.");
    throw new VendorFetchError(`Grafana answered HTTP ${String(user.status)}`);
  },
};

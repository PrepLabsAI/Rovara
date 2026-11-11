// The Datadog connector's tools. Datadog is read with an org connection's two keys (an API key and an application key) at
// `https://api.<site>/`, one of the sites the connection allows. A scope is a set of 1 to 5 `key:value` tags: every search is narrowed to them, a metric query has
// them added to its filter, and a monitor is shown only if it carries every one. The model's own words are never trusted to stay inside the scope, so each
// query is checked (balanced quotes and brackets, one metric query of a fixed shape) before the tags are put around it or into it.
//
// Endpoints and permissions, confirmed against docs.datadoghq.com/api (2026-10-22):
//   search_monitors  GET  /api/v1/monitor/search           application key permission monitors_read (query, page, per_page)
//   get_monitor      GET  /api/v1/monitor/{monitor_id}     monitors_read
//   query_metrics    GET  /api/v1/query                    timeseries_query (query, from and to in seconds)
//   search_logs      POST /api/v2/logs/events/search       logs_read_data (filter.query/from/to, sort, page.limit)
//   check            GET  /api/v1/validate (API key), then GET /api/v1/monitor/search?per_page=1 (the application key)
// Not confirmed in the documentation: the monitor search syntax for tags and states (`tag:"k:v"`, `status:alert`), which is Datadog's long-standing syntax.
import { DatadogConnectorSchema, type DatadogConnectorConfig, type OrgConnection } from "@agentx/contracts";
import { NativeCheckFailed, NativeToolRefusal, type NativeConnectorSpec, type NativeTool, type NativeToolContext } from "./runtime.js";
import { VendorFetchError } from "./vendor-fetch.js";

export interface DatadogEngineScope { alias: string; tags: string[] }
export interface DatadogRunScope { alias: string; tags: string[] }

/** The longest `tags` routing value a scope can have: 5 tags (`DatadogScopeSchema`), each at most 64 + 1 + 100 characters (`DatadogTagSchema`), and 4 commas (review M-2). */
const MAX_TAGS_VALUE = 5 * (64 + 1 + 100) + 4;

export const DATADOG_KEYS_REFUSED = "Datadog refused the keys. Check the API key, and that the application key has monitors_read, timeseries_query and logs_read_data.";

const CLIP = 300;
const clip = (value: unknown, max = CLIP): string => {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function keysOf(token: string): { apiKey: string; appKey: string } {
  try {
    const parsed: unknown = JSON.parse(token);
    if (isRecord(parsed) && typeof parsed["apiKey"] === "string" && typeof parsed["appKey"] === "string") return { apiKey: parsed["apiKey"], appKey: parsed["appKey"] };
  } catch { /* falls through */ }
  throw new NativeToolRefusal("Datadog's keys could not be read", "vendor_error");
}

/** Datadog's two key headers. */
const keyHeaders = (apiKey: string, appKey: string): Record<string, string> => ({ "dd-api-key": apiKey, "dd-application-key": appKey, accept: "application/json" });

async function ddRequest(
  ctx: NativeToolContext<DatadogRunScope>,
  path: string,
  options: { query?: Record<string, string>; body?: unknown; notFound?: string } = {},
): Promise<unknown> {
  const { apiKey, appKey } = keysOf(ctx.credential.token);
  const search = new URLSearchParams(options.query ?? {}).toString();
  const response = await ctx.fetch(`${path}${search === "" ? "" : `?${search}`}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: { ...keyHeaders(apiKey, appKey), ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 200) {
    if (response.json === undefined) throw new NativeToolRefusal("Datadog answered something this connector cannot read", "vendor_error");
    return response.json;
  }
  if (response.status === 401 || response.status === 403) throw new NativeToolRefusal(DATADOG_KEYS_REFUSED, "vendor_error");
  if (response.status === 404) throw new NativeToolRefusal(options.notFound ?? "Datadog has no such item", "vendor_error");
  if (response.status === 400) throw new NativeToolRefusal("Datadog did not accept that query", "vendor_error");
  if (response.status === 429) throw new NativeToolRefusal("Datadog is limiting requests; try again later", "vendor_error");
  throw new NativeToolRefusal(`Datadog answered HTTP ${String(response.status)}`, "vendor_error");
}

/** Characters that look like a quote, a bracket or a backslash and are none of them. */
const SYNTAX_LOOKALIKES = /[\u201C\u201D\uFF02\uFF08\uFF09\uFF3C]/u;

/**
 * Whether a search the model wrote can sit inside a group of its own: no control characters, quotes that balance, and brackets that balance outside quotes and
 * never close more than were opened, so it cannot close the group the scope's tags are put around and add terms outside it. A backslash escapes the character
 * after it, inside quotes and outside them, because Datadog reads it that way: `\(` and `\"` are plain characters there, so counting them as a bracket or a quote
 * here would let a query close the group from inside. A query that ends in a backslash is refused, since it would escape the bracket the
 * scope puts after it. The look-alikes of those three characters are refused outright, so the guard does not rest on Datadog ignoring them: the curly double
 * quotes U+201C and U+201D, the fullwidth quote U+FF02, the fullwidth brackets U+FF08 and U+FF09 and the fullwidth backslash U+FF3C.
 */
export function isContainedQuery(query: string): boolean {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(query) || SYNTAX_LOOKALIKES.test(query)) return false;
  let inQuote = false;
  let depth = 0;
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if (char === "\\") {
      if (index + 1 >= query.length) return false;
      index += 1;
    } else if (inQuote) {
      if (char === '"') inQuote = false;
    } else if (char === '"') {
      inQuote = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return !inQuote && depth === 0;
}

/**
 * Whether what a vendor answered with carries every one of the scope's tags: in its own tag list, or as the `service` or `host` attribute a log has beside
 * its tags. The vendor's narrowing is not trusted to be the only guard, as `get_monitor` already did not.
 */
const carriesEveryTag = (scopeTags: readonly string[], carried: readonly string[]): boolean => scopeTags.every((tag) => carried.includes(tag));
const stringsOf = (value: unknown): string[] => listOf(value).filter((entry): entry is string => typeof entry === "string");

/** A tag as a log search term: `key:value`, the value quoted when it holds a character the search reads as syntax. */
const logTerm = (tag: string): string => {
  const [key, ...rest] = tag.split(":");
  const value = rest.join(":");
  return /^[A-Za-z0-9_.]+$/u.test(value) ? tag : `${key}:"${value}"`;
};

const METRIC_QUERY = /^(avg|sum|min|max|count):([A-Za-z0-9_.]+)\{([^{}]*)\}((?: by \{[A-Za-z0-9_.,:/-]+\})?(?:\.[a-z_]+\([^(){}\\]*\))*)$/u;
const FILTER_TOKEN = /^!?(?:\*|[A-Za-z0-9_./:-]+)$/u;

/**
 * One metric query with the scope's tags added to its filter (tags in a metric filter are ANDed), or undefined when it is not of the one shape that can be
 * narrowed this way: an aggregation, a metric, a filter of plain tags (no OR, brackets or spaces), then optionally `by {tags}` and function calls.
 */
export function scopedMetricQuery(query: string, tags: readonly string[]): string | undefined {
  const matched = METRIC_QUERY.exec(query);
  if (matched === null) return undefined;
  const tokens = matched[3]!.split(",");
  if (!tokens.every((token) => FILTER_TOKEN.test(token))) return undefined;
  const filter = [...tokens.filter((token) => token !== "*"), ...tags].join(",");
  return `${matched[1]!}:${matched[2]!}{${filter}}${matched[4]!}`;
}

const refuse = (tool: string, argument: string) => new NativeToolRefusal(`${tool}: ${argument} is not allowed`);

const STATES = { Alert: "status:alert", Warn: "status:warn", "No Data": 'status:"no data"' } as const;

const searchMonitors: NativeTool<DatadogRunScope> = {
  name: "search_monitors",
  description: "Search this Datadog scope's monitors by words and state. Only monitors carrying all of the scope's tags are searched.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 200, description: "Words to look for in monitor names, messages and tags" },
      state: { type: "string", enum: ["Alert", "Warn", "No Data"], description: "Only monitors in this state" },
    },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const model = typeof args["query"] === "string" ? args["query"].trim() : "";
    if (!isContainedQuery(model)) throw refuse("search_monitors", "query");
    const terms = [
      ...ctx.scope.tags.map((tag) => `tag:"${tag}"`),
      ...(typeof args["state"] === "string" && Object.hasOwn(STATES, args["state"]) ? [STATES[args["state"] as keyof typeof STATES]] : []),
      ...(model === "" ? [] : [`(${model})`]),
    ];
    const answer = recordOf(await ddRequest(ctx, "api/v1/monitor/search", { query: { query: terms.join(" "), per_page: "25" } }));
    const monitors = listOf(answer["monitors"]).filter(isRecord).filter((monitor) => carriesEveryTag(ctx.scope.tags, stringsOf(monitor["tags"])));
    const lines = monitors.map((monitor) => `#${clip(monitor["id"], 20)} [${clip(monitor["status"], 20)}] ${clip(monitor["name"])} (${clip(monitor["type"], 40)}) tags: ${listOf(monitor["tags"]).map((tag) => clip(tag, 60)).slice(0, 10).join(", ")}`);
    return { text: monitors.length === 0 ? `No monitors in ${ctx.scope.alias}.` : `${String(monitors.length)} monitor${monitors.length === 1 ? "" : "s"} in ${ctx.scope.alias}:\n${lines.join("\n")}` };
  },
};

const getMonitor: NativeTool<DatadogRunScope> = {
  name: "get_monitor",
  description: "Read one monitor of this Datadog scope by its numeric id. A monitor that does not carry all of the scope's tags is refused.",
  inputSchema: { type: "object", properties: { monitorId: { type: "integer", minimum: 1, maximum: 9_007_199_254_740_991, description: "The numeric monitor id" } }, required: ["monitorId"], additionalProperties: false },
  async run(args, ctx) {
    const monitor = recordOf(await ddRequest(ctx, `api/v1/monitor/${String(args["monitorId"])}`, { notFound: "Datadog has no such monitor" }));
    const tags = listOf(monitor["tags"]).filter((tag): tag is string => typeof tag === "string");
    if (!ctx.scope.tags.every((tag) => tags.includes(tag))) throw new NativeToolRefusal(`that monitor is not in ${ctx.scope.alias}`);
    return {
      text: [
        `Monitor #${clip(monitor["id"], 20)}: ${clip(monitor["name"])}`,
        `Type: ${clip(monitor["type"], 40)}`,
        `State: ${clip(monitor["overall_state"], 20)}`,
        `Tags: ${tags.slice(0, 20).map((tag) => clip(tag, 60)).join(", ")}`,
        `Query: ${clip(monitor["query"], 500)}`,
        `Message: ${clip(monitor["message"], 500)}`,
      ].join("\n"),
    };
  },
};

const queryMetrics: NativeTool<DatadogRunScope> = {
  name: "query_metrics",
  description: "Query one metric over a recent period, narrowed to this scope's tags. One query like avg:system.cpu.user{host:web1} by {host}; the filter holds plain tags only.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500, description: "One metric query: aggregation:metric{tag,tag} [by {tag}] [.function()]" },
      fromMinutesAgo: { type: "integer", minimum: 5, maximum: 1440, description: "How far back to look, in minutes" },
    },
    required: ["query", "fromMinutesAgo"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const scoped = scopedMetricQuery(String(args["query"]), ctx.scope.tags);
    if (scoped === undefined) throw refuse("query_metrics", "query");
    const to = Math.floor(Date.now() / 1000);
    const from = to - Number(args["fromMinutesAgo"]) * 60;
    const answer = recordOf(await ddRequest(ctx, "api/v1/query", { query: { from: String(from), to: String(to), query: scoped } }));
    const series = listOf(answer["series"]).filter(isRecord).slice(0, 20);
    if (series.length === 0) return { text: `No data for that query in ${ctx.scope.alias}.` };
    const lines = series.map((entry) => {
      const points = listOf(entry["pointlist"]).filter((point): point is unknown[] => Array.isArray(point) && typeof point[1] === "number");
      const values = points.map((point) => point[1] as number);
      const last = values.at(-1);
      return `${clip(entry["metric"], 120)} {${clip(entry["scope"], 200)}}: ${String(points.length)} points${last === undefined ? "" : `, last ${String(last)}, min ${String(Math.min(...values))}, max ${String(Math.max(...values))}`}`;
    });
    return { text: `${String(series.length)} series for ${scoped}:\n${lines.join("\n")}` };
  },
};

const searchLogs: NativeTool<DatadogRunScope> = {
  name: "search_logs",
  description: "Search this Datadog scope's logs over a recent period, newest first. Only logs carrying all of the scope's tags are searched.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500, description: "A Datadog log search, for example service:billing status:error" },
      fromMinutesAgo: { type: "integer", minimum: 5, maximum: 1440, description: "How far back to look, in minutes" },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "How many logs to return (default 25)" },
    },
    required: ["query", "fromMinutesAgo"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const model = String(args["query"]);
    if (!isContainedQuery(model)) throw refuse("search_logs", "query");
    const limit = typeof args["limit"] === "number" ? args["limit"] : 25;
    const body = {
      filter: { query: `(${ctx.scope.tags.map(logTerm).join(" AND ")}) AND (${model})`, from: `now-${String(args["fromMinutesAgo"])}m`, to: "now" },
      sort: "-timestamp",
      page: { limit },
    };
    const answer = recordOf(await ddRequest(ctx, "api/v2/logs/events/search", { body }));
    const logs = listOf(answer["data"]).filter(isRecord).filter((log) => {
      const attributes = recordOf(log["attributes"]);
      const attributeTags = (["service", "host"] as const).flatMap((key) => (typeof attributes[key] === "string" ? [`${key}:${attributes[key]}`] : []));
      return carriesEveryTag(ctx.scope.tags, [...stringsOf(attributes["tags"]), ...attributeTags]);
    }).slice(0, limit);
    if (logs.length === 0) return { text: `No logs in ${ctx.scope.alias} for that search.` };
    const lines = logs.map((log) => {
      const attributes = recordOf(log["attributes"]);
      return `${clip(attributes["timestamp"], 40)} [${clip(attributes["status"], 20)}] ${clip(attributes["service"], 60)}: ${clip(attributes["message"], 400)}`;
    });
    return { text: `${String(logs.length)} log${logs.length === 1 ? "" : "s"} in ${ctx.scope.alias}:\n${lines.join("\n")}` };
  },
};

export const DATADOG_TOOLS: readonly NativeTool<DatadogRunScope>[] = [searchMonitors, getMonitor, queryMetrics, searchLogs];
/** The tools a project may approve on a datadog connector (`PROJECT_CONNECTOR_TOOLS.datadog`). */
export const DATADOG_TOOL_NAMES: readonly string[] = DATADOG_TOOLS.map((tool) => tool.name);

type DatadogConnection = Extract<OrgConnection, { type: "datadog" }>;

export const DATADOG_SPEC: NativeConnectorSpec<DatadogConnectorConfig, DatadogEngineScope, DatadogRunScope, DatadogConnection> = {
  type: "datadog",
  connectionType: "datadog",
  schema: DatadogConnectorSchema,
  label: "Datadog",
  vendor: "Datadog",
  scopeNoun: "tag scope",
  scopes: (config) => config.scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, tags: [...scope.tags] } })),
  endpoint: (connection) => new URL(`https://api.${connection.site}/`),
  permissionsHint: "the Datadog API key and application key (monitors_read, timeseries_query, logs_read_data)",
  tools: DATADOG_TOOLS,
  itemArguments: [],
  routing: {
    properties: {
      scopeAlias: { type: "string", minLength: 1, maxLength: 63 },
      tags: { type: "string", minLength: 1, maxLength: MAX_TAGS_VALUE },
    },
    scopeOf: (values) => ({ alias: values["scopeAlias"]!, tags: values["tags"]!.split(",") }),
    fromScope: (scope) => ({ scopeAlias: scope.alias, tags: scope.tags.join(",") }),
    fromConnection: () => ({}),
  },
  packSecret: (secret) => JSON.stringify({ apiKey: (secret as { apiKey: string }).apiKey, appKey: (secret as { appKey: string }).appKey }),
  secretParts: (packed) => {
    try {
      const parsed: unknown = JSON.parse(packed);
      return isRecord(parsed) ? Object.values(parsed).filter((value): value is string => typeof value === "string") : [];
    } catch { return []; }
  },
  checkHeaders: (secret) => keyHeaders((secret as { apiKey: string }).apiKey, (secret as { appKey: string }).appKey),
  async check(fetch) {
    const validated = await fetch("api/v1/validate");
    if (validated.status === 401 || validated.status === 403) throw new NativeCheckFailed("Datadog refused the API key. Check that it is an API key for this site.");
    if (validated.status !== 200) throw new VendorFetchError(`Datadog answered HTTP ${String(validated.status)}`);
    // The API key is valid; a cheap search proves the application key and its permission.
    const searched = await fetch("api/v1/monitor/search?per_page=1");
    if (searched.status === 401 || searched.status === 403) {
      throw new NativeCheckFailed("Datadog accepted the API key but refused the application key. Check that it has monitors_read, timeseries_query and logs_read_data.");
    }
    if (searched.status !== 200) throw new VendorFetchError(`Datadog answered HTTP ${String(searched.status)}`);
  },
};

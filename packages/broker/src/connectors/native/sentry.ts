// The Sentry connector's tools. Sentry is read through an org connection's auth token (an internal integration with org:read, project:read and
// event:read) at `https://<us|de>.sentry.io/api/0/`. A scope is one project of the connection's organization. The organization and project are routing
// values the server binds on every call; no tool takes either from the model, and a tool that is handed an issue id confirms the issue is in the scope's
// project before it says anything about it.
//
// Endpoints, confirmed against Sentry's API documentation (docs.sentry.io/api, 2026-10-22):
//   list_issues       GET /projects/{org}/{project}/issues/                        scope event:read (query, statsPeriod "24h"|"14d", limit up to 100)
//   get_issue         GET /organizations/{org}/issues/{issue_id}/                  scope event:read (the response names project.slug)
//   get_latest_event  GET /organizations/{org}/issues/{issue_id}/events/latest/    scope event:read (event_id may be latest, oldest or recommended)
//   list_releases     GET /projects/{org}/{project}/releases/                      scope project:read (or project:releases)
//   check             GET /organizations/{org}/                                    scope org:read
import { SentryConnectorSchema, type OrgConnection, type SentryConnectorConfig } from "@agentx/contracts";
import { NativeCheckFailed, NativeToolRefusal, type NativeConnectorSpec, type NativeTool, type NativeToolContext } from "./runtime.js";
import { VendorFetchError } from "./vendor-fetch.js";

export interface SentryEngineScope { alias: string; projectSlug: string }
export interface SentryRunScope { organization: string; projectSlug: string; alias: string }

export const SENTRY_TOKEN_REFUSED = "Sentry refused the token. Check that it has org:read, project:read and event:read.";

const SLUG = "^[a-z0-9][a-z0-9_-]{0,49}$";
const ISSUE_ID = "^\\d{1,20}$";
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

/** GET a JSON answer from Sentry, turning every failure into a refusal in fixed words (nothing Sentry said is repeated). */
async function sentryGet(ctx: NativeToolContext<SentryRunScope>, path: string, query: Record<string, string> = {}): Promise<unknown> {
  const search = new URLSearchParams(query).toString();
  const response = await ctx.fetch(`${path}${search === "" ? "" : `?${search}`}`, { headers: { authorization: `Bearer ${ctx.credential.token}`, accept: "application/json" } });
  if (response.status === 200) {
    if (response.json === undefined) throw new NativeToolRefusal("Sentry answered something this connector cannot read", "vendor_error");
    return response.json;
  }
  if (response.status === 401 || response.status === 403) throw new NativeToolRefusal(SENTRY_TOKEN_REFUSED, "vendor_error");
  if (response.status === 404) throw new NativeToolRefusal("Sentry has no such project or issue", "vendor_error");
  if (response.status === 429) throw new NativeToolRefusal("Sentry is limiting requests; try again later", "vendor_error");
  throw new NativeToolRefusal(`Sentry answered HTTP ${String(response.status)}`, "vendor_error");
}

/** An issue of the scope's project, or a refusal: the organization's issue endpoint answers for any project the token can see. */
async function issueInScope(ctx: NativeToolContext<SentryRunScope>, issueId: string): Promise<Record<string, unknown>> {
  const issue = recordOf(await sentryGet(ctx, `organizations/${segment(ctx.scope.organization)}/issues/${segment(issueId)}/`));
  if (recordOf(issue["project"])["slug"] !== ctx.scope.projectSlug) throw new NativeToolRefusal(`that issue is not in ${ctx.scope.alias}`);
  return issue;
}

function issueLine(issue: Record<string, unknown>): string {
  return `${clip(issue["shortId"], 40)} [${clip(issue["level"], 20)}, ${clip(issue["status"], 20)}] ${clip(issue["title"])} (${clip(issue["count"], 20)} events, ${clip(issue["userCount"], 20)} users, last seen ${clip(issue["lastSeen"], 40)}) ${clip(issue["permalink"], 200)}`;
}

/**
 * The event tags the model is shown: the ones that describe the software and where it ran. An allowlist, not a deny list, because a real event carries whatever
 * the customer's code tagged it with (`user`, `user.email`, `url`, `ip`, `client_ip`, `server_name`, an account id), and the tool promises to leave the person and
 * the request out.
 */
const SHOWN_TAGS: ReadonlySet<string> = new Set([
  "environment", "release", "level", "handled", "mechanism", "logger", "transaction", "runtime", "runtime.name", "browser", "browser.name", "os", "os.name", "device", "device.family",
]);

const listIssues: NativeTool<SentryRunScope> = {
  name: "list_issues",
  description: "List the issues of this Sentry project, newest activity first. Optionally filter with a Sentry search query, choose the stats period and limit how many are returned.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 200, description: "A Sentry issue search, for example is:unresolved level:error" },
      statsPeriod: { type: "string", enum: ["24h", "14d"], description: "The period the event counts cover" },
      limit: { type: "integer", minimum: 1, maximum: 25, description: "How many issues to return (default 10)" },
    },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const limit = typeof args["limit"] === "number" ? args["limit"] : 10;
    const query: Record<string, string> = { limit: String(limit) };
    if (typeof args["query"] === "string") query["query"] = args["query"];
    if (typeof args["statsPeriod"] === "string") query["statsPeriod"] = args["statsPeriod"];
    // The endpoint is the project's own, but a free-form query is passed through and the answer is not trusted: only issues of this project are shown.
    const issues = listOf(await sentryGet(ctx, `projects/${segment(ctx.scope.organization)}/${segment(ctx.scope.projectSlug)}/issues/`, query)).filter(isRecord)
      .filter((issue) => recordOf(issue["project"])["slug"] === ctx.scope.projectSlug).slice(0, limit);
    const text = issues.length === 0 ? `No issues in ${ctx.scope.alias}.` : `${String(issues.length)} issue${issues.length === 1 ? "" : "s"} in ${ctx.scope.alias}:\n${issues.map(issueLine).join("\n")}`;
    return { text };
  },
};

const getIssue: NativeTool<SentryRunScope> = {
  name: "get_issue",
  description: "Read one issue of this Sentry project by its numeric id.",
  inputSchema: { type: "object", properties: { issueId: { type: "string", pattern: ISSUE_ID, description: "The numeric Sentry issue id" } }, required: ["issueId"], additionalProperties: false },
  async run(args, ctx) {
    const issue = await issueInScope(ctx, String(args["issueId"]));
    const metadata = recordOf(issue["metadata"]);
    const lines = [
      issueLine(issue),
      `Culprit: ${clip(issue["culprit"])}`,
      `First seen: ${clip(issue["firstSeen"], 40)}`,
      ...(clip(metadata["value"]) === "" ? [] : [`Error: ${clip(metadata["type"], 80)}: ${clip(metadata["value"])}`]),
    ];
    return { text: lines.join("\n") };
  },
};

const getLatestEvent: NativeTool<SentryRunScope> = {
  name: "get_latest_event",
  description: "Read the latest event of one issue of this Sentry project: its time, tags and the exception with the most recent stack frames. The user's details and request data are left out.",
  inputSchema: { type: "object", properties: { issueId: { type: "string", pattern: ISSUE_ID, description: "The numeric Sentry issue id" } }, required: ["issueId"], additionalProperties: false },
  async run(args, ctx) {
    const issueId = String(args["issueId"]);
    const issue = await issueInScope(ctx, issueId);
    const event = recordOf(await sentryGet(ctx, `organizations/${segment(ctx.scope.organization)}/issues/${segment(issueId)}/events/latest/`));
    const tags = listOf(event["tags"]).filter(isRecord).filter((tag) => typeof tag["key"] === "string" && SHOWN_TAGS.has(tag["key"])).slice(0, 20)
      .map((tag) => `${clip(tag["key"], 40)}=${clip(tag["value"], 80)}`);
    const lines = [`Latest event ${clip(event["eventID"], 64)} of ${clip(issue["shortId"], 40)} at ${clip(event["dateCreated"], 40)}`, `Title: ${clip(event["title"])}`, `Platform: ${clip(event["platform"], 40)}`];
    if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
    for (const entry of listOf(event["entries"]).filter(isRecord)) {
      if (entry["type"] !== "exception") continue;
      for (const value of listOf(recordOf(entry["data"])["values"]).filter(isRecord).slice(0, 3)) {
        lines.push(`Exception: ${clip(value["type"], 80)}: ${clip(value["value"])}`);
        const frames = listOf(recordOf(value["stacktrace"])["frames"]).filter(isRecord).slice(-10).reverse();
        for (const frame of frames) lines.push(`  at ${clip(frame["function"], 80) || "?"} (${clip(frame["filename"], 120)}:${clip(frame["lineNo"], 10)})${frame["inApp"] === true ? " [in app]" : ""}`);
      }
    }
    return { text: lines.join("\n") };
  },
};

const listReleases: NativeTool<SentryRunScope> = {
  name: "list_releases",
  description: "List the latest releases of this Sentry project with their dates, new issues, commit counts and last deploy.",
  inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10, description: "How many releases to return (default 5)" } }, required: [], additionalProperties: false },
  async run(args, ctx) {
    const limit = typeof args["limit"] === "number" ? args["limit"] : 5;
    const releases = listOf(await sentryGet(ctx, `projects/${segment(ctx.scope.organization)}/${segment(ctx.scope.projectSlug)}/releases/`, { per_page: String(limit) })).slice(0, limit).filter(isRecord);
    if (releases.length === 0) return { text: `No releases in ${ctx.scope.alias}.` };
    const lines = releases.map((release) => {
      const deploy = recordOf(release["lastDeploy"]);
      return `${clip(release["version"], 120)} created ${clip(release["dateCreated"], 40)}, ${clip(release["newGroups"], 10)} new issues, ${clip(release["commitCount"], 10)} commits${clip(deploy["environment"], 40) === "" ? "" : `, last deployed to ${clip(deploy["environment"], 40)} at ${clip(deploy["dateFinished"], 40)}`}`;
    });
    return { text: `${String(releases.length)} release${releases.length === 1 ? "" : "s"} in ${ctx.scope.alias}:\n${lines.join("\n")}` };
  },
};

export const SENTRY_TOOLS: readonly NativeTool<SentryRunScope>[] = [listIssues, getIssue, getLatestEvent, listReleases];
/** The tools a project may approve on a sentry connector (`PROJECT_CONNECTOR_TOOLS.sentry`). */
export const SENTRY_TOOL_NAMES: readonly string[] = SENTRY_TOOLS.map((tool) => tool.name);

export const SENTRY_SPEC: NativeConnectorSpec<SentryConnectorConfig, SentryEngineScope, SentryRunScope, Extract<OrgConnection, { type: "sentry" }>> = {
  type: "sentry",
  connectionType: "sentry",
  schema: SentryConnectorSchema,
  label: "Sentry issues",
  vendor: "Sentry",
  scopeNoun: "project",
  scopes: (config) => config.scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, projectSlug: scope.projectSlug } })),
  endpoint: (connection) => new URL(`https://${connection.region}.sentry.io/api/0/`),
  permissionsHint: "the Sentry auth token's scopes (org:read, project:read, event:read)",
  tools: SENTRY_TOOLS,
  itemArguments: [],
  routing: {
    properties: {
      organization: { type: "string", pattern: SLUG },
      projectSlug: { type: "string", pattern: SLUG },
      scopeAlias: { type: "string", minLength: 1, maxLength: 63 },
    },
    scopeOf: (values) => ({ organization: values["organization"]!, projectSlug: values["projectSlug"]!, alias: values["scopeAlias"]! }),
    fromScope: (scope) => ({ projectSlug: scope.projectSlug, scopeAlias: scope.alias }),
    fromConnection: (connection) => ({ organization: connection.orgSlug }),
  },
  async check(fetch, connection) {
    const response = await fetch(`organizations/${segment(connection.orgSlug)}/`);
    if (response.status === 200) return;
    if (response.status === 401 || response.status === 403) throw new NativeCheckFailed(SENTRY_TOKEN_REFUSED);
    if (response.status === 404) throw new NativeCheckFailed(`Sentry has no organization called ${connection.orgSlug}`);
    // Anything else (a rate limit, an outage) says nothing about the token: retry later.
    throw new VendorFetchError(`Sentry answered HTTP ${String(response.status)}`);
  },
};

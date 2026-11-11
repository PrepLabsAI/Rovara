// The Vercel connector's tools. Vercel is read with an org connection's access token at `https://api.vercel.com/`. A scope is one project:
// deployments are listed for it, and a deployment is shown only if it belongs to it. A connection with a team id adds `teamId` to every request.
//
// Endpoints, confirmed against vercel.com/docs/rest-api (2026-10-22):
//   list_deployments       GET /v7/deployments?projectId=&limit=&target=   (the brief names v6; the documentation lists v7 as current, same parameters)
//   get_deployment         GET /v13/deployments/{idOrUrl}                  (projectId, readyState, target, url, meta, errorMessage)
//   get_deployment_events  GET /v3/deployments/{idOrUrl}/events            (limit, direction; events carry type, created, payload.text)
//   check                  GET /v2/user
// `target` filters on `production` or `staging` in the documentation; `preview` here means "anything that is not production" and is filtered after the request.
import { VercelConnectorSchema, type OrgConnection, type VercelConnectorConfig } from "@agentx/contracts";
import { NativeCheckFailed, NativeToolRefusal, type NativeConnectorSpec, type NativeTool, type NativeToolContext } from "./runtime.js";
import { VendorFetchError } from "./vendor-fetch.js";

export interface VercelEngineScope { alias: string; projectId: string }
export interface VercelRunScope { alias: string; projectId: string; teamId: string }

export const VERCEL_TOKEN_REFUSED = "Vercel refused the token. Check that it is a valid access token for this team and can read deployments.";

const DEPLOYMENT_ID = "^dpl_[A-Za-z0-9]{1,64}$";
const CLIP = 300;
const clip = (value: unknown, max = CLIP): string => {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const when = (millis: unknown): string => (typeof millis === "number" && Number.isFinite(millis) ? new Date(millis).toISOString() : "");

async function vercelGet(ctx: NativeToolContext<VercelRunScope>, path: string, query: Array<[string, string]> = [], notFound = "Vercel has no such deployment"): Promise<unknown> {
  // A team's requests carry its id, every one of them.
  const pairs = ctx.scope.teamId === "" ? query : [...query, ["teamId", ctx.scope.teamId] as [string, string]];
  const search = new URLSearchParams(pairs).toString();
  const response = await ctx.fetch(`${path}${search === "" ? "" : `?${search}`}`, { headers: { authorization: `Bearer ${ctx.credential.token}`, accept: "application/json" } });
  if (response.status === 200) {
    if (response.json === undefined) throw new NativeToolRefusal("Vercel answered something this connector cannot read", "vendor_error");
    return response.json;
  }
  if (response.status === 401 || response.status === 403) throw new NativeToolRefusal(VERCEL_TOKEN_REFUSED, "vendor_error");
  if (response.status === 404) throw new NativeToolRefusal(notFound, "vendor_error");
  if (response.status === 429) throw new NativeToolRefusal("Vercel is limiting requests; try again later", "vendor_error");
  throw new NativeToolRefusal(`Vercel answered HTTP ${String(response.status)}`, "vendor_error");
}

/** A deployment of the scope's project, or a refusal: the deployment route answers for any project the token can see. */
async function deploymentInScope(ctx: NativeToolContext<VercelRunScope>, deploymentId: string): Promise<Record<string, unknown>> {
  const deployment = recordOf(await vercelGet(ctx, `v13/deployments/${encodeURIComponent(deploymentId)}`));
  if (deployment["projectId"] !== ctx.scope.projectId) throw new NativeToolRefusal(`that deployment is not in ${ctx.scope.alias}`);
  return deployment;
}

/** What a deployment shows: its state, where it went, when, the commit's words and branch. The creator's and the commit author's emails are left out. */
function deploymentLine(deployment: Record<string, unknown>): string {
  const meta = recordOf(deployment["meta"]);
  const id = clip(deployment["uid"] ?? deployment["id"], 80);
  const commit = clip(meta["githubCommitMessage"] ?? meta["gitlabCommitMessage"] ?? meta["bitbucketCommitMessage"], 120);
  const ref = clip(meta["githubCommitRef"] ?? meta["gitlabCommitRef"] ?? meta["bitbucketCommitRef"], 80);
  return `${id} [${clip(deployment["readyState"] ?? deployment["state"], 20)}] ${clip(deployment["target"], 20) || "preview"} ${clip(deployment["url"], 120)} created ${when(deployment["created"] ?? deployment["createdAt"])}${commit === "" ? "" : ` "${commit}"`}${ref === "" ? "" : ` (${ref})`}`;
}

const listDeployments: NativeTool<VercelRunScope> = {
  name: "list_deployments",
  description: "List the latest deployments of this Vercel project, newest first, optionally only production or only preview ones.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["production", "preview"], description: "Only production deployments, or only preview ones" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "How many deployments to return (default 10)" },
    },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const limit = typeof args["limit"] === "number" ? args["limit"] : 10;
    const query: Array<[string, string]> = [["projectId", ctx.scope.projectId], ["limit", String(limit)]];
    if (args["target"] === "production") query.push(["target", "production"]);
    // The filter is the server's, but the answer is not trusted to have kept to it.
    const deployments = listOf(recordOf(await vercelGet(ctx, "v7/deployments", query))["deployments"]).filter(isRecord)
      .filter((deployment) => deployment["projectId"] === ctx.scope.projectId)
      .filter((deployment) => args["target"] !== "preview" || deployment["target"] !== "production").slice(0, limit);
    return { text: deployments.length === 0 ? `No deployments in ${ctx.scope.alias}.` : `${String(deployments.length)} deployment${deployments.length === 1 ? "" : "s"} in ${ctx.scope.alias}:\n${deployments.map(deploymentLine).join("\n")}` };
  },
};

const getDeployment: NativeTool<VercelRunScope> = {
  name: "get_deployment",
  description: "Read one deployment of this Vercel project by its id (dpl_...): state, target, time, commit and any build error.",
  inputSchema: { type: "object", properties: { deploymentId: { type: "string", pattern: DEPLOYMENT_ID, description: "The deployment id, starting dpl_" } }, required: ["deploymentId"], additionalProperties: false },
  async run(args, ctx) {
    const deployment = await deploymentInScope(ctx, String(args["deploymentId"]));
    const error = clip(deployment["errorMessage"], 300);
    return { text: [deploymentLine(deployment), `Name: ${clip(deployment["name"], 100)}`, ...(error === "" ? [] : [`Error: ${error} (${clip(deployment["errorCode"], 60)})`])].join("\n") };
  },
};

const getDeploymentEvents: NativeTool<VercelRunScope> = {
  name: "get_deployment_events",
  description: "Read the build output of one deployment of this Vercel project, oldest first.",
  inputSchema: {
    type: "object",
    properties: {
      deploymentId: { type: "string", pattern: DEPLOYMENT_ID, description: "The deployment id, starting dpl_" },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "How many events to return (default 100); the latest ones" },
    },
    required: ["deploymentId"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const deploymentId = String(args["deploymentId"]);
    await deploymentInScope(ctx, deploymentId);
    const limit = typeof args["limit"] === "number" ? args["limit"] : 100;
    const events = listOf(await vercelGet(ctx, `v3/deployments/${encodeURIComponent(deploymentId)}/events`, [["limit", String(limit)], ["direction", "backward"]])).filter(isRecord).slice(0, limit)
      .sort((left, right) => Number(left["created"] ?? 0) - Number(right["created"] ?? 0));
    if (events.length === 0) return { text: "No build events." };
    const lines = events.map((event) => `${when(event["created"])} ${clip(event["type"], 30)}: ${clip(recordOf(event["payload"])["text"], 300)}`);
    return { text: `${String(events.length)} build event${events.length === 1 ? "" : "s"}:\n${lines.join("\n")}` };
  },
};

export const VERCEL_TOOLS: readonly NativeTool<VercelRunScope>[] = [listDeployments, getDeployment, getDeploymentEvents];
/** The tools a project may approve on a vercel connector (`PROJECT_CONNECTOR_TOOLS.vercel`). */
export const VERCEL_TOOL_NAMES: readonly string[] = VERCEL_TOOLS.map((tool) => tool.name);

type VercelConnection = Extract<OrgConnection, { type: "vercel" }>;

export const VERCEL_SPEC: NativeConnectorSpec<VercelConnectorConfig, VercelEngineScope, VercelRunScope, VercelConnection> = {
  type: "vercel",
  connectionType: "vercel",
  schema: VercelConnectorSchema,
  label: "Vercel",
  vendor: "Vercel",
  scopeNoun: "project",
  scopes: (config) => config.scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, projectId: scope.projectId } })),
  endpoint: () => new URL("https://api.vercel.com/"),
  permissionsHint: "the Vercel access token and its team",
  tools: VERCEL_TOOLS,
  itemArguments: [],
  routing: {
    properties: {
      scopeAlias: { type: "string", minLength: 1, maxLength: 63 },
      projectId: { type: "string", pattern: "^prj_[A-Za-z0-9]{1,64}$" },
      // The connection's team, or empty: a team's requests all carry it.
      teamId: { type: "string", pattern: "^(team_[A-Za-z0-9]{1,64})?$" },
    },
    scopeOf: (values) => ({ alias: values["scopeAlias"]!, projectId: values["projectId"]!, teamId: values["teamId"]! }),
    fromScope: (scope) => ({ scopeAlias: scope.alias, projectId: scope.projectId }),
    fromConnection: (connection) => ({ teamId: connection.teamId ?? "" }),
  },
  async check(fetch, connection) {
    const response = await fetch(connection.teamId === undefined ? "v2/user" : `v2/user?teamId=${encodeURIComponent(connection.teamId)}`);
    if (response.status === 200) return;
    if (response.status === 401 || response.status === 403) throw new NativeCheckFailed(VERCEL_TOKEN_REFUSED);
    throw new VendorFetchError(`Vercel answered HTTP ${String(response.status)}`);
  },
};

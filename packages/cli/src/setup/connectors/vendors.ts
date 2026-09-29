// The one real read each connector's test needs (FR-038), behind one interface so tests fake it.
// Nothing here reaches the control plane; only the vendor's own API.
import { agentXError, OAUTH_AUTHORIZATION_PROFILES } from "@agentx/contracts";
import { connectMcp, McpUnauthorized } from "@agentx/gateway";

export interface LinearTeam { id: string; key: string; name: string }
export interface VendorApi {
  linearTeams(apiKey: string): Promise<LinearTeam[]>;
  /** GET https://<site>.atlassian.net/_edge/tenant_info: the site's cloudId, lowercase. */
  jiraCloudId(siteUrl: string): Promise<string>;
  /** searchJiraIssuesUsingJql through Rovo MCP /v2 with the API token as Bearer: the distinct
   * issue keys found (at most maxResults issues). */
  jiraSearch(input: { token: string; cloudId: string; jql: string; maxResults: number }): Promise<string[]>;
  /** One refresh at Asana's token endpoint; the refresh token back when Asana rotated it. */
  asanaAccessToken(input: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken?: string }>;
  /** get_project through Asana MCP: the project's name, or undefined when the bot cannot see it. */
  asanaProject(input: { accessToken: string; projectGid: string }): Promise<{ name: string } | undefined>;
}

/** The project's name from get_project's text: `data.name` (the owner and members carry names of
 * their own, so the first "name" in the text is not always the project's). Printable characters
 * only, at most 200, since it is shown on a terminal; undefined when the text holds none. */
function asanaProjectName(text: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const data = parsed !== null && typeof parsed === "object" ? (parsed as { data?: unknown }).data : undefined;
  const name = data !== null && typeof data === "object" ? (data as { name?: unknown }).name : undefined;
  if (typeof name !== "string") return undefined;
  const shown = Array.from(name.replace(/[\p{C}]/gu, "")).slice(0, 200).join("").trim();
  return shown === "" ? undefined : shown;
}

/** Thrown when a vendor refuses the credential (401 or 403). Carries no vendor text, so an error
 * message never repeats what the vendor said about the key. */
export class VendorRefused extends Error {
  constructor(vendor: string) {
    super(`${vendor} refused the credential`);
    this.name = "VendorRefused";
  }
}

export function vendorApi(fetchImplementation: typeof fetch): VendorApi {
  return {
    async linearTeams(apiKey) {
      // A personal API key goes in Authorization as it is, without "Bearer" (Linear's API docs).
      const response = await fetchImplementation("https://api.linear.app/graphql", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: apiKey, "content-type": "application/json" },
        body: JSON.stringify({ query: "{ teams { nodes { id key name } } }" }),
      });
      if (response.status === 401 || response.status === 403) throw new VendorRefused("Linear");
      if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Linear answered HTTP ${response.status}; try again in a minute`);
      const body = (await response.json()) as { data?: { teams?: { nodes?: LinearTeam[] } }; errors?: unknown[] };
      if (body.errors !== undefined && body.errors.length > 0) throw new VendorRefused("Linear");
      return body.data?.teams?.nodes ?? [];
    },
    async jiraCloudId(siteUrl) {
      const response = await fetchImplementation(`${siteUrl}/_edge/tenant_info`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      const body = response.ok ? (await response.json()) as { cloudId?: unknown } : {};
      if (typeof body.cloudId !== "string") throw agentXError("CONFIG_INVALID", `${siteUrl} did not return a cloudId; check the site name`);
      return body.cloudId.toLowerCase();
    },
    async jiraSearch({ token, cloudId, jql, maxResults }) {
      let connection;
      try {
        // /v2 is the endpoint that accepts API tokens; /v1 ignores them (spec 013 lessons).
        connection = await connectMcp({ endpoint: new URL("https://mcp.atlassian.com/v2/mcp"), token, tools: ["searchJiraIssuesUsingJql"], signal: AbortSignal.timeout(30_000), fetchImplementation });
      } catch (error) {
        if (error instanceof McpUnauthorized) throw new VendorRefused("Atlassian");
        throw error;
      }
      try {
        const result = await connection.call("searchJiraIssuesUsingJql", { cloudId, jql, maxResults });
        if (result.isError === true) throw new VendorRefused("Atlassian");
        const text = (result.content ?? []).map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("");
        return [...new Set(text.match(/\b[A-Z][A-Z0-9_]+-[0-9]+\b/g) ?? [])];
      } finally {
        await connection.close();
      }
    },
    async asanaAccessToken({ clientId, clientSecret, refreshToken }) {
      const response = await fetchImplementation(OAUTH_AUTHORIZATION_PROFILES.asana.tokenUrl, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
      });
      // Asana answers a bad client or a revoked refresh token with 400 (invalid_grant) or 401.
      if (response.status === 400 || response.status === 401) throw new VendorRefused("Asana");
      if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Asana's token endpoint answered HTTP ${response.status}; try again in a minute`);
      const body = (await response.json()) as { access_token?: unknown; refresh_token?: unknown };
      if (typeof body.access_token !== "string" || body.access_token === "") throw new VendorRefused("Asana");
      const next = typeof body.refresh_token === "string" ? body.refresh_token : "";
      return { accessToken: body.access_token, ...(next !== "" && next !== refreshToken ? { refreshToken: next } : {}) };
    },
    async asanaProject({ accessToken, projectGid }) {
      let connection;
      try {
        connection = await connectMcp({ endpoint: new URL(OAUTH_AUTHORIZATION_PROFILES.asana.resource), token: accessToken, tools: ["get_project"], signal: AbortSignal.timeout(30_000), fetchImplementation });
      } catch (error) {
        // F28: as for Jira, a 401 from the MCP server is the vendor refusing the credential.
        if (error instanceof McpUnauthorized) throw new VendorRefused("Asana");
        throw error;
      }
      try {
        // Asana's get_project takes project_id (packages/gateway/src/asana.ts, asanaBinder).
        const result = await connection.call("get_project", { project_id: projectGid });
        if (result.isError === true) return undefined;
        const text = (result.content ?? []).map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("");
        return { name: asanaProjectName(text) ?? projectGid };
      } finally {
        await connection.close();
      }
    },
  };
}

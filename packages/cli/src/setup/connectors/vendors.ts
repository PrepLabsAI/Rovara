// The one real read each connector's test needs (FR-038), behind one interface so tests fake it.
// Nothing here reaches the control plane; only the vendor's own API.
import { agentXError } from "@agentx/contracts";
import { connectMcp, McpUnauthorized } from "@agentx/gateway";

export interface LinearTeam { id: string; key: string; name: string }
export interface VendorApi {
  linearTeams(apiKey: string): Promise<LinearTeam[]>;
  /** GET https://<site>.atlassian.net/_edge/tenant_info: the site's cloudId, lowercase. */
  jiraCloudId(siteUrl: string): Promise<string>;
  /** searchJiraIssuesUsingJql through Rovo MCP /v2 with the API token as Bearer: the distinct
   * issue keys found (at most maxResults issues). */
  jiraSearch(input: { token: string; cloudId: string; jql: string; maxResults: number }): Promise<string[]>;
  // Task 11 adds asanaAccessToken and asanaProject.
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
  };
}

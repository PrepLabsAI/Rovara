// The one real read each connector's test needs (FR-038), behind one interface so tests fake it.
// Nothing here reaches the control plane; only the vendor's own API.
import { agentXError } from "@agentx/contracts";

export interface LinearTeam { id: string; key: string; name: string }
export interface VendorApi {
  linearTeams(apiKey: string): Promise<LinearTeam[]>;
  // Tasks 10 and 11 add jiraCloudId, jiraSearch, asanaAccessToken and asanaProject.
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
  };
}

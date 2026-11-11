// Where each vendor connection's token may go, and the fetch a check is given.
// A Sentry, Datadog, PagerDuty or Vercel connection names a region or site, never an address, so the host its token is for follows from it
// (`vendorHostOf`), and the credential registry pins the token to that host. A check for one of them is handed a fetch held to that origin
// (`originHeldFetch`): it cannot be pointed anywhere else, and it never follows a redirect, which could lead to an address the check did not look at.
// A Grafana address is typed by a person and is held another way (`mcpEndpointGuard`'s pinned fetch); CloudWatch speaks to AWS through its own client.
import type { OrgConnection } from "@agentx/contracts";

/** The vendor host a connection's token is for, from its region or site; undefined where the address is not a fixed vendor's (Grafana, MCP, Jira) or there is no token (CloudWatch). */
export function vendorHostOf(connection: OrgConnection): string | undefined {
  switch (connection.type) {
    case "sentry": return `${connection.region}.sentry.io`;
    case "datadog": return `api.${connection.site}`;
    case "pagerduty": return connection.region === "eu" ? "api.eu.pagerduty.com" : "api.pagerduty.com";
    case "vercel": return "api.vercel.com";
    case "linear":
    case "jira":
    case "mcp":
    case "cloudwatch":
    case "grafana": return undefined;
  }
}

const REFUSED = "a request to anywhere but the vendor's address was refused";

/** `base`, kept to `https://<host>`: any other origin, scheme or port, a login in the address, or a redirect is refused. */
export function originHeldFetch(base: typeof fetch, host: string): typeof fetch {
  const origin = `https://${host}`;
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    } catch {
      throw new TypeError(REFUSED);
    }
    if (url.origin !== origin || url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new TypeError(REFUSED);
    return base(input, { ...init, redirect: "error" });
  };
}

/** The fetch of a check that makes no web request. */
export const noWebRequests: typeof fetch = () => Promise.reject(new TypeError("this check makes no web requests; the request was refused"));

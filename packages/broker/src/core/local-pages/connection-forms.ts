// The forms of the Connections page: for each kind of connection, the fields the owner fills in. Plain data, so the page draws them and the install turns a posted form into the connection's
// settings and secret in one place (`local/app/connections.ts`), checked again by the contract's schemas. A field marked `secret` is write-only: it is never shown again.
import { DATADOG_SITES } from "@agentx/contracts";

export interface ConnectionFormField {
  name: string;
  label: string;
  kind: "text" | "select" | "password";
  /** Where the value goes: the connection's settings, or its secret. */
  into: "settings" | "secret";
  options?: readonly string[];
  required?: boolean;
  hint?: string;
}

export interface ConnectionFormSpec {
  type: string;
  title: string;
  /** Whether the connection may be read-write (Linear, Jira, MCP); the others only read. */
  mayWrite: boolean;
  fields: readonly ConnectionFormField[];
}

const text = (name: string, label: string, hint?: string): ConnectionFormField => ({ name, label, kind: "text", into: "settings", required: true, ...(hint === undefined ? {} : { hint }) });
const secret = (name: string, label: string): ConnectionFormField => ({ name, label, kind: "password", into: "secret", required: true });
const choice = (name: string, label: string, options: readonly string[]): ConnectionFormField => ({ name, label, kind: "select", into: "settings", options, required: true });

export const CONNECTION_FORMS: readonly ConnectionFormSpec[] = [
  { type: "linear", title: "Linear", mayWrite: true, fields: [secret("apiKey", "API key")] },
  { type: "jira", title: "Jira", mayWrite: true, fields: [text("siteUrl", "Site address", "https://<site>.atlassian.net"), { ...secret("email", "Atlassian account email"), kind: "text" }, secret("apiToken", "API token")] },
  { type: "mcp", title: "MCP server (public address)", mayWrite: true, fields: [text("endpoint", "Address", "https://..."), text("vendor", "Vendor name"), secret("token", "Token")] },
  { type: "sentry", title: "Sentry", mayWrite: false, fields: [choice("region", "Region", ["us", "de"]), text("orgSlug", "Organization slug"), secret("authToken", "Auth token")] },
  { type: "datadog", title: "Datadog", mayWrite: false, fields: [choice("site", "Site", DATADOG_SITES), secret("apiKey", "API key"), secret("appKey", "Application key")] },
  { type: "grafana", title: "Grafana", mayWrite: false, fields: [text("baseUrl", "Address", "https://..."), secret("serviceAccountToken", "Service account token")] },
  { type: "pagerduty", title: "PagerDuty", mayWrite: false, fields: [choice("region", "Region", ["us", "eu"]), secret("apiKey", "API key")] },
  { type: "vercel", title: "Vercel", mayWrite: false, fields: [{ name: "teamId", label: "Team id (optional)", kind: "text", into: "settings", hint: "team_..." }, secret("token", "Token")] },
];

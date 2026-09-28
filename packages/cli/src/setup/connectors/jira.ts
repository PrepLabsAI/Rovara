// agentx connector add jira (FR-036 to FR-039), from docs/connectors/jira.md: a service account's
// API token against Rovo MCP /v2. The test read is the guide's Step 8: the token must find an issue
// inside the project before anything is stored. Issues it finds outside the project do not stop it
// (owner decision 6, 2026-09-28): the connector is saved with a warning naming those projects.
import { agentXError, type ConnectorConfig } from "@agentx/contracts";
import { registerCredential } from "../../admin/credential.js";
import { secretFromSource } from "../../init/prompts.js";
import { addConnectorRevision, connectorSecretName, refuseLegacyGitHubMcp, scopeAlias, storeConnectorSecret, type ConnectorAddInput } from "./revision.js";

export const JIRA_GUIDE = [
  "Jira: AgentX acts as an Atlassian service account, with an API token.",
  "  1. admin.atlassian.com: Apps, AI settings, Rovo MCP server, Authentication: turn on Allow API token authentication.",
  "  2. Directory, Service accounts: create one (for example AgentX), and give it Jira with the User role only.",
  "  3. Add it to the project AgentX may use; make sure no other project lets it browse (docs/connectors/jira.md, Step 4).",
  "  4. On the service account, Credentials: create an API token (not OAuth) with read:jira-work, write:jira-work, read:jira-user,",
  "     read:jira:agent-interface, write:jira:agent-interface and search:jira:agent-interface. Copy it; it is about 192 characters.",
].join("\n");

export const JIRA_TOOLS: ConnectorConfig["tools"] = [
  { name: "searchJiraIssuesUsingJql", access: "read" },
  { name: "getJiraIssue", access: "read" },
  { name: "createJiraIssue", access: "write" },
  { name: "addOrEditJiraIssueComment", access: "write" },
];

export function jiraSiteUrl(typed: string): string {
  const text = typed.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
  const site = text.endsWith(".atlassian.net") ? text.slice(0, -".atlassian.net".length) : text;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/.test(site)) throw agentXError("CONFIG_INVALID", "Jira Cloud sites are https://<site>.atlassian.net; type the <site> part");
  return `https://${site}.atlassian.net`;
}

const refused = (error: unknown) => error instanceof Error && error.name === "VendorRefused";

/** `vendors.jiraSearch`, with a VendorRefused caught and reworded (both searches read this way,
 * one at a time: the inside search's result decides whether the outside search runs at all). */
async function jiraSearch(vendors: ConnectorAddInput["services"]["vendors"], params: { token: string; cloudId: string; jql: string; maxResults: number }): Promise<string[]> {
  try {
    return await vendors.jiraSearch(params);
  } catch (error) {
    if (refused(error)) throw agentXError("AUTH_REQUIRED", "Atlassian refused the API token; check that Rovo MCP's Allow API token authentication is on (Step 1) and the token has all six scopes (Step 5). Nothing was stored");
    throw error;
  }
}

/** How many issues the outside search reads, to name the other projects (owner decision 6). */
export const OUTSIDE_SAMPLE = 50;
const NAMED = 5;
const WARNING_LIMIT = 300;

/** The project keys in `issueKeys` (PAY-1 -> PAY), distinct, in first-seen order. */
export function projectKeys(issueKeys: readonly string[]): string[] {
  return [...new Set(issueKeys.map((key) => key.replace(/-[0-9]+$/, "")))];
}

/** Owner decision 6's warning, at most 300 characters: up to 5 keys, then "and N more". */
export function widerAccessWarning(projectKey: string, others: readonly string[]): string {
  const shown = others.slice(0, NAMED);
  const rest = others.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)!}` : shown[0]!;
  const text = `the Jira service account can also see issues in ${list}, so AgentX will be able to read issues in those projects too. Narrow the account to ${projectKey} in each other project's permission scheme (docs/connectors/jira.md, Step 4)`;
  // Project keys are at most 10 characters, so 5 of them always fit; the cut is only a guard.
  return text.length <= WARNING_LIMIT ? text : text.slice(0, WARNING_LIMIT);
}

export async function addJira(input: ConnectorAddInput): Promise<{ ref: string; revision: number; warning?: string }> {
  await refuseLegacyGitHubMcp({ projectName: input.projectName, configDir: input.services.configDir });
  input.write(JIRA_GUIDE);
  const siteUrl = jiraSiteUrl(input.flags.jiraSite ?? await input.prompter.ask("Your Jira site (the <site> in <site>.atlassian.net)", { flag: "--jira-site" }));
  const cloudId = await input.services.vendors.jiraCloudId(siteUrl);
  const token = await secretFromSource({ what: "Jira API token", flag: "--jira-token", source: input.flags.jiraToken ?? {}, processEnv: input.processEnv, prompter: input.prompter });
  const projectKey = (input.flags.jiraProject ?? await input.prompter.ask("The Jira project key AgentX may use (for example PAY)", { flag: "--jira-project" })).trim().toUpperCase();
  // F4: the schema's own pattern (JiraScopeSchema.projectKey), so a key the schema would refuse is
  // refused here first, before the token is ever stored.
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)) throw agentXError("CONFIG_INVALID", "a Jira project key is capital letters and digits, such as PAY");

  // The inside search decides everything: an empty project is refused here, one Jira read only,
  // before the outside search (which exists only to build owner decision 6's warning) ever runs.
  const inside = await jiraSearch(input.services.vendors, { token, cloudId, jql: `project = ${projectKey}`, maxResults: 5 });
  if (inside.length === 0) throw agentXError("CONFIG_INVALID", `the search found no issue in ${projectKey}; if the project is empty, create one issue in it and run this again. If it has issues, the service account cannot see them: add it to the project (Step 4)`);
  const outside = await jiraSearch(input.services.vendors, { token, cloudId, jql: `project not in (${projectKey})`, maxResults: OUTSIDE_SAMPLE });
  // Owner decision 6: warn and save, never refuse, and never ask (so --yes behaves the same).
  const others = projectKeys(outside).filter((key) => key !== projectKey);
  const warning = others.length === 0 ? undefined : widerAccessWarning(projectKey, others);
  input.write(`The token sees ${projectKey} (${inside.join(", ")}).${warning === undefined ? " It sees no other project." : ""}`);
  if (warning !== undefined) input.write(`Warning: ${warning}`);

  const secretName = connectorSecretName(input.env, "jira");
  await storeConnectorSecret(input.secrets, secretName, JSON.stringify({ apiKey: token }));
  await registerCredential({ ...input.session, ref: "jira", type: "static-secret", secretName }, input.services.fetch);
  const { revision } = await addConnectorRevision({
    env: input.env, session: input.session, projectName: input.projectName, write: input.write, services: input.services,
    connector: { name: "jira", type: "jira", credentialRef: "jira", scopes: [{ alias: scopeAlias(projectKey), cloudId, projectKey, siteUrl }], tools: JIRA_TOOLS },
  });
  return { ref: "jira", revision, ...(warning === undefined ? {} : { warning }) };
}

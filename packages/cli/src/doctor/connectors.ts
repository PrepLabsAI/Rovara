// FR-050's "each connector's test read" and the 15d2 decision "FR-050, for phase 15e": for every
// connector in this environment's project files, the credential exists with the right shape and,
// for Linear and Jira, still works. Asana is not refreshed here: a refresh rotates the token the
// control plane holds (question 10). A vendor's own words never reach a check: they may repeat the key.
import { environmentConnectorSecretPrefix, OAuthRefreshTokenSecretSchema, StaticSecretSchema, type McpAuth } from "@agentx/contracts";
import { mcpCredentialRef } from "../setup/connectors/mcp.js";
import { connectorSecretName } from "../setup/connectors/revision.js";
import { environmentProjectFiles } from "../setup/project-add.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

type KnownType = "linear" | "jira" | "asana";
interface KnownConnector { type: KnownType; credentialRef: string; scopes: Array<{ alias: string; teamId?: string; cloudId?: string; projectKey?: string; projectGid?: string }> }
const LABEL: Record<KnownType, string> = { linear: "Linear", jira: "Jira", asana: "Asana" };
const refused = (error: unknown) => error instanceof Error && error.name === "VendorRefused";

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

async function connectorCheck(context: DoctorContext, project: string, connector: KnownConnector): Promise<DoctorCheck> {
  const { env, services } = context;
  const name = `${LABEL[connector.type]} (project ${project})`;
  const again = `agentx --env ${env} connector add ${connector.type} --project ${project}`;
  if (connector.credentialRef !== connector.type) return check("connectors", name, "skip", `credential ${connector.credentialRef} was registered by hand, so its secret is not known here`);
  const secretName = connectorSecretName(env, connector.type);
  let raw: string | undefined;
  try {
    raw = await services.secrets.get(secretName);
  } catch (error) {
    // Only the error's name: AccessDenied, a KMS refusal, or a secret scheduled for deletion. Its message is not kept.
    return check("connectors", name, "fail", `could not read secret ${secretName} (${error instanceof Error ? error.name : "unknown error"})`, "check that your AWS role can read it, then run agentx doctor again");
  }
  if (raw === undefined) return check("connectors", name, "fail", `credentials missing: no secret ${secretName}`, again);
  const value = parseJson(raw);
  if (connector.type === "asana") {
    return OAuthRefreshTokenSecretSchema.safeParse(value).success
      ? check("connectors", name, "ok", "the bot's sign-in is stored; not tested live, since a test refresh would rotate the token the control plane holds")
      : check("connectors", name, "fail", "the Asana bot never finished signing in (no refresh token is stored)", again);
  }
  const secret = StaticSecretSchema.safeParse(value);
  if (!secret.success) return check("connectors", name, "fail", `the secret ${secretName} has the wrong shape`, again);
  const key = secret.data.apiKey;
  if (connector.type === "linear") {
    let teams;
    try { teams = await services.vendors.linearTeams(key); } catch (error) {
      return refused(error) ? check("connectors", name, "fail", "Linear refused the stored key: it expired or was revoked", again) : check("connectors", name, "fail", "could not reach Linear to test the key", "check this computer's network access to linear.app, then run agentx doctor again");
    }
    const missing = connector.scopes.filter((scope) => !teams.some((team) => team.id.toLowerCase() === (scope.teamId ?? "").toLowerCase())).map((scope) => scope.alias);
    return missing.length > 0 ? check("connectors", name, "fail", `the key no longer sees team ${missing.join(", ")}`, again) : check("connectors", name, "ok", `the key sees ${teams.length} ${teams.length === 1 ? "team" : "teams"}`);
  }
  const empty: string[] = [];
  for (const scope of connector.scopes) {
    if (scope.cloudId === undefined) continue;
    let keys: string[];
    try {
      keys = await services.vendors.jiraSearch({ token: key, cloudId: scope.cloudId, jql: scope.projectKey === undefined ? "order by created DESC" : `project = ${scope.projectKey}`, maxResults: 1 });
    } catch (error) {
      return refused(error) ? check("connectors", name, "fail", "Atlassian refused the stored API token: it expired or was revoked", again) : check("connectors", name, "fail", "could not reach Atlassian to test the API token", "check this computer's network access to atlassian.com, then run agentx doctor again");
    }
    if (keys.length === 0) empty.push(scope.projectKey ?? scope.alias);
  }
  return empty.length > 0 ? check("connectors", name, "warn", `the API token works, but finds no issue in ${empty.join(", ")}`, "check that the Jira service account can still browse the project") : check("connectors", name, "ok", "the API token finds issues in the connected project");
}

/** A generic MCP connector's entry, as far as doctor reads it (spec 055 phase 3). */
interface McpEntry { name: string; vendor?: unknown; endpoint?: unknown; credentialRef?: unknown; auth?: McpAuth; tools?: Array<{ name?: unknown }> }

/**
 * A generic connector set up by connector add mcp: its secret exists with a known shape and, for an
 * API key, the server still lists every approved tool to it. An OAuth sign-in is not refreshed here,
 * for the reason Asana's is not: a refresh rotates the token the control plane holds.
 */
async function mcpConnectorCheck(context: DoctorContext, project: string, entry: McpEntry): Promise<DoctorCheck> {
  const { env, services } = context;
  const vendor = typeof entry.vendor === "string" ? entry.vendor : entry.name;
  const label = `${vendor} (project ${project})`;
  const ref = mcpCredentialRef(entry.name);
  if (entry.credentialRef !== ref) return check("connectors", label, "skip", `credential ${String(entry.credentialRef)} was registered by hand, so its secret is not known here`);
  if (typeof entry.endpoint !== "string") return check("connectors", label, "skip", "the connector entry has no endpoint");
  const again = `agentx --env ${env} connector add mcp --project ${project} --endpoint ${entry.endpoint} --name ${entry.name}`;
  const secretName = `${environmentConnectorSecretPrefix(env)}${ref}`;
  let raw: string | undefined;
  try {
    raw = await services.secrets.get(secretName);
  } catch (error) {
    return check("connectors", label, "fail", `could not read secret ${secretName} (${error instanceof Error ? error.name : "unknown error"})`, "check that your AWS role can read it, then run agentx doctor again");
  }
  if (raw === undefined) return check("connectors", label, "fail", `credentials missing: no secret ${secretName}`, again);
  const value = parseJson(raw);
  if (OAuthRefreshTokenSecretSchema.safeParse(value).success) {
    return check("connectors", label, "ok", "the bot's sign-in is stored; not tested live, since a test refresh would rotate the token the control plane holds");
  }
  const secret = StaticSecretSchema.safeParse(value);
  if (!secret.success) return check("connectors", label, "fail", `the secret ${secretName} has the wrong shape`, again);
  const host = new URL(entry.endpoint).host;
  let offered: string[];
  try {
    offered = (await services.vendors.mcpTools({ endpoint: entry.endpoint, token: secret.data.apiKey, auth: entry.auth })).map((tool) => tool.name);
  } catch (error) {
    return refused(error)
      ? check("connectors", label, "fail", `${host} refused the stored key: it expired or was revoked`, again)
      : check("connectors", label, "fail", `could not reach ${host} to test the key`, `check this computer's network access to ${host}, then run agentx doctor again`);
  }
  const approved = (entry.tools ?? []).flatMap((tool) => (typeof tool.name === "string" ? [tool.name] : []));
  const missing = approved.filter((name) => !offered.includes(name));
  return missing.length > 0
    ? check("connectors", label, "warn", `the key works, but ${host} no longer offers ${missing.join(", ")}`, `remove those tools from the project, or check the key's permissions, then run ${again}`)
    : check("connectors", label, "ok", `the key reaches ${offered.length} tools, including every approved one`);
}

export async function connectorChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, progress, services } = context;
  const found = await environmentProjectFiles(services.configDir, env);
  const checks: DoctorCheck[] = [];
  const fixFile = "fix the file or move it out of the project directory, then run agentx doctor again";
  for (const file of found) {
    if (file.error === "unreadable") checks.push(check("connectors", `project file ${file.path}`, "warn", `could not be read (${file.errorCode ?? "unknown"}), so its connectors were not checked`, fixFile));
    if (file.error === "invalid-yaml") checks.push(check("connectors", `project file ${file.path}`, "warn", `has agentx's register line for environment ${env}, but is not valid YAML`, fixFile));
  }
  const files = found.filter((file) => file.error === undefined);
  for (const file of files) {
    const integrations = (file.definition.integrations ?? {}) as { githubMcp?: unknown; connectors?: unknown[] };
    if (integrations.githubMcp !== undefined) {
      checks.push(check("connectors", `project ${file.name}`, "warn", "uses the older integrations.githubMcp setting", "move it to integrations.connectors (specs/013-connector-gateway/contracts/project-config.md), then register the project again"));
    }
    for (const entry of integrations.connectors ?? []) {
      if ((entry as { type?: unknown }).type === "mcp") {
        const mcp = entry as McpEntry;
        checks.push(typeof mcp.name === "string" ? await mcpConnectorCheck(context, file.name, mcp) : check("connectors", `MCP connector (project ${file.name})`, "skip", "the connector entry has no name"));
        continue;
      }
      const connector = entry as Partial<KnownConnector> & { type?: string };
      if (connector.type !== "linear" && connector.type !== "jira" && connector.type !== "asana") continue;
      const label = `${LABEL[connector.type]} (project ${file.name})`;
      if (typeof connector.credentialRef !== "string") { checks.push(check("connectors", label, "skip", "the connector entry has no credentialRef, so its secret is not known")); continue; }
      if (!Array.isArray(connector.scopes)) { checks.push(check("connectors", label, "skip", "the connector entry has no scopes list")); continue; }
      checks.push(await connectorCheck(context, file.name, connector as KnownConnector));
    }
  }
  for (const saved of progress?.connectors ?? []) {
    if (saved.warning === undefined) continue;
    checks.push(check("connectors", `${LABEL[saved.type]} warning`, "warn", saved.warning, saved.type === "jira"
      ? `narrow the Jira service account to the connected project (docs/connectors/jira.md, Step 4), then run agentx --env ${env} connector add jira --project <name> again`
      : `agentx --env ${env} connector add ${saved.type} --project <name>`));
  }
  const recorded = progress?.connectors ?? [];
  if (files.length === 0 && recorded.length > 0) {
    const added = recorded.map((entry) => LABEL[entry.type]).join(", ");
    // A file marked unusable above may be this environment's: never also claim there is none.
    checks.push(found.length > 0
      ? check("connectors", "project files", "warn", `agentx init added ${added}, but the only project files found for environment ${env} could not be used (see the warnings above)`, fixFile)
      : check("connectors", "project files", "warn", `agentx init added ${added}, but no project file of environment ${env} is in ${services.configDir}`, "run agentx doctor with --config-dir <the directory holding the project files>"));
  }
  return checks.length > 0 ? checks : [check("connectors", "connectors", "ok", "no connectors are set up")];
}

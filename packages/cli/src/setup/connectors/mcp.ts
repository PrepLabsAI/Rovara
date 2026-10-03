// agentx connector add mcp (spec 055 phase 3), from docs/connectors/custom-mcp.md: any remote MCP
// server, with no AgentX code for it. The test read is the server's own tool list, from which the
// engineer approves tools; the credential is pinned to the endpoint's host, and the project gets a
// new revision only once the control plane's preflight confirms the connector is connected.
// A key or token never appears in a log, an error or the project file: only a secret reference does.
import { readFile } from "node:fs/promises";
import {
  agentXError, ConnectorNameSchema, environmentConnectorSecretPrefix, mcpEndpointProblem, McpConnectorSchema, OAuthRefreshTokenSecretSchema,
  type McpAuth, type McpConnectorConfig,
} from "@agentx/contracts";
import { listCredentials, registerCredential } from "../../admin/credential.js";
import type { AuthorizeSecrets } from "../../admin/authorize.js";
import { secretFromSource, type SecretSource } from "../../init/prompts.js";
import type { SetupServices } from "../services.js";
import type { McpToolSummary } from "./vendors.js";
import { addConnectorRevision, errorName, loadProjectFile, refuseLegacyGitHubMcp, scopeAlias, storeConnectorSecret, type ConnectorAddInput } from "./revision.js";

export const MCP_GUIDE = [
  "Any MCP server: AgentX connects to the server's endpoint with a credential you create for it.",
  "  1. Find the server's remote MCP endpoint (https://...) in the vendor's documentation.",
  "  2. Create a credential that reaches only what this project needs: a scoped API key, or a dedicated bot user that signs in once.",
  "  3. AgentX lists the server's tools; approve only the ones the project needs. Tools that change data need an ownership rule (--config-file) or your explicit acknowledgment.",
  "  The credential is sent only to the endpoint's host.",
].join("\n");

export interface McpAddFlags {
  endpoint?: string;
  name?: string;
  vendor?: string;
  label?: string;
  /** How the server authenticates AgentX: an API key or token, or an OAuth sign-in. */
  auth?: "key" | "oauth";
  key?: SecretSource;
  authHeader?: string;
  authPrefix?: string;
  registerClient?: boolean;
  clientId?: string;
  clientSecret?: SecretSource;
  scope?: string;
  botEmail?: string;
  /** Comma-separated tool names, each optionally `:read` or `:write`. */
  tools?: string;
  acknowledgeUnscopedWrites?: boolean;
  /** A JSON file with any other connector fields: scopes, bind, scoping, itemArguments, attributionKeys, auth, tools. */
  configFile?: string;
}

export type McpAddInput = Omit<ConnectorAddInput, "flags" | "services"> & {
  flags: McpAddFlags;
  services: ConnectorAddInput["services"] & Pick<SetupServices, "authorize" | "authorizeSecrets">;
};

const refused = (error: unknown) => error instanceof Error && error.name === "VendorRefused";

/** "Sentry" from mcp.sentry.dev: the host's most specific label that is not a service word. */
export function vendorFromHost(host: string): string {
  const labels = host.split(".").slice(0, -1).filter((label) => !["mcp", "api", "www", "app", "eu", "us"].includes(label));
  const word = labels.at(-1) ?? host.split(".")[0] ?? "vendor";
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/** A connector name from a vendor name: lowercase letters, digits and hyphens, at most 20. */
function nameFrom(vendor: string): string {
  const slug = vendor.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
  return /^[a-z]/.test(slug) ? slug : `mcp-${slug}`.slice(0, 20);
}

/** The credential reference and secret of an mcp connector: `mcp-<name>`, so it never collides with a built-in connector's. */
export function mcpCredentialRef(name: string): string {
  return `mcp-${name}`;
}

/** The fields --config-file may set; anything it does not set comes from flags, prompts and defaults. */
async function readConfigFile(path: string | undefined): Promise<Partial<McpConnectorConfig>> {
  if (path === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    throw agentXError("CONFIG_INVALID", `--config-file ${path} is not a readable JSON file (${errorName(error)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw agentXError("CONFIG_INVALID", `--config-file ${path} must hold one JSON object with connector fields`);
  // Unchecked here: the whole connector is validated by McpConnectorSchema before anything is stored.
  return parsed;
}

/** The approvals from `name[:read|:write]` items. Without a suffix, a tool the server marks read-only is a read, and any other a write. */
export function parseToolApprovals(text: string, offered: readonly McpToolSummary[]): McpConnectorConfig["tools"] {
  const items = text.split(",").map((item) => item.trim()).filter((item) => item !== "");
  if (items.length === 0) throw agentXError("CONFIG_INVALID", "approve at least one tool");
  const byName = new Map(offered.map((tool) => [tool.name, tool]));
  const approvals: McpConnectorConfig["tools"] = [];
  for (const item of items) {
    const [name = "", access, extra] = item.split(":");
    if (extra !== undefined || (access !== undefined && access !== "read" && access !== "write")) throw agentXError("CONFIG_INVALID", `tool ${item} must be a name, optionally followed by :read or :write`);
    const tool = byName.get(name);
    if (tool === undefined) throw agentXError("CONFIG_INVALID", `the server offers no tool ${name}; it offers ${[...byName.keys()].join(", ")}`);
    if (approvals.some((approval) => approval.name === name)) continue;
    approvals.push({ name, access: access === "read" || access === "write" ? access : tool.readOnly === true ? "read" : "write" });
  }
  return approvals;
}

/** One line per tool: its name, what the server says it does, and whether it changes data. */
function toolLines(tools: readonly McpToolSummary[]): string {
  return tools.map((tool) => {
    const kind = tool.readOnly === true ? "read-only" : tool.destructive === true ? "destructive" : tool.readOnly === false ? "changes data" : "not marked";
    return `    ${tool.name} (${kind})${tool.description === "" ? "" : `: ${tool.description}`}`;
  }).join("\n");
}

export async function addMcp(input: McpAddInput): Promise<{ ref: string; name: string; revision: number; tools: number }> {
  const flags = input.flags;
  const base = await readConfigFile(flags.configFile);
  const endpoint = (flags.endpoint ?? base.endpoint ?? await input.prompter.ask("The MCP server's endpoint (https://...)", { flag: "--endpoint", validate: mcpEndpointProblem })).trim();
  const endpointProblem = mcpEndpointProblem(endpoint);
  if (endpointProblem !== undefined) throw agentXError("CONFIG_INVALID", `--endpoint: ${endpointProblem}`);
  const host = new URL(endpoint).hostname;
  const vendor = flags.vendor ?? base.vendor ?? vendorFromHost(host);
  const nameProblem = (value: string) => (ConnectorNameSchema.safeParse(value.trim()).success ? undefined : "a connector name is lowercase letters, digits and hyphens, at most 20, starting with a letter");
  const name = (flags.name ?? base.name ?? await input.prompter.ask("A name for this connector (its tools are shown as <name>__<tool>)", { flag: "--name", defaultValue: nameFrom(vendor), validate: nameProblem })).trim();
  if (nameProblem(name) !== undefined) throw agentXError("CONFIG_INVALID", `--name ${name}: ${nameProblem(name)!}`);
  const rerun = input.rerun ?? `agentx --env ${input.env} connector add mcp --project ${input.projectName} --endpoint ${endpoint} --name ${name}`;

  await refuseLegacyGitHubMcp({ projectName: input.projectName, configDir: input.services.configDir, rerun });
  const existing = (await loadProjectFile({ projectName: input.projectName, configDir: input.services.configDir, rerun })).integrations?.connectors ?? [];
  const clash = existing.find((entry) => entry.name === name && entry.type !== "mcp");
  if (clash !== undefined) throw agentXError("CONFIG_INVALID", `project ${input.projectName} already has a ${clash.type} connector named ${name}; choose another --name. Nothing was stored`);
  input.write(MCP_GUIDE);

  const ref = mcpCredentialRef(name);
  const secretName = `${environmentConnectorSecretPrefix(input.env)}${ref}`;
  const auth: McpAuth | undefined = flags.authHeader !== undefined || flags.authPrefix !== undefined
    ? { ...(flags.authHeader === undefined ? {} : { header: flags.authHeader }), ...(flags.authPrefix === undefined ? {} : { prefix: flags.authPrefix }) }
    : base.auth;
  const kind = flags.auth ?? await input.prompter.choose<"key" | "oauth">(`How does ${vendor} authenticate AgentX?`, [
    { value: "key", label: "An API key or token" },
    { value: "oauth", label: "OAuth: a bot user signs in once in a browser" },
  ], { flag: "--auth", defaultValue: "key" });

  let offered: McpToolSummary[];
  let storeKey: (() => Promise<void>) | undefined;
  if (kind === "key") {
    const key = await secretFromSource({ what: `${vendor} API key`, flag: "--key", source: flags.key ?? {}, processEnv: input.processEnv, prompter: input.prompter });
    try {
      offered = await input.services.vendors.mcpTools({ endpoint, token: key, auth });
    } catch (error) {
      if (refused(error)) throw agentXError("AUTH_REQUIRED", `${host} refused the key; check you copied all of it, that it is not revoked, and the header it goes in (--auth-header, --auth-prefix). Nothing was stored`);
      throw error;
    }
    // Stored and registered only once the connector itself validates, below.
    storeKey = async () => {
      await storeConnectorSecret(input.secrets, secretName, JSON.stringify({ apiKey: key }));
      await registerCredential({ ...input.session, ref, type: "static-secret", secretName, host }, input.services.fetch);
    };
  } else {
    offered = await signInAndList({ input, endpoint, host, ref, secretName, auth, rerun });
  }
  if (offered.length === 0) throw agentXError("CONFIG_INVALID", `${host} offers no tools to this credential; check its permissions, then run ${rerun} again`);
  input.write(`${host} offers ${offered.length} tools:\n${toolLines(offered)}`);

  const readOnly = offered.filter((tool) => tool.readOnly === true).map((tool) => tool.name);
  const toolText = flags.tools ?? (base.tools === undefined
    ? await input.prompter.ask("Tools to approve, comma-separated (add :write to a tool that changes data, :read to one that only reads)", {
      flag: "--tools", ...(readOnly.length > 0 ? { defaultValue: readOnly.join(",") } : {}),
    })
    : undefined);
  const tools = toolText === undefined ? base.tools! : parseToolApprovals(toolText, offered);

  let scoping = base.scoping ?? { mode: "credential" as const };
  const writes = tools.filter((tool) => tool.access === "write").map((tool) => tool.name);
  if (scoping.mode === "credential" && writes.length > 0 && scoping.acknowledgeUnscopedWrites !== true) {
    const acknowledged = flags.acknowledgeUnscopedWrites ?? await input.prompter.confirm(
      `${writes.join(", ")} can change anything this credential reaches in ${vendor}, since no ownership rule limits them. Approve them anyway?`, { defaultValue: false },
    );
    if (!acknowledged) throw agentXError("CONFIG_INVALID", `approve only read tools, or give an ownership rule in --config-file (docs/connectors/custom-mcp.md), then run ${rerun} again`);
    scoping = { mode: "credential", acknowledgeUnscopedWrites: true };
  }

  const parsed = McpConnectorSchema.safeParse({
    ...base, name, type: "mcp", endpoint, vendor, label: flags.label ?? base.label ?? vendor, credentialRef: ref,
    scopes: base.scopes ?? [{ alias: scopeAlias(vendor), values: {} }], scoping, tools, ...(auth === undefined ? {} : { auth }),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `the connector is invalid: ${issue?.path.join(".") || "entry"}: ${issue?.message ?? "invalid"}. Nothing was registered`);
  }
  await storeKey?.();
  const { revision } = await addConnectorRevision({
    env: input.env, session: input.session, projectName: input.projectName, write: input.write, services: input.services, rerun, connector: parsed.data,
  });
  return { ref, name, revision, tools: tools.length };
}

/**
 * The bot user's one-time sign-in (admin/authorize.ts, discovered from the endpoint), then one
 * refresh and the server's tool list as the test read. authorize registers the credential pinned to
 * the host with its token URL and resource; a rotated refresh token is written back at once.
 */
async function signInAndList(context: {
  input: McpAddInput; endpoint: string; host: string; ref: string; secretName: string; auth: McpAuth | undefined; rerun: string;
}): Promise<McpToolSummary[]> {
  const { input, endpoint, host, ref, secretName, rerun } = context;
  const flags = input.flags;
  const registerClient = flags.registerClient ?? (flags.clientId === undefined && await input.prompter.confirm(
    `Let AgentX register itself as ${host}'s OAuth client? Choose no to use an OAuth app you created.`, { defaultValue: true },
  ));
  let client = "{}";
  if (!registerClient) {
    const clientId = (flags.clientId ?? await input.prompter.ask("The OAuth app's client ID", { flag: "--client-id", validate: (value) => (value.trim() === "" ? "give the client ID" : undefined) })).trim();
    const clientSecret = flags.clientSecret === undefined ? undefined
      : await secretFromSource({ what: "OAuth client secret", flag: "--client-secret", source: flags.clientSecret, processEnv: input.processEnv, prompter: input.prompter });
    client = JSON.stringify({ clientId, ...(clientSecret === undefined ? {} : { clientSecret }) });
  }
  // As for Asana: a first run creates the secret; a rerun leaves it alone until the sign-in succeeds.
  if ((await input.secrets.arn(secretName)) === undefined) await input.secrets.create(secretName, client);
  const awsSecrets = input.services.authorizeSecrets;
  const signInSecrets: AuthorizeSecrets = {
    read: async (name) => (name === secretName ? client : awsSecrets.read(name)),
    write: (name, value) => awsSecrets.write(name, value),
    tag: (name) => awsSecrets.tag(name),
  };
  await input.services.authorize({
    controlPlaneUrl: input.session.controlPlaneUrl, accessToken: input.session.accessToken, ref, secretName, endpoint,
    ...(registerClient ? { registerClient: true } : {}), ...(flags.scope === undefined ? {} : { scope: flags.scope }),
    ...(flags.botEmail === undefined ? {} : { expectAccount: flags.botEmail }),
    secrets: signInSecrets, fetchImplementation: input.services.fetch,
    // As for Asana (FR-037): no browser is opened here; the engineer opens the address as the bot.
    showUrl: (url, redirect) => {
      input.write([
        `Sign in as the bot user ${redirect}. Open this address in a private window signed in as the bot user:`,
        url,
        "On a machine you reach over SSH, forward the port first: ssh -L 8765:127.0.0.1:8765 <that machine>.",
      ].join("\n"));
    },
    showAccount: (line) => { input.write(line); },
  });

  const listed = await listCredentials(input.session, input.services.fetch) as { credentials?: Array<{ ref?: unknown; tokenUrl?: unknown; resource?: unknown }> };
  const registered = (listed.credentials ?? []).find((entry) => entry.ref === ref);
  if (registered === undefined || typeof registered.tokenUrl !== "string") {
    throw agentXError("RUNTIME_UNAVAILABLE", `the sign-in finished, but the control plane does not list credential ${ref} with a token URL; run ${rerun} again`);
  }
  let stored: unknown;
  try { stored = JSON.parse((await awsSecrets.read(secretName)) ?? ""); } catch { stored = undefined; }
  const signedIn = OAuthRefreshTokenSecretSchema.safeParse(stored);
  if (!signedIn.success) throw agentXError("CONFIG_INVALID", `secret ${secretName} has no refresh token after the sign-in; run ${rerun} again`);
  let tokens;
  try {
    tokens = await input.services.vendors.oauthAccessToken({
      tokenUrl: registered.tokenUrl, clientId: signedIn.data.clientId, clientSecret: signedIn.data.clientSecret, refreshToken: signedIn.data.refreshToken,
      resource: typeof registered.resource === "string" ? registered.resource : undefined,
    });
  } catch (error) {
    if (refused(error)) throw agentXError("AUTH_REQUIRED", `the token endpoint refused to renew the bot user's sign-in, so the project was not changed; run ${rerun} again to sign in again`);
    throw error;
  }
  if (tokens.refreshToken !== undefined) {
    await awsSecrets.write(secretName, JSON.stringify({ ...signedIn.data, refreshToken: tokens.refreshToken })).catch((error: unknown) => {
      throw agentXError("CONFIG_INVALID", `${host} issued a new refresh token, but it could not be stored in secret ${secretName} with your AWS credentials (${errorName(error)}); run ${rerun} again to sign in again`);
    });
  }
  try {
    return await input.services.vendors.mcpTools({ endpoint, token: tokens.accessToken, auth: context.auth });
  } catch (error) {
    if (refused(error)) throw agentXError("AUTH_REQUIRED", `${host} refused the bot user's access token, so the project was not changed; check the scopes the sign-in asked for (--scope), then run ${rerun} again`);
    throw error;
  }
}

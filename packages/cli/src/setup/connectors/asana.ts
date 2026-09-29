// agentx connector add asana (FR-036 to FR-039), from docs/connectors/asana.md. The bot user signs
// in once (FR-037: no browser is opened, and only --expect-account's sign-in is kept), then one
// refresh gets an access token (a rotated refresh token is written back at once), and the test read
// is get_project as the bot, before the project revision is saved.
//
// C3 (accepted, 2026-09-28): authorizeCredential itself stores the refresh token beside the app's
// client, tags the secret agentx-writable=refresh-token and registers the credential as
// oauth-refresh-token, all before get_project. Only the project revision waits for the read.
// The sign-in listens on 127.0.0.1:8765 only, and closes on every path (admin/authorize.ts).
import { agentXError, OAuthAppSecretSchema, type ConnectorConfig } from "@agentx/contracts";
import type { AuthorizeSecrets } from "../../admin/authorize.js";
import { AlertEmailSchema } from "../../deploy/answer-schemas.js";
import { secretFromSource } from "../../init/prompts.js";
import type { SetupServices } from "../services.js";
import { addConnectorRevision, connectorRerun, connectorSecretName, errorName, refuseLegacyGitHubMcp, scopeAlias, type ConnectorAddInput } from "./revision.js";

export const ASANA_GUIDE = [
  "Asana: AgentX acts as a bot user that signs in once. An Asana token reaches everything that user sees.",
  "  1. Invite a dedicated bot address (outside your email domain, so it joins as a guest) to the one project, with Editor access.",
  "  2. app.asana.com/0/my-apps: Create new app, type Asana MCP (not External MCP, not an API app).",
  "  3. In the app's settings, add the redirect URL http://localhost:8765/callback exactly.",
  "  4. Manage Distribution: Any workspace (a guest bot signs in through another domain).",
  "  5. Copy the Client ID and the Client secret.",
].join("\n");

export const ASANA_TOOLS: ConnectorConfig["tools"] = [
  { name: "get_task", access: "read" },
  { name: "get_tasks", access: "read" },
  { name: "create_tasks", access: "write" },
  { name: "update_tasks", access: "write" },
  { name: "add_comment", access: "write" },
];

const DIGITS = /^\d{1,20}$/;
const clientIdProblem = (value: string) => (DIGITS.test(value.trim()) ? undefined : "the Client ID is digits only; copy it from the Asana app's page (Step 5)");
const emailProblem = (value: string) => (AlertEmailSchema.safeParse(value.trim()).success ? undefined : "the bot user's email must be an email address");
const gidProblem = (value: string) => (DIGITS.test(value.trim()) ? undefined : "the GID is digits: the number after /project/ in the project's address");

/** A flag's value or the prompt's answer, trimmed, checked the same way either way. */
function checked(value: string, problem: (value: string) => string | undefined): string {
  const found = problem(value);
  if (found !== undefined) throw agentXError("CONFIG_INVALID", found);
  return value.trim();
}

const refused = (error: unknown) => error instanceof Error && error.name === "VendorRefused";

export async function addAsana(input: ConnectorAddInput & { services: ConnectorAddInput["services"] & Pick<SetupServices, "authorize" | "authorizeSecrets"> }): Promise<{ ref: string; revision: number }> {
  const rerun = connectorRerun(input, "asana");
  await refuseLegacyGitHubMcp({ projectName: input.projectName, configDir: input.services.configDir, rerun });
  input.write(ASANA_GUIDE);
  const clientId = checked(input.flags.asanaClientId ?? await input.prompter.ask("The Asana app's Client ID", { flag: "--asana-client-id", validate: clientIdProblem }), clientIdProblem);
  const clientSecret = await secretFromSource({ what: "Asana client secret", flag: "--asana-client-secret", source: input.flags.asanaClientSecret ?? {}, processEnv: input.processEnv, prompter: input.prompter });
  const botEmail = checked(input.flags.asanaBotEmail ?? await input.prompter.ask("The bot user's email", { flag: "--asana-bot-email", validate: emailProblem }), emailProblem);
  // Asked before the sign-in, so a mistyped GID never costs a sign-in.
  const projectGid = checked(input.flags.asanaProject ?? await input.prompter.ask("The Asana project's GID (the number after /project/ in its address)", { flag: "--asana-project", validate: gidProblem }), gidProblem);

  const secretName = connectorSecretName(input.env, "asana");
  const client = JSON.stringify({ clientId, clientSecret });
  // A first run creates the secret (tagged agentx:env) with the app's client only: there is nothing
  // to lose yet. A rerun leaves the stored secret alone: the sign-in reads the new client from
  // memory and writes the whole secret (client and refresh token) only after the bot's sign-in
  // succeeds, so a refused, cancelled or timed-out rerun leaves a working connector exactly as it was.
  if ((await input.secrets.arn(secretName)) === undefined) await input.secrets.create(secretName, client);
  const awsSecrets = input.services.authorizeSecrets;
  const signInSecrets: AuthorizeSecrets = {
    read: async (name) => (name === secretName ? client : awsSecrets.read(name)),
    write: (name, value) => awsSecrets.write(name, value),
    tag: (name) => awsSecrets.tag(name),
  };
  await input.services.authorize({
    controlPlaneUrl: input.session.controlPlaneUrl, accessToken: input.session.accessToken, ref: "asana", secretName, provider: "asana",
    secrets: signInSecrets, expectAccount: botEmail, fetchImplementation: input.services.fetch,
    // FR-037: no openBrowser; the engineer opens the address in a private window as the bot.
    showUrl: (url, redirect) => {
      input.write([
        `Sign in as the bot user ${redirect}. Open this address in a private window signed in as ${botEmail}:`,
        url,
        "On a machine you reach over SSH, forward the port first: ssh -L 8765:127.0.0.1:8765 <that machine>.",
      ].join("\n"));
    },
    showAccount: (line) => { input.write(line); },
  });

  const signedIn = OAuthAppSecretSchema.safeParse(parseJson((await awsSecrets.read(secretName)) ?? ""));
  if (!signedIn.success || signedIn.data.refreshToken === undefined) {
    throw agentXError("CONFIG_INVALID", `secret ${secretName} has no refresh token after the sign-in; run ${rerun} again`);
  }
  let tokens;
  try {
    tokens = await input.services.vendors.asanaAccessToken({ clientId, clientSecret, refreshToken: signedIn.data.refreshToken });
  } catch (error) {
    if (refused(error)) throw agentXError("AUTH_REQUIRED", `Asana refused to renew the bot user's sign-in, so the project was not changed; run ${rerun} again to sign in again`);
    throw error;
  }
  // Written back before anything else can fail, in one PutSecretValue (the whole JSON), so the
  // stored refresh token is the live one even if the read below fails. The broker handles later
  // rotations the same way.
  if (tokens.refreshToken !== undefined) {
    await awsSecrets.write(secretName, JSON.stringify({ ...signedIn.data, refreshToken: tokens.refreshToken })).catch((error: unknown) => {
      throw agentXError("CONFIG_INVALID", `Asana issued a new refresh token, but it could not be stored in secret ${secretName} with your AWS credentials (${errorName(error)}); the stored one may no longer work, so run ${rerun} again to sign in again`);
    });
  }
  let project;
  try {
    project = await input.services.vendors.asanaProject({ accessToken: tokens.accessToken, projectGid });
  } catch (error) {
    // F28: Asana MCP refusing the token, explained as Jira explains Atlassian's refusal.
    if (refused(error)) throw agentXError("AUTH_REQUIRED", `Asana MCP refused the bot user's access token, so the project was not changed; check the app type is Asana MCP (docs/connectors/asana.md, Step 2), then run ${rerun} again`);
    // Anything else (a raw MCP client or SDK error, a missing get_project tool) is named by its
    // class only: its message can carry vendor text.
    throw agentXError("RUNTIME_UNAVAILABLE", `could not read Asana project ${projectGid} through Asana MCP (${errorName(error)}), so the project was not changed; check that the Asana app type is Asana MCP (see the Asana guide, docs/connectors/asana.md, Step 2), then rerun ${rerun}`);
  }
  if (project === undefined) {
    // get_project answered with an error: most often the bot is not in the project, but Asana gives
    // the same answer for a read that simply failed.
    throw agentXError("CONFIG_INVALID", `the bot cannot see, or could not read, project ${projectGid}; invite it to the project (${botEmail}, as a guest with Editor access: docs/connectors/asana.md, Step 1) or try again: ${rerun}`);
  }
  input.write(`The bot user sees the Asana project ${project.name}.`);
  const { revision } = await addConnectorRevision({
    env: input.env, session: input.session, projectName: input.projectName, write: input.write, services: input.services, rerun,
    connector: { name: "asana", type: "asana", credentialRef: "asana", scopes: [{ alias: scopeAlias(project.name), projectGid }], tools: ASANA_TOOLS },
  });
  return { ref: "asana", revision };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}


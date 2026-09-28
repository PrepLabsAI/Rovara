// agentx connector add linear (FR-036 to FR-039), from docs/connectors/linear.md. The key's own
// team list is the test read (FR-038), and the engineer picks the team from it. The key never
// appears in a log, an error or the project file: only a Secrets Manager reference does.
import { agentXError, type ConnectorConfig } from "@agentx/contracts";
import { registerCredential } from "../../admin/credential.js";
import { secretFromSource } from "../../init/prompts.js";
import { addConnectorRevision, connectorSecretName, scopeAlias, storeConnectorSecret, type ConnectorAddInput } from "./revision.js";

export const LINEAR_GUIDE = [
  "Linear: AgentX uses a Linear API key, which acts as the Linear user who made it.",
  "  1. In Linear, open Settings, Account, Security & Access. Under Personal API keys, choose New API key.",
  "  2. Permissions: Read, plus Create issues and Create comments (or Write, to let AgentX update issues).",
  "  3. Team access: only the teams this project may use.",
  "  4. Create the key and copy it; Linear shows it once. A dedicated Linear user keeps AgentX's writes apart from a person's.",
].join("\n");

export const LINEAR_TOOLS: ConnectorConfig["tools"] = [
  { name: "list_issues", access: "read" },
  { name: "get_issue", access: "read", allowedArguments: ["id", "includeCustomerNeeds", "includeReleases"] },
  { name: "save_issue", access: "write", allowedArguments: ["id", "title", "description", "state", "assignee", "priority", "labels", "dueDate"] },
  { name: "save_comment", access: "write", allowedArguments: ["issueId", "body"] },
];

export async function addLinear(input: ConnectorAddInput): Promise<{ ref: string; revision: number }> {
  input.write(LINEAR_GUIDE);
  const apiKey = await secretFromSource({ what: "Linear API key", flag: "--linear-key", source: input.flags.linearKey ?? {}, processEnv: input.processEnv, prompter: input.prompter });
  let teams;
  try {
    teams = await input.services.vendors.linearTeams(apiKey);
  } catch (error) {
    if (error instanceof Error && error.name === "VendorRefused") {
      throw agentXError("AUTH_REQUIRED", "Linear refused the API key; check you copied all of it and that it is not revoked (Settings, Account, Security & Access). Nothing was stored");
    }
    throw error;
  }
  if (teams.length === 0) throw agentXError("CONFIG_INVALID", "the key can see no Linear team; give it access to the project's team, then run this again. Nothing was stored");
  input.write(`The key can see ${teams.length} teams: ${teams.map((team) => `${team.key} (${team.name})`).join(", ")}.${teams.length > 1 ? " Limit the key to the project's team in Linear if you can." : ""}`);
  const wanted = input.flags.linearTeam ?? await input.prompter.choose<string>("Which Linear team may this project use?", teams.map((team) => ({ value: team.id, label: `${team.key} (${team.name})` })), { flag: "--linear-team", defaultValue: teams[0]!.id });
  const team = teams.find((entry) => entry.id === wanted || entry.key.toLowerCase() === wanted.toLowerCase());
  if (team === undefined) throw agentXError("CONFIG_INVALID", `the key cannot see team ${wanted}; it sees ${teams.map((entry) => entry.key).join(", ")}. Nothing was stored`);

  const secretName = connectorSecretName(input.env, "linear");
  await storeConnectorSecret(input.secrets, secretName, JSON.stringify({ apiKey }));
  await registerCredential({ ...input.session, ref: "linear", type: "static-secret", secretName }, input.services.fetch);
  const { revision } = await addConnectorRevision({
    env: input.env, session: input.session, projectName: input.projectName, write: input.write, services: input.services,
    connector: { name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: scopeAlias(team.key), teamId: team.id }], tools: LINEAR_TOOLS },
  });
  return { ref: "linear", revision };
}

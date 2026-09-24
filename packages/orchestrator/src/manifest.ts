import type { ConnectorCatalog, ThreadConnector } from "@agentx/contracts";

/** Vendors AgentX can connect, so the model can say plainly which ones this channel lacks. */
const KNOWN_CONNECTORS = [
  { type: "github", label: "GitHub issues" },
  { type: "linear", label: "Linear" },
  { type: "jira", label: "Jira" },
  { type: "asana", label: "Asana" },
] as const;

export function capabilitiesManifest(input: {
  repositories: readonly string[];
  connectors: readonly ThreadConnector[];
  catalogs: readonly ConnectorCatalog[];
  /** Connector names whose discovery failed transiently this turn; listed on their own line, not as "not connected". */
  unavailable?: readonly string[];
  /** Connector names whose discovery failed for an authorization, configuration or malformed-response reason. */
  misconfigured?: readonly string[];
}): string {
  const repositories = input.repositories.join(", ");
  const misconfiguredNames = new Set(input.misconfigured ?? []);
  const unavailableNames = new Set([...(input.unavailable ?? []), ...misconfiguredNames]);
  const connectors = input.connectors.filter((connector) => !unavailableNames.has(connector.name));
  const usable = connectors.filter((connector) =>
    connector.connected && (input.catalogs.find((catalog) => catalog.connector === connector.name)?.tools.length ?? 0) > 0);
  const lines = [
    "What this channel can do:",
    `- Repository code and files (${repositories}): agentx_submit_task, agentx_follow_up`,
    `- Pull requests (${repositories}): agentx_create_pull_request, agentx_manage_pull_request`,
    ...usable.map((connector) => `- ${connector.label} (${connector.scopes.join(", ")}): ${connector.name}__* tools`),
  ];
  const transientLabels = input.connectors
    .filter((connector) => unavailableNames.has(connector.name) && !misconfiguredNames.has(connector.name)).map((connector) => connector.label);
  if (transientLabels.length > 0) {
    lines.push(`Temporarily unavailable: ${transientLabels.join(", ")}. Tell the user it is temporarily unavailable and continue with the rest.`);
  }
  const misconfiguredLabels = input.connectors.filter((connector) => misconfiguredNames.has(connector.name)).map((connector) => connector.label);
  if (misconfiguredLabels.length > 0) {
    lines.push(`Unavailable because of a setup problem: ${misconfiguredLabels.join(", ")}. Tell the user an administrator needs to check this connector, and continue with the rest.`);
  }
  const usableTypes = new Set<string>(usable.map((connector) => connector.type));
  const unusable = [
    ...connectors.filter((connector) => !usable.includes(connector)).map((connector) => connector.label),
    ...KNOWN_CONNECTORS.filter((known) => !usableTypes.has(known.type) && !input.connectors.some((connector) => connector.type === known.type)).map((known) => known.label),
  ];
  if (unusable.length > 0) {
    lines.push(`Not connected for this channel: ${unusable.join(", ")}. If asked about something that is not connected, say it is not connected for this channel and do not attempt a workaround.`);
  }
  lines.push("Closing this thread's workspace is a command, not a tool: the user writes \"close this workspace\".");
  return lines.join("\n");
}

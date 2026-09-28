// A connector joins a project as a new revision of the project file project add wrote (FR-039).
// Registration runs the control plane's preflight; anything but a confirmed "connected" fails the
// step with its reason, so a broken connector, or one the control plane never actually checked
// (a missing or unparseable preflight report, or the connector simply absent from it), is never
// reported as set up (F17).
import { agentXError, environmentConnectorSecretPrefix, type ConnectorConfig } from "@agentx/contracts";
import { loadProjectConfig } from "../../config.js";
import type { InitSecrets, FinishFlags } from "../../init/context.js";
import type { ConnectorType } from "../../init/install-state.js";
import type { Prompter } from "../../init/prompts.js";
import { registerRevision } from "../project-add.js";
import type { AdminSession, SetupServices } from "../services.js";

export interface ConnectorAddInput {
  env: string; session: AdminSession; projectName: string; secrets: Pick<InitSecrets, "arn" | "create" | "put" | "get">;
  prompter: Prompter; processEnv: NodeJS.ProcessEnv; write: (line: string) => void;
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir" | "vendors">;
  flags: FinishFlags;
}

export function connectorSecretName(env: string, type: ConnectorType): string {
  return `${environmentConnectorSecretPrefix(env)}${type}`;
}

export function scopeAlias(text: string): string {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z]/.test(cleaned) ? cleaned : `scope-${cleaned}`.slice(0, 40);
}

export async function storeConnectorSecret(secrets: Pick<InitSecrets, "arn" | "create" | "put">, name: string, value: string): Promise<void> {
  if ((await secrets.arn(name)) === undefined) await secrets.create(name, value);
  else await secrets.put(name, value);
}

/**
 * A hand-written project file may still carry the pre-connectors `integrations.githubMcp` policy.
 * Adding a connector on top of it would build a definition with both `githubMcp` and `connectors`
 * set, which the control plane's (and `registerProject`'s own local) schema refuses with a raw
 * "use either integrations.githubMcp or integrations.connectors, not both" error. Refuse here
 * instead, with a message that says what to do, before a connector module stores or registers
 * anything: every `addX` calls this first, ahead of storing its credential.
 */
export async function refuseLegacyGitHubMcp(input: { projectName: string; configDir: string }): Promise<void> {
  const current = await loadProjectConfig({ projectName: input.projectName, configDirectory: input.configDir, allowLoopback: false });
  if (current.integrations?.githubMcp !== undefined) {
    throw agentXError(
      "CONFIG_INVALID",
      `project ${input.projectName} uses the older integrations.githubMcp setting; move it to integrations.connectors (see docs/project-configuration.md) before adding connectors`,
    );
  }
}

export async function addConnectorRevision(input: {
  env: string; session: AdminSession; projectName: string; connector: ConnectorConfig;
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir">; write: (line: string) => void;
}): Promise<{ revision: number }> {
  const current = await loadProjectConfig({ projectName: input.projectName, configDirectory: input.services.configDir, allowLoopback: false });
  const others = (current.integrations?.connectors ?? []).filter((entry) => entry.name !== input.connector.name);
  const definition = { ...current, revision: current.revision + 1, integrations: { ...current.integrations, connectors: [...others, input.connector] } };
  const registered = await registerRevision({ env: input.env, session: input.session, definition, services: input.services });
  const report = registered.preflight.find((entry) => entry.name === input.connector.name);
  for (const warning of registered.warnings) input.write(`Warning: ${warning}`);
  // A missing preflight report, one that failed to parse, or one that simply never mentions this
  // connector, all reach here as report === undefined: none of them is confirmation the connector
  // works, so none of them may be read as success (F17).
  if (report === undefined) {
    throw agentXError(
      "RUNTIME_UNAVAILABLE",
      `revision ${registered.revision} of ${input.projectName} is registered, but the control plane reported no preflight for the ${input.connector.name} connector, so the registration could not be confirmed. Run agentx connector add ${input.connector.type} --project ${input.projectName} again to check it`,
    );
  }
  if (report.status !== "connected") {
    throw agentXError(
      "CONFIG_INVALID",
      `revision ${registered.revision} of ${input.projectName} is registered, but the ${input.connector.name} connector is ${report.status}${report.problem === undefined ? "" : `: ${report.problem}`}. Fix it, then run agentx connector add ${input.connector.type} --project ${input.projectName} again`,
    );
  }
  input.write(`Registered revision ${registered.revision} of ${input.projectName} with the ${input.connector.name} connector, offering ${report.offered.length} tools.`);
  return { revision: registered.revision };
}

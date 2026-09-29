// agentx config list|get|set (FR-048, FR-049), under the operator role. Stack-parameter keys change
// with a parameter-only stack update (spec 025 R6's updateStackParameters); the alert address is an
// SSM value; the workspace limits are the control plane's setting (spec 025 FR-053). list and get
// never print the alert address, which can be a webhook secret: only whether it is set.
import { agentXError, environmentStackName } from "@agentx/contracts";
import type { CallerIdentity, StackReader } from "../environments/adopt.js";
import { withEnvironmentLock } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { updateStackParameters } from "../deploy/parameter-update.js";
import { checkAlertWebhook, storeAlertWebhook, webhookDisplay } from "../init/answers.js";
import type { InitSecrets } from "../init/context.js";
import { readInstallAnswers, writeInstallAnswers } from "../init/install-state.js";
import { modelCheckProblem, type PrerequisiteChecks } from "../init/prerequisites.js";
import { secretFromSource, type Prompter, type SecretSource } from "../init/prompts.js";
import { alertsTopicArn, ensureSubscribed, type AlertsApi } from "../setup/alerts.js";
import { CONFIG_KEYS, configKey, whereText, type ConfigKey, type ModelRole } from "./keys.js";

export interface ConfigServices {
  store: ParameterStore;
  secrets: InitSecrets;
  cloudFormation: { send(command: unknown): Promise<unknown> };
  stacks: StackReader;
  identity: CallerIdentity;
  /** Built for the environment's own region, once its settings are read (the model test call runs there). */
  checks: (region: string) => Pick<PrerequisiteChecks, "converse" | "openRouter">;
  alerts: AlertsApi;
  prompter: Prompter;
  processEnv: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
}

export interface ConfigRow { key: string; value: string; where: string; description: string }

const LIMITS_REFUSAL = (key: string) =>
  `${key} is the control plane's workspace limits setting; AgentX changes it with the admin change tool from spec 025 phase 25e, which this release does not have yet. Until then, new installs take the stack parameter as their default`;

async function installed(services: ConfigServices, env: string): Promise<EnvironmentSettings> {
  const settings = await readEnvironmentSettings(services.store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `agentx config works on environments installed with agentx init; ${env} uses the legacy stack names`);
  return settings;
}

const looksLikeWebhook = (value: string) => /^https?:\/\//i.test(value.trim());

/** The alert address as the settings record it (an email, or a webhook shown only by its host), or
 * as init's install answers do when the settings hold none: init writes only the answers. */
async function recordedAlertAddress(services: ConfigServices, env: string, settings: EnvironmentSettings): Promise<string | undefined> {
  if (settings.alertAddress !== undefined) return settings.alertAddress;
  const alert = (await readInstallAnswers(services.store, env))?.alert;
  if (alert === undefined || alert.kind === "none") return undefined;
  return alert.kind === "email" ? alert.address : alert.display;
}

async function currentValue(services: ConfigServices, env: string, settings: EnvironmentSettings, entry: ConfigKey): Promise<string> {
  const { target } = entry;
  if (target.kind === "settings") {
    const address = await recordedAlertAddress(services, env, settings);
    if (address === undefined) return "none";
    return looksLikeWebhook(address) ? "set (webhook)" : "set (email address)";
  }
  const part = target.kind === "stack-parameter" ? target.part : target.installDefault.part;
  const name = target.kind === "stack-parameter" ? target.parameter : target.installDefault.parameter;
  const stack = await services.stacks.describe(environmentStackName(env, part));
  const value = stack?.parameters[name] ?? entry.defaultValue ?? "unknown";
  return target.kind === "stack-parameter" ? value : `${value} (install-time default; the control plane may hold a newer setting)`;
}

export async function runConfigList(services: ConfigServices, env: string): Promise<ConfigRow[]> {
  const settings = await installed(services, env);
  const rows: ConfigRow[] = [];
  for (const entry of CONFIG_KEYS) {
    rows.push({ key: entry.key, value: await currentValue(services, env, settings, entry), where: whereText(entry.target, env), description: entry.description });
  }
  return rows;
}

export async function runConfigGet(services: ConfigServices, env: string, key: string): Promise<ConfigRow> {
  const entry = configKey(key);
  const settings = await installed(services, env);
  return { key: entry.key, value: await currentValue(services, env, settings, entry), where: whereText(entry.target, env), description: entry.description };
}

/** FR-049: a model key passes the same one-token test call init makes, with the environment's provider. */
async function checkModel(services: ConfigServices, settings: EnvironmentSettings, role: ModelRole, modelId: string): Promise<void> {
  const checks = services.checks(settings.region);
  try {
    if (settings.models.providers?.[role] === "openrouter") {
      if (checks.openRouter === undefined) throw new Error("this agentx cannot check OpenRouter models");
      await checks.openRouter(modelId, settings.models.openRouter ?? {});
    } else {
      await checks.converse(modelId);
    }
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `${modelCheckProblem({ modelId, role, region: settings.region, error })}; nothing changed`);
  }
}

/** Records a model in the settings and the install answers. Both must follow the stack: `agentx
 * upgrade` rebuilds each ModelId parameter from the install answers (deploy/parameters.ts), so a
 * stale answer would quietly put the old model back on the next upgrade. */
async function recordModel(services: ConfigServices, env: string, role: ModelRole, modelId: string): Promise<void> {
  let what: RecordModelError["what"] = "the settings";
  try {
    const current = await installed(services, env);
    if (current.models[role] !== modelId) {
      await writeEnvironmentSettings(services.store, { ...current, models: { ...current.models, [role]: modelId }, updatedAt: new Date(services.now()).toISOString() });
    }
    what = "the install answers";
    const answers = await readInstallAnswers(services.store, env);
    if (answers !== undefined && answers.models[role] !== modelId) {
      await writeInstallAnswers(services.store, { ...answers, models: { ...answers.models, [role]: modelId } });
    }
  } catch (error) {
    throw new RecordModelError(what, error);
  }
}

/** Which record a model write failed on, with the original error as its cause. */
class RecordModelError extends Error {
  constructor(readonly what: "the settings" | "the install answers", cause: unknown) {
    super(`could not update ${what}`, { cause });
    this.name = "RecordModelError";
  }
}

/** True when the settings and install answers (if any) already name this model. */
async function modelRecorded(services: ConfigServices, env: string, settings: EnvironmentSettings, role: ModelRole, modelId: string): Promise<boolean> {
  if (settings.models[role] !== modelId) return false;
  const answers = await readInstallAnswers(services.store, env);
  return answers === undefined || answers.models[role] === modelId;
}

export async function runConfigSet(services: ConfigServices, env: string, input: { key: string; value?: string; valueSource?: SecretSource; yes: boolean }): Promise<{ changed: boolean }> {
  const entry = configKey(input.key);
  const { target } = entry;
  if (target.kind === "control-plane-setting") throw agentXError("CONFIG_INVALID", LIMITS_REFUSAL(entry.key));
  if (target.kind === "settings") return setAlertAddress(services, env, input);
  if (input.value === undefined) throw agentXError("CONFIG_INVALID", `give the new value: agentx config set ${entry.key} <value>`);
  const value = entry.parse(input.value);
  const settings = await installed(services, env);
  const role = entry.model;
  if ((await currentValue(services, env, settings, entry)) === value) {
    if (role === undefined || await modelRecorded(services, env, settings, role, value)) {
      services.write(`${entry.key} is already ${value}; nothing to change`);
      return { changed: false };
    }
    // The stack already runs this model, but an earlier set stopped before recording it.
    const holder = (await services.identity.get()).arn;
    return withEnvironmentLock({ store: services.store, env, holder, command: `config set ${entry.key}`, now: services.now }, async () => {
      await recordModel(services, env, role, value);
      services.write(`${entry.key} was already ${value} on the stack; recorded it in the settings and install answers`);
      return { changed: true };
    });
  }
  if (role !== undefined) await checkModel(services, settings, role, value);
  const roleArn = settings.access?.cloudFormationRoleArn;
  if (roleArn === undefined) throw agentXError("CONFIG_INVALID", `environment ${env}'s settings name no CloudFormation role; run agentx env use --env ${env}, or agentx init --resume`);
  const holder = (await services.identity.get()).arn;
  return withEnvironmentLock({ store: services.store, env, holder, command: `config set ${entry.key}`, now: services.now }, async () => {
    const stackName = environmentStackName(env, target.part);
    const result = await updateStackParameters({
      cloudFormation: services.cloudFormation, stackName, roleArn, changes: { [target.parameter]: value }, label: "config",
      confirm: async ({ parameters, changes }) => {
        for (const change of parameters) services.write(`${entry.key}: ${change.name} ${change.from} -> ${change.to} on ${stackName}`);
        for (const change of changes) services.write(`  ${change.action} ${change.logicalId} (${change.type})${change.replacement === "True" ? " [replacement]" : ""}`);
        return input.yes || services.prompter.confirm(`Apply this change to ${stackName}?`, { defaultValue: false });
      },
      write: services.write, now: services.now, sleep: services.sleep, ...(services.pollMs === undefined ? {} : { pollMs: services.pollMs }),
    });
    if (result.changed && role !== undefined) {
      try {
        await recordModel(services, env, role, value);
      } catch (error) {
        const failed = error instanceof RecordModelError ? error : new RecordModelError("the settings", error);
        throw Object.assign(
          agentXError("RUNTIME_UNAVAILABLE", `stack ${stackName} now uses ${value}, but ${failed.what} were not updated; run the same agentx config set again to record it`),
          { cause: failed.cause },
        );
      }
    }
    return { changed: result.changed };
  });
}

/** alerts.address: an email from the command line, or a webhook from a file, variable or hidden
 * prompt (FR-020). It shows the change and asks first unless --yes (FR-049). The operator role cannot unsubscribe (question 8): the old address stays until an
 * admin removes it, and this prints the exact command, showing a webhook only by its host. */
async function setAlertAddress(services: ConfigServices, env: string, input: { value?: string; valueSource?: SecretSource; yes: boolean }): Promise<{ changed: boolean }> {
  if (input.value !== undefined && looksLikeWebhook(input.value)) {
    throw agentXError("CONFIG_INVALID", "a webhook alert address is a secret; pass it with --value-file <path> or --value-env <NAME>, never on the command line");
  }
  const settings = await installed(services, env);
  const target = input.value !== undefined
    ? { kind: "email" as const, address: configKey("alerts.address").parse(input.value) }
    : await (async () => {
      const endpoint = checkAlertWebhook(await secretFromSource({ what: "the alert webhook address", flag: "--value", source: input.valueSource ?? {}, processEnv: services.processEnv, prompter: services.prompter }));
      return { kind: "webhook" as const, endpoint, display: webhookDisplay(endpoint) };
    })();
  const shown = target.kind === "email" ? target.address : target.display;
  const secretName = `agentx/${env}/alert-endpoint`;
  if (await alertAddressAlreadySet(services, settings, target, secretName)) {
    services.write("alerts.address is already set; nothing to change");
    return { changed: false };
  }
  services.write(`alerts.address: ${(await recordedAlertAddress(services, env, settings)) ?? "none"} -> ${shown}`);
  if (!input.yes && !(await services.prompter.confirm("Apply this change?", { defaultValue: false }))) {
    throw agentXError("CONFIG_INVALID", "the alerts.address change was not applied; nothing changed");
  }
  const holder = (await services.identity.get()).arn;
  return withEnvironmentLock({ store: services.store, env, holder, command: "config set alerts.address", now: services.now }, async () => {
    const topicArn = await alertsTopicArn({ stackOutputs: async (name) => (await services.stacks.describe(name))?.outputs, stackName: settings.stacks["control-plane"], next: "upgrade the environment with agentx upgrade" });
    const before = await services.alerts.subscriptions(topicArn);
    const state = await ensureSubscribed({ api: services.alerts, topicArn, target, write: services.write, sleep: services.sleep, now: services.now });
    // Only once the new address is subscribed: until then the secret keeps the old one.
    if (target.kind === "webhook") await storeAlertWebhook(services.secrets, secretName, target.endpoint);
    const current = await installed(services, env);
    await writeEnvironmentSettings(services.store, { ...current, alertAddress: shown, updatedAt: new Date(services.now()).toISOString() });
    const answers = await readInstallAnswers(services.store, env);
    if (answers !== undefined) {
      await writeInstallAnswers(services.store, { ...answers, alert: target.kind === "email" ? { kind: "email", address: target.address } : { kind: "webhook", display: target.display, secretName } });
    }
    const newEndpoint = target.kind === "email" ? target.address.toLowerCase() : target.endpoint;
    for (const old of before) {
      const endpoint = old.protocol === "email" ? old.endpoint.toLowerCase() : old.endpoint;
      if (endpoint === newEndpoint || !old.arn.startsWith("arn:")) continue;
      const oldShown = old.protocol === "email" ? old.endpoint : `${old.protocol}://${safeHost(old.endpoint)}/...`;
      services.write(`${oldShown} is still subscribed. To stop sending it alarms, an admin runs: aws sns unsubscribe --subscription-arn ${old.arn} --region ${settings.region}`);
    }
    services.write(state === "pending"
      ? `Alerts will go to ${shown} once the subscription is confirmed; then run agentx --env ${env} alerts test.`
      : `Alerts now go to ${shown}. Send a test alarm with agentx --env ${env} alerts test.`);
    return { changed: true };
  });
}

/** The settings already record this address: an email compared without case, or a webhook whose
 * shown host matches and whose stored secret is the same address. */
async function alertAddressAlreadySet(services: ConfigServices, settings: EnvironmentSettings, target: { kind: "email"; address: string } | { kind: "webhook"; endpoint: string; display: string }, secretName: string): Promise<boolean> {
  const recorded = settings.alertAddress;
  if (recorded === undefined) return false;
  if (target.kind === "email") return recorded.toLowerCase() === target.address.toLowerCase();
  return recorded === target.display && (await services.secrets.get(secretName)) === target.endpoint;
}

function safeHost(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return "an address"; }
}

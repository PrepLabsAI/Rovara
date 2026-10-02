// agentx config list|get|set (FR-048, FR-049), under the operator role. Stack-parameter keys change
// with a parameter-only stack update (spec 025 R6's updateStackParameters); the alert address is an
// SSM value; the workspace limits are the control plane's setting (spec 025 FR-053). list and get
// never print the alert address, which can be a webhook secret: only whether it is set.
import { randomUUID } from "node:crypto";
import { AgentXError, SECRET_CONFIG_ERROR_MESSAGE, SECRET_CONFIG_KEYS, agentXError, environmentStackName, type ConfigChangeOutcomeRequest } from "@agentx/contracts";
import { recordConfigChange, recordConfigOutcome, runCliChange } from "../admin/changes.js";
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
import { CLI_VERSION } from "../version.js";
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
  /** Spec 025 FR-053: this computer's unexpired admin sign-in for the environment, for the workspace limits' change path and (issue #205) every other change's record. `expiresAt` is epoch milliseconds. */
  adminSession?(env: string): Promise<{ controlPlaneUrl: string; accessToken: string; expiresAt?: number } | undefined>;
  /** How the workspace limits' change path reaches the control plane; the global fetch when absent. */
  fetch?: typeof fetch;
  /** False when nobody can answer a prompt (no terminal): a workspace limits change then needs --yes. */
  canAsk?: boolean;
}

export interface ConfigRow { key: string; value: string; where: string; description: string }

const notInstalled = (env: string) => agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);

/** The deployment's live environment name; before agentx env adopt it has no settings record, and it is still the legacy deployment. */
const LEGACY_ENV = "production";

async function installed(services: ConfigServices, env: string): Promise<EnvironmentSettings> {
  const settings = await readEnvironmentSettings(services.store, env);
  if (settings === undefined) throw notInstalled(env);
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
async function checkModel(services: ConfigServices, env: string, settings: EnvironmentSettings, role: ModelRole, modelId: string): Promise<void> {
  const checks = services.checks(settings.region);
  try {
    if (settings.models.providers?.[role] === "openrouter") {
      if (checks.openRouter === undefined) throw new Error("this agentx cannot check OpenRouter models");
      await checks.openRouter(modelId, settings.models.openRouter ?? {});
    } else {
      await checks.converse(modelId);
    }
  } catch (error) {
    // Live check L3: init's wording names its --<role>-model flag, which config set does not take.
    const wording = {
      changeModel: `agentx --env ${env} config set models.${role} <another model id>`,
      rerun: `run agentx --env ${env} config set models.${role} again`,
      region: "check this computer's network access to AWS (an environment cannot move regions), then try again",
    };
    throw agentXError("CONFIG_INVALID", `${modelCheckProblem({ modelId, role, region: settings.region, error, wording })}; nothing changed`);
  }
}

/** Records a model in the settings, then the install answers. `agentx upgrade` reads the models from
 * the settings (upgradeAnswers uses `settings.models`), so the settings are written first; the
 * install answers are kept in step so `agentx init --resume` (and a re-run of init) deploys the same
 * model rather than quietly putting the old one back. */
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

type AdminSession = { controlPlaneUrl: string; accessToken: string; expiresAt?: number };
/** Issue #205: a config set change recorded in the admin change history, waiting for its outcome. */
interface Recording { session: AdminSession; changeId: string; traceId: string }

const iso = (ms: number) => new Date(ms).toISOString();
const withoutCode = (error: AgentXError) => (error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);
const capped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
/** The record schema's limit on a before or after value. */
const VALUE_MAX = 300;
/** A stack update may take up to 30 minutes (updateStackParameters' deadline); the sign-in must outlast it, so its outcome is recorded too. */
const STACK_SIGN_IN_MS = 35 * 60_000;
const ALERT_SIGN_IN_MS = 10 * 60_000;

/**
 * Issue #205: the admin sign-in a config set change is recorded with. The operator role alone may
 * still change a setting (installer SC-005), so without a sign-in the change goes ahead unrecorded
 * and the command says so first. A sign-in that would end before the change could finish is
 * refused, since its outcome could then not be recorded.
 */
async function recordingSession(services: ConfigServices, env: string, entry: ConfigKey, needMs: number, yes: boolean): Promise<AdminSession | undefined> {
  const session = await services.adminSession?.(env);
  if (session === undefined) {
    services.write(yes
      ? `Warning: this change to ${entry.key} will not be recorded in the admin change history, because this computer has no admin sign-in for ${env}; it goes ahead now. To record config changes, run agentx --env ${env} login --admin before config set.`
      : `Warning: this change to ${entry.key} will not be recorded in the admin change history, because this computer has no admin sign-in for ${env}. To record it, answer no, run agentx --env ${env} login --admin, then run this again.`);
    return undefined;
  }
  checkSignInLeft(services, env, entry, session, needMs);
  return session;
}

/** Refuses a sign-in that would end before the change could finish and its outcome be recorded (a reminder to sign in again; the operator role alone can always skip recording). */
function checkSignInLeft(services: ConfigServices, env: string, entry: ConfigKey, session: AdminSession, needMs: number): void {
  if (session.expiresAt === undefined || session.expiresAt - services.now() >= needMs) return;
  throw agentXError("AUTH_REQUIRED", `this computer's admin sign-in for ${env} ends in ${Math.max(0, Math.floor((session.expiresAt - services.now()) / 60_000))} minutes, too soon to record how this ${entry.key} change ends; run agentx --env ${env} login --admin again, then try again; nothing changed`);
}

/**
 * Issue #205: records the change after the yes and before it applies, asking once more (with the
 * same request ID, so never twice) if AgentX could not be reached. With a sign-in, a change that
 * cannot be recorded is not made.
 */
async function startRecording(services: ConfigServices, env: string, session: AdminSession | undefined, entry: ConfigKey, needMs: number, values: { before: string; after: string } | undefined, requestedAt: string | undefined): Promise<Recording | undefined> {
  if (session === undefined) return undefined;
  // Checked again after the prompt, which may have stayed open a while.
  checkSignInLeft(services, env, entry, session, needMs);
  const hidden = SECRET_CONFIG_KEYS.has(entry.key) || values === undefined;
  const change = { kind: "set_config" as const, key: entry.key, target: whereText(entry.target, env), ...(hidden ? { valueHidden: true as const } : { before: capped(values.before, VALUE_MAX), after: capped(values.after, VALUE_MAX) }) };
  const requestId = randomUUID();
  const record = () => recordConfigChange({ ...session, cliVersion: CLI_VERSION, requestId, change, ...(requestedAt === undefined ? {} : { requestedAt }), answeredAt: iso(services.now()) }, services.fetch ?? fetch);
  try {
    let recorded: Awaited<ReturnType<typeof recordConfigChange>>;
    try {
      recorded = await record();
    } catch (error) {
      if (!(error instanceof AgentXError && error.code === "RUNTIME_UNAVAILABLE")) throw error;
      recorded = await record();
    }
    return { session, ...recorded };
  } catch (error) {
    const reason = error instanceof AgentXError ? withoutCode(error) : "an unexpected error";
    if (error instanceof AgentXError && error.code === "NOT_FOUND") {
      throw agentXError("RUNTIME_UNAVAILABLE", `${entry.key} was not changed: this environment's control plane cannot record config changes yet; upgrade it with agentx --env ${env} upgrade, then try again; nothing changed`);
    }
    if (error instanceof AgentXError && (error.code === "AUTH_REQUIRED" || error.code === "FORBIDDEN")) {
      throw agentXError(error.code, `${entry.key} was not changed: AgentX would not record the change with this computer's admin sign-in (${reason}); run agentx --env ${env} login --admin, then try again; nothing changed`);
    }
    throw agentXError(error instanceof AgentXError ? error.code : "RUNTIME_UNAVAILABLE", `${entry.key} was not changed: AgentX could not record the change in the admin change history (${reason}); nothing changed, try again`);
  }
}

/** The failure as the record keeps it: a secret-bearing key's by fixed words only. */
function failureOf(entry: ConfigKey, error: unknown): ConfigChangeOutcomeRequest {
  const code = error instanceof AgentXError ? error.code : "RUNTIME_UNAVAILABLE";
  if (SECRET_CONFIG_KEYS.has(entry.key)) return { outcome: "failed", error: { code, message: SECRET_CONFIG_ERROR_MESSAGE } };
  const message = error instanceof AgentXError ? withoutCode(error) : "the change did not finish";
  return { outcome: "failed", error: { code, message: capped(message === "" ? "the change did not finish" : message, 1_000) } };
}

/**
 * Issue #205: how the change ended. The change has already happened (or failed), so a record that
 * cannot be stepped forward never fails the command: it warns, and the record stays applying, which
 * agentx admin changes shows, rather than claiming an outcome nobody recorded.
 */
async function finishRecording(services: ConfigServices, entry: ConfigKey, recording: Recording | undefined, outcome: ConfigChangeOutcomeRequest): Promise<void> {
  if (recording === undefined) return;
  try {
    await recordConfigOutcome({ ...recording.session, changeId: recording.changeId, traceId: recording.traceId, outcome }, services.fetch ?? fetch);
  } catch {
    services.write(outcome.outcome === "applied"
      ? `Warning: ${entry.key} changed, but AgentX could not record that it applied, so agentx admin changes shows change ${recording.changeId} as applying.`
      : `Warning: AgentX could not record that the ${entry.key} change failed, so agentx admin changes shows change ${recording.changeId} as applying.`);
  }
}

export async function runConfigSet(services: ConfigServices, env: string, input: { key: string; value?: string; valueSource?: SecretSource; yes: boolean }): Promise<{ changed: boolean }> {
  const entry = configKey(input.key);
  const { target } = entry;
  if (target.kind === "control-plane-setting") return setLimitsThroughChange(services, env, entry, target, input);
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
  const session = await recordingSession(services, env, entry, STACK_SIGN_IN_MS, input.yes);
  if (role !== undefined) await checkModel(services, env, settings, role, value);
  const roleArn = settings.access?.cloudFormationRoleArn;
  if (roleArn === undefined) throw agentXError("CONFIG_INVALID", `environment ${env}'s settings name no CloudFormation role; run agentx env use --env ${env}, or agentx init --resume`);
  const holder = (await services.identity.get()).arn;
  return withEnvironmentLock({ store: services.store, env, holder, command: `config set ${entry.key}`, now: services.now }, async () => {
    const stackName = environmentStackName(env, target.part);
    // Issue #205: recorded after the yes, before the change set runs; a failed record runs nothing.
    let recording: Recording | undefined;
    let unrecorded: Error | undefined;
    let result: { changed: boolean };
    try {
      result = await updateStackParameters({
        cloudFormation: services.cloudFormation, stackName, roleArn, changes: { [target.parameter]: value }, label: "config",
        confirm: async ({ parameters, changes }) => {
          for (const change of parameters) services.write(`${entry.key}: ${change.name} ${change.from} -> ${change.to} on ${stackName}`);
          for (const change of changes) services.write(`  ${change.action} ${change.logicalId} (${change.type})${change.replacement === "True" ? " [replacement]" : ""}`);
          const requestedAt = input.yes ? undefined : iso(services.now());
          if (!(input.yes || await services.prompter.confirm(`Apply this change to ${stackName}?`, { defaultValue: false }))) return false;
          const parameter = parameters.find((change) => change.name === target.parameter);
          try {
            recording = await startRecording(services, env, session, entry, STACK_SIGN_IN_MS, { before: parameter?.from ?? "", after: parameter?.to ?? value }, requestedAt);
          } catch (error) {
            unrecorded = error instanceof Error ? error : agentXError("RUNTIME_UNAVAILABLE", `${entry.key} was not changed; nothing changed, try again`);
            return false;
          }
          return true;
        },
        write: services.write, now: services.now, sleep: services.sleep, ...(services.pollMs === undefined ? {} : { pollMs: services.pollMs }),
      });
    } catch (error) {
      if (unrecorded !== undefined) throw unrecorded;
      // Only a stack that ended (rolled back, or gone) is a failure for certain. A deadline, a
      // throttled poll or a lost answer may still be applying: the record is left applying.
      if (error instanceof AgentXError && error.code === "CONFIG_INVALID") await finishRecording(services, entry, recording, failureOf(entry, error));
      else if (recording !== undefined) services.write(`Warning: the ${entry.key} change may still be applying, so agentx admin changes shows change ${recording.changeId} as applying; check ${stackName} in the CloudFormation console.`);
      throw error;
    }
    // After a yes, updateStackParameters either changed the stack or threw.
    if (result.changed) await finishRecording(services, entry, recording, { outcome: "applied" });
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

/**
 * Spec 025 FR-053, E17: the workspace limits change through the admin change path, with its audit.
 * The control plane plans the change (keeping the other limit as it is) and says who is at or over
 * the new one; the person typing the command confirms it (the cli method), or --yes does.
 */
async function setLimitsThroughChange(
  services: ConfigServices, env: string, entry: ConfigKey,
  target: Extract<ConfigKey["target"], { kind: "control-plane-setting" }>, input: { value?: string; yes: boolean },
): Promise<{ changed: boolean }> {
  if (input.value === undefined) throw agentXError("CONFIG_INVALID", `give the new value: agentx config set ${entry.key} <value>`);
  const value = Number(entry.parse(input.value));
  const settings = await readEnvironmentSettings(services.store, env);
  // D14: the legacy deployment has no admin change routes: adopted (settings naming legacy), or not
  // yet adopted (production with no settings record).
  if (settings === undefined ? env === LEGACY_ENV : settings.naming !== "environment") {
    throw agentXError("CONFIG_INVALID", `${entry.key} changes through AgentX's admin change path, which only environments installed with agentx init have, not the legacy deployment; nothing changed. To change it there, update the AgentXControlPlane stack parameter ${target.installDefault.parameter}`);
  }
  if (settings === undefined) throw notInstalled(env);
  const session = await services.adminSession?.(env);
  if (session === undefined) throw agentXError("AUTH_REQUIRED", `${entry.key} changes through AgentX's admin change path, which needs this computer's admin sign-in; run agentx --env ${env} login --admin, then try again`);
  // SC-005: checked before anything is planned.
  if (!input.yes && services.canAsk === false) {
    throw agentXError("CONFIRMATION_UNAVAILABLE", `${entry.key} needs a yes: run the command in a terminal to answer its prompt, or pass --yes; nothing changed`);
  }
  // With a prompt, the effect is shown once, in the question; with --yes it is printed as runCliChange writes it.
  let held: string | undefined;
  let first = true;
  const flush = () => { if (held !== undefined) services.write(held); held = undefined; };
  let result: Awaited<ReturnType<typeof runCliChange>>;
  try {
    result = await runCliChange({
      controlPlaneUrl: session.controlPlaneUrl, accessToken: session.accessToken, cliVersion: CLI_VERSION,
      change: { kind: "set_workspace_limits", [target.field]: value },
      confirm: async (effect) => {
        if (input.yes) return true;
        if (held !== effect) flush();
        held = undefined;
        return services.prompter.confirm(`${effect}\nApply this change?`, { defaultValue: false });
      },
      write: (line) => {
        if (first && !input.yes) { first = false; held = line; return; }
        flush();
        services.write(line);
      },
    }, services.fetch ?? fetch);
  } finally {
    flush();
  }
  return { changed: result.outcome === "applied" };
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
  const entry = configKey("alerts.address");
  const session = await recordingSession(services, env, entry, ALERT_SIGN_IN_MS, input.yes);
  services.write(`alerts.address: ${(await recordedAlertAddress(services, env, settings)) ?? "none"} -> ${shown}`);
  const requestedAt = input.yes ? undefined : iso(services.now());
  if (!input.yes && !(await services.prompter.confirm("Apply this change?", { defaultValue: false }))) {
    throw agentXError("CONFIG_INVALID", "the alerts.address change was not applied; nothing changed");
  }
  const holder = (await services.identity.get()).arn;
  return withEnvironmentLock({ store: services.store, env, holder, command: "config set alerts.address", now: services.now }, async () => {
    // Issue #205: recorded under the lock, before anything changes; the record names the key only.
    const recording = await startRecording(services, env, session, entry, ALERT_SIGN_IN_MS, undefined, requestedAt);
    try {
      const result = await changeAlertAddress(services, env, settings, target, shown, secretName);
      await finishRecording(services, entry, recording, { outcome: "applied" });
      return result;
    } catch (error) {
      await finishRecording(services, entry, recording, failureOf(entry, error));
      throw error;
    }
  });
}

/** The alert address change itself, under the environment lock. */
async function changeAlertAddress(
  services: ConfigServices, env: string, settings: EnvironmentSettings,
  target: { kind: "email"; address: string } | { kind: "webhook"; endpoint: string; display: string }, shown: string, secretName: string,
): Promise<{ changed: boolean }> {
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

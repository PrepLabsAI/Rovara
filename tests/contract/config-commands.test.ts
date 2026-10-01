import { describe, expect, it } from "vitest";
import { runConfigGet, runConfigList, runConfigSet } from "../../packages/cli/src/config/commands.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings, settingsParameterName, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { installAnswersParameterName, readInstallAnswers, writeInstallAnswers } from "../../packages/cli/src/init/install-state.js";
import { memoryInitSecrets, passingChecks, sampleAnswers, scriptedPrompter, T0 } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { fakeAlerts, STAGING_SETTINGS } from "../support/setup-fakes.js";
import { ROLE, seeded, services, stacks } from "../support/config-services.js";

const ENV = "staging";
const WEBHOOK = "https://events.pagerduty.com/integration/SECRETkey0123456789/enqueue";
const OLD_WEBHOOK = "https://events.pagerduty.com/integration/OLDkey0123456789/enqueue";

/** A store whose next put of one parameter fails, once `failNext` is set, as SSM might after the stack has changed. */
class PutFailsOnce extends MemoryParameterStore {
  failNext = false;
  constructor(private readonly failing: string) { super(); }
  override async put(name: string, value: string, options: { createOnly?: boolean } = {}): Promise<void> {
    if (this.failNext && name === this.failing) {
      this.failNext = false;
      this.calls.push({ op: "put", name });
      throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    }
    return super.put(name, value, options);
  }
}

const lockOps = (store: MemoryParameterStore) => store.calls.filter((call) => call.name === lockParameterName(ENV)).map((call) => call.op);

describe("agentx config list and get", () => {
  it("lists every key with its value and where it lives", async () => {
    const rows = await runConfigList(services({ store: await seeded() }), ENV);
    expect(rows.find((row) => row.key === "limits.threadTurnsPerMinute")).toMatchObject({ value: "6", where: "stack parameter SlackThreadTurnsPerMinute on agentx-staging-control-plane" });
    expect(rows.find((row) => row.key === "models.orchestrator")?.value).toBe("us.anthropic.claude-sonnet-4-6");
    expect(rows.find((row) => row.key === "alerts.address")?.value).toBe("none");
    expect(rows.find((row) => row.key === "limits.workspacesPerMember")?.value).toBe("3 (install-time default; the control plane may hold a newer setting)");
    expect(rows).toHaveLength(12);
  });

  it("never shows the alert address itself, only that it is set", async () => {
    const store = await seeded();
    const current = (await readEnvironmentSettings(store, ENV))!;
    await writeEnvironmentSettings(store, { ...current, alertAddress: "ops@example.com" });
    const row = await runConfigGet(services({ store }), ENV, "alerts.address");
    expect(row.value).toBe("set (email address)");
    expect(JSON.stringify(await runConfigList(services({ store }), ENV))).not.toContain("ops@example.com");
  });

  it("shows the alert address as set from the install answers when the settings hold none (F17)", async () => {
    const email = await seeded();
    await writeInstallAnswers(email, sampleAnswers({ alert: { kind: "email", address: "ops@example.com" } }));
    expect((await runConfigGet(services({ store: email }), ENV, "alerts.address")).value).toBe("set (email address)");
    const webhook = await seeded();
    await writeInstallAnswers(webhook, sampleAnswers({ alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" } }));
    const row = await runConfigGet(services({ store: webhook }), ENV, "alerts.address");
    expect(row.value).toBe("set (webhook)");
    expect(row.value).not.toContain("pagerduty");
  });

  it("refuses an unknown key", async () => {
    await expect(runConfigGet(services({ store: await seeded() }), ENV, "nope")).rejects.toThrow("unknown config key nope");
  });

  it("refuses an environment that is not installed, and the legacy deployment", async () => {
    await expect(runConfigList(services({ store: new MemoryParameterStore() }), ENV)).rejects.toThrow("environment staging is not installed in this account and region");
    const legacy = new MemoryParameterStore();
    await writeEnvironmentSettings(legacy, { ...STAGING_SETTINGS, naming: "legacy" });
    await expect(runConfigList(services({ store: legacy }), ENV)).rejects.toThrow("agentx config works on environments installed with agentx init; staging uses the legacy stack names");
  });
});

describe("agentx config set", () => {
  it("refuses a held lock with the same next step as the other commands, even for its own killed run (final review M2)", async () => {
    const store = await seeded();
    const holder = "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice";
    store.values.set(lockParameterName(ENV), JSON.stringify({ holder, command: "config set limits.threadTurnsPerMinute", acquiredAt: new Date(T0).toISOString() }));
    await expect(runConfigSet(services({ store, now: () => T0 + 60_000 }), ENV, { key: "limits.threadTurnsPerMinute", value: "12", yes: true }))
      .rejects.toThrow(`locked by ${holder} running "config set limits.threadTurnsPerMinute" since ${new Date(T0).toISOString()}; wait for it to finish, then run the same agentx command again. If it is no longer running, agentx init, upgrade and destroy offer a takeover once the lock is 2 hours old, or delete it now (aws ssm delete-parameter --name ${lockParameterName(ENV)} --region <region>)`);
  });

  it("changes one stack parameter with a parameter-only update, keeping every other value, under the lock", async () => {
    const store = await seeded();
    const cloudFormation = fakeCloudFormation({ parameters: { SlackThreadTurnsPerMinute: "6", BudgetMonthlyUsd: "100", CallbackSigningKey: "****" } });
    const result = await runConfigSet(services({ store, cloudFormation }), ENV, { key: "limits.threadTurnsPerMinute", value: "12", yes: true });
    expect(result.changed).toBe(true);
    const create = cloudFormation.calls.find((call) => call.name === "CreateChangeSetCommand")!.input;
    expect(create.RoleARN).toBe(ROLE);
    expect(create.UsePreviousTemplate).toBe(true);
    expect(create.ChangeSetName).toMatch(/^agentx-config-\d+$/);
    expect(create.Parameters).toEqual(expect.arrayContaining([
      { ParameterKey: "SlackThreadTurnsPerMinute", ParameterValue: "12" },
      { ParameterKey: "CallbackSigningKey", UsePreviousValue: true },
    ]));
    expect(store.calls.filter((call) => call.name === lockParameterName(ENV)).map((call) => call.op)).toEqual(["put", "get", "delete"]);
  });

  it("changes nothing for an invalid value, before any AWS call", async () => {
    const cloudFormation = fakeCloudFormation();
    await expect(runConfigSet(services({ store: await seeded(), cloudFormation }), ENV, { key: "limits.threadTurnsPerMinute", value: "6.5", yes: true })).rejects.toThrow("must be a whole number from 1 to 60; nothing changed");
    expect(cloudFormation.calls).toEqual([]);
  });

  it("changes nothing when the stack parameter refuses a value the CLI accepted, and says why", async () => {
    const store = await seeded();
    const cloudFormation = fakeCloudFormation({ parameters: { BudgetMonthlyUsd: "100" }, changeSet: { status: "FAILED", reason: "Parameter BudgetMonthlyUsd failed to satisfy constraint" } });
    await expect(runConfigSet(services({ store, cloudFormation }), ENV, { key: "budget.monthlyUsd", value: "1000000", yes: true }))
      .rejects.toThrow("the change set for agentx-staging-control-plane failed: Parameter BudgetMonthlyUsd failed to satisfy constraint; nothing changed");
    expect(cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toEqual([]);
    expect(lockOps(store)).toEqual(["put", "get", "delete"]);
  });

  it("names config set, not an init flag, as the way to pick another model (live check L3)", async () => {
    const store = await seeded();
    const notFound = passingChecks({ converse: async () => { throw Object.assign(new Error("model not found"), { name: "ResourceNotFoundException" }); } });
    await expect(runConfigSet(services({ store, cloudFormation: fakeCloudFormation(), checks: () => notFound }), ENV, { key: "models.worker", value: "us.made-up-v1", yes: true }))
      .rejects.toThrow("us.made-up-v1 is not a Bedrock model id available in us-east-1; check the id, or choose another with agentx --env staging config set models.worker <another model id>; nothing changed");
    const denied = passingChecks({ converse: async () => { throw Object.assign(new Error("You don't have access to the model"), { name: "AccessDeniedException" }); } });
    const error = await runConfigSet(services({ store, cloudFormation: fakeCloudFormation(), checks: () => denied }), ENV, { key: "models.orchestrator", value: "us.anthropic.claude-opus-4-1", yes: true }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain("or choose another model with agentx --env staging config set models.orchestrator <another model id>; nothing changed");
    expect(error?.message).not.toContain("--orchestrator-model");
  });

  it("changes nothing when the model fails its one-token test call, and says why", async () => {
    const store = await seeded();
    const cloudFormation = fakeCloudFormation();
    const checks = passingChecks({ converse: async () => { throw Object.assign(new Error("You don't have access to the model"), { name: "AccessDeniedException" }); } });
    await expect(runConfigSet(services({ store, cloudFormation, checks: () => checks }), ENV, { key: "models.orchestrator", value: "us.anthropic.claude-opus-4-1", yes: true })).rejects.toThrow("nothing changed");
    expect(cloudFormation.calls.filter((call) => call.name === "CreateChangeSetCommand")).toEqual([]);
    expect((await readEnvironmentSettings(store, ENV))?.models.orchestrator).toBe(STAGING_SETTINGS.models.orchestrator);
  });

  it("updates the model's stack parameter and the settings when the model answers", async () => {
    const store = await seeded();
    const checks = passingChecks();
    await runConfigSet(services({ store, checks: () => checks, cloudFormation: fakeCloudFormation({ parameters: { ModelId: "amazon.nova-pro-v1:0" } }) }), ENV, { key: "models.worker", value: "amazon.nova-premier-v1:0", yes: true });
    expect(checks.models).toEqual(["amazon.nova-premier-v1:0"]);
    expect((await readEnvironmentSettings(store, ENV))?.models.worker).toBe("amazon.nova-premier-v1:0");
  });

  it("records a model change in the install answers, which upgrades rebuild ModelId from (F18)", async () => {
    const store = await seeded();
    await writeInstallAnswers(store, sampleAnswers());
    await runConfigSet(services({ store, cloudFormation: fakeCloudFormation({ parameters: { ModelId: "amazon.nova-pro-v1:0" } }) }), ENV, { key: "models.worker", value: "amazon.nova-premier-v1:0", yes: true });
    expect((await readInstallAnswers(store, ENV))?.models.worker).toBe("amazon.nova-premier-v1:0");
  });

  it("leaves the install answers alone for a non-model key, which upgrades keep from the stack (F18)", async () => {
    const store = await seeded();
    await writeInstallAnswers(store, sampleAnswers());
    const before = store.values.get(installAnswersParameterName(ENV));
    store.calls.length = 0;
    await runConfigSet(services({ store, cloudFormation: fakeCloudFormation({ parameters: { BudgetMonthlyUsd: "100" } }) }), ENV, { key: "budget.monthlyUsd", value: "250", yes: true });
    expect(store.values.get(installAnswersParameterName(ENV))).toBe(before);
    expect(store.calls.some((call) => call.op === "put" && call.name === installAnswersParameterName(ENV))).toBe(false);
  });

  it("says how to finish when the stack changed but the answers could not be written, and a rerun records it", async () => {
    const store = new PutFailsOnce(installAnswersParameterName(ENV));
    await writeEnvironmentSettings(store, { ...STAGING_SETTINGS, access: { artifactBucket: "b", cloudFormationRoleArn: ROLE, operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } });
    await writeInstallAnswers(store, sampleAnswers());
    store.failNext = true;
    store.calls.length = 0;
    const cloudFormation = fakeCloudFormation({ parameters: { ModelId: "amazon.nova-pro-v1:0" } });
    const error = await runConfigSet(services({ store, cloudFormation }), ENV, { key: "models.worker", value: "amazon.nova-premier-v1:0", yes: true }).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("stack agentx-staging-runtime now uses amazon.nova-premier-v1:0, but the install answers were not updated; run the same agentx config set again to record it");
    expect(((error as Error).cause as Error).message).toBe("Rate exceeded");
    expect(cloudFormation.parameters.ModelId).toBe("amazon.nova-premier-v1:0");
    expect((await readInstallAnswers(store, ENV))?.models.worker).toBe("amazon.nova-pro-v1:0");
    expect(lockOps(store)).toEqual(["put", "get", "delete"]);

    store.calls.length = 0;
    const rerunStack = fakeCloudFormation({ parameters: { ModelId: "amazon.nova-premier-v1:0" } });
    const rerun = services({ store, cloudFormation: rerunStack, stacks: stacks({ "agentx-staging-runtime": { ModelId: "amazon.nova-premier-v1:0" } }) });
    const result = await runConfigSet(rerun, ENV, { key: "models.worker", value: "amazon.nova-premier-v1:0", yes: true });
    expect(result.changed).toBe(true);
    expect(rerunStack.calls.filter((call) => call.name === "CreateChangeSetCommand")).toEqual([]);
    expect((await readInstallAnswers(store, ENV))?.models.worker).toBe("amazon.nova-premier-v1:0");
    expect((await readEnvironmentSettings(store, ENV))?.models.worker).toBe("amazon.nova-premier-v1:0");
    expect(lockOps(store)).toEqual(["put", "get", "delete"]);
  });

  it("names the settings when their write fails after the stack change, keeping the cause", async () => {
    const store = new PutFailsOnce(settingsParameterName(ENV));
    await writeEnvironmentSettings(store, { ...STAGING_SETTINGS, access: { artifactBucket: "b", cloudFormationRoleArn: ROLE, operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } });
    await writeInstallAnswers(store, sampleAnswers());
    store.failNext = true;
    const error = await runConfigSet(services({ store, cloudFormation: fakeCloudFormation({ parameters: { ModelId: "amazon.nova-pro-v1:0" } }) }), ENV, { key: "models.worker", value: "amazon.nova-premier-v1:0", yes: true }).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("stack agentx-staging-runtime now uses amazon.nova-premier-v1:0, but the settings were not updated; run the same agentx config set again to record it");
    expect(((error as Error).cause as Error).message).toBe("Rate exceeded");
    expect((await readInstallAnswers(store, ENV))?.models.worker).toBe("amazon.nova-pro-v1:0");
  });

  it("says nothing changed for a model already recorded everywhere, and takes no lock", async () => {
    const store = await seeded();
    await writeInstallAnswers(store, sampleAnswers());
    const result = await runConfigSet(services({ store }), ENV, { key: "models.worker", value: "amazon.nova-pro-v1:0", yes: true });
    expect(result.changed).toBe(false);
    expect(lockOps(store)).toEqual([]);
  });

  it("makes the model's test call in the environment's own region (F33)", async () => {
    const store = await seeded("eu-west-1");
    const regions: string[] = [];
    const checks = passingChecks();
    await runConfigSet(services({ store, checks: (region) => { regions.push(region); return checks; }, cloudFormation: fakeCloudFormation({ parameters: { ModelId: "amazon.nova-pro-v1:0" } }) }), ENV, { key: "models.worker", value: "amazon.nova-premier-v1:0", yes: true });
    expect(regions).toEqual(["eu-west-1"]);
    expect(checks.models).toEqual(["amazon.nova-premier-v1:0"]);
  });

  it("says nothing changed when the value is already set, and takes no lock", async () => {
    const store = await seeded();
    const result = await runConfigSet(services({ store, cloudFormation: fakeCloudFormation({ parameters: { SlackThreadTurnsPerMinute: "6" } }) }), ENV, { key: "limits.threadTurnsPerMinute", value: "6", yes: true });
    expect(result.changed).toBe(false);
    expect(store.calls.some((call) => call.name === lockParameterName(ENV))).toBe(false);
  });

  it("needs the admin sign-in for the workspace limits, which change through the admin change path (spec 025 phase 25e)", async () => {
    await expect(runConfigSet(services({ store: await seeded(), adminSession: async () => undefined }), ENV, { key: "limits.workspacesPerMember", value: "5", yes: true }))
      .rejects.toThrow(`limits.workspacesPerMember changes through AgentX's admin change path, which needs this computer's admin sign-in; run agentx --env ${ENV} login --admin, then try again`);
  });

  it("asks before applying without --yes, and applies nothing on no", async () => {
    const store = await seeded();
    const cloudFormation = fakeCloudFormation({ parameters: { SlowTurnMinutes: "5" } });
    await expect(runConfigSet(services({ store, cloudFormation, prompter: scriptedPrompter([false]) }), ENV, { key: "alerts.slowTurnMinutes", value: "9", yes: false }))
      .rejects.toThrow("the config change to agentx-staging-slack was not applied; nothing changed");
    expect(cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toEqual([]);
  });

  it("subscribes a new email alert address and records it, naming the old subscription an admin must remove", async () => {
    const store = await seeded();
    const alerts = fakeAlerts({ existing: [{ arn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:1", protocol: "email", endpoint: "old@example.com" }], confirmAfterPolls: 0 });
    const run = services({ store, alerts });
    await runConfigSet(run, ENV, { key: "alerts.address", value: "ops@example.com", yes: true });
    expect(alerts.subscribed).toEqual(["email ops@example.com"]);
    expect((await readEnvironmentSettings(store, ENV))?.alertAddress).toBe("ops@example.com");
    expect(run.lines.join("\n")).toContain("aws sns unsubscribe --subscription-arn arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:1 --region us-east-1");
  });

  it("shows the alert address change and asks before applying without --yes, and applies nothing on no (F15)", async () => {
    const store = await seeded();
    const alerts = fakeAlerts({ confirmAfterPolls: 0 });
    const prompter = scriptedPrompter([false]);
    const run = services({ store, alerts, prompter });
    await expect(runConfigSet(run, ENV, { key: "alerts.address", value: "ops@example.com", yes: false }))
      .rejects.toThrow("the alerts.address change was not applied; nothing changed");
    expect(run.lines).toContain("alerts.address: none -> ops@example.com");
    expect(prompter.asked).toHaveLength(1);
    expect(alerts.subscribed).toEqual([]);
    expect(store.calls.some((call) => call.name === lockParameterName(ENV))).toBe(false);
    expect((await readEnvironmentSettings(store, ENV))?.alertAddress).toBeUndefined();
  });

  it("says an alert address that is already set needs no change, without the lock or any write", async () => {
    const store = await seeded();
    const current = (await readEnvironmentSettings(store, ENV))!;
    await writeEnvironmentSettings(store, { ...current, alertAddress: "ops@example.com" });
    store.calls.length = 0;
    const alerts = fakeAlerts({ confirmAfterPolls: 0 });
    const run = services({ store, alerts });
    expect(await runConfigSet(run, ENV, { key: "alerts.address", value: "OPS@example.com", yes: true })).toEqual({ changed: false });
    expect(run.lines).toContain("alerts.address is already set; nothing to change");
    expect(alerts.subscribed).toEqual([]);
    expect(store.calls.filter((call) => call.op !== "get")).toEqual([]);
  });

  it("says a webhook that is already set needs no change, and never prints it", async () => {
    const store = await seeded();
    const current = (await readEnvironmentSettings(store, ENV))!;
    await writeEnvironmentSettings(store, { ...current, alertAddress: "https://events.pagerduty.com/..." });
    store.calls.length = 0;
    const secrets = memoryInitSecrets({ "agentx/staging/alert-endpoint": WEBHOOK });
    const alerts = fakeAlerts({ confirmAfterPolls: 0 });
    const run = services({ store, secrets, alerts, processEnv: { HOOK: WEBHOOK } });
    expect(await runConfigSet(run, ENV, { key: "alerts.address", valueSource: { envName: "HOOK" }, yes: true })).toEqual({ changed: false });
    expect(alerts.subscribed).toEqual([]);
    expect(store.calls.filter((call) => call.op !== "get")).toEqual([]);
    expect(run.lines.join("\n")).not.toContain("SECRETkey");
  });

  it("keeps the old webhook secret when subscribing the new one fails", async () => {
    const store = await seeded();
    const secrets = memoryInitSecrets({ "agentx/staging/alert-endpoint": OLD_WEBHOOK });
    const alerts = { ...fakeAlerts({ confirmAfterPolls: 0 }), subscribe: async () => { throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }); } };
    const run = services({ store, secrets, alerts, processEnv: { HOOK: WEBHOOK } });
    await expect(runConfigSet(run, ENV, { key: "alerts.address", valueSource: { envName: "HOOK" }, yes: true })).rejects.toThrow("Rate exceeded");
    expect(secrets.values.get("agentx/staging/alert-endpoint")).toBe(OLD_WEBHOOK);
    expect((await readEnvironmentSettings(store, ENV))?.alertAddress).toBeUndefined();
    expect(lockOps(store)).toEqual(["put", "get", "delete"]);
  });

  it("reads a webhook alert address only from a file or variable, stores it as a secret and never prints it", async () => {
    const store = await seeded();
    const secrets = memoryInitSecrets();
    const alerts = fakeAlerts({ confirmAfterPolls: 0 });
    const run = services({ store, secrets, alerts, processEnv: { HOOK: WEBHOOK } });
    await runConfigSet(run, ENV, { key: "alerts.address", valueSource: { envName: "HOOK" }, yes: true });
    expect(secrets.values.get("agentx/staging/alert-endpoint")).toBe(WEBHOOK);
    expect(alerts.subscribed).toEqual([`https ${WEBHOOK}`]);
    expect((await readEnvironmentSettings(store, ENV))?.alertAddress).toBe("https://events.pagerduty.com/...");
    expect(run.lines.join("\n")).not.toContain("SECRETkey");
    expect([...store.values.values()].join("\n")).not.toContain("SECRETkey");
  });

  it("refuses a webhook typed on the command line (FR-020)", async () => {
    await expect(runConfigSet(services({ store: await seeded() }), ENV, { key: "alerts.address", value: WEBHOOK, yes: true }))
      .rejects.toThrow("a webhook alert address is a secret; pass it with --value-file <path> or --value-env <NAME>, never on the command line");
  });
});

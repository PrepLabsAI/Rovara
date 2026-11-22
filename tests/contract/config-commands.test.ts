import { describe, expect, it } from "vitest";
import { runConfigGet, runConfigList, runConfigSet } from "../../packages/cli/src/config/commands.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { installAnswersParameterName, readInstallAnswers, writeInstallAnswers } from "../../packages/cli/src/init/install-state.js";
import { memoryInitSecrets, passingChecks, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";
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

  it("says how to finish when the stack changed but the answers could not be written, and a rerun records it", async () => {
    const store = new PutFailsOnce(installAnswersParameterName(ENV));
    await writeEnvironmentSettings(store, { ...STAGING_SETTINGS, access: { artifactBucket: "b", cloudFormationRoleArn: ROLE, operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } });
    await writeInstallAnswers(store, sampleAnswers());
    store.failNext = true;
    store.calls.length = 0;
    const cloudFormation = fakeCloudFormation({ parameters: { ModelId: "us.anthropic.claude-sonnet-4-6" } });
    const error = await runConfigSet(services({ store, cloudFormation }), ENV, { key: "models.worker", value: "zai.glm-4.7", yes: true }).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("stack agentx-staging-runtime now uses zai.glm-4.7, but the install answers were not updated; run the same agentx config set again to record it");
    expect(((error as Error).cause as Error).message).toBe("Rate exceeded");
    expect(cloudFormation.parameters.ModelId).toBe("zai.glm-4.7");
    expect((await readInstallAnswers(store, ENV))?.models.worker).toBe("us.anthropic.claude-sonnet-4-6");
    expect(lockOps(store)).toEqual(["put", "get", "delete"]);

    store.calls.length = 0;
    const rerunStack = fakeCloudFormation({ parameters: { ModelId: "zai.glm-4.7" } });
    const rerun = services({ store, cloudFormation: rerunStack, stacks: stacks({ "agentx-staging-runtime": { ModelId: "zai.glm-4.7" } }) });
    const result = await runConfigSet(rerun, ENV, { key: "models.worker", value: "zai.glm-4.7", yes: true });
    expect(result.changed).toBe(true);
    expect(rerunStack.calls.filter((call) => call.name === "CreateChangeSetCommand")).toEqual([]);
    expect((await readInstallAnswers(store, ENV))?.models.worker).toBe("zai.glm-4.7");
    expect((await readEnvironmentSettings(store, ENV))?.models.worker).toBe("zai.glm-4.7");
    expect(lockOps(store)).toEqual(["put", "get", "delete"]);
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

  it("refuses a webhook typed on the command line (FR-020)", async () => {
    await expect(runConfigSet(services({ store: await seeded() }), ENV, { key: "alerts.address", value: WEBHOOK, yes: true }))
      .rejects.toThrow("a webhook alert address is a secret; pass it with --value-file <path> or --value-env <NAME>, never on the command line");
  });
});


it("refuses later gateway activation before any change when the broker cannot sign run-price ceilings", async () => {
  const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: "" } });
  await expect(runConfigSet(services({ store: await seeded(), cloudFormation }), ENV, { key: "coreEngine.modelGatewayUrl", value: "https://gateway.example", yes: true })).rejects.toThrow("price-serving broker");
  expect(cloudFormation.calls).toEqual([]);
});

it.each([false, true])("checks the gateway on later config activation after broker qualification (ready=%s)", async ready => {
  const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: "" } });
  const svc = services({ store: await seeded(), cloudFormation, stacks: { describe: async () => ({ status: "UPDATE_COMPLETE", outputs: { ModelRunPriceVersion: "1" }, parameters: { CoreModelGatewayHost: "" } }) } });
  const recorder = svc.fetch!;
  svc.fetch = async (input, init) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).endsWith("/healthz") ? Response.json(ready ? { ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 7 } } : { ok: true }) : recorder(input, init);
  const change = runConfigSet(svc, ENV, { key: "coreEngine.modelGatewayUrl", value: "https://gateway.example", yes: true });
  if (ready) { expect(await change).toEqual({ changed: true }); expect(cloudFormation.calls.length).toBeGreaterThan(0); }
  else { await expect(change).rejects.toThrow("gateway must serve run prices"); expect(cloudFormation.calls).toEqual([]); }
});

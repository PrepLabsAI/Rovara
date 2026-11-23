import { installGatewayFixture } from "../support/install-gateway.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetTemplateCommand } from "@aws-sdk/client-cloudformation";
import type { ChangeSetChange, DeployRequest, StackDeployer } from "../../packages/cli/src/deploy/deployer.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { DoctorReport } from "../../packages/cli/src/doctor/checks.js";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { writeSlackTeamId } from "../../packages/cli/src/signin/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { prepareDeployment } from "../../packages/cli/src/deploy/commands.js";
import { accessChanged, runUpgrade, type UpgradeDependencies } from "../../packages/cli/src/upgrade/run.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeGitHubApi, fakeRelease, memoryInitSecrets, scriptedDeployer, T0, TEST_PRIVATE_KEY } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

installGatewayFixture();

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
/** A bundle path in a fresh temporary directory, removed after each test. */
async function bundleDir(prefix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(parent);
  return join(parent, "bundle");
}

const ADMIN = "arn:aws:sts::123456789012:assumed-role/Admin/alice";
const OPERATOR = "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice";
const ACCESS_TEMPLATE = JSON.stringify({ Resources: { ArtifactBucket: { Type: "AWS::S3::Bucket" } } });
const CHANGED_ACCESS_TEMPLATE = JSON.stringify({ Resources: { ArtifactBucket: { Type: "AWS::S3::Bucket" }, NewRole: { Type: "AWS::IAM::Role" } } });
const CALLBACK_KEY = "k".repeat(43);
const INSTALLED = {
  ...SETTINGS, version: "1.2.3",
  access: { artifactBucket: "agentx-staging-access-artifactbucket-abc", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" },
};

function release(version = "1.3.0", declared: string[] = ["CoreModelGatewayHost", "CoreAgentModel", "BudgetMonthlyUsd", "BudgetScope", "SlackThreadTurnsPerMinute"], accessTemplate = ACCESS_TEMPLATE): LoadedRelease {
  return { ...fakeRelease(version), template: (part) => (part === "access" ? accessTemplate : JSON.stringify({ Outputs: { ModelRunPriceVersion: { Value: "1" } }, Parameters: Object.fromEntries([...new Set([...declared, "CoreModelGatewayHost", "CoreAgentModel"])].map((name) => [name, {}])) })) };
}

/** The templates engine's contract, faked: it asks request.confirm, and declines the way the engine does. */
function upgradeStackOutputs() {
  const outputs = allStackOutputs();
  outputs["agentx-staging-control-plane"] = { ...outputs["agentx-staging-control-plane"], ModelRunPriceVersion: "1" };
  return outputs;
}

function confirmingDeployer(changes: Record<string, ChangeSetChange[]> = {}): StackDeployer & { deployed: string[]; requests: DeployRequest[] } {
  const outputs = upgradeStackOutputs();
  const inner = scriptedDeployer(outputs, Object.keys(outputs));
  return {
    get deployed() { return inner.requests.map((request) => request.stackName); },
    get requests() { return inner.requests; },
    async deploy(request) {
      if (request.confirm !== undefined && !(await request.confirm({ stackName: request.stackName, changes: changes[request.stackName] ?? [] }))) {
        throw new Error(`deploy of ${request.stackName} not executed; confirmation declined`);
      }
      return inner.deploy(request);
    },
    outputs: (name) => inner.outputs(name),
  };
}

const healthy: DoctorReport = { env: "staging", region: "us-east-1", version: "1.3.0", engine: "templates", checks: [], failed: 0, warned: 0, passed: 25 };

const GITHUB_APP_SECRET = "agentx/staging/github-app";
const HAND_SET_WEBHOOK_SECRET = "hand-set-webhook-secret-".padEnd(40, "h");
const GITHUB_WEBHOOK_URL = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/github/webhooks";

async function harness(overrides: Partial<UpgradeDependencies> & { caller?: string; deployer?: StackDeployer; changes?: Record<string, ChangeSetChange[]>; controlPlane?: Record<string, string>; github?: Parameters<typeof fakeGitHubApi>[0]; githubSecret?: string | null } = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, INSTALLED);
  const deployer = overrides.deployer ?? confirmingDeployer(overrides.changes);
  const lines: string[] = [];
  const doctorRuns: string[] = [];
  const prepared: string[] = [];
  const github = fakeGitHubApi(overrides.github);
  const githubSecrets = memoryInitSecrets(overrides.githubSecret === null ? {} : { [GITHUB_APP_SECRET]: overrides.githubSecret ?? JSON.stringify({ appId: "123", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY, webhookSecret: HAND_SET_WEBHOOK_SECRET }) });
  const controlPlane = { CoreModelGatewayHost: "gateway.example", CoreAgentModel: "claude-sonnet-4-6", ...(overrides.controlPlane ?? { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****" }) };
  const deps: UpgradeDependencies = {
    store,
    stacks: { describe: async (name): Promise<StackDescription | undefined> => ({ status: "UPDATE_COMPLETE", outputs: upgradeStackOutputs()[name] ?? {}, parameters: name === "agentx-staging-control-plane" ? controlPlane : {} }) },
    cloudFormation: { async send(command: unknown) { if (command instanceof GetTemplateCommand) return { TemplateBody: ACCESS_TEMPLATE }; throw new Error("unexpected"); } },
    identity: { get: async () => ({ account: "123456789012", arn: overrides.caller ?? ADMIN }) },
    loadRelease: async () => release(),
    sourceRelease: async () => { throw new Error("test setup: no source release expected"); },
    notes: async () => ({ text: "Fixes.", url: "https://example.test" }),
    prepare: async (input) => {
      prepared.push(input.settings.env);
      return { deployer, store, secrets: memoryInitSecrets({ "agentx/staging/callback-signing-key": CALLBACK_KEY }), holder: overrides.caller ?? ADMIN, partition: "aws", cleanup: async () => undefined };
    },
    cdkDiff: async (request) => `Stack ${request.stackName}\nThere were no differences`,
    ask: async () => "y",
    isInteractive: () => true,
    githubWebhook: () => ({ secrets: githubSecrets, github }),
    doctor: async (env) => { doctorRuns.push(env); return healthy; },
    write: (line) => lines.push(line),
    now: () => T0,
    cliVersion: "1.3.0",
    ...overrides,
  };
  return { deps, store, lines, doctorRuns, prepared, github, githubSecrets, deployer: deployer as ReturnType<typeof confirmingDeployer> };
}

const options = { env: "staging", yes: true, allowReplace: [] as string[] };

describe("agentx upgrade (FR-042 to FR-044)", () => {
  it("upgrades a source-only CDK release using its selected synthesized broker", async () => {
    const h = await harness({ cliVersion: undefined });
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    h.deps.sourceRelease = async () => ({ ...release(), template: () => { throw new Error("source has no published templates"); } });
    const inner = confirmingDeployer();
    const qualifyBroker = vi.fn(async () => undefined);
    const prepare = h.deps.prepare.bind(h.deps);
    h.deps.prepare = async (input) => ({ ...await prepare(input),
      declaredParameters: () => new Set(["CoreModelGatewayHost", "CoreAgentModel", "BudgetMonthlyUsd", "BudgetScope"]),
      deployer: { ...inner, qualifyBroker },
    });
    await runUpgrade({ ...options, source: "/selected-source" }, h.deps);
    // deployEnvironment qualifies before the lock and again under it.
    expect(qualifyBroker).toHaveBeenCalledTimes(2);
    expect(inner.requests.map((request) => request.part)).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
  });

  it("rejects the selected CDK broker before gateway, secret or stack writes even when published templates qualify", async () => {
    const h = await harness({ cliVersion: undefined, sourceRelease: async () => release() });
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    const inner = confirmingDeployer();
    const qualifyBroker = vi.fn(async () => { throw new Error("selected synthesized broker does not serve run prices"); });
    const secrets = memoryInitSecrets();
    const create = vi.spyOn(secrets, "create");
    const put = vi.spyOn(secrets, "put");
    const transport = vi.fn(async () => Response.json({ runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 1 } }));
    vi.stubGlobal("fetch", transport);
    const prepare = h.deps.prepare.bind(h.deps);
    h.deps.prepare = async (input) => ({ ...await prepare(input), secrets, deployer: {
      qualifyBroker,
      outputs: (name) => inner.outputs(name),
      deploy: async (request) => {
        if (request.part === "control-plane") await qualifyBroker();
        return inner.deploy(request);
      },
    } });
    await expect(runUpgrade({ ...options, source: "/selected-source" }, h.deps)).rejects.toThrow("selected synthesized broker does not serve run prices");
    expect(inner.requests).toEqual([]);
    expect(qualifyBroker).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
  });

  it.each(["old-broker", "unsigned-gateway", "unavailable-gateway", "ready"] as const)("upgrades with unchanged core model settings (%s)", async (state) => {
    const coreSettings = {
      CoreTaskCapUsd: "500",
      CoreCompanyDayCapUsd: "800",
      CorePolicyHook: `{"address":"https://hook.example/answer","jwks":"https://hook.example/jwks.json","thumbprints":["${"a".repeat(43)}"]}`,
      CoreLessons: "on:org_aaaaaaaaaaaaaaaaaaaa",
      // Core switch-on blocker (2026-11-17): the model gateway settings an overlay used to carry, now kept like the rest.
      CoreModelGatewayHost: "gateway.staging.example.dev",
      CoreAgentModel: "claude-sonnet-4-6",
      // L4-AM (DEC 254zzn(2)): the hosted answers model is kept across an upgrade too.
      CoreAnswersModel: "claude-haiku-5-5",
      // DEC 254zzz58: the hosted lessons learning model is kept across an upgrade too.
      CoreLearningModel: "claude-haiku-5-5",
    };
    const outputs = upgradeStackOutputs();
    if (state === "old-broker") delete outputs["agentx-staging-control-plane"]!.ModelRunPriceVersion;
    const deployer = scriptedDeployer(outputs, Object.keys(outputs));
    const deploy = deployer.deploy.bind(deployer);
    deployer.deploy = async (request) => ({ ...await deploy(request), ...(request.part === "control-plane" ? { ModelRunPriceVersion: "1" } : {}) });
    const h = await harness({ deployer, controlPlane: { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****", ...coreSettings }, loadRelease: async () => release("1.3.0", ["BudgetMonthlyUsd", ...Object.keys(coreSettings)]) });
    const transport = vi.fn(async () => {
      if (state === "unavailable-gateway") throw new Error("gateway unavailable");
      return Response.json({ runPrice: { version: 1, snapshotVersion: 1, ...(state === "ready" || state === "old-broker" ? { admissionVersion: 1 } : {}) } });
    });
    vi.stubGlobal("fetch", transport);
    if (state === "unsigned-gateway" || state === "unavailable-gateway") {
      await expect(runUpgrade(options, h.deps)).rejects.toThrow("gateway must serve run prices");
      expect(h.deployer.requests).toEqual([]);
      return;
    }
    await runUpgrade(options, h.deps);
    expect(transport).toHaveBeenCalled();
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
    const deployed = h.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")?.parameters;
    for (const [name, value] of Object.entries(coreSettings)) expect(deployed?.[name], name).toBe(value);
  });

  it("shows the notes, deploys in upgrade order, records the new version, keeps the budget and runs doctor", async () => {
    const h = await harness();
    const result = await runUpgrade(options, h.deps);
    expect(h.lines).toContain("Upgrading staging from 1.2.3 to 1.3.0 (templates engine)");
    expect(h.lines).toContain("Release notes for 1.3.0:\n  Fixes.");
    expect(h.deployer.deployed).toEqual(["agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-control-plane", "agentx-staging-runtime", "agentx-staging-slack"]);
    // Ruling F7: the operator's budget survives the upgrade.
    expect(h.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")?.parameters.BudgetMonthlyUsd).toBe("250");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
    expect(h.doctorRuns).toEqual(["staging"]);
    expect(result).toMatchObject({ from: "1.2.3", to: "1.3.0", doctor: { failed: 0 } });
  });

  describe("the GitHub webhook", () => {

    it("tells the owner which events to tick and where", async () => {
      const h = await harness({ github: { hookUrl: GITHUB_WEBHOOK_URL, events: ["pull_request"] } });
      await runUpgrade(options, h.deps);
      expect(h.lines).toContain("GitHub webhook: tick these events on https://github.com/organizations/acme/settings/apps/agentx-acme-staging/permissions: pull_request_review, pull_request_review_comment, pull_request_review_thread, issue_comment, check_suite, check_run");
    });

    it("never prints the webhook secret, stored or generated", async () => {
      const kept = await harness();
      await runUpgrade(options, kept.deps);
      expect(kept.lines.join("\n")).not.toContain(HAND_SET_WEBHOOK_SECRET);

      const generated = await harness({ githubSecret: JSON.stringify({ appId: "123", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
      const result = await runUpgrade(options, generated.deps);
      const stored = JSON.parse(generated.githubSecrets.values.get(GITHUB_APP_SECRET)!) as { webhookSecret: string };
      expect(stored.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(generated.lines.join("\n")).not.toContain(stored.webhookSecret);
      expect(JSON.stringify(result)).not.toContain(stored.webhookSecret);
    });

    // Webhook lane W3: the owner's dedicated secret. Once it has a value, `agentx upgrade` must never put the App secret's old key (or anything) into GitHub's hook, nor store a new key.
    it("never overwrites GitHub's copy of the owner's dedicated webhook secret: the hook gets its URL only, and nothing is stored", async () => {
      const OWNER_SET = "owner-set-dedicated-secret-".padEnd(48, "d");
      const stale = await harness({ github: { hookUrl: "https://old.example.test/hook", events: [] } });
      stale.githubSecrets.values.set("agentx/staging/github-webhook-secret", OWNER_SET);
      const before = stale.githubSecrets.values.get(GITHUB_APP_SECRET);
      await runUpgrade(options, stale.deps);
      expect(stale.github.hookWrites).toEqual([{ url: GITHUB_WEBHOOK_URL }]);
      expect(JSON.stringify(stale.github.hookWrites)).not.toContain(HAND_SET_WEBHOOK_SECRET);
      expect(JSON.stringify(stale.github.hookWrites)).not.toContain(OWNER_SET);
      expect(stale.githubSecrets.values.get(GITHUB_APP_SECRET)).toBe(before);
      expect(stale.lines.join("\n")).not.toContain(OWNER_SET);
      // A secret that has the old key, and a hook already pointing here: no write to GitHub at all.
      const right = await harness({ github: { hookUrl: GITHUB_WEBHOOK_URL } });
      right.githubSecrets.values.set("agentx/staging/github-webhook-secret", OWNER_SET);
      await runUpgrade(options, right.deps);
      expect(right.github.hookWrites).toEqual([]);
      // Without a value in the dedicated secret, the old behaviour stands: the App secret's key is sent.
      const old = await harness({ github: { hookUrl: GITHUB_WEBHOOK_URL } });
      await runUpgrade(options, old.deps);
      expect(old.github.hookWrites).toEqual([{ url: GITHUB_WEBHOOK_URL, secret: HAND_SET_WEBHOOK_SECRET }]);
    });

    it("does not print the secret when storing it fails", async () => {
      const h = await harness({ githubSecret: JSON.stringify({ appId: "123", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
      let written = "";
      h.githubSecrets.put = async (_name, value) => { written = value; throw Object.assign(new Error(`access denied for ${value}`), { name: "AccessDeniedException" }); };
      await runUpgrade(options, h.deps);
      const generated = (JSON.parse(written) as { webhookSecret: string }).webhookSecret;
      expect(h.lines.some((line) => line.startsWith("GitHub webhook: could not be set up") && line.includes("AccessDeniedException"))).toBe(true);
      expect(h.lines.join("\n")).not.toContain(generated);
      expect(h.lines.join("\n")).not.toContain("PRIVATE KEY");
    });

    it("skips an environment that has no GitHub App yet", async () => {
      const h = await harness({ githubSecret: null });
      await runUpgrade(options, h.deps);
      expect(h.lines.some((line) => line.startsWith("GitHub webhook: skipped"))).toBe(true);
      expect(h.github.hookWrites).toEqual([]);
    });
  });

  it("keeps a stale lock when the takeover is declined, deploying nothing", async () => {
    const h = await harness({ ask: async () => "n" });
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "upgrade", acquiredAt: new Date(T0 - 3 * 60 * 60 * 1000).toISOString() }));
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("older than 2 hours");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("never takes over its own lock without a terminal to ask at", async () => {
    const h = await harness({ isInteractive: () => false });
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "upgrade", acquiredAt: new Date(T0).toISOString() }));
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("your own earlier \"upgrade\"");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("allows the same release, so a re-run finishes an upgrade that stopped (question 3)", async () => {
    const h = await harness({ loadRelease: async () => release("1.2.3") });
    await runUpgrade(options, h.deps);
    expect(h.lines).toContain("Environment staging already runs 1.2.3; checking that every stack is on it");
    expect(h.deployer.deployed).toHaveLength(6);
  });

  it("needs a version when this agentx was built from source", async () => {
    const h = await harness({ cliVersion: undefined });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("this agentx was built from source, so it has no release of its own; pass --to <version> or --release <dir>");
  });

  it("refuses --to that does not match the release directory", async () => {
    const h = await harness();
    await expect(runUpgrade({ ...options, to: "1.4.0", releaseDir: "/releases/1.3.0" }, h.deps)).rejects.toThrow("--release holds release 1.3.0, not 1.4.0");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("refuses the legacy deployment and an environment that is not installed", async () => {
    const h = await harness();
    await writeEnvironmentSettings(h.store, { ...INSTALLED, naming: "legacy" });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("agentx upgrade works on environments installed with agentx init; staging uses the legacy stack names");
    await expect(runUpgrade({ ...options, env: "other" }, h.deps)).rejects.toThrow("environment other is not installed in this account and region");
  });

  it("stops when the operator declines a stack's changes, naming how to continue", async () => {
    const h = await harness({ ask: async () => "n" });
    await expect(runUpgrade({ ...options, yes: false }, h.deps)).rejects.toThrow("upgrade stopped before agentx-staging-access: nothing in it changed");
    expect(h.doctorRuns).toEqual([]);
  });

  it("lists a config key the new release drops, before deploying", async () => {
    const h = await harness({ loadRelease: async () => release("1.3.0", ["BudgetScope"]) });
    await runUpgrade(options, h.deps);
    const warning = h.lines.findIndex((line) => line === "config key budget.monthlyUsd (250) is not in release 1.3.0, so the upgrade drops it; nothing replaces it");
    const firstDeploy = h.lines.findIndex((line) => line.startsWith("deployed "));
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(firstDeploy);
  });

  it("fails when doctor finds a problem after the upgrade (FR-044)", async () => {
    const h = await harness({ doctor: async () => ({ ...healthy, failed: 2 }) });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("upgraded staging to 1.3.0, but 2 doctor checks failed; fix what each one names, then run agentx doctor again");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
    expect(h.deployer.deployed).toHaveLength(6);
  });

  it("says the upgrade finished when doctor itself cannot run", async () => {
    const h = await harness({ doctor: async () => { throw new Error("connect ETIMEDOUT 140.82.112.3:443"); } });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("upgraded staging to 1.3.0, but doctor could not run: connect ETIMEDOUT 140.82.112.3:443; run agentx doctor");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
  });

  it("puts no secret in a refusal", async () => {
    const refusals: string[] = [];
    const changes = { "agentx-staging-control-plane": [{ action: "Modify", logicalId: "State", type: "AWS::DynamoDB::Table", replacement: "True" }] };
    for (const h of [
      await harness({ changes }),
      await harness({ caller: OPERATOR, loadRelease: async () => release("1.3.0", [], CHANGED_ACCESS_TEMPLATE) }),
      await harness({ doctor: async () => ({ ...healthy, failed: 1 }) }),
    ]) {
      const error = await runUpgrade(options, h.deps).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      refusals.push((error as Error).message, ...h.lines);
    }
    for (const text of refusals) expect(text).not.toContain(CALLBACK_KEY);
  });

  it("needs --yes when stdin is not a terminal", async () => {
    const h = await harness({ isInteractive: () => false });
    await expect(runUpgrade({ ...options, yes: false }, h.deps)).rejects.toThrow("agentx upgrade needs --yes when stdin is not a terminal");
  });

  it("with --export under the operator role, carries a changed access stack instead of refusing (question 9)", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    const h = await harness({ caller: OPERATOR, isInteractive: () => false, loadRelease: async () => release("1.3.0", [], CHANGED_ACCESS_TEMPLATE) });
    const result = await runUpgrade({ ...options, yes: false, exportDir: out }, h.deps);
    expect(result.parts[0]).toBe("access");
    expect(await readFile(join(out, "README.md"), "utf8")).toContain("create-change-set --stack-name agentx-staging-access ");
  });

  it("applies the same sign-in values as agentx upgrade when SSM and the stack disagree (ruling F29)", async () => {
    const declared = ["BudgetMonthlyUsd", "SlackTeamId", "DeveloperSignInSlack"];
    const controlPlane = { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****", SlackTeamId: "T0OLD", DeveloperSignInSlack: "enabled" };
    const upgraded = await harness({ controlPlane, loadRelease: async () => release("1.3.0", declared) });
    await writeSlackTeamId(upgraded.store, "staging", "T0NEW");
    await runUpgrade(options, upgraded.deps);
    const sent = upgraded.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")!.parameters;

    const out = await bundleDir("agentx-upgrade-run-export-");
    const exported = await harness({ controlPlane, loadRelease: async () => release("1.3.0", declared) });
    await writeSlackTeamId(exported.store, "staging", "T0NEW");
    await runUpgrade({ ...options, exportDir: out }, exported.deps);
    const file = JSON.parse(await readFile(join(out, "parameters", "control-plane.json"), "utf8")) as Array<{ ParameterKey: string; ParameterValue?: string }>;
    const written = Object.fromEntries(file.map((entry) => [entry.ParameterKey, entry.ParameterValue]));

    expect({ SlackTeamId: sent.SlackTeamId, DeveloperSignInSlack: sent.DeveloperSignInSlack }).toEqual({ SlackTeamId: "T0NEW", DeveloperSignInSlack: "disabled" });
    expect({ SlackTeamId: written.SlackTeamId, DeveloperSignInSlack: written.DeveloperSignInSlack }).toEqual({ SlackTeamId: sent.SlackTeamId, DeveloperSignInSlack: sent.DeveloperSignInSlack });
  });

});

describe("agentx upgrade with the cdk engine", () => {
  const cdk = async (overrides: Parameters<typeof harness>[0] = {}) => {
    const h = await harness(overrides);
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    return h;
  };

  it("reviews each stack's cdk diff before deploying it", async () => {
    const h = await cdk({ cdkDiff: async (request) => (request.part === "control-plane" ? "Stack agentx-staging-control-plane\nResources\n[-] AWS::S3::Bucket Artifacts Artifacts9F8E7D destroy" : `Stack ${request.stackName}\nThere were no differences`) });
    await expect(runUpgrade({ ...options, source: "/src" }, h.deps)).rejects.toThrow("upgrade stopped: agentx-staging-control-plane would delete Artifacts9F8E7D (AWS::S3::Bucket)");
    expect(h.deployer.deployed).not.toContain("agentx-staging-runtime");
    expect(h.deployer.deployed).not.toContain("agentx-staging-control-plane");
  });

  it("upgrades every stack with admin credentials and runs doctor, which must pass (ruling F4)", async () => {
    const h = await cdk();
    const result = await runUpgrade({ ...options, source: "/src" }, h.deps);
    expect(h.deployer.deployed).toEqual(["agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-control-plane", "agentx-staging-runtime", "agentx-staging-slack"]);
    expect(h.doctorRuns).toEqual(["staging"]);
    expect(result.doctor).toEqual({ failed: 0, warned: 0 });
  });

  it("refuses a --to that is not the source's tag before anything deploys, through the real prepare (review M9)", async () => {
    const h = await cdk({ cliVersion: undefined, loadRelease: async () => release("1.3.0") });
    const tagged = { async run(_command: string, args: string[]) { return { stdout: args[0] === "tag" ? "v1.4.0\n" : "" }; } };
    h.deps.prepare = (input) => prepareDeployment({
      engine: "cdk", env: "staging", region: "us-east-1", account: "123456789012", identityMode: "cognito", release: input.release, source: "/src",
      deps: { identity: h.deps.identity, store: h.store, secrets: memoryInitSecrets({}), commandRunner: tagged }, stderr: { write: () => undefined },
    });
    await expect(runUpgrade({ ...options, source: "/src", to: "1.3.0" }, h.deps)).rejects.toThrow("the cdk engine must run from a checkout of tag v1.3.0; /src is at v1.4.0");
    expect(h.deployer.deployed).toEqual([]);
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
  });

  it("reports the config keys the synth drops, not the ones the release's templates drop (issue 152)", async () => {
    // The release's template declares the thread limit; the synth of the source no longer does.
    const h = await cdk({
      controlPlane: { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", SlackThreadTurnsPerMinute: "12", CallbackSigningKey: "****" },
      loadRelease: async () => release("1.3.0", ["BudgetScope", "SlackThreadTurnsPerMinute"]),
    });
    const prepare = h.deps.prepare.bind(h.deps);
    h.deps.prepare = async (input) => ({ ...(await prepare(input)), declaredParameters: (part) => new Set(part === "control-plane" ? ["BudgetMonthlyUsd", "CoreModelGatewayHost", "CoreAgentModel"] : []) });
    await runUpgrade({ ...options, source: "/src" }, h.deps);
    // Exactly the synth's drop: the budget, which the release's template does not declare, is kept.
    expect(h.lines.filter((line) => line.startsWith("config key"))).toEqual(["config key limits.threadTurnsPerMinute (12) is not in release 1.3.0, so the upgrade drops it; nothing replaces it"]);
    expect(h.lines).toContain("kept agentx-staging-control-plane: BudgetMonthlyUsd, CoreModelGatewayHost, CoreAgentModel; not in this release, so not sent: SlackThreadTurnsPerMinute");
    const controlPlane = h.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")!;
    expect(controlPlane.parameters.BudgetMonthlyUsd).toBe("250");
    expect(controlPlane.parameters).not.toHaveProperty("SlackThreadTurnsPerMinute");
  });

  it("needs --source", async () => {
    const h = await cdk();
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("the cdk engine upgrades from a checkout of the target release's tag; pass --source <dir>");
  });

  it("refuses the operator role up front, naming admin credentials (ruling F20)", async () => {
    const h = await cdk({ caller: OPERATOR });
    await expect(runUpgrade({ ...options, source: "/src" }, h.deps)).rejects.toThrow("a cdk environment upgrades with admin credentials (the operator role cannot use CDK's bootstrap resources)");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("refuses --export (ruling F19)", async () => {
    const h = await cdk();
    await expect(runUpgrade({ ...options, exportDir: "/tmp/bundle" }, h.deps)).rejects.toThrow("upgrade --export writes the published templates; a cdk environment upgrades with --source");
    expect(h.deployer.deployed).toEqual([]);
  });
});

/** The command's own writer (stderr) replaces the harness's line collector. */
function withoutWrite(deps: UpgradeDependencies): Partial<UpgradeDependencies> {
  const copy: Partial<UpgradeDependencies> = { ...deps };
  delete copy.write;
  return copy;
}

describe("the agentx upgrade command", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } };
  }

  it("with --export, says where the bundle is and who it is for", async () => {
    const out = await bundleDir("agentx-upgrade-cli-export-");
    const h = await harness();
    const io = capture();
    const code = await executeCli(["--env", "staging", "upgrade", "--export", out], { ...io, upgrade: withoutWrite(h.deps) });
    expect(code).toBe(0);
    expect(io.out.join("")).toBe(`Wrote the upgrade of staging to 1.3.0 to ${out}; give it to your platform team.\n`);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("passes --to, --release and --allow-replace through, and prints JSON with --json", async () => {
    const loaded: Array<{ releaseDir?: string; version?: string }> = [];
    const changes = { "agentx-staging-control-plane": [{ action: "Modify", logicalId: "State", type: "AWS::DynamoDB::Table", replacement: "True" }] };
    const h = await harness({ changes, loadRelease: async (input) => { loaded.push(input); return release(); } });
    const io = capture();
    const rest = withoutWrite(h.deps);
    const code = await executeCli(["--env", "staging", "--json", "upgrade", "--yes", "--release", "/releases/1.3.0", "--to", "1.3.0", "--allow-replace", "State"], { ...io, upgrade: rest });
    expect(code).toBe(0);
    expect(loaded).toEqual([{ releaseDir: "/releases/1.3.0" }]);
    expect(h.deployer.deployed).toContain("agentx-staging-control-plane");
    expect(JSON.parse(io.out.join(""))).toMatchObject({ ok: true, data: { env: "staging", from: "1.2.3", to: "1.3.0" } });
  });

  it("passes --source and the image flags to the source release of a source-built CLI's cdk upgrade (issue 152)", async () => {
    const built: Array<{ source: string; images?: { worker?: string; slack?: string } }> = [];
    const h = await harness({ cliVersion: undefined, sourceRelease: async (input) => { built.push(input); return release(); } });
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    const io = capture();
    const slack = `123456789012.dkr.ecr.us-east-1.amazonaws.com/s@sha256:${"e".repeat(64)}`;
    const code = await executeCli(["--env", "staging", "upgrade", "--yes", "--source", "/src", "--slack-image", slack], { ...io, upgrade: withoutWrite(h.deps) });
    expect(io.err.join("")).not.toContain("AgentX error");
    expect(code).toBe(0);
    expect(built).toEqual([{ source: "/src", images: { slack } }]);
  });
});

describe("accessChanged (question 9)", () => {
  const input = (templateBody: string | undefined) => ({
    cloudFormation: { send: async () => (templateBody === undefined ? {} : { TemplateBody: templateBody }) },
    stackName: "agentx-staging-access", release: release(), region: "us-east-1", env: "staging",
  });

  it("is true when GetTemplate returns no body", async () => {
    expect(await accessChanged(input(undefined))).toBe(true);
  });

  it("is true when the deployed template is not JSON", async () => {
    expect(await accessChanged(input("Resources:\n  ArtifactBucket:\n    Type: AWS::S3::Bucket\n"))).toBe(true);
  });
});

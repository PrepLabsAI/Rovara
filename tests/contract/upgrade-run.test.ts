import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { agentXError } from "@agentx/contracts";
import { accessChanged, runUpgrade, type UpgradeDependencies } from "../../packages/cli/src/upgrade/run.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeRelease, memoryInitSecrets, scriptedDeployer, T0 } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
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

function release(version = "1.3.0", declared: string[] = ["BudgetMonthlyUsd", "BudgetScope", "SlackThreadTurnsPerMinute"], accessTemplate = ACCESS_TEMPLATE): LoadedRelease {
  return { ...fakeRelease(version), template: (part) => (part === "access" ? accessTemplate : JSON.stringify({ Parameters: Object.fromEntries(declared.map((name) => [name, {}])) })) };
}

/** The templates engine's contract, faked: it asks request.confirm, and declines the way the engine does. */
function confirmingDeployer(changes: Record<string, ChangeSetChange[]> = {}): StackDeployer & { deployed: string[]; requests: DeployRequest[] } {
  const inner = scriptedDeployer(allStackOutputs(), Object.keys(allStackOutputs()));
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

async function harness(overrides: Partial<UpgradeDependencies> & { caller?: string; deployer?: StackDeployer; changes?: Record<string, ChangeSetChange[]>; controlPlane?: Record<string, string> } = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, INSTALLED);
  const deployer = overrides.deployer ?? confirmingDeployer(overrides.changes);
  const lines: string[] = [];
  const doctorRuns: string[] = [];
  const prepared: string[] = [];
  const controlPlane = overrides.controlPlane ?? { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****" };
  const deps: UpgradeDependencies = {
    store,
    stacks: { describe: async (name): Promise<StackDescription | undefined> => ({ status: "UPDATE_COMPLETE", outputs: allStackOutputs()[name] ?? {}, parameters: name === "agentx-staging-control-plane" ? controlPlane : {} }) },
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
    doctor: async (env) => { doctorRuns.push(env); return healthy; },
    write: (line) => lines.push(line),
    now: () => T0,
    cliVersion: "1.3.0",
    ...overrides,
  };
  return { deps, store, lines, doctorRuns, prepared, deployer: deployer as ReturnType<typeof confirmingDeployer> };
}

const options = { env: "staging", yes: true, allowReplace: [] as string[] };

describe("agentx upgrade (FR-042 to FR-044)", () => {
  it("shows the notes, deploys in upgrade order, records the new version, keeps the budget and runs doctor", async () => {
    const h = await harness();
    const result = await runUpgrade(options, h.deps);
    expect(h.lines).toContain("Upgrading staging from 1.2.3 to 1.3.0 (templates engine)");
    expect(h.lines).toContain("Release notes for 1.3.0:\n  Fixes.");
    expect(h.deployer.deployed).toEqual(["agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-runtime", "agentx-staging-control-plane", "agentx-staging-slack"]);
    // Ruling F7: the operator's budget survives the upgrade.
    expect(h.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")?.parameters.BudgetMonthlyUsd).toBe("250");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
    expect(h.doctorRuns).toEqual(["staging"]);
    expect(result).toMatchObject({ from: "1.2.3", to: "1.3.0", doctor: { failed: 0 } });
  });

  it("never prints the callback signing key", async () => {
    const h = await harness();
    const result = await runUpgrade(options, h.deps);
    expect(h.lines.join("\n")).not.toContain(CALLBACK_KEY);
    expect(JSON.stringify(result)).not.toContain(CALLBACK_KEY);
  });

  it("refuses an older release before anything else happens", async () => {
    const h = await harness({ loadRelease: async () => release("1.1.0") });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.1.0 is older than 1.2.3");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("re-checks the version under the environment lock, so a concurrent upgrade is never undone (question 3)", async () => {
    const h = await harness();
    h.deps.loadRelease = async () => {
      // Another upgrade finishes while this one loads its release.
      await writeEnvironmentSettings(h.store, { ...INSTALLED, version: "1.4.0" });
      return release("1.3.0");
    };
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.3.0 is older than 1.4.0");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("holds the environment lock while it deploys, and releases it after", async () => {
    const h = await harness();
    const holders: Array<string | undefined> = [];
    const prepare = h.deps.prepare.bind(h.deps);
    h.deps.prepare = async (input) => {
      holders.push(h.store.values.get(lockParameterName("staging")));
      return prepare(input);
    };
    await runUpgrade(options, h.deps);
    expect(holders).toHaveLength(1);
    expect(JSON.parse(holders[0] ?? "{}")).toMatchObject({ holder: ADMIN, command: "upgrade" });
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("refuses while another command holds the environment lock, deploying nothing", async () => {
    const h = await harness();
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: "arn:aws:sts::123456789012:assumed-role/Admin/bob", command: "config set", acquiredAt: new Date(T0).toISOString() }));
    await expect(runUpgrade(options, h.deps)).rejects.toThrow(`locked by arn:aws:sts::123456789012:assumed-role/Admin/bob running "config set" since ${new Date(T0).toISOString()}; wait for it to finish, then run the same agentx command again`);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("offers to take over a stale lock a killed upgrade left, and upgrades once confirmed", async () => {
    const asked: string[] = [];
    const h = await harness({ ask: async (prompt) => { asked.push(prompt); return "y"; } });
    const stale = new Date(T0 - 3 * 60 * 60 * 1000).toISOString();
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "upgrade", acquiredAt: stale }));
    await runUpgrade(options, h.deps);
    expect(asked[0]).toBe(`Environment staging is locked by ${ADMIN} running "upgrade" since ${stale}. Take the lock over? Say yes only if that command is no longer running. [y/N] `);
    expect(h.deployer.deployed).toHaveLength(6);
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("keeps a stale lock when the takeover is declined, deploying nothing", async () => {
    const h = await harness({ ask: async () => "n" });
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "upgrade", acquiredAt: new Date(T0 - 3 * 60 * 60 * 1000).toISOString() }));
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("older than 2 hours");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("offers the same caller its own cut-off upgrade's lock at once, and upgrades once confirmed", async () => {
    const asked: string[] = [];
    const h = await harness({ ask: async (prompt) => { asked.push(prompt); return "y"; } });
    const fresh = new Date(T0).toISOString();
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "upgrade", acquiredAt: fresh }));
    await runUpgrade(options, h.deps);
    expect(asked[0]).toBe(`Environment staging is locked by ${ADMIN} running "upgrade" since ${fresh}. Take the lock over? Say yes only if that command is no longer running. [y/N] `);
    expect(h.deployer.deployed).toHaveLength(6);
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("still refuses a fresh upgrade lock another caller holds, asking nothing", async () => {
    const asked: string[] = [];
    const h = await harness({ ask: async (prompt) => { asked.push(prompt); return "y"; } });
    const bob = "arn:aws:sts::123456789012:assumed-role/Admin/bob";
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: bob, command: "upgrade", acquiredAt: new Date(T0).toISOString() }));
    await expect(runUpgrade(options, h.deps)).rejects.toThrow(`locked by ${bob} running "upgrade"`);
    expect(asked).toEqual([]);
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

  it("refuses a prerelease target right after loading it, deploying nothing (ruling F31)", async () => {
    const h = await harness({ loadRelease: async () => release("1.3.0-rc.1") });
    await expect(runUpgrade({ ...options, releaseDir: "/releases/rc" }, h.deps)).rejects.toThrow("release 1.3.0-rc.1 is a prerelease");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
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

  it("under the operator role, skips an unchanged access stack", async () => {
    const h = await harness({ caller: OPERATOR });
    await runUpgrade(options, h.deps);
    expect(h.deployer.deployed[0]).toBe("agentx-staging-foundation");
  });

  it("under the operator role, stops before deploying when the release changes the access stack (question 9)", async () => {
    const h = await harness({ caller: OPERATOR, loadRelease: async () => release("1.3.0", [], CHANGED_ACCESS_TEMPLATE) });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.3.0 changes the access stack, which only admin credentials can deploy");
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("agentx --env staging upgrade --export <dir>");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("with admin credentials, deploys a changed access stack first without comparing it (question 9)", async () => {
    const sent: unknown[] = [];
    const h = await harness({ loadRelease: async () => release("1.3.0", ["BudgetMonthlyUsd"], CHANGED_ACCESS_TEMPLATE), cloudFormation: { send: async (command) => { sent.push(command); throw new Error("unexpected"); } } });
    await runUpgrade(options, h.deps);
    expect(h.deployer.deployed[0]).toBe("agentx-staging-access");
    expect(sent).toEqual([]);
  });

  it("stops on a data replacement under --yes, deleting nothing, and continues with --allow-replace", async () => {
    const changes = { "agentx-staging-control-plane": [{ action: "Modify", logicalId: "State", type: "AWS::DynamoDB::Table", replacement: "True" }] };
    const stopped = await harness({ changes });
    await expect(runUpgrade(options, stopped.deps)).rejects.toThrow("upgrade stopped: agentx-staging-control-plane would replace State (AWS::DynamoDB::Table)");
    expect(stopped.deployer.deployed).not.toContain("agentx-staging-control-plane");
    const allowed = await harness({ changes });
    await runUpgrade({ ...options, allowReplace: ["State"] }, allowed.deps);
    expect(allowed.deployer.deployed).toContain("agentx-staging-control-plane");
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

  it("keeps a release's own refusal for a region it does not cover", async () => {
    const uncovered: LoadedRelease = { ...release(), template: (part) => { if (part === "access") throw agentXError("CONFIG_INVALID", "release 1.3.0 does not cover region us-east-1; use a region it lists"); return "{}"; } };
    const h = await harness({ caller: OPERATOR, loadRelease: async () => uncovered });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.3.0 does not cover region us-east-1; use a region it lists");
    expect(h.deployer.deployed).toEqual([]);
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

  it("with --export, writes the bundle and deploys nothing", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    const h = await harness();
    const result = await runUpgrade({ ...options, exportDir: out }, h.deps);
    expect(result.exported).toBe(out);
    expect(h.deployer.deployed).toEqual([]);
    expect(h.prepared).toEqual([]);
    expect(h.doctorRuns).toEqual([]);
    // No AWS write: the settings keep the old version, and no lock is taken.
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
    expect(await readdir(out)).toEqual(expect.arrayContaining(["README.md", "parameters", "templates", "packages"]));
    expect(h.lines).toContain("Writing the upgrade of staging from 1.2.3 to 1.3.0 (templates engine) to a bundle");
  });

  it("with --export under the operator role, carries a changed access stack instead of refusing (question 9)", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    const h = await harness({ caller: OPERATOR, isInteractive: () => false, loadRelease: async () => release("1.3.0", [], CHANGED_ACCESS_TEMPLATE) });
    const result = await runUpgrade({ ...options, yes: false, exportDir: out }, h.deps);
    expect(result.parts[0]).toBe("access");
    expect(await readFile(join(out, "README.md"), "utf8")).toContain("create-change-set --stack-name agentx-staging-access ");
  });

  it("with --export, leaves out an unchanged access stack", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    const h = await harness();
    const result = await runUpgrade({ ...options, exportDir: out }, h.deps);
    expect(result.parts).not.toContain("access");
    expect(await readFile(join(out, "README.md"), "utf8")).not.toContain("--stack-name agentx-staging-access ");
  });

  it("with --export, describes each stack once", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    const h = await harness();
    const described: string[] = [];
    const stacks = h.deps.stacks;
    h.deps.stacks = { describe: async (name) => { described.push(name); return stacks.describe(name); } };
    await runUpgrade({ ...options, exportDir: out }, h.deps);
    expect(described.length).toBeGreaterThan(0);
    expect(new Set(described).size).toBe(described.length);
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

  it("with --export, still refuses an older release and a prerelease", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    await expect(runUpgrade({ ...options, exportDir: out }, (await harness({ loadRelease: async () => release("1.1.0") })).deps)).rejects.toThrow("release 1.1.0 is older than 1.2.3");
    await expect(runUpgrade({ ...options, exportDir: out }, (await harness({ loadRelease: async () => release("1.3.0-rc.1") })).deps)).rejects.toThrow("release 1.3.0-rc.1 is a prerelease");
    expect(await readdir(dirname(out))).toEqual([]);
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
    expect(h.deployer.deployed).toContain("agentx-staging-runtime");
    expect(h.deployer.deployed).not.toContain("agentx-staging-control-plane");
  });

  it("upgrades every stack with admin credentials and runs doctor, which must pass (ruling F4)", async () => {
    const h = await cdk();
    const result = await runUpgrade({ ...options, source: "/src" }, h.deps);
    expect(h.deployer.deployed).toEqual(["agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-runtime", "agentx-staging-control-plane", "agentx-staging-slack"]);
    expect(h.doctorRuns).toEqual(["staging"]);
    expect(result.doctor).toEqual({ failed: 0, warned: 0 });
  });

  // Issue 152 replaces live check L7's refusal: a source-built CLI takes the version from the tag.
  it("with a source-built CLI and no --release or --to, builds the release from --source: the tag's version", async () => {
    const built: Array<{ source: string; images?: { worker?: string; slack?: string } }> = [];
    const h = await cdk({
      cliVersion: undefined,
      loadRelease: async () => { throw new Error("test setup: no release directory or download expected"); },
      sourceRelease: async (input) => { built.push(input); return release("1.3.0"); },
    });
    const images = { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"d".repeat(64)}` };
    const result = await runUpgrade({ ...options, source: "/src", images }, h.deps);
    expect(built).toEqual([{ source: "/src", images }]);
    expect(result).toMatchObject({ from: "1.2.3", to: "1.3.0" });
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
  });

  it("with --to or --release, loads that release as before (prepare then checks it is the source's tag)", async () => {
    const loaded: Array<{ releaseDir?: string; version?: string }> = [];
    const h = await cdk({
      cliVersion: undefined,
      loadRelease: async (input) => { loaded.push(input); return release("1.3.0"); },
      sourceRelease: async () => { throw new Error("test setup: no source release expected"); },
    });
    await runUpgrade({ ...options, source: "/src", to: "1.3.0" }, h.deps);
    expect(loaded).toEqual([{ version: "1.3.0" }]);
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
    h.deps.prepare = async (input) => ({ ...(await prepare(input)), declaredParameters: (part) => new Set(part === "control-plane" ? ["BudgetMonthlyUsd"] : []) });
    await runUpgrade({ ...options, source: "/src" }, h.deps);
    // Exactly the synth's drop: the budget, which the release's template does not declare, is kept.
    expect(h.lines.filter((line) => line.startsWith("config key"))).toEqual(["config key limits.threadTurnsPerMinute (12) is not in release 1.3.0, so the upgrade drops it; nothing replaces it"]);
    expect(h.lines).toContain("kept agentx-staging-control-plane: BudgetMonthlyUsd; not in this release, so not sent: SlackThreadTurnsPerMinute");
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

  it("upgrades and says so, keeping progress on stderr", async () => {
    const h = await harness();
    const io = capture();
    const rest = withoutWrite(h.deps);
    const code = await executeCli(["--env", "staging", "upgrade", "--yes"], { ...io, upgrade: rest });
    expect(code).toBe(0);
    expect(io.out.join("")).toBe("Upgraded staging from 1.2.3 to 1.3.0.\n");
    expect(io.err.join("")).toContain("Upgrading staging from 1.2.3 to 1.3.0 (templates engine)");
    expect(io.out.join("") + io.err.join("")).not.toContain(CALLBACK_KEY);
  });

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

  it("is false for the same template written differently", async () => {
    expect(await accessChanged(input(JSON.stringify({ Resources: { ArtifactBucket: { Type: "AWS::S3::Bucket" } } }, null, 2)))).toBe(false);
  });

  it("is true when GetTemplate returns no body", async () => {
    expect(await accessChanged(input(undefined))).toBe(true);
  });

  it("is true when the deployed template is not JSON", async () => {
    expect(await accessChanged(input("Resources:\n  ArtifactBucket:\n    Type: AWS::S3::Bucket\n"))).toBe(true);
  });
});

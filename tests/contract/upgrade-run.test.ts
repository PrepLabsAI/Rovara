import { describe, expect, it } from "vitest";
import { GetTemplateCommand } from "@aws-sdk/client-cloudformation";
import type { ChangeSetChange, DeployRequest, StackDeployer } from "../../packages/cli/src/deploy/deployer.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { DoctorReport } from "../../packages/cli/src/doctor/checks.js";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { runUpgrade, type UpgradeDependencies } from "../../packages/cli/src/upgrade/run.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeRelease, memoryInitSecrets, scriptedDeployer, T0 } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

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
    notes: async () => ({ text: "Fixes.", url: "https://example.test" }),
    prepare: async (input) => {
      prepared.push(input.settings.env);
      return { deployer, store, secrets: memoryInitSecrets({ "agentx/staging/callback-signing-key": CALLBACK_KEY }), holder: overrides.caller ?? ADMIN, partition: "aws", cleanup: async () => undefined };
    },
    cdkDiff: async () => "",
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
  });

  it("needs --yes when stdin is not a terminal", async () => {
    const h = await harness({ isInteractive: () => false });
    await expect(runUpgrade({ ...options, yes: false }, h.deps)).rejects.toThrow("agentx upgrade needs --yes when stdin is not a terminal");
  });

  it("never deploys when --export is given", async () => {
    const h = await harness();
    await expect(runUpgrade({ ...options, exportDir: "/tmp/bundle" }, h.deps)).rejects.toThrow("upgrade --export");
    expect(h.deployer.deployed).toEqual([]);
  });
});

describe("agentx upgrade with the cdk engine", () => {
  const cdk = async (overrides: Parameters<typeof harness>[0] = {}) => {
    const h = await harness(overrides);
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    return h;
  };

  it("reviews each stack's cdk diff before deploying it", async () => {
    const h = await cdk({ cdkDiff: async (request) => (request.part === "control-plane" ? "Resources\n[-] AWS::S3::Bucket Artifacts Artifacts9F8E7D destroy" : "") });
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
});

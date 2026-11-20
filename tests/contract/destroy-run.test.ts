import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDefinition } from "@agentx/contracts";
import { inventoryParameterName } from "../../packages/cli/src/destroy/inventory.js";
import { runDestroy, type DestroyDependencies } from "../../packages/cli/src/destroy/run.js";
import { developerTokenKey, readDeveloperConfig, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { settingsParameterName, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { installAnswersParameterName, installProgressParameterName, writeInstallAnswers, writeInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { destroyProjectFiles } from "../../packages/cli/src/destroy/project-files.js";
import { fakeDestroyApi, installedAccount, PROGRESS, SETTINGS, type FakeAccount } from "../support/destroy-fakes.js";
import { sampleAnswers } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { memoryTokenStore } from "../support/setup-fakes.js";

const ADMIN = "arn:aws:sts::123456789012:assumed-role/Admin/alice";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function harness(input: { account?: FakeAccount; typed?: string[]; caller?: string; installed?: boolean; env?: string } = {}) {
  const env = input.env ?? "staging";
  const account = input.account ?? installedAccount(env);
  const store = new MemoryParameterStore();
  if (input.installed !== false) {
    await writeEnvironmentSettings(store, { ...SETTINGS, env, stacks: { access: `agentx-${env}-access`, foundation: `agentx-${env}-foundation`, identity: `agentx-${env}-identity`, runtime: `agentx-${env}-runtime`, "control-plane": `agentx-${env}-control-plane`, slack: `agentx-${env}-slack` } });
    await writeInstallAnswers(store, sampleAnswers({ env }));
    await writeInstallProgress(store, { ...PROGRESS, env, connectors: [{ type: "linear", ref: "linear" }] });
    store.values.set(`/agentx/${env}/worker/image`, "x");
  }
  // A sibling environment whose name extends this one: nothing of it may be touched.
  store.values.set(`/agentx/${env}-eu/settings`, "{}");
  const home = await mkdtemp(join(tmpdir(), "agentx-destroy-home-"));
  const configDir = join(home, ".agentx", "projects");
  dirs.push(home);
  await mkdir(join(home, ".agentx", "environments"), { recursive: true });
  await writeFile(environmentCachePath(home, env), "env: x\n");
  const binding = (lt: string) => ({ deploymentMode: "ec2-ebs", launchTemplateId: lt, subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaa1111bbbb2222c" }], volumeSizeGib: "20", volumeType: "gp3" }) as never;
  await writeProjectFile(configDir, { name: "payments", revision: 1 } as unknown as ProjectDefinition, { env, binding: binding("lt-0123456789abcdef0") });
  await writeProjectFile(configDir, { name: "eu-app", revision: 1 } as unknown as ProjectDefinition, { env: `${env}-eu`, binding: binding("lt-0fffffffffffffff0") });
  let time = 0;
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  const lines: string[] = [];
  const typed = [...(input.typed ?? [env])];
  const asked: string[] = [];
  const deps: DestroyDependencies = {
    store, api: fakeDestroyApi(account, clock), identity: { get: async () => ({ account: "123456789012", arn: input.caller ?? ADMIN }) },
    confirmLine: async (question) => { asked.push(question); return typed.shift() ?? ""; },
    write: (line) => lines.push(line), ...clock, home, projectFiles: (name) => destroyProjectFiles({ configDir, env: name, write: (line) => lines.push(line) }), tokenStore: memoryTokenStore(), region: "us-east-1",
    isInteractive: () => true,
  };
  return { deps, account, store, lines, asked, home, configDir, env };
}

describe("agentx destroy (FR-055, item 3)", () => {
  it("refuses a region other than the environment's, before asking or deleting anything", async () => {
    const h = await harness();
    await expect(runDestroy({ env: "staging", keepData: false }, { ...h.deps, region: "eu-west-1" })).rejects.toThrow("environment staging is installed in us-east-1, not eu-west-1; run agentx --env staging destroy --region us-east-1");
    expect(h.asked).toEqual([]);
    expect(h.account.calls).toEqual([]);
  });

  it("says which check a retained resource failed: the tag, or the name (review M4)", async () => {
    const account = installedAccount("staging");
    const access = account.stacks.get("agentx-staging-access")!;
    access.resources = [{ logicalId: "ArtifactBucket", type: "AWS::S3::Bucket", physicalId: "agentx-staging-foundation-artifactbucket-1a" }];
    account.tags.set("agentx-staging-foundation-artifactbucket-1a", { "agentx:env": "staging" });
    account.tags.set("key-3c", { "agentx:env": "staging-eu" });
    const h = await harness({ account });
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls.join("\n")).not.toContain("delete bucket agentx-staging-foundation-artifactbucket-1a");
    expect(result.leftInPlace).toEqual([
      "AWS::KMS::Key key-3c (it does not carry agentx:env=staging)",
      "AWS::S3::Bucket agentx-staging-foundation-artifactbucket-1a (its name does not match stack agentx-staging-access)",
    ]);
  });

  it("asks for the account id too for production, and for an environment AgentX has no record of", async () => {
    const production = await harness({ env: "production", typed: ["production", "123456789012"] });
    await runDestroy({ env: "production", keepData: false }, production.deps);
    expect(production.asked).toHaveLength(2);
    const unrecorded = await harness({ installed: false, typed: ["staging", "999999999999"] });
    await expect(runDestroy({ env: "staging", keepData: false }, unrecorded.deps)).rejects.toThrow("you typed 999999999999, not 123456789012; nothing was removed");
  });

  it("refuses the legacy deployment, the operator role, and credentials for another account", async () => {
    const legacy = await harness();
    await writeEnvironmentSettings(legacy.store, { ...SETTINGS, naming: "legacy" });
    await expect(runDestroy({ env: "staging", keepData: false }, legacy.deps)).rejects.toThrow("agentx destroy never removes the legacy deployment");
    const operator = await harness({ caller: "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice" });
    await expect(runDestroy({ env: "staging", keepData: false }, operator.deps)).rejects.toThrow("agentx destroy needs admin credentials");
    const other = await harness();
    other.deps.identity = { get: async () => ({ account: "999999999999", arn: ADMIN }) };
    await expect(runDestroy({ env: "staging", keepData: false }, other.deps)).rejects.toThrow("environment staging is installed in account 123456789012, but your AWS credentials are for 999999999999");
  });

  it("stops at a stack that cannot be deleted, keeps the inventory, and continues on the next run", async () => {
    const account = installedAccount();
    account.stacks.get("agentx-staging-foundation")!.failDeletes = 1;
    const first = await harness({ account });
    await expect(runDestroy({ env: "staging", keepData: false }, first.deps)).rejects.toThrow("stack agentx-staging-foundation could not be deleted");
    expect(first.store.values.has(settingsParameterName("staging"))).toBe(true);
    expect(first.store.values.has(inventoryParameterName("staging"))).toBe(true);
    expect(first.store.values.has(lockParameterName("staging"))).toBe(false);
    await expect(access(environmentCachePath(first.home, "staging"))).resolves.toBeUndefined();
    await expect(access(join(first.configDir, "payments.yaml"))).resolves.toBeUndefined();
    // The next run: control-plane and identity are gone, but their retained resources come from the saved inventory.
    first.deps.confirmLine = async () => "staging";
    await runDestroy({ env: "staging", keepData: false }, first.deps);
    expect(first.account.calls).toContain("delete table agentx-staging-control-plane-State-5e");
    expect(first.account.calls).toContain("delete user pool us-east-1_Pool4d (domain agentx-staging-123456789012)");
    expect(first.store.values.has(settingsParameterName("staging"))).toBe(false);
  });

  it("offers to take over its own lock after a closed terminal", async () => {
    const h = await harness({ typed: ["staging", "yes"] });
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "destroy", acquiredAt: new Date(0).toISOString() }));
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.asked[1]).toContain("Take the lock over?");
  });

  it("names each install record it could not read, and nothing of what it holds (final review M8)", async () => {
    const h = await harness();
    h.store.values.set(installAnswersParameterName("staging"), "{\"SECRETanswer\": ");
    h.store.values.set(installProgressParameterName("staging"), "[\"SECRETprogress\"]");
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.lines).toContain(`Could not read ${installAnswersParameterName("staging")}, so agentx destroy goes on without the install answers: it may ask for the account id, and the steps printed at the end name no GitHub App of this environment.`);
    expect(h.lines).toContain(`Could not read ${installProgressParameterName("staging")}, so agentx destroy goes on without the install progress: the steps printed at the end name no app of this environment.`);
    expect(h.lines.join("\n")).not.toContain("SECRET");
  });

  it("removes the environment's developer sign-in and moves the default to a remaining environment (#221)", async () => {
    const h = await harness();
    const entry = (name: string) => ({ url: `https://${name}.example.test`, issuer: `https://${name}.example.test/v1/auth`, tokenEndpoint: `https://${name}.example.test/v1/auth/token`, revocationEndpoint: `https://${name}.example.test/v1/auth/revoke` });
    await saveDeveloperEnvironment(h.home, "other", entry("other"));
    await saveDeveloperEnvironment(h.home, "staging", entry("staging"));
    const tokens = h.deps.tokenStore as ReturnType<typeof memoryTokenStore>;
    await tokens.set(developerTokenKey(entry("staging").issuer), { accessToken: "staging-developer", expiresAt: 1 });
    await tokens.set(developerTokenKey(entry("other").issuer), { accessToken: "other-developer", expiresAt: 1 });
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(result.removed).toBe(true);
    const config = await readDeveloperConfig(h.home);
    expect(Object.keys(config.environments)).toEqual(["other"]);
    expect(config.default).toBe("other");
    expect(tokens.values.has(developerTokenKey(entry("staging").issuer))).toBe(false);
    expect(tokens.values.has(developerTokenKey(entry("other").issuer))).toBe(true);
    expect(await access(environmentCachePath(h.home, "staging")).then(() => true, () => false)).toBe(false);
    expect(h.lines).toContain("Removed this computer's developer sign-in for staging; the default developer environment is now other.");
  });

  it("clears the default developer environment when the destroyed one was the only one (#221)", async () => {
    const h = await harness();
    await saveDeveloperEnvironment(h.home, "staging", { url: "https://staging.example.test", issuer: "https://staging.example.test/v1/auth", tokenEndpoint: "https://staging.example.test/v1/auth/token", revocationEndpoint: "https://staging.example.test/v1/auth/revoke" });
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(await readDeveloperConfig(h.home)).toEqual({ environments: {} });
    expect(h.lines).toContain("Removed this computer's developer sign-in for staging; no developer environment is the default now.");
  });

  it("refuses up front when the access stack is gone but a stack deployed through its role remains", async () => {
    const account = installedAccount();
    account.stacks.delete("agentx-staging-access");
    const h = await harness({ account });
    await expect(runDestroy({ env: "staging", keepData: false }, h.deps)).rejects.toThrow("stack agentx-staging-slack was deployed through the role arn:aws:iam::123456789012:role/agentx-staging-cloudformation, which the access stack held and which is gone");
    expect(h.account.calls).toEqual([]);
  });

  it("ruling F21: refuses the older production deployment by its stacks, before listing or asking anything", async () => {
    const account = installedAccount("production");
    account.stacks.set("AgentXControlPlane", { status: "UPDATE_COMPLETE", terminationProtection: false, outputs: {}, template: "{}", resources: [] });
    const h = await harness({ env: "production", account, installed: false, typed: ["production", "123456789012"] });
    await expect(runDestroy({ env: "production", keepData: false }, h.deps)).rejects.toThrow("agentx destroy never removes the legacy deployment");
    expect(h.account.calls).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.store.calls.filter((call) => call.op === "delete")).toEqual([]);
  });

  it("ruling F21: refuses when the settings cannot be read, naming the parameter, instead of treating them as absent", async () => {
    const h = await harness();
    h.store.values.set(settingsParameterName("staging"), "{not json");
    await expect(runDestroy({ env: "staging", keepData: false }, h.deps)).rejects.toThrow("/agentx/staging/settings");
    expect(h.account.calls).toEqual([]);
    expect(h.asked).toEqual([]);
  });

  it("ruling F3: --keep-data keeps the inventory, so a second run without it removes what was kept", async () => {
    const h = await harness();
    const first = await runDestroy({ env: "staging", keepData: true }, h.deps);
    expect(h.store.values.has(inventoryParameterName("staging"))).toBe(true);
    expect(first.manualSteps).toContain("Run agentx destroy again, without --keep-data, to remove what was kept.");
    h.deps.confirmLine = async (question) => (question.includes("account id") ? "123456789012" : "staging");
    const second = await runDestroy({ env: "staging", keepData: false }, h.deps);
    // Only the inventory was left: the settings delete that finds nothing is not counted.
    expect(second.parameters).toBe(1);
    expect(h.account.calls).toEqual(expect.arrayContaining([
      "delete table agentx-staging-control-plane-State-5e", "delete user pool us-east-1_Pool4d (domain agentx-staging-123456789012)", "schedule key key-3c",
      "delete secret agentx/staging/callback-signing-key",
    ]));
    expect(h.store.values.has(inventoryParameterName("staging"))).toBe(false);
  });

  it("ruling F32: names the ECR repositories under agentx-<env>/ as a manual step", async () => {
    // Live check L6: the step is printed only when the pull-through cache made a repository.
    const account = installedAccount();
    account.repositories = ["agentx-staging/ghcr/preplabsai/agentx-worker", "agentx-staging-eu/ghcr/preplabsai/agentx-worker", "other/repo"];
    const h = await harness({ account });
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(result.manualSteps.filter((step) => step.includes("ECR"))).toEqual([
      "Delete the ECR repositories under agentx-staging/ that the image pull-through cache created (agentx-staging/ghcr/preplabsai/agentx-worker): in the ECR console for us-east-1, Private registry, Repositories, filter by agentx-staging/ and delete each one (or aws ecr delete-repository --force --region us-east-1 --repository-name <name>).",
    ]);
  });

  it("lists the ECR repositories before deleting anything, and a failed listing keeps every manual step (re-review R1)", async () => {
    const account = installedAccount();
    account.repositoriesError = Object.assign(new Error("not authorized to perform: ecr:DescribeRepositories"), { name: "AccessDeniedException" });
    const h = await harness({ account });
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(result.removed).toBe(true);
    expect(h.account.repositoriesListedAfter).toBe(0);
    expect(result.manualSteps.some((step) => step.startsWith("Delete the GitHub App"))).toBe(true);
    expect(result.manualSteps.some((step) => step.startsWith("Delete the Slack app"))).toBe(true);
    expect(result.manualSteps.some((step) => step.startsWith("Revoke the Linear API key"))).toBe(true);
    expect(result.manualSteps.filter((step) => step.includes("ECR"))).toEqual([
      "Delete the ECR repositories under agentx-staging/ that the image pull-through cache created: in the ECR console for us-east-1, Private registry, Repositories, filter by agentx-staging/ and delete each one (or aws ecr delete-repository --force --region us-east-1 --repository-name <name>).",
    ]);
    expect(h.lines).toContain("Could not list the ECR repositories under agentx-staging/ (AccessDeniedException), so the step to delete them is printed at the end anyway.");
  });

  it("waits for a busy stack to finish, then deletes it", async () => {
    const account = installedAccount();
    Object.assign(account.stacks.get("agentx-staging-runtime")!, { status: "UPDATE_IN_PROGRESS", busyMinutes: 10, settledStatus: "UPDATE_ROLLBACK_COMPLETE" });
    const h = await harness({ account });
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.lines).toContain("Waiting for agentx-staging-runtime: it is UPDATE_IN_PROGRESS");
    expect(h.account.calls).toContain("delete stack agentx-staging-runtime");
  });

  it("deletes a REVIEW_IN_PROGRESS stack whose template cannot be read, as retaining nothing", async () => {
    const account = installedAccount();
    Object.assign(account.stacks.get("agentx-staging-slack")!, { status: "REVIEW_IN_PROGRESS", noTemplate: true });
    const h = await harness({ account });
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls[0]).toBe("delete stack agentx-staging-slack");
  });

});

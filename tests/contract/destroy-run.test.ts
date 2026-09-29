import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDefinition } from "@agentx/contracts";
import { inventoryParameterName } from "../../packages/cli/src/destroy/inventory.js";
import { runDestroy, type DestroyDependencies } from "../../packages/cli/src/destroy/run.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { settingsParameterName, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { installAnswersParameterName, installProgressParameterName, writeInstallAnswers, writeInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { awsDestroyApi } from "../../packages/cli/src/destroy/aws.js";
import { destroyProjectFiles } from "../../packages/cli/src/destroy/project-files.js";
import { fakeDestroyApi, forceDeletedSecretsClient, installedAccount, PROGRESS, SETTINGS, type FakeAccount } from "../support/destroy-fakes.js";
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

  it("removes everything in the documented order and deletes the settings last", async () => {
    const h = await harness();
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    const order = h.account.calls;
    const at = (text: string) => order.findIndex((call) => call === text);
    expect(order.slice(0, 5)).toEqual(["delete stack agentx-staging-slack", "protection off agentx-staging-runtime", "delete stack agentx-staging-runtime", "delete stack agentx-staging-control-plane", "terminate i-worker1"]);
    expect(at("delete volume vol-ws1")).toBeLessThan(at("protection off agentx-staging-identity"));
    expect(at("delete stack agentx-staging-identity")).toBeLessThan(at("delete stack agentx-staging-foundation"));
    expect(at("delete stack agentx-staging-foundation")).toBeLessThan(at("delete stack agentx-staging-access"));
    expect(at("delete stack agentx-staging-access")).toBeLessThan(at("delete bucket agentx-staging-access-artifactbucket-1a"));
    expect(order).toEqual(expect.arrayContaining([
      "delete table agentx-staging-control-plane-State-5e", "delete bucket agentx-staging-control-plane-slackthreadsessions-6f",
      "delete log group agentx-staging-foundation-VpcFlowLogs-2b", "delete user pool us-east-1_Pool4d (domain agentx-staging-123456789012)",
      "schedule key key-3c", "delete alias alias/agentx/staging/workspaces",
      "delete secret agentx/staging/callback-signing-key", "delete secret agentx/staging/github-app",
    ]));
    expect(h.store.values.has(settingsParameterName("staging"))).toBe(false);
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
    expect(h.store.values.has(inventoryParameterName("staging"))).toBe(false);
    expect(h.store.values.has("/agentx/staging/worker/image")).toBe(false);
    const settingsDelete = h.store.calls.filter((call) => call.op === "delete").map((call) => call.name);
    expect(settingsDelete.indexOf(settingsParameterName("staging"))).toBe(settingsDelete.length - 2); // then the lock
    expect(settingsDelete.indexOf(inventoryParameterName("staging"))).toBe(settingsDelete.length - 3); // just before the settings
    expect(result.manualSteps).toEqual(expect.arrayContaining([
      "Delete the GitHub App agentx-acme: open https://github.com/organizations/acme/settings/apps/agentx-acme/advanced and choose Delete GitHub App.",
      "Delete the Slack app: open https://api.slack.com/apps/A0APP/general and choose Delete App at the bottom of the page.",
    ]));
    expect(result.localFiles).toEqual(expect.arrayContaining([environmentCachePath(h.home, "staging"), join(h.configDir, "payments.yaml")]));
    expect(await readdir(h.configDir)).toEqual(["eu-app.yaml"]);
    expect(h.lines).toContain("Deleting agentx-staging-control-plane: this usually takes 20 to 40 minutes while its Lambda functions release their network interfaces.");
  });

  it("never touches a sibling environment, the legacy deployment's workers, or a retained resource with another tag", async () => {
    const account = installedAccount("staging");
    account.instances.push({ id: "i-legacy", state: "running", tags: { DeploymentMode: "ec2-ebs", Environment: "staging" } });
    account.secrets.push({ name: "agentx/staging-eu/slack", scheduled: false });
    account.aliases.push("alias/agentx/staging-eu/workspaces");
    account.tags.set("key-3c", { "agentx:env": "staging-eu" });
    const h = await harness({ account });
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls.join("\n")).not.toMatch(/staging-eu|i-legacy|schedule key key-3c/);
    expect(h.store.values.has("/agentx/staging-eu/settings")).toBe(true);
    expect(result.leftInPlace).toEqual(["AWS::KMS::Key key-3c (it does not carry agentx:env=staging)"]);
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

  it("changes nothing when the typed name is wrong", async () => {
    const h = await harness({ typed: ["stagin"] });
    await expect(runDestroy({ env: "staging", keepData: false }, h.deps)).rejects.toThrow("you typed stagin, not staging; nothing was removed");
    expect(h.account.calls).toEqual([]);
    expect(h.store.values.has(settingsParameterName("staging"))).toBe(true);
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

  it("with --keep-data, keeps the tables, buckets, secrets, user pool and KMS keys, and removes the rest", async () => {
    const h = await harness();
    const result = await runDestroy({ env: "staging", keepData: true }, h.deps);
    expect(h.account.calls.join("\n")).not.toMatch(/delete table|delete bucket|delete user pool|schedule key|delete secret|delete alias/);
    expect(h.account.calls).toContain("delete log group agentx-staging-foundation-VpcFlowLogs-2b");
    expect(h.store.values.has(settingsParameterName("staging"))).toBe(false);
    expect(result.kept).toEqual(expect.arrayContaining(["AWS::DynamoDB::Table agentx-staging-control-plane-State-5e", "AWS::Cognito::UserPool us-east-1_Pool4d"]));
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

  it("deletes a stack left in ROLLBACK_COMPLETE by a failed first install", async () => {
    const account = installedAccount();
    for (const name of [...account.stacks.keys()]) if (name !== "agentx-staging-access" && name !== "agentx-staging-identity") account.stacks.delete(name);
    account.stacks.get("agentx-staging-identity")!.status = "ROLLBACK_COMPLETE";
    account.stacks.get("agentx-staging-identity")!.terminationProtection = false;
    account.instances = [];
    account.volumes = [];
    const h = await harness({ account, installed: false, typed: ["staging", "123456789012"] });
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls).toContain("delete stack agentx-staging-identity");
  });

  it("offers to take over its own lock after a closed terminal", async () => {
    const h = await harness({ typed: ["staging", "yes"] });
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "destroy", acquiredAt: new Date(0).toISOString() }));
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.asked[1]).toContain("Take the lock over?");
  });

  it("never offers a takeover without a terminal: a piped yes cannot take a lock over (final review M11)", async () => {
    const h = await harness({ typed: ["staging", "yes"] });
    h.deps.isInteractive = () => false;
    const held = JSON.stringify({ holder: ADMIN, command: "destroy", acquiredAt: new Date(0).toISOString() });
    h.store.values.set(lockParameterName("staging"), held);
    await expect(runDestroy({ env: "staging", keepData: false }, h.deps)).rejects.toThrow(`environment staging is locked by ${ADMIN} running "destroy" since ${new Date(0).toISOString()} (your own earlier "destroy"; confirm the takeover only if that run is no longer going; to clear it, delete ${lockParameterName("staging")} once you are sure no AgentX command is running)`);
    expect(h.asked).toHaveLength(1);
    expect(h.store.values.get(lockParameterName("staging"))).toBe(held);
    expect(h.account.calls.filter((call) => call.startsWith("delete"))).toEqual([]);
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

  it("says so, and asks nothing, when there is nothing to remove", async () => {
    const empty: FakeAccount = { stacks: new Map(), instances: [], volumes: [], tags: new Map(), secrets: [], aliases: [], calls: [] };
    const h = await harness({ account: empty, installed: false });
    await rm(environmentCachePath(h.home, "staging"));
    await rm(join(h.configDir, "payments.yaml"));
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(result.removed).toBe(false);
    expect(h.asked).toEqual([]);
    expect(h.lines).toContain("Environment staging has nothing to remove in this account and region.");
    expect(result.notFound).toBe("found nothing for environment staging in account 123456789012, region us-east-1; if it is installed in another region, pass --region <that region>");
  });

  it("refuses up front when the access stack is gone but a stack deployed through its role remains", async () => {
    const account = installedAccount();
    account.stacks.delete("agentx-staging-access");
    const h = await harness({ account });
    await expect(runDestroy({ env: "staging", keepData: false }, h.deps)).rejects.toThrow("stack agentx-staging-slack was deployed through the role arn:aws:iam::123456789012:role/agentx-staging-cloudformation, which the access stack held and which is gone");
    expect(h.account.calls).toEqual([]);
  });

  it("refuses an empty answer (or end of input), and a name typed with extra characters: the match is exact", async () => {
    const empty = await harness({ typed: [""] });
    await expect(runDestroy({ env: "staging", keepData: false }, empty.deps)).rejects.toThrow("you typed nothing, not staging; nothing was removed");
    expect(empty.account.calls).toEqual([]);
    const spaced = await harness({ typed: ["staging "] });
    await expect(runDestroy({ env: "staging", keepData: false }, spaced.deps)).rejects.toThrow("not staging; nothing was removed");
    expect(spaced.account.calls).toEqual([]);
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

  it("prints no ECR step when no repository under agentx-<env>/ exists (live check L6)", async () => {
    const account = installedAccount();
    account.repositories = ["agentx-staging-eu/ghcr/preplabsai/agentx-worker"];
    const h = await harness({ account });
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(result.manualSteps.filter((step) => step.includes("ECR"))).toEqual([]);
  });

  it("deletes a stack left in REVIEW_IN_PROGRESS by an interrupted init, without waiting for it", async () => {
    const account = installedAccount();
    account.stacks.get("agentx-staging-slack")!.status = "REVIEW_IN_PROGRESS";
    const h = await harness({ account });
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls[0]).toBe("delete stack agentx-staging-slack");
    expect(h.lines.join("\n")).not.toContain("Waiting for agentx-staging-slack");
  });

  it("waits for a busy stack to finish, then deletes it", async () => {
    const account = installedAccount();
    Object.assign(account.stacks.get("agentx-staging-runtime")!, { status: "UPDATE_IN_PROGRESS", busyMinutes: 10, settledStatus: "UPDATE_ROLLBACK_COMPLETE" });
    const h = await harness({ account });
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.lines).toContain("Waiting for agentx-staging-runtime: it is UPDATE_IN_PROGRESS");
    expect(h.account.calls).toContain("delete stack agentx-staging-runtime");
  });

  it("deletes the retained Slack secret once, and leaves it out of the agentx/<env>/ sweep and its count", async () => {
    const h = await harness();
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    const secretCalls = h.account.calls.filter((call) => call.startsWith("delete secret"));
    expect(secretCalls).toEqual([
      "delete secret arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/slack-AbCdEf",
      "delete secret agentx/staging/callback-signing-key", "delete secret agentx/staging/github-app",
    ]);
    expect(result.secrets).toBe(2);
  });

  it("builds the inventory inside the lock, from what the stacks hold after the confirmation", async () => {
    const h = await harness();
    const controlPlane = h.account.stacks.get("agentx-staging-control-plane")!;
    const answer = h.deps.confirmLine;
    h.deps.confirmLine = async (question) => {
      // A stack update lands between the plan and the lock: a new retained table.
      controlPlane.resources.push({ logicalId: "Late", type: "AWS::DynamoDB::Table", physicalId: "agentx-staging-control-plane-Late-9z" });
      controlPlane.template = JSON.stringify({ Resources: Object.fromEntries(controlPlane.resources.map((resource) => [resource.logicalId, { Type: resource.type, DeletionPolicy: "Retain" }])) });
      h.account.tags.set("agentx-staging-control-plane-Late-9z", { "agentx:env": "staging" });
      return answer(question);
    };
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls).toContain("delete table agentx-staging-control-plane-Late-9z");
  });

  it("with --keep-data, names every kept agentx/<env>/ secret in the manual step", async () => {
    const h = await harness();
    const result = await runDestroy({ env: "staging", keepData: true }, h.deps);
    const kept = result.manualSteps.find((step) => step.startsWith("Kept, as --keep-data asked:"));
    expect(kept).toContain("agentx/staging/callback-signing-key");
    expect(kept).toContain("agentx/staging/github-app");
  });

  it("tells the operator role that destroy needs admin credentials, and that a role without delete rights fails partway", async () => {
    const operator = await harness({ caller: "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice" });
    await expect(runDestroy({ env: "staging", keepData: false }, operator.deps)).rejects.toThrow("any other role without the rights to delete all of it fails partway; run agentx destroy again with admin credentials to continue");
  });

  it("sweeps agentx/<env>/github even though the retained agentx/<env>/github-app shares its start", async () => {
    const account = installedAccount();
    account.stacks.get("agentx-staging-control-plane")!.resources.push({ logicalId: "GitHubSecret", type: "AWS::SecretsManager::Secret", physicalId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-XyZ123" });
    account.stacks.get("agentx-staging-control-plane")!.template = JSON.stringify({ Resources: Object.fromEntries(account.stacks.get("agentx-staging-control-plane")!.resources.map((resource) => [resource.logicalId, { Type: resource.type, DeletionPolicy: "Retain" }])) });
    account.tags.set("arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-XyZ123", { "agentx:env": "staging" });
    account.secrets.push({ name: "agentx/staging/github", scheduled: false });
    const h = await harness({ account });
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls).toContain("delete secret agentx/staging/github");
    expect(h.account.calls).not.toContain("delete secret agentx/staging/github-app");
    expect(result.secrets).toBe(2);
  });

  it("passes the token DeleteStack answered to the failure report", async () => {
    const account = installedAccount();
    account.stacks.get("agentx-staging-foundation")!.failDeletes = 1;
    const h = await harness({ account });
    await expect(runDestroy({ env: "staging", keepData: false }, h.deps)).rejects.toThrow("stack agentx-staging-foundation could not be deleted");
    expect(h.account.failedTokens).toEqual(["agentx-destroy-test-agentx-staging-foundation"]);
  });

  it("finishes when a secret an earlier run force-deleted is still listed and refuses RestoreSecret", async () => {
    const h = await harness();
    let time = 0;
    const sdk = forceDeletedSecretsClient(["agentx/staging/github-app"]);
    const real = awsDestroyApi(sdk.clients, { sleep: async (ms) => { time += ms; } });
    h.deps.api = { ...h.deps.api, deleteSecret: (name) => real.deleteSecret(name) };
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(result.removed).toBe(true);
    expect(sdk.calls).toEqual(expect.arrayContaining(["RestoreSecret agentx/staging/github-app", "DeleteSecret agentx/staging/callback-signing-key"]));
    expect(sdk.calls).not.toContain("DeleteSecret agentx/staging/github-app");
    expect(time).toBeGreaterThan(0);
  });

  it("deletes a REVIEW_IN_PROGRESS stack whose template cannot be read, as retaining nothing", async () => {
    const account = installedAccount();
    Object.assign(account.stacks.get("agentx-staging-slack")!, { status: "REVIEW_IN_PROGRESS", noTemplate: true });
    const h = await harness({ account });
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls[0]).toBe("delete stack agentx-staging-slack");
  });

  it("works out this computer's files from the inventory read inside the lock", async () => {
    const account = installedAccount();
    const foundation = account.stacks.get("agentx-staging-foundation")!;
    foundation.outputs = {};
    const h = await harness({ account });
    const answer = h.deps.confirmLine;
    h.deps.confirmLine = async (question) => {
      foundation.outputs = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0" };
      return answer(question);
    };
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(result.localFiles).toContain(join(h.configDir, "payments.yaml"));
    expect(await readdir(h.configDir)).toEqual(["eu-app.yaml"]);
  });
});

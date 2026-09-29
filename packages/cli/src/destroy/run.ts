// agentx destroy (FR-055, and item 3 of the phase 15e brief): remove one named environment in the
// order docs/architecture-production.md's teardown gives, waiting properly, never touching another
// environment, and safe to re-run: the inventory of retained resources is saved in SSM before any
// stack is deleted, and the settings and lock are deleted last.
import { access, rm } from "node:fs/promises";
import { agentXError, environmentPullThroughPrefix, environmentStackName, type StackPart } from "@agentx/contracts";
import { tokenStoreKey } from "../auth.js";
import { ADOPTED_STACK_NAMES, type CallerIdentity } from "../environments/adopt.js";
import { environmentCachePath } from "../environments/cache.js";
import { lockParameterName, withEnvironmentLock } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, settingsParameterName, type EnvironmentSettings } from "../environments/settings.js";
import { isOperatorRole } from "../init/commands.js";
import { readInstallAnswers, readInstallProgress } from "../init/install-state.js";
import type { TokenStore } from "../token-store.js";
import type { DestroyApi, DestroyStack } from "./aws.js";
import { confirmationPrompts, destroyPlanText, inventoryParameterName, KEPT_BY_KEEP_DATA, mergeInventory, readInventory, retainedResources, vendorSteps, writeInventory, type RetainedResource } from "./inventory.js";
import { DELETE_AFTER_WORKERS, DELETE_BEFORE_WORKERS, isOwnedAlias, isOwnedParameter, isOwnedRetained, isOwnedSecret, isOwnedStack, isOwnedWorker } from "./names.js";
import { deleteVolumesWhenFree, waitForInstancesGone, waitForStackDelete } from "./wait.js";

export interface DestroyDependencies {
  store: ParameterStore;
  api: DestroyApi;
  identity: CallerIdentity;
  confirmLine: (question: string) => Promise<string>;
  write: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  home: string;
  /** This environment's project files on this computer (environmentProjectFiles, setup/project-add.ts). */
  projectFiles: (env: string) => Promise<Array<{ path: string; launchTemplateId: string }>>;
  tokenStore: TokenStore;
  region: string;
}

export interface DestroyResult {
  env: string; removed: boolean; stacksDeleted: string[]; instances: number; volumes: number;
  retainedDeleted: string[]; kept: string[]; leftInPlace: string[]; secrets: number; parameters: number; localFiles: string[]; manualSteps: string[];
}

const exists = (path: string) => access(path).then(() => true, () => false);
const label = (resource: RetainedResource) => `${resource.type} ${resource.physicalId}`;
const IDLE_TIMEOUT_MS = 60 * 60_000;

export async function runDestroy(options: { env: string; keepData: boolean }, deps: DestroyDependencies): Promise<DestroyResult> {
  const { env } = options;
  const { api, store } = deps;
  // Ruling F21: the older (adopted) production deployment is refused before anything is listed,
  // asked or deleted. The name guards match its /agentx/production/* parameters and its KMS alias,
  // so this refusal is what protects it. Unreadable settings are refused, never taken as absent.
  let settings: EnvironmentSettings | undefined;
  try {
    settings = await readEnvironmentSettings(store, env);
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `${settingsParameterName(env)} cannot be read (${error instanceof Error ? error.message : String(error)}), so agentx destroy cannot tell whether ${env} is the older production deployment; nothing was removed. Fix that parameter, or delete it if you are sure ${env} is not that deployment, then run agentx destroy again`);
  }
  const legacyRefusal = "agentx destroy never removes the legacy deployment (fixed stack names); tear it down by hand if you mean to";
  if (settings?.naming === "legacy") throw agentXError("CONFIG_INVALID", legacyRefusal);
  if (env === "production") {
    for (const name of Object.values(ADOPTED_STACK_NAMES)) {
      if ((await api.stack(name)) !== undefined) throw agentXError("CONFIG_INVALID", `${legacyRefusal}: stack ${name} exists in this account and region`);
    }
  }
  const caller = await deps.identity.get();
  if (isOperatorRole(caller.arn, env)) {
    throw agentXError("CONFIG_INVALID", "agentx destroy needs admin credentials: it deletes the access stack and its IAM roles, which the operator role cannot do by design");
  }
  if (settings !== undefined && settings.account !== caller.account) {
    throw agentXError("CONFIG_INVALID", `environment ${env} is installed in account ${settings.account}, but your AWS credentials are for ${caller.account}; use credentials for ${settings.account}`);
  }
  const answers = await readInstallAnswers(store, env).catch(() => undefined);
  const progress = await readInstallProgress(store, env).catch(() => undefined);

  // 1. Read everything first.
  const stacks = new Map<StackPart, DestroyStack>();
  for (const part of [...DELETE_BEFORE_WORKERS, ...DELETE_AFTER_WORKERS]) {
    const found = await api.stack(environmentStackName(env, part));
    if (found !== undefined) stacks.set(part, found);
  }
  if (!stacks.has("access")) {
    for (const [part, stack] of stacks) {
      if (stack.roleArn === undefined) continue;
      const name = environmentStackName(env, part);
      throw agentXError("CONFIG_INVALID", `stack ${name} was deployed through the role ${stack.roleArn}, which the access stack held and which is gone, so CloudFormation cannot delete it. Delete it with a role that can (aws cloudformation delete-stack --stack-name ${name} --role-arn <an admin role ARN> --region ${deps.region}), then run agentx destroy again`);
    }
  }
  const found: RetainedResource[] = [];
  for (const [part] of stacks) {
    const name = environmentStackName(env, part);
    found.push(...retainedResources(part, await api.template(name), await api.stackResources(name)));
  }
  const stored = await readInventory(store, env);
  const launchTemplateId = stacks.get("foundation")?.outputs.Ec2WorkerLaunchTemplateId;
  const github = progress?.github === undefined || answers === undefined ? undefined : { account: progress.github.account, accountType: answers.github.accountType, slug: progress.github.slug };
  const connectors = progress?.connectors === undefined ? undefined : [...new Set(progress.connectors.map((entry) => entry.type))];
  const inventory = mergeInventory(stored, {
    env, resources: found,
    ...(launchTemplateId === undefined ? {} : { launchTemplateId }), ...(github === undefined ? {} : { github }),
    ...(progress?.slack?.appId === undefined ? {} : { slackAppId: progress.slack.appId }), ...(connectors === undefined ? {} : { connectors }),
  });
  // Every list is checked against the guards again here, whatever the adapter already filtered.
  const instances = (await api.workerInstances(env)).filter((instance) => isOwnedWorker(env, instance.tags));
  const volumes = (await api.workerVolumes(env)).filter((volume) => isOwnedWorker(env, volume.tags));
  const secrets = (await api.secrets(env)).filter((secret) => isOwnedSecret(env, secret.name));
  const parameters = (await store.list(`/agentx/${env}`)).filter((name) => isOwnedParameter(env, name));
  const cachePath = environmentCachePath(deps.home, env);
  const projectFiles = inventory.launchTemplateId === undefined ? [] : (await deps.projectFiles(env)).filter((file) => file.launchTemplateId === inventory.launchTemplateId);
  const localFiles = [...((await exists(cachePath)) ? [cachePath] : []), ...projectFiles.map((file) => file.path)];

  const result: DestroyResult = { env, removed: false, stacksDeleted: [], instances: 0, volumes: 0, retainedDeleted: [], kept: [], leftInPlace: [], secrets: 0, parameters: 0, localFiles: [], manualSteps: [] };
  if (stacks.size + inventory.resources.length + instances.length + volumes.length + secrets.length + parameters.length + localFiles.length === 0) {
    deps.write(`Environment ${env} has nothing to remove in this account and region.`);
    return result;
  }

  // 2. Show everything, then the typed confirmation (question 1).
  const orderedStacks = [...DELETE_BEFORE_WORKERS, ...DELETE_AFTER_WORKERS].flatMap((part) => { const stack = stacks.get(part); return stack === undefined ? [] : [{ name: environmentStackName(env, part), status: stack.status }]; });
  for (const line of destroyPlanText({ env, account: caller.account, region: deps.region, stacks: orderedStacks, instances: instances.length, volumes: volumes.length, resources: inventory.resources, secrets: secrets.length, parameters: parameters.length, localFiles, keepData: options.keepData })) deps.write(line);
  const recorded = settings?.naming === "environment" || answers !== undefined;
  for (const prompt of confirmationPrompts({ env, account: caller.account, recorded })) {
    // Exact: only the line ending is dropped. An empty line, or end of input, refuses.
    const typed = (await deps.confirmLine(prompt.question)).replace(/\r?\n$/, "");
    if (typed === "" || typed !== prompt.expected) throw agentXError("CONFIG_INVALID", `you typed ${typed || "nothing"}, not ${prompt.expected}; nothing was removed`);
  }

  const deleteStack = async (part: StackPart): Promise<void> => {
    const name = environmentStackName(env, part);
    if (!isOwnedStack(env, name)) throw agentXError("CONFIG_INVALID", `refusing to delete stack ${name}: it does not belong to environment ${env}`);
    let stack = await api.stack(name);
    if (stack === undefined) return;
    const idleSince = deps.now();
    while (stack !== undefined && stack.status.endsWith("_IN_PROGRESS") && stack.status !== "DELETE_IN_PROGRESS") {
      if (deps.now() - idleSince >= IDLE_TIMEOUT_MS) throw agentXError("RUNTIME_UNAVAILABLE", `stack ${name} is still ${stack.status} after 60 minutes; wait for it to finish, then run agentx destroy again`);
      deps.write(`Waiting for ${name}: it is ${stack.status}`);
      await deps.sleep(15_000);
      stack = await api.stack(name);
    }
    if (stack === undefined) return;
    if (stack.terminationProtection) await api.disableTerminationProtection(name);
    if (stack.status !== "DELETE_IN_PROGRESS") {
      if (part === "control-plane") deps.write(`Deleting ${name}: this usually takes 20 to 40 minutes while its Lambda functions release their network interfaces.`);
      else deps.write(`Deleting ${name}`);
      await api.deleteStack(name);
    }
    await waitForStackDelete({ api, name, write: deps.write, sleep: deps.sleep, now: deps.now });
    result.stacksDeleted.push(name);
  };

  await withEnvironmentLock({
    store, env, holder: caller.arn, command: "destroy", now: deps.now, takeOverOwn: true,
    confirmTakeover: async (held) => /^y(es)?$/i.test((await deps.confirmLine(`Environment ${env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}. Take the lock over? Say yes only if that command is no longer running. [y/N] `)).trim()),
  }, async () => {
    await writeInventory(store, inventory);
    for (const part of DELETE_BEFORE_WORKERS) await deleteStack(part);

    // 3. Workers: launched by Step Functions, outside CloudFormation (all three tags checked in the adapter).
    const running = (await api.workerInstances(env)).filter((instance) => isOwnedWorker(env, instance.tags)).map((instance) => instance.id);
    if (running.length > 0) {
      deps.write(`Terminating ${running.length} worker ${running.length === 1 ? "instance" : "instances"}`);
      await api.terminateInstances(running);
      await waitForInstancesGone({ api, env, ids: running, sleep: deps.sleep, now: deps.now });
      result.instances = running.length;
    }
    const left = (await api.workerVolumes(env)).filter((volume) => isOwnedWorker(env, volume.tags)).map((volume) => volume.id);
    if (left.length > 0) {
      deps.write(`Deleting ${left.length} workspace ${left.length === 1 ? "volume" : "volumes"}`);
      await deleteVolumesWhenFree({ api, ids: left, sleep: deps.sleep, now: deps.now });
      result.volumes = left.length;
    }

    for (const part of DELETE_AFTER_WORKERS) await deleteStack(part);

    // 5. What the stacks retained.
    for (const resource of inventory.resources) {
      if (options.keepData && KEPT_BY_KEEP_DATA.has(resource.type)) { result.kept.push(label(resource)); continue; }
      const tags = await api.resourceTags(resource);
      if (tags === undefined) continue;
      if (!isOwnedRetained(env, resource, tags)) { result.leftInPlace.push(`${label(resource)} (it does not carry agentx:env=${env})`); continue; }
      switch (resource.type) {
        case "AWS::S3::Bucket": await api.deleteBucket(resource.physicalId, (count) => { if (count % 1000 === 0) deps.write(`${resource.physicalId}: ${count} objects deleted`); }); break;
        case "AWS::DynamoDB::Table": await api.deleteTable(resource.physicalId); break;
        case "AWS::Logs::LogGroup": await api.deleteLogGroup(resource.physicalId); break;
        case "AWS::Cognito::UserPool": await api.deleteUserPool(resource.physicalId, `agentx-${env}-${caller.account}`); break;
        case "AWS::KMS::Key": await api.scheduleKeyDeletion(resource.physicalId); break;
        case "AWS::SecretsManager::Secret": await api.deleteSecret(resource.physicalId); break;
        default: result.leftInPlace.push(`${label(resource)} (agentx destroy does not delete this type; delete it by hand)`); continue;
      }
      result.retainedDeleted.push(label(resource));
    }
    if (!options.keepData) {
      for (const alias of (await api.aliases(env)).filter((entry) => isOwnedAlias(env, entry.name))) await api.deleteAlias(alias.name);
      // 6. Every agentx/<env>/ secret, without recovery, so a reinstall can reuse the names.
      const remaining = (await api.secrets(env)).filter((secret) => isOwnedSecret(env, secret.name));
      for (const secret of remaining) await api.deleteSecret(secret.name);
      result.secrets = remaining.length;
    }

    // 7. Parameters; the settings last, and the lock is released after this function returns. Under
    // --keep-data the inventory stays (ruling F3): a later run without it finds what was kept there.
    const keep = new Set([settingsParameterName(env), lockParameterName(env), ...(options.keepData ? [inventoryParameterName(env)] : [])]);
    const names = (await store.list(`/agentx/${env}`)).filter((name) => isOwnedParameter(env, name) && !keep.has(name));
    for (const name of names) await store.delete(name);
    await store.delete(settingsParameterName(env));
    result.parameters = names.length + 1;
  });

  // 8. This computer.
  for (const path of localFiles) await rm(path, { force: true });
  if (settings !== undefined) await deps.tokenStore.delete(tokenStoreKey({ issuer: settings.identity.issuer, clientId: settings.identity.clientId, audience: settings.identity.audience }));
  result.localFiles = localFiles;

  // 9. What AgentX cannot do.
  result.manualSteps = [
    ...vendorSteps(inventory),
    ...(options.keepData && result.kept.length > 0 ? [`Kept, as --keep-data asked: ${result.kept.join(", ")}. A new install named ${env} cannot reuse the secret names until you delete them.`] : []),
    ...(options.keepData ? ["Run agentx destroy again, without --keep-data, to remove what was kept."] : []),
    // Ruling F32: the image pull-through cache made these repositories, outside every stack.
    `Delete the ECR repositories under ${environmentPullThroughPrefix(env)}/ that the image pull-through cache created: in the ECR console for ${deps.region}, Private registry, Repositories, filter by ${environmentPullThroughPrefix(env)}/ and delete each one (or aws ecr delete-repository --force --region ${deps.region} --repository-name <name>).`,
    ...(result.retainedDeleted.some((entry) => entry.startsWith("AWS::KMS::Key")) ? ["The KMS keys are scheduled for deletion in 7 days; until then, aws kms cancel-key-deletion brings one back."] : []),
    ...result.leftInPlace.map((entry) => `Left in place: ${entry}.`),
  ];
  result.removed = true;
  deps.write(`Environment ${env} is removed.`);
  for (const step of result.manualSteps) deps.write(`  ${step}`);
  return result;
}

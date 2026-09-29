// agentx destroy (FR-055, and item 3 of the phase 15e brief): remove one named environment in the
// order docs/architecture-production.md's teardown gives, waiting properly, never touching another
// environment, and safe to re-run: the inventory of retained resources is saved in SSM before any
// stack is deleted, and the settings and lock are deleted last.
import { access, rm } from "node:fs/promises";
import { agentXError, environmentPullThroughPrefix, environmentStackName, type StackPart } from "@agentx/contracts";
import { tokenStoreKey } from "../auth.js";
import { ADOPTED_STACK_NAMES, type CallerIdentity } from "../environments/adopt.js";
import { cachedEnvironmentRegion, environmentCachePath } from "../environments/cache.js";
import { lockParameterName, withEnvironmentLock, type LockRecord } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, settingsParameterName, type EnvironmentSettings } from "../environments/settings.js";
import { isOperatorRole } from "../init/commands.js";
import { installAnswersParameterName, installProgressParameterName, readInstallAnswers, readInstallProgress } from "../init/install-state.js";
import type { TokenStore } from "../token-store.js";
import type { DestroyApi, DestroyStack } from "./aws.js";
import { confirmationPrompts, destroyPlanText, inventoryParameterName, KEPT_BY_KEEP_DATA, mergeInventory, readInventory, retainedResources, vendorSteps, writeInventory, type Inventory, type RetainedResource } from "./inventory.js";
import { DELETE_AFTER_WORKERS, DELETE_BEFORE_WORKERS, isOwnedAlias, isOwnedParameter, isOwnedRetained, isOwnedSecret, isOwnedStack, isOwnedWorker, isSecretId } from "./names.js";
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
  /** Whether stdin is a terminal: a lock takeover is offered only then, never to piped input. */
  isInteractive: () => boolean;
}

export interface DestroyResult {
  env: string; removed: boolean; stacksDeleted: string[]; instances: number; volumes: number;
  retainedDeleted: string[]; kept: string[]; leftInPlace: string[]; secrets: number; parameters: number; localFiles: string[]; manualSteps: string[];
  /** Set when nothing of the environment was found: says where agentx looked. */
  notFound?: string;
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
  // Every client is built for deps.region; an environment installed elsewhere is not in them.
  if (settings !== undefined && settings.region !== deps.region) {
    throw agentXError("CONFIG_INVALID", `environment ${env} is installed in ${settings.region}, not ${deps.region}; run agentx --env ${env} destroy --region ${settings.region}`);
  }
  // SSM is regional: in the wrong region the settings simply read as absent. This computer's cache
  // records the environment's endpoints, which name its region.
  if (settings === undefined) {
    const cachedRegion = await cachedEnvironmentRegion(deps.home, env);
    if (cachedRegion !== undefined && cachedRegion !== deps.region) {
      throw agentXError("CONFIG_INVALID", `this computer's record of environment ${env} (${environmentCachePath(deps.home, env)}) says it is in ${cachedRegion}, not ${deps.region}; run agentx --env ${env} destroy --region ${cachedRegion}`);
    }
  }
  if (env === "production") {
    for (const name of Object.values(ADOPTED_STACK_NAMES)) {
      if ((await api.stack(name)) !== undefined) throw agentXError("CONFIG_INVALID", `${legacyRefusal}: stack ${name} exists in this account and region`);
    }
  }
  const caller = await deps.identity.get();
  if (isOperatorRole(caller.arn, env)) {
    throw agentXError("CONFIG_INVALID", "agentx destroy needs admin credentials. It deletes the access stack and its IAM roles, which the operator role cannot do by design, and any other role without the rights to delete all of it fails partway; run agentx destroy again with admin credentials to continue");
  }
  if (settings !== undefined && settings.account !== caller.account) {
    throw agentXError("CONFIG_INVALID", `environment ${env} is installed in account ${settings.account}, but your AWS credentials are for ${caller.account}; use credentials for ${settings.account}`);
  }
  // An unreadable record is safe to go on without; the line names it, never what it holds.
  const unreadable = (name: string, effect: string) => () => {
    deps.write(`Could not read ${name}, so agentx destroy goes on without ${effect}.`);
    return undefined;
  };
  const answers = await readInstallAnswers(store, env).catch(unreadable(installAnswersParameterName(env), "the install answers: it may ask for the account id, and the steps printed at the end name no GitHub App of this environment"));
  const progress = await readInstallProgress(store, env).catch(unreadable(installProgressParameterName(env), "the install progress: the steps printed at the end name no app of this environment"));

  // 1. Read everything first. The stacks and the inventory are read again inside the lock, so what
  // is saved and deleted is never older than the lock.
  const github = progress?.github === undefined || answers === undefined ? undefined : { account: progress.github.account, accountType: answers.github.accountType, slug: progress.github.slug };
  const connectors = progress?.connectors === undefined ? undefined : [...new Set(progress.connectors.map((entry) => entry.type))];
  const readStacks = async (): Promise<{ stacks: Map<StackPart, DestroyStack>; inventory: Inventory }> => {
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
    for (const [part, stack] of stacks) {
      const name = environmentStackName(env, part);
      try {
        found.push(...retainedResources(part, await api.template(name), await api.stackResources(name)));
      } catch (error) {
        // A stack with only a pending change set (an interrupted init) may have no template yet: it
        // holds nothing, so nothing is retained. Any other stack's read error stops destroy.
        if (stack.status !== "REVIEW_IN_PROGRESS") throw error;
      }
    }
    const launchTemplateId = stacks.get("foundation")?.outputs.Ec2WorkerLaunchTemplateId;
    const inventory = mergeInventory(await readInventory(store, env), {
      env, resources: found,
      ...(launchTemplateId === undefined ? {} : { launchTemplateId }), ...(github === undefined ? {} : { github }),
      ...(progress?.slack?.appId === undefined ? {} : { slackAppId: progress.slack.appId }), ...(connectors === undefined ? {} : { connectors }),
    });
    return { stacks, inventory };
  };
  const { stacks, inventory: planned } = await readStacks();
  let inventory = planned;
  // Every list is checked against the guards again here, whatever the adapter already filtered.
  const instances = (await api.workerInstances(env)).filter((instance) => isOwnedWorker(env, instance.tags));
  const volumes = (await api.workerVolumes(env)).filter((volume) => isOwnedWorker(env, volume.tags));
  const secrets = (await api.secrets(env)).filter((secret) => isOwnedSecret(env, secret.name));
  const parameters = (await store.list(`/agentx/${env}`)).filter((name) => isOwnedParameter(env, name));
  const cachePath = environmentCachePath(deps.home, env);
  // This computer's files: the cache, and the project files bound to the inventory's launch template.
  const filesFor = async (from: Inventory): Promise<string[]> => {
    const projectFiles = from.launchTemplateId === undefined ? [] : (await deps.projectFiles(env)).filter((file) => file.launchTemplateId === from.launchTemplateId);
    return [...((await exists(cachePath)) ? [cachePath] : []), ...projectFiles.map((file) => file.path)];
  };
  let localFiles = await filesFor(inventory);

  const keptSecrets: string[] = [];
  const result: DestroyResult = { env, removed: false, stacksDeleted: [], instances: 0, volumes: 0, retainedDeleted: [], kept: [], leftInPlace: [], secrets: 0, parameters: 0, localFiles: [], manualSteps: [] };
  if (stacks.size + inventory.resources.length + instances.length + volumes.length + secrets.length + parameters.length + localFiles.length === 0) {
    deps.write(`Environment ${env} has nothing to remove in this account and region.`);
    result.notFound = `found nothing for environment ${env} in account ${caller.account}, region ${deps.region}; if it is installed in another region, pass --region <that region>`;
    return result;
  }

  // 2. Show everything, then the typed confirmation (question 1).
  const orderedStacks = [...DELETE_BEFORE_WORKERS, ...DELETE_AFTER_WORKERS].flatMap((part) => { const stack = stacks.get(part); return stack === undefined ? [] : [{ name: environmentStackName(env, part), status: stack.status }]; });
  for (const line of destroyPlanText({ env, account: caller.account, region: deps.region, stacks: orderedStacks, instances: instances.length, volumes: volumes.length, resources: inventory.resources, secrets: secrets.length, parameters: parameters.length, localFiles, keepData: options.keepData })) deps.write(line);
  const recorded = settings?.naming === "environment" || answers !== undefined;
  for (const prompt of confirmationPrompts({ env, account: caller.account, recorded })) {
    // Exact: only the line ending is dropped. An empty line, or end of input, refuses.
    const typed = (await deps.confirmLine(prompt.question)).replace(/\r?\n$/, "");
    if (typed !== prompt.expected) throw agentXError("CONFIG_INVALID", `you typed ${typed || "nothing"}, not ${prompt.expected}; nothing was removed`);
  }

  const deleteStack = async (part: StackPart): Promise<void> => {
    const name = environmentStackName(env, part);
    if (!isOwnedStack(env, name)) throw agentXError("CONFIG_INVALID", `refusing to delete stack ${name}: it does not belong to environment ${env}`);
    let stack = await api.stack(name);
    if (stack === undefined) return;
    const idleSince = deps.now();
    // REVIEW_IN_PROGRESS is a change set an interrupted init never ran: nothing is running, so it is
    // deleted at once, as init's busyStatus treats it (init/deploy-steps.ts).
    while (stack !== undefined && stack.status.endsWith("_IN_PROGRESS") && stack.status !== "DELETE_IN_PROGRESS" && stack.status !== "REVIEW_IN_PROGRESS") {
      if (deps.now() - idleSince >= IDLE_TIMEOUT_MS) throw agentXError("RUNTIME_UNAVAILABLE", `stack ${name} is still ${stack.status} after 60 minutes; wait for it to finish, then run agentx destroy again`);
      deps.write(`Waiting for ${name}: it is ${stack.status}`);
      await deps.sleep(15_000);
      stack = await api.stack(name);
    }
    if (stack === undefined) return;
    if (stack.terminationProtection) await api.disableTerminationProtection(name);
    let token: string | undefined;
    if (stack.status !== "DELETE_IN_PROGRESS") {
      if (part === "control-plane") deps.write(`Deleting ${name}: this usually takes 20 to 40 minutes while its Lambda functions release their network interfaces.`);
      else deps.write(`Deleting ${name}`);
      token = await api.deleteStack(name);
    }
    await waitForStackDelete({ api, name, ...(token === undefined ? {} : { token }), write: deps.write, sleep: deps.sleep, now: deps.now });
    result.stacksDeleted.push(name);
  };

  // As upgrade: a takeover is offered only at a terminal, so a script piping answers never takes a lock over.
  const confirmTakeover = deps.isInteractive()
    ? async (held: LockRecord) => /^y(es)?$/i.test((await deps.confirmLine(`Environment ${env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}. Take the lock over? Say yes only if that command is no longer running. [y/N] `)).trim())
    : undefined;
  await withEnvironmentLock({
    store, env, holder: caller.arn, command: "destroy", now: deps.now, takeOverOwn: true, ...(confirmTakeover === undefined ? {} : { confirmTakeover }),
  }, async () => {
    inventory = (await readStacks()).inventory;
    localFiles = await filesFor(inventory);
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

    // 5. What the stacks retained. The secrets deleted here are left out of step 6's sweep: Secrets
    // Manager can still list one as scheduled, and deleting it again would restore it first.
    const deletedSecrets: string[] = [];
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
        case "AWS::SecretsManager::Secret": await api.deleteSecret(resource.physicalId); deletedSecrets.push(resource.physicalId); break;
        default: result.leftInPlace.push(`${label(resource)} (agentx destroy does not delete this type; delete it by hand)`); continue;
      }
      result.retainedDeleted.push(label(resource));
    }
    if (!options.keepData) {
      for (const alias of (await api.aliases(env)).filter((entry) => isOwnedAlias(env, entry.name))) await api.deleteAlias(alias.name);
      // 6. Every agentx/<env>/ secret, without recovery, so a reinstall can reuse the names.
      const already = (name: string) => deletedSecrets.some((id) => isSecretId(id, name));
      const remaining = (await api.secrets(env)).filter((secret) => isOwnedSecret(env, secret.name) && !already(secret.name));
      for (const secret of remaining) await api.deleteSecret(secret.name);
      result.secrets = remaining.length;
    } else {
      const keptIds = inventory.resources.filter((resource) => resource.type === "AWS::SecretsManager::Secret").map((resource) => resource.physicalId);
      keptSecrets.push(...(await api.secrets(env)).filter((secret) => isOwnedSecret(env, secret.name) && !keptIds.some((id) => isSecretId(id, secret.name))).map((secret) => secret.name));
    }

    // 7. Parameters; the settings last, and the lock is released after this function returns. Under
    // --keep-data the inventory stays (ruling F3): a later run without it finds what was kept there.
    // The inventory goes just before the settings, so a run that fails earlier still has it.
    const listed = (await store.list(`/agentx/${env}`)).filter((name) => isOwnedParameter(env, name));
    const last = [...(options.keepData ? [] : [inventoryParameterName(env)]), settingsParameterName(env)].filter((name) => listed.includes(name));
    const skipped = new Set([settingsParameterName(env), lockParameterName(env), inventoryParameterName(env)]);
    const names = [...listed.filter((name) => !skipped.has(name)), ...last];
    for (const name of names) await store.delete(name);
    result.parameters = names.length;
  });

  // 8. This computer.
  for (const path of localFiles) await rm(path, { force: true });
  if (settings !== undefined) await deps.tokenStore.delete(tokenStoreKey({ issuer: settings.identity.issuer, clientId: settings.identity.clientId, audience: settings.identity.audience }));
  result.localFiles = localFiles;

  // 9. What AgentX cannot do.
  result.manualSteps = [
    ...vendorSteps(inventory),
    ...(options.keepData && result.kept.length + keptSecrets.length > 0 ? [`Kept, as --keep-data asked: ${[...result.kept, ...keptSecrets.map((name) => `secret ${name}`)].join(", ")}. A new install named ${env} cannot reuse the secret names until you delete them.`] : []),
    ...(options.keepData ? ["Run agentx destroy again, without --keep-data, to remove what was kept."] : []),
    // Ruling F32: the image pull-through cache made these repositories, outside every stack.
    `Delete the ECR repositories under ${environmentPullThroughPrefix(env)}/ that the image pull-through cache created: in the ECR console for ${deps.region}, Private registry, Repositories, filter by ${environmentPullThroughPrefix(env)}/ and delete each one (or aws ecr delete-repository --force --region ${deps.region} --repository-name <name>).`,
    ...(result.retainedDeleted.some((entry) => entry.startsWith("AWS::KMS::Key")) ? ["The KMS keys are scheduled for deletion in 7 days; until then, aws kms cancel-key-deletion brings one back."] : []),
    ...result.leftInPlace.map((entry) => `Left in place: ${entry}.`),
  ];
  result.removed = true;
  // The command prints the manual steps once, on stdout, with its own summary line.
  deps.write(`Environment ${env} is removed.`);
  return result;
}

// agentx upgrade (FR-042 to FR-044): read the environment's version and engine from SSM, show the
// target release's notes and every change, deploy in upgrade order (stopping at the first failure,
// which leaves earlier stacks upgraded and is safe to re-run), then run doctor.
import { GetTemplateCommand } from "@aws-sdk/client-cloudformation";
import { agentXError, environmentStackName } from "@agentx/contracts";
import { CONFIG_KEYS } from "../config/keys.js";
import { progressLine, type Ask, type PreparedDeployment } from "../deploy/commands.js";
import { deployEnvironment, keptOperatorParameters, templateParameterNames } from "../deploy/deploy-environment.js";
import type { DeployRequest } from "../deploy/deployer.js";
import { upgradeOrder, type DeployPart } from "../deploy/parameters.js";
import type { LoadedRelease } from "../deploy/release.js";
import { reportText, type DoctorReport } from "../doctor/checks.js";
import type { CallerIdentity, StackReader } from "../environments/adopt.js";
import { withEnvironmentLock, type LockRecord } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { isOperatorRole } from "../init/commands.js";
import { plainMessage } from "../output.js";
import { upgradeAnswers } from "./answers.js";
import { cdkDiffRisks, cdkReviewedDeployer, guardData, upgradeConfirm } from "./review.js";
import { notesText, refusePrereleaseTarget, upgradeDirection, type ReleaseNotes } from "./target.js";

export interface UpgradeOptions { env: string; to?: string; releaseDir?: string; source?: string; yes: boolean; allowReplace: string[]; exportDir?: string; images?: { worker?: string; slack?: string } }

export interface UpgradeDependencies {
  store: ParameterStore;
  stacks: StackReader;
  /** GetTemplate, for the access-stack comparison under the operator role. */
  cloudFormation: { send(command: unknown): Promise<unknown> };
  identity: CallerIdentity;
  loadRelease(input: { releaseDir?: string; version?: string }): Promise<LoadedRelease>;
  notes(version: string): Promise<ReleaseNotes | undefined>;
  prepare(input: { settings: EnvironmentSettings; release: LoadedRelease; source?: string }): Promise<PreparedDeployment>;
  cdkDiff(request: DeployRequest, settings: EnvironmentSettings, source: string): Promise<string>;
  ask: Ask;
  isInteractive(): boolean;
  doctor(env: string): Promise<DoctorReport>;
  write: (line: string) => void;
  now: () => number;
  /** This agentx's own release (RELEASE_VERSION); undefined for a build from source. */
  cliVersion: string | undefined;
}

export interface UpgradeResult { env: string; from: string; to: string; parts: DeployPart[]; exported?: string; doctor?: { failed: number; warned: number } }

/** Sorts object keys at every level, so two templates compare by content, not by formatting. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

/** Question 9: whether the release's access template differs from the deployed one. A deployed
 * template this code cannot read as JSON counts as changed, so the upgrade stops rather than leave
 * the access stack behind. */
export async function accessChanged(input: { cloudFormation: { send(command: unknown): Promise<unknown> }; stackName: string; release: LoadedRelease; region: string; env: string }): Promise<boolean> {
  // Only the parse is caught: the release's own refusal (a region it does not cover, say) keeps its words.
  const releaseText = input.release.template("access", input.region, input.env);
  let releaseTemplate: unknown;
  try {
    releaseTemplate = JSON.parse(releaseText);
  } catch {
    throw agentXError("CONFIG_INVALID", `the release's access template for ${input.region} could not be read; rebuild or re-download release ${input.release.manifest.version}`);
  }
  const deployed = ((await input.cloudFormation.send(new GetTemplateCommand({ StackName: input.stackName, TemplateStage: "Original" }))) as { TemplateBody?: string }).TemplateBody;
  if (deployed === undefined) return true;
  let deployedTemplate: unknown;
  try {
    deployedTemplate = JSON.parse(deployed);
  } catch {
    return true;
  }
  return JSON.stringify(canonical(deployedTemplate)) !== JSON.stringify(canonical(releaseTemplate));
}

/** The spec's edge case "A release that removes a config key an environment has set": each operator
 * parameter a deployed stack holds that the target release's template no longer declares. Ruling
 * F10: keptOperatorParameters owns that test; this only names each one by its config key. */
export async function droppedConfigKeys(input: { release: LoadedRelease; env: string; parts: DeployPart[]; stacks: StackReader }): Promise<Array<{ key: string; value: string }>> {
  const dropped: Array<{ key: string; value: string }> = [];
  for (const part of input.parts) {
    const deployed = (await input.stacks.describe(environmentStackName(input.env, part)))?.parameters;
    if (deployed === undefined) continue;
    const found = keptOperatorParameters({ part, computed: {}, deployed, declared: templateParameterNames(input.release, part, input.env) }).dropped;
    for (const { parameter, value } of found) {
      const key = CONFIG_KEYS.find((entry) => entry.target.kind === "stack-parameter" && entry.target.part === part && entry.target.parameter === parameter)?.key ?? parameter;
      dropped.push({ key, value });
    }
  }
  return dropped;
}

/** The settings an upgrade may run on. Read before the environment lock, and read again under it. */
function upgradableSettings(settings: EnvironmentSettings | undefined, env: string): EnvironmentSettings {
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `agentx upgrade works on environments installed with agentx init; ${env} uses the legacy stack names`);
  return settings;
}

export async function runUpgrade(options: UpgradeOptions, deps: UpgradeDependencies): Promise<UpgradeResult> {
  const { env } = options;
  const first = upgradableSettings(await readEnvironmentSettings(deps.store, env), env);
  if (options.exportDir !== undefined) {
    // Ruling F19 (FR-013): the bundle holds the published templates; deploying them onto
    // cdk-deployed stacks would switch the environment's engine.
    if (first.engine === "cdk") throw agentXError("CONFIG_INVALID", "upgrade --export writes the published templates; a cdk environment upgrades with --source. Run agentx upgrade --source <dir> with admin credentials instead");
    throw agentXError("CONFIG_INVALID", "upgrade --export is not available in this agentx yet; run agentx upgrade with admin credentials instead, or ask your platform team to deploy the access stack");
  }
  if (first.engine === "cdk" && options.source === undefined) {
    throw agentXError("CONFIG_INVALID", "the cdk engine upgrades from a checkout of the target release's tag; pass --source <dir>");
  }
  if (!options.yes && !deps.isInteractive()) throw agentXError("CONFIG_INVALID", "agentx upgrade needs --yes when stdin is not a terminal");

  const caller = await deps.identity.get();
  const operator = isOperatorRole(caller.arn, env);
  // Ruling F20: the cdk engine reads CDK's bootstrap version parameter and deploys through the
  // bootstrap roles and bucket, none of which the operator role may use.
  if (operator && first.engine === "cdk") {
    throw agentXError("CONFIG_INVALID", "a cdk environment upgrades with admin credentials (the operator role cannot use CDK's bootstrap resources); run agentx upgrade again with admin credentials");
  }

  const version = options.releaseDir === undefined ? options.to ?? deps.cliVersion : undefined;
  if (options.releaseDir === undefined && version === undefined) {
    throw agentXError("CONFIG_INVALID", "this agentx was built from source, so it has no release of its own; pass --to <version> or --release <dir>");
  }
  const release = await deps.loadRelease({ ...(options.releaseDir === undefined ? {} : { releaseDir: options.releaseDir }), ...(version === undefined ? {} : { version }) });
  const target = release.manifest.version;
  refusePrereleaseTarget(target);
  if (options.to !== undefined && options.releaseDir !== undefined && options.to !== target) {
    throw agentXError("CONFIG_INVALID", `--release holds release ${target}, not ${options.to}; pass the release you mean`);
  }
  // Checked here to fail fast, and again under the lock, where it counts.
  upgradeDirection(env, first.version, target);

  // Question 3 under concurrency: another upgrade may finish between the read above and this lock,
  // so the settings are read again, and every check on them repeated, while the lock is held.
  // A killed upgrade leaves its lock; once it is stale (2 hours), a person at a terminal may take it
  // over, as with init and destroy. --yes never takes one over on its own.
  const confirmTakeover = deps.isInteractive()
    ? async (held: LockRecord) => /^y(es)?$/i.test((await deps.ask(`Environment ${env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}. Take the lock over? Say yes only if that command is no longer running. [y/N] `)).trim())
    : undefined;
  const { settings, parts } = await withEnvironmentLock({ store: deps.store, env, holder: caller.arn, command: "upgrade", now: deps.now, ...(confirmTakeover === undefined ? {} : { confirmTakeover }) }, async () => {
    const settings = upgradableSettings(await readEnvironmentSettings(deps.store, env), env);
    if (settings.engine !== first.engine) {
      throw agentXError("CONFIG_INVALID", `environment ${env}'s settings changed to the ${settings.engine} engine while agentx upgrade was starting; run agentx upgrade again`);
    }
    const direction = upgradeDirection(env, settings.version, target);
    deps.write(direction === "same" ? `Environment ${env} already runs ${target}; checking that every stack is on it` : `Upgrading ${env} from ${settings.version} to ${target} (${settings.engine} engine)`);
    deps.write(notesText(await deps.notes(target), target));

    const answers = await upgradeAnswers({ settings, stacks: deps.stacks, ...(options.images === undefined ? {} : { images: options.images }) });
    let parts = upgradeOrder(settings.identity.mode);
    // Question 9: the operator role cannot change the access stack (it holds the IAM roles). An
    // unchanged one is skipped; a changed one stops the upgrade before anything deploys. Admin
    // credentials deploy it first, like every other stack.
    if (operator) {
      parts = parts.filter((part) => part !== "access");
      const accessStack = settings.stacks.access ?? environmentStackName(env, "access");
      if (await accessChanged({ cloudFormation: deps.cloudFormation, stackName: accessStack, release, region: settings.region, env })) {
        throw agentXError("CONFIG_INVALID", `release ${target} changes the access stack, which only admin credentials can deploy. Ask your platform team to deploy it (agentx --env ${env} upgrade --export <dir> writes what they need), or run agentx upgrade with admin credentials; then run agentx upgrade again`);
      }
    }

    for (const entry of await droppedConfigKeys({ release, env, parts, stacks: deps.stacks })) {
      deps.write(`config key ${entry.key} (${entry.value}) is not in release ${target}, so the upgrade drops it; nothing replaces it`);
    }

    const allowReplace = new Set(options.allowReplace);
    const review = upgradeConfirm({ write: deps.write, ask: deps.ask, yes: options.yes, allowReplace });
    const prepared = await deps.prepare({ settings, release, ...(options.source === undefined ? {} : { source: options.source }) });
    try {
      const deployer = settings.engine === "templates" ? prepared.deployer : cdkReviewedDeployer(prepared.deployer, async (request) => {
        const risks = cdkDiffRisks(await deps.cdkDiff(request, settings, options.source ?? ""));
        if (risks.iam) deps.write(`${request.stackName} changes IAM; the changes are in the diff above.`);
        const refusal = await guardData({ stackName: request.stackName, data: risks.data, allowReplace, yes: options.yes, ask: deps.ask });
        if (refusal !== undefined) throw agentXError("CONFIG_INVALID", refusal);
        if (!options.yes && !/^y(es)?$/i.test((await deps.ask(`Deploy ${request.stackName}? [y/N] `)).trim())) {
          throw agentXError("CONFIG_INVALID", `upgrade stopped before ${request.stackName}: nothing in it changed. Stacks upgraded before it keep the new release; run agentx upgrade again to continue`);
        }
      });
      try {
        // The lock is this command's, in deps.store, where the settings live; deployEnvironment
        // checks that and writes the new settings there.
        await deployEnvironment({
          mode: "upgrade", engine: settings.engine, answers, release, deployer, store: deps.store, secrets: prepared.secrets, holder: caller.arn, parts, lockHeld: true,
          onEvent: (event) => deps.write(progressLine(event)),
          ...(settings.engine === "templates" ? { confirm: review.confirm } : {}),
          deployedParameters: async (stackName) => (await deps.stacks.describe(stackName))?.parameters,
          now: deps.now,
        });
      } catch (error) {
        const refusal = review.refusal();
        if (refusal !== undefined && error instanceof Error && /confirmation declined/.test(error.message)) throw agentXError("CONFIG_INVALID", refusal);
        throw error;
      }
    } finally {
      await prepared.cleanup();
    }
    return { settings, parts };
  });

  deps.write("Checking the environment with agentx doctor");
  let report: DoctorReport;
  try {
    report = await deps.doctor(env);
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `upgraded ${env} to ${target}, but doctor could not run: ${plainMessage(error)}; run agentx doctor`);
  }
  deps.write(reportText(report).trimEnd());
  if (report.failed > 0) {
    throw agentXError("CONFIG_INVALID", `upgraded ${env} to ${target}, but ${report.failed} doctor ${report.failed === 1 ? "check" : "checks"} failed; fix what each one names, then run agentx doctor again`);
  }
  return { env, from: settings.version, to: target, parts, doctor: { failed: report.failed, warned: report.warned } };
}

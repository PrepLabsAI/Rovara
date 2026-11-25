import { readDeploymentOutputs } from "./cx-b/stack-outputs.js";
import { coreEngineParameters } from "./core-engine-answers.js";
// The deploy orchestrator: ties a stack deployer engine to install/upgrade order, the environment
// lock, the callback signing key and environment settings. Phase 15d's `agentx init`/`agentx
// upgrade` build a StackDeployer (the templates or cdk engine), collect DeployAnswers, and call
// deployEnvironment; everything else (order, outputs feeding forward, the lock, settings) lives here.
import { assertBrokerRunPrices, assertGatewayRunPrices, assertBrokerArtifactRunPrices } from "./gateway-price-preflight.js";
import { agentXError, environmentStackName } from "@agentx/contracts";
import { PROTECTED_PARTS, type DeployEvent, type DeployRequest, type StackDeployer } from "./deployer.js";
import { currentLockHolder, withEnvironmentLock } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { installOrder, OPERATOR_PARAMETERS, SECRET_PARAMETERS, stackParameters, upgradeOrder, type DeployPart, type InstallAnswers, type StackOutputs } from "./parameters.js";
import { controlPlaneUrlOf, planFromDeploy, withDeclaredPublicApiUrlFor, withPublicApiUrl } from "./public-api-url.js";
import type { LoadedRelease } from "./release.js";
import { callbackSigningKey, type SecretValueStore } from "./signing-key.js";
import { GITHUB_SIGN_IN_PARAMETER_NAMES, readStoredDeveloperSignIn, SIGN_IN_PARAMETER_NAMES, type StoredDeveloperSignIn } from "../signin/settings.js";

export type { SecretValueStore } from "./signing-key.js";

/** Everything `stackParameters` needs except the release manifest and the callback signing key,
 * which `deployEnvironment` supplies itself. */
export type DeployAnswers = Omit<InstallAnswers, "release" | "callbackSigningKey">;

export interface DeployEnvironmentInput {
  mode: "install" | "upgrade";
  engine: "templates" | "cdk";
  answers: DeployAnswers;
  release: LoadedRelease;
  deployer: StackDeployer;
  /** Settings and the environment lock. */
  store: ParameterStore;
  secrets: SecretValueStore;
  /** The lock holder (the caller's own ARN). */
  holder: string;
  /** A subset of the mode's order, in that order; default: the whole order for the mode. */
  parts?: DeployPart[];
  onEvent?: (event: DeployEvent) => void;
  /** Passed through to every deploy request when given; only the templates engine consults it. */
  confirm?: DeployRequest["confirm"];
  now?: () => number;
  /** The caller already holds the environment lock (agentx init's step runner): do not take it again. */
  lockHeld?: boolean;
  /** An upgrade reads each deployed stack's parameters here, to keep OPERATOR_PARAMETERS (Task 1 of
   * phase 15e). Required for an upgrade that deploys a part with operator parameters. */
  deployedParameters?: (stackName: string) => Promise<Record<string, string> | undefined>;
  /** CODE-PUBLIC-URL: the operator confirms that a first or changed PublicApiUrl on a running install is an issuer change (public-api-url.ts). */
  confirmPublicApiUrlChange?: boolean;
  /** The parameter names each part's template declares, when the engine knows them better than the
   * release does: the cdk engine's synth of its source (issue 152, prepareDeployment). Omitted, they
   * are read from the release's own templates (templateParameterNames), as the templates engine does. */
  declaredParameters?: (part: DeployPart) => ReadonlySet<string>;
}

export interface DeployEnvironmentResult {
  outputs: Partial<Record<DeployPart, StackOutputs>>;
  settingsWritten: boolean;
  /** Operator parameters an upgrade could not keep because this release's template no longer declares them. */
  droppedParameters: Array<{ stackName: string; parameter: string; value: string }>;
}

/**
 * The exact parameter names the release's template for `part` declares. F24: for the control plane,
 * so `withDeclaredSignIn` below can drop any stored sign-in key that template does not know about —
 * concretely, an environment upgraded to a release built before phase 25a while sign-in settings
 * from a later release are still stored in SSM. A CDK stack's parameter *names* do not vary by
 * region (only default/output values do), so any region the release covers is used here, never
 * `answers.region` specifically: the cdk engine in particular may target a region the release's own
 * pre-synthesized templates do not cover at all (it synthesizes fresh from the checked-out source
 * instead of deploying one of them), and requiring `answers.region` to be one of them here would be
 * its own, unrelated failure. Returns undefined when the release covers no region at all
 * (conceivable for a release meant only for the cdk engine, with no pre-synthesized templates
 * recorded): there is nothing to parse, so the caller falls back to passing every sign-in key
 * through, trusting the freshly cdk-synthesized template — built from that same checked-out source,
 * which always declares them for a named environment — to accept them.
 */
export function templateParameterNames(release: LoadedRelease, part: DeployPart, env: string): ReadonlySet<string> | undefined {
  const [anyRegion] = release.regions();
  // No region at all (a release meant only for the cdk engine, with no pre-synthesized templates
  // recorded): there is nothing here to parse. `withDeclaredSignIn` below then passes every
  // sign-in key through unfiltered rather than dropping them all; if the freshly cdk-synthesized
  // template this deploy actually sends does not declare one of them, CloudFormation itself refuses
  // the deploy loudly, which is far better than this code silently resetting stored sign-in.
  if (anyRegion === undefined) return undefined;
  let template: { Parameters?: Record<string, unknown> };
  try {
    template = JSON.parse(release.template(part, anyRegion, env)) as { Parameters?: Record<string, unknown> };
  } catch {
    // Whether `release.template()` itself failed (a missing or unreadable file) or the text it
    // returned was not valid JSON, a bare SyntaxError (or any other raw error) must never surface
    // here: name the release version and region so the operator knows exactly what to re-fetch.
    throw agentXError(
      "CONFIG_INVALID",
      `the release's ${part} template for ${anyRegion} could not be read; rebuild or re-download release ${release.manifest.version}`,
    );
  }
  return new Set(Object.keys(template.Parameters ?? {}));
}

/**
 * F24's actual "only the keys the template declares" enforcement: drops any of the seven sign-in
 * parameter names from `parameters` that `declared` does not list, leaving every other parameter
 * untouched.
 */
export function withDeclaredSignIn(parameters: Record<string, string>, declared: ReadonlySet<string> | undefined): Record<string, string> {
  // declared === undefined: no region to introspect (see templateParameterNames). Every
  // sign-in key is passed through unfiltered here, deliberately — CloudFormation is left to refuse
  // the deploy loudly if the actual template does not declare one of them, rather than this
  // function silently resetting stored sign-in settings on the operator's behalf.
  if (declared === undefined) return parameters;
  const filtered = { ...parameters };
  for (const name of [...SIGN_IN_PARAMETER_NAMES, ...GITHUB_SIGN_IN_PARAMETER_NAMES]) {
    if (!declared.has(name)) delete filtered[name];
  }
  return filtered;
}

/**
 * F1 L1a-1 (the one carry rule: a parameter an upgrade does not supply keeps its deployed value). The stored sign-in names a Slack team id only when its SSM parameter holds one (it is
 * never stored empty), so a stored sign-in without one supplies nothing for the control plane's SlackTeamId: it is left out here, and the deployed team id is kept. Sending the
 * empty string `stackParameters` writes for it would clear a team id set another way and turn Slack sign-in off. (`agentx signin` itself, which sets the stack from the same
 * settings, still sends the empty value on purpose: parameter-update.ts.)
 */
export function withoutUnsetSlackTeamId(parameters: Record<string, string>, stored: StoredDeveloperSignIn | undefined): Record<string, string> {
  if (stored === undefined || stored.slackTeamId !== undefined || !Object.hasOwn(parameters, "SlackTeamId")) return parameters;
  const rest = { ...parameters };
  delete rest.SlackTeamId;
  return rest;
}

/**
 * Keeps what the operator set (OPERATOR_PARAMETERS) on an upgrade: each listed parameter the answers
 * did not set keeps its deployed value, when the release's template still declares it. One the
 * template no longer declares is reported as dropped and never sent: CloudFormation refuses an
 * unknown parameter. `declared` undefined means the release has no template to read (a cdk-only
 * release): every candidate is kept, and CloudFormation itself refuses one it does not know. A name
 * in SECRET_PARAMETERS is never kept, even if it were listed.
 */
export function keptOperatorParameters(input: {
  part: DeployPart; computed: Record<string, string>; deployed: Record<string, string> | undefined; declared: ReadonlySet<string> | undefined;
}): { kept: Record<string, string>; dropped: Array<{ parameter: string; value: string }> } {
  const kept: Record<string, string> = {};
  const dropped: Array<{ parameter: string; value: string }> = [];
  for (const name of upgradeKeptParameterNames(input.part)) {
    // A secret is never carried: DescribeStacks reads a NoEcho value back as "****", which would
    // overwrite the real secret. The answers always supply secrets themselves.
    if (SECRET_PARAMETERS.has(name)) continue;
    if (Object.hasOwn(input.computed, name)) continue;
    const value = input.deployed?.[name];
    if (value === undefined) continue;
    if (input.declared !== undefined && !input.declared.has(name)) {
      dropped.push({ parameter: name, value });
      continue;
    }
    kept[name] = value;
  }
  return { kept, dropped };
}

/**
 * Ruling F29: the one rule for which of a stack's deployed parameters an upgrade keeps, for
 * `agentx upgrade` and `agentx upgrade --export` alike: the operator's settings (OPERATOR_PARAMETERS)
 * and the secrets. keptOperatorParameters takes its candidates from here (sending each kept operator
 * setting's deployed value); the export marks each UsePreviousValue. A secret's value never leaves
 * AWS: agentx upgrade sends it from Secrets Manager, the export keeps the deployed one.
 *
 * Developer sign-in: both paths send the choice stored in SSM (readStoredDeveloperSignIn, then
 * withDeclaredSignIn), so when SSM and the stack disagree, both apply SSM's; the sign-in
 * parameters SSM does not name (no stored choice, no GitHub sign-in ever, no Slack team id) are
 * kept from the stack like any operator setting (L1a-1). Any other deployed parameter (one set
 * by hand in the console) is carried by the engine on every path, never reset (carry.ts).
 */
export function upgradeKeptParameterNames(part: DeployPart): ReadonlySet<string> {
  return new Set([...OPERATOR_PARAMETERS[part], ...SECRET_PARAMETERS]);
}

/** The control plane's deployed GitHubAppId, which an upgrade keeps when its answers name none.
 * Refused when the deployed stack has no such parameter: nothing to keep, so the answers must name one. */
async function deployedGitHubAppId(read: DeployEnvironmentInput["deployedParameters"], stackName: string): Promise<string> {
  if (read === undefined) {
    throw agentXError("CONFIG_INVALID", "an upgrade must read the deployed stacks' parameters to keep what the operator set; this is an AgentX bug, so report it");
  }
  const value = (await read(stackName))?.GitHubAppId;
  if (value === undefined) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} has no GitHubAppId parameter to keep; name the GitHub App id (github.appId) in the answers`);
  }
  // Empty (read the id from the secret) or a GitHub App id; anything else is not carried forward.
  if (value !== "" && !/^\d+$/.test(value)) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName}'s GitHubAppId parameter is not a GitHub App id (a number); name the GitHub App id (github.appId) in the answers`);
  }
  return value;
}

/** Throws the exact message a missing stack output must report, naming the real (`environment`-naming) stack name. */
function requiredOutput(outputs: Partial<Record<DeployPart, StackOutputs>>, part: DeployPart, name: string, env: string): string {
  const value = outputs[part]?.[name];
  if (value === undefined) throw agentXError("CONFIG_INVALID", `stack ${environmentStackName(env, part)} has no output ${name}`);
  return value;
}

/**
 * Refuses a deploy that cannot proceed against `existing` settings: a legacy-adopted environment
 * (its stacks are not named the way this orchestrator deploys and rewrites settings for), a
 * different engine than it was installed with, an upgrade of an uninstalled environment, or an
 * install over an installed one with no `parts` given. Called both before the lock (a fast, no-op
 * failure that never takes the lock or creates the signing key) and again just after acquiring it
 * (settings read a second time, since the first read happened outside the lock and could be stale).
 */
function assertDeployAllowed(existing: EnvironmentSettings | undefined, mode: "install" | "upgrade", engine: "templates" | "cdk", parts: DeployPart[] | undefined, env: string): void {
  if (existing !== undefined && existing.naming === "legacy") {
    throw agentXError("CONFIG_INVALID", `environment ${env} uses the legacy stack names; upgrading it with agentx deploy is not supported yet`);
  }
  if (existing !== undefined && existing.engine !== engine) {
    throw agentXError("CONFIG_INVALID", `environment ${env} was installed with the ${existing.engine} engine; switching engines is not supported`);
  }
  if (mode === "upgrade" && existing === undefined) {
    throw agentXError("CONFIG_INVALID", `environment ${env} is not installed; install it first`);
  }
  if (mode === "install" && existing !== undefined && parts === undefined) {
    throw agentXError("CONFIG_INVALID", `environment ${env} is already installed; use upgrade`);
  }
}

/** Keep the existing release/region diagnostic for an unreadable selected template. */
function qualifyReleaseBroker(input: DeployEnvironmentInput): void {
  const { release, answers } = input;
  let text: string;
  try {
    text = release.template("control-plane", answers.region, answers.env);
    JSON.parse(text);
  } catch {
    throw agentXError("CONFIG_INVALID", `the release's control-plane template for ${answers.region} could not be read; rebuild or re-download release ${release.manifest.version}`);
  }
  assertBrokerArtifactRunPrices(text);
}

/** Before any secret or stack write, qualify the selected broker, then the effective gateway.
 * Partial upgrades that do not replace the broker must qualify the installed one. */
export async function assertDeployGatewayReady(input: DeployEnvironmentInput, deploySet: ReadonlySet<DeployPart>, declaredFor: (part: DeployPart) => ReadonlySet<string> | undefined): Promise<Record<string, string>> {
  const stackName = environmentStackName(input.answers.env, "control-plane");
  const keepInstalled = input.mode === "upgrade" && (input.answers.coreEngine === undefined || !deploySet.has("control-plane"));
  const computed = keepInstalled ? {} : coreEngineParameters(input.answers.coreEngine);
  const deployed = input.mode === "upgrade" ? await input.deployedParameters?.(stackName) : undefined;
  const kept = keptOperatorParameters({ part: "control-plane", computed, deployed, declared: input.mode === "upgrade" && deploySet.has("control-plane") ? declaredFor("control-plane") : undefined }).kept;
  const effective = { ...kept, ...computed };
  if (input.mode === "install" || deploySet.has("control-plane")) {
    if (input.deployer.qualifyBroker !== undefined) await input.deployer.qualifyBroker();
    else qualifyReleaseBroker(input);
  } else {
    assertBrokerRunPrices(await input.deployer.outputs(stackName));
  }
  const host = effective.CoreModelGatewayHost;
  if (!host || !effective.CoreAgentModel) throw agentXError("CONFIG_INVALID", "coreEngine.modelGatewayUrl and coreEngine.agentModel must both be configured before worker activation; supply coreEngine answers to repair this install");
  await assertGatewayRunPrices(`https://${host}`);
  return effective;
}

/**
 * Runs one install or upgrade: validates the engine, mode and naming against existing settings
 * (before the lock, and again just after taking it), validates your own OIDC provider carries a
 * clientId (also before the lock: without it settings can never be written, so nothing should be
 * deployed first), holds the environment lock for the whole deploy, gets the callback signing key
 * once, deploys every requested part in the mode's order (reading already-existing parts' outputs
 * instead of redeploying them), and — once the control plane's outputs and the identity are both
 * known — writes environment settings.
 */
export async function deployEnvironment(input: DeployEnvironmentInput): Promise<DeployEnvironmentResult> {
  const { mode, engine, answers, release, deployer, store, secrets, holder } = input;
  const env = answers.env;
  const declaredBy = input.declaredParameters;
  const declaredFor = (part: DeployPart): ReadonlySet<string> | undefined => (declaredBy === undefined ? templateParameterNames(release, part, env) : declaredBy(part));
  const now = input.now ?? Date.now;

  assertDeployAllowed(await readEnvironmentSettings(store, env), mode, engine, input.parts, env);
  if (answers.identity.mode === "oidc" && answers.identity.clientId === undefined) {
    throw agentXError("CONFIG_INVALID", "bringing your own OIDC provider requires clientId to write environment settings (needed for agentx login)");
  }
  // F6: refused before the lock and the deploy loop, so nothing deploys. An upgrade that could not
  // read the deployed parameters would reset every operator parameter to its template default.
  // The order and the parts are read once, here, and the deploy loop below uses these same values, so
  // the parts this guard checks are exactly the parts that deploy.
  const fullOrder = mode === "install" ? installOrder(answers.identity.mode) : upgradeOrder(answers.identity.mode);
  const deploySet = new Set(input.parts ?? fullOrder);
  if (mode === "upgrade" && input.deployedParameters === undefined && [...deploySet].some((part) => OPERATOR_PARAMETERS[part].length > 0)) {
    throw agentXError("CONFIG_INVALID", "an upgrade must read the deployed stacks' parameters to keep what the operator set; this is an AgentX bug, so report it");
  }
  // Only an upgrade may leave the GitHub App id out (it keeps the deployed one); an install must name it.
  if (mode === "install" && answers.github.appId === undefined) {
    throw agentXError("CONFIG_INVALID", "an install needs the GitHub App id (github.appId in the answers)");
  }

  // An upgrade whose answers leave github.appId out keeps the control plane's deployed GitHubAppId,
  // even an empty one (the broker then reads the App id from the private-key secret). Checked here,
  // before the lock and the signing key, so a control plane with no such parameter refuses the run.
  const needsKeptAppId = mode === "upgrade" && answers.github.appId === undefined && deploySet.has("control-plane");
  if (needsKeptAppId) await deployedGitHubAppId(input.deployedParameters, environmentStackName(env, "control-plane"));

  await assertDeployGatewayReady(input, deploySet, declaredFor);

  const work = async (): Promise<DeployEnvironmentResult> => {
    // Settings may have changed in the window between the check above and taking the lock (or, with
    // lockHeld, in whatever window the caller's own held lock does not cover); the lock now held (or
    // already held by the caller), this is the authoritative read the rest of the deploy is based on.
    const existing = await readEnvironmentSettings(store, env);
    assertDeployAllowed(existing, mode, engine, input.parts, env);

    let gatewayParameters = await assertDeployGatewayReady(input, deploySet, declaredFor);
    const key = await callbackSigningKey(secrets, env);

    // Extra defense-in-depth, not itself the F24 "only the keys the template declares" fix (that is
    // `withDeclaredSignIn`/`templateParameterNames` below): assertDeployAllowed above already
    // refuses a legacy-named deploy outright, so this never actually triggers today. It stays as a
    // second, explicit guard against ever reading stored sign-in for a legacy-named environment's
    // control plane, in case a later change lets a legacy deploy reach this far. `existing`
    // undefined means a fresh install, which this orchestrator always writes as "environment" naming.
    const environmentNamed = existing === undefined || existing.naming === "environment";
    // R7: a control-plane deploy always carries the stored developer sign-in, so no deploy resets it.
    const developerSignIn = answers.developerSignIn ?? (deploySet.has("control-plane") && environmentNamed ? await readStoredDeveloperSignIn(store, env) : undefined);
    // Read again under the lock: the deploy sends this value, not the one checked before the lock.
    const keptAppId = needsKeptAppId ? await deployedGitHubAppId(input.deployedParameters, environmentStackName(env, "control-plane")) : undefined;
    const github = keptAppId === undefined ? answers.github : { ...answers.github, appId: keptAppId };
    const fullAnswers: InstallAnswers = { ...answers, github, ...(developerSignIn === undefined ? {} : { developerSignIn }), release: release.manifest, callbackSigningKey: key };

    const outputs: Partial<Record<DeployPart, StackOutputs>> = {};
    const droppedParameters: DeployEnvironmentResult["droppedParameters"] = [];
    // CODE-PUBLIC-URL: decided before any stack changes, so a refusal deploys nothing.
    const publicApiUrl = await planFromDeploy({ ...input, env, deploySet });
    const answersWithAddress: InstallAnswers = withPublicApiUrl(fullAnswers, publicApiUrl);

    await readDeploymentOutputs({ existing, deployer, env, fullOrder, deploySet, outputs });

    for (const part of fullOrder) {
      if (!deploySet.has(part)) continue;
      const stackName = environmentStackName(env, part);
      const rawParameters = stackParameters(part, answersWithAddress, outputs, { packages: engine === "templates" });
      // F24: only when this deploy is actually sending a stored sign-in choice to the control plane
      // are the declared parameters even consulted (every other deploy never calls `release.template`).
      let parameters = part === "control-plane" && developerSignIn !== undefined
        ? withoutUnsetSlackTeamId(withDeclaredSignIn(rawParameters, declaredFor("control-plane")), developerSignIn)
        : rawParameters;
      parameters = withDeclaredPublicApiUrlFor(parameters, part, declaredFor);
      if (mode === "upgrade" && OPERATOR_PARAMETERS[part].length > 0) {
        // The F6 guard above already refused this before anything deployed. Never skip carrying the
        // parameters: skipping would reset them to the template defaults, the bug this code prevents.
        if (input.deployedParameters === undefined) {
          throw agentXError("CONFIG_INVALID", "an upgrade must read the deployed stacks' parameters to keep what the operator set; this is an AgentX bug, so report it");
        }
        const deployed = await input.deployedParameters(stackName);
        // The template is read only when there is something to keep: most upgrades read none.
        const candidates = OPERATOR_PARAMETERS[part].filter((name) => deployed?.[name] !== undefined && !Object.hasOwn(parameters, name));
        const declared = candidates.length === 0 ? undefined : declaredFor(part);
        const { kept, dropped } = keptOperatorParameters({ part, computed: parameters, deployed, declared });
        parameters = { ...kept, ...parameters };
        droppedParameters.push(...dropped.map((entry) => ({ stackName, ...entry })));
        const keptFromAnswers = part === "control-plane" && keptAppId !== undefined ? ["GitHubAppId"] : [];
        if (candidates.length > 0 || keptFromAnswers.length > 0) {
          input.onEvent?.({ kind: "kept", stackName, kept: [...Object.keys(kept), ...keptFromAnswers], dropped: dropped.map((entry) => entry.parameter) });
        }
      }
      const roleArn = part === "access" ? undefined : requiredOutput(outputs, "access", "CloudFormationRoleArn", env);
      const request: DeployRequest = {
        part,
        stackName,
        parameters,
        terminationProtection: PROTECTED_PARTS.has(part),
        ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
        ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
        ...(roleArn === undefined ? {} : { roleArn }),
      };
      if (part === "control-plane") gatewayParameters = parameters;
      if (part === "runtime") {
        assertBrokerRunPrices(outputs["control-plane"]);
        await assertGatewayRunPrices(`https://${gatewayParameters.CoreModelGatewayHost}`);
      }
      outputs[part] = await deployer.deploy(request);
    }

    const controlPlaneOutputs = outputs["control-plane"];
    const identityKnown = answers.identity.mode === "cognito" ? outputs.identity !== undefined : answers.identity.clientId !== undefined;
    if (controlPlaneOutputs === undefined || !identityKnown) return { outputs, settingsWritten: false, droppedParameters };

    const identitySettings = identitySettingsFor(answers.identity, outputs, env);

    const foundationStack = outputs.foundation === undefined ? undefined : environmentStackName(env, "foundation");
    const runtimeStack = outputs.runtime === undefined ? undefined : environmentStackName(env, "runtime");
    const controlPlaneStack = environmentStackName(env, "control-plane");
    const slackStack = outputs.slack === undefined ? undefined : environmentStackName(env, "slack");
    if (foundationStack === undefined || runtimeStack === undefined || slackStack === undefined) {
      // Every part this environment needs (foundation, runtime, control-plane, slack) is required by
      // the settings schema; if control-plane is known but one of the others somehow is not, nothing
      // was written rather than writing settings that lie about what is deployed.
      return { outputs, settingsWritten: false, droppedParameters };
    }

    const settings: EnvironmentSettings = {
      schemaVersion: 1,
      env,
      account: answers.account,
      region: answers.region,
      engine,
      version: release.manifest.version,
      naming: "environment",
      stacks: {
        ...(outputs.access === undefined ? {} : { access: environmentStackName(env, "access") }),
        foundation: foundationStack,
        ...(outputs.identity === undefined ? {} : { identity: environmentStackName(env, "identity") }),
        runtime: runtimeStack,
        "control-plane": controlPlaneStack,
        slack: slackStack,
      },
      // CODE-PUBLIC-URL: the control plane's permanent address where the install has one (what `agentx login` names and the sign-in callbacks are built on), else its API endpoint, as before.
      controlPlaneUrl: controlPlaneUrlOf(controlPlaneOutputs, () => requiredOutput(outputs, "control-plane", "ApiEndpoint", env)),
      identity: identitySettings,
      models: answers.models,
      // F16: set after install (agentx setup alerts, agentx config set alerts.address); no deploy's answers carry it.
      ...(existing?.alertAddress === undefined ? {} : { alertAddress: existing.alertAddress }),
      ...(outputs.access === undefined
        ? {}
        : {
            access: {
              artifactBucket: requiredOutput(outputs, "access", "ArtifactBucketName", env),
              cloudFormationRoleArn: requiredOutput(outputs, "access", "CloudFormationRoleArn", env),
              operatorRoleArn: requiredOutput(outputs, "access", "OperatorRoleArn", env),
              pullThroughPrefix: requiredOutput(outputs, "access", "PullThroughPrefix", env),
              ...(answers.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: answers.permissionsBoundaryArn }),
            },
          }),
      updatedAt: new Date(now()).toISOString(),
    };
    await writeEnvironmentSettings(store, settings, { onLegacyKeysDropped: (keys) => input.onEvent?.({ kind: "settings-legacy-keys-dropped", env, keys }) });
    return { outputs, settingsWritten: true, droppedParameters };
  };

  if (input.lockHeld === true) {
    const holdingArn = await currentLockHolder(store, env);
    if (holdingArn !== holder) {
      throw agentXError("CONFIG_INVALID", `environment ${env}'s lock is not held by ${holder}; lockHeld only skips taking a lock the caller already holds, and this caller does not currently hold it`);
    }
    return work();
  }
  return withEnvironmentLock({ store, env, holder, command: `deploy ${mode}`, now }, work);
}

/**
 * The settings identity block: from the identity stack's outputs for Cognito, or from the answers
 * for your own OIDC provider (clientId is required there to write settings — needed for `agentx
 * login` — since there is no identity stack's ClientId output to read it from instead). The caller
 * only reaches this once `identityKnown` has already confirmed the source it names is present, and
 * `deployEnvironment` itself already refused a missing OIDC clientId before ever taking the lock.
 */
function identitySettingsFor(identity: DeployAnswers["identity"], outputs: Partial<Record<DeployPart, StackOutputs>>, env: string): EnvironmentSettings["identity"] {
  if (identity.mode === "cognito") {
    return {
      mode: "cognito",
      issuer: requiredOutput(outputs, "identity", "Issuer", env),
      audience: requiredOutput(outputs, "identity", "Audience", env),
      clientId: requiredOutput(outputs, "identity", "ClientId", env),
    };
  }
  if (identity.clientId === undefined) {
    throw agentXError("CONFIG_INVALID", "bringing your own OIDC provider requires clientId to write environment settings (needed for agentx login)");
  }
  return { mode: "oidc", issuer: identity.issuer, audience: identity.audience, clientId: identity.clientId };
}

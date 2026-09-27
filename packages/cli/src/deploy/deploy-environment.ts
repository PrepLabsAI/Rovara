// The deploy orchestrator: ties a stack deployer engine to install/upgrade order, the environment
// lock, the callback signing key and environment settings. Phase 15d's `agentx init`/`agentx
// upgrade` build a StackDeployer (the templates or cdk engine), collect DeployAnswers, and call
// deployEnvironment; everything else (order, outputs feeding forward, the lock, settings) lives here.
import { agentXError, environmentStackName } from "@agentx/contracts";
import { PROTECTED_PARTS, type DeployEvent, type DeployRequest, type StackDeployer } from "./deployer.js";
import { currentLockHolder, withEnvironmentLock } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { installOrder, stackParameters, upgradeOrder, type DeployPart, type InstallAnswers, type StackOutputs } from "./parameters.js";
import type { LoadedRelease } from "./release.js";
import { callbackSigningKey, type SecretValueStore } from "./signing-key.js";

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
}

export interface DeployEnvironmentResult {
  outputs: Partial<Record<DeployPart, StackOutputs>>;
  settingsWritten: boolean;
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
  const now = input.now ?? Date.now;

  assertDeployAllowed(await readEnvironmentSettings(store, env), mode, engine, input.parts, env);
  if (answers.identity.mode === "oidc" && answers.identity.clientId === undefined) {
    throw agentXError("CONFIG_INVALID", "bringing your own OIDC provider requires clientId to write environment settings (needed for agentx login)");
  }

  const work = async (): Promise<DeployEnvironmentResult> => {
    // Settings may have changed in the window between the check above and taking the lock (or, with
    // lockHeld, in whatever window the caller's own held lock does not cover); the lock now held (or
    // already held by the caller), this is the authoritative read the rest of the deploy is based on.
    const existing = await readEnvironmentSettings(store, env);
    assertDeployAllowed(existing, mode, engine, input.parts, env);

    const key = await callbackSigningKey(secrets, env);
    const fullAnswers: InstallAnswers = { ...answers, release: release.manifest, callbackSigningKey: key };

    const fullOrder = mode === "install" ? installOrder(answers.identity.mode) : upgradeOrder(answers.identity.mode);
    const deploySet = new Set(input.parts ?? fullOrder);
    const outputs: Partial<Record<DeployPart, StackOutputs>> = {};

    if (existing !== undefined) {
      // Every part this environment already has settings for supplies its outputs by reading the
      // existing stack, whether or not it is also being (re)deployed below: a part deployed on its
      // own (`--parts slack`) still needs the current outputs of the parts it is not redeploying.
      for (const part of Object.keys(existing.stacks) as DeployPart[]) {
        const knownStackName = existing.stacks[part];
        if (knownStackName === undefined) continue;
        const fetched = await deployer.outputs(knownStackName);
        if (fetched === undefined) {
          // access and identity are optional in the settings schema: silently treating a stack
          // settings names as gone would just drop it from the rewritten settings below, hiding a
          // real inconsistency (the recorded stack no longer reports outputs) as if it had never
          // existed. The other four parts are required by the schema, so the same silent loss
          // cannot happen for them: either something downstream needs their output and
          // `stackParameters` already names what is missing, or nothing does and settings simply
          // are not written (see the foundation/runtime/slack check below).
          if (part === "access" || part === "identity") {
            throw agentXError("CONFIG_INVALID", `stack ${knownStackName} (environment ${env}'s ${part} stack) no longer reports outputs; its settings may be stale`);
          }
          continue;
        }
        outputs[part] = fetched;
      }
    } else {
      // No settings yet: this may be a fresh install resuming after an earlier partial failure.
      // Whatever isn't being (re)deployed this run may already exist from that earlier attempt;
      // probe it directly by the name this orchestrator would have used. A part whose stack does
      // not exist yet yields no outputs, exactly as `deployer.outputs` documents; `stackParameters`
      // reports clearly whatever a later part still needs and does not have.
      for (const part of fullOrder) {
        if (deploySet.has(part)) continue;
        const fetched = await deployer.outputs(environmentStackName(env, part));
        if (fetched !== undefined) outputs[part] = fetched;
      }
    }

    for (const part of fullOrder) {
      if (!deploySet.has(part)) continue;
      const stackName = environmentStackName(env, part);
      const parameters = stackParameters(part, fullAnswers, outputs);
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
      outputs[part] = await deployer.deploy(request);
    }

    const controlPlaneOutputs = outputs["control-plane"];
    const identityKnown = answers.identity.mode === "cognito" ? outputs.identity !== undefined : answers.identity.clientId !== undefined;
    if (controlPlaneOutputs === undefined || !identityKnown) return { outputs, settingsWritten: false };

    const identitySettings = identitySettingsFor(answers.identity, outputs, env);

    const foundationStack = outputs.foundation === undefined ? undefined : environmentStackName(env, "foundation");
    const runtimeStack = outputs.runtime === undefined ? undefined : environmentStackName(env, "runtime");
    const controlPlaneStack = environmentStackName(env, "control-plane");
    const slackStack = outputs.slack === undefined ? undefined : environmentStackName(env, "slack");
    if (foundationStack === undefined || runtimeStack === undefined || slackStack === undefined) {
      // Every part this environment needs (foundation, runtime, control-plane, slack) is required by
      // the settings schema; if control-plane is known but one of the others somehow is not, nothing
      // was written rather than writing settings that lie about what is deployed.
      return { outputs, settingsWritten: false };
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
      controlPlaneUrl: requiredOutput(outputs, "control-plane", "ApiEndpoint", env),
      identity: identitySettings,
      models: answers.models,
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
    await writeEnvironmentSettings(store, settings);
    return { outputs, settingsWritten: true };
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

// Saved environment images, hosted (lane L4-SE6; the binding contract is briefs/lead4/L4-SE-OUTPUT-CONTRACT.md): what the stack that creates the image roles and the repository creation template
// (agentx-<env>-control-plane, named environments only) publishes, and what it gives the broker. Pure names: the infrastructure (infra/lib/saved-env-images.ts) writes them, the broker's role-session
// seam (broker/src/aws/saved-env-role-sessions.ts) reads the variables, and `agentx config set savedEnvironments.switch on` reads the outputs to decide whether the registry is there.

/** The CloudFormation output keys. `SavedEnvRegistryReady` is "1" only when the three roles AND the creation template are in the same template. */
export const SAVED_ENV_OUTPUT_PUSH_ROLE_ARN = "SavedEnvImgPushRoleArn";
export const SAVED_ENV_OUTPUT_PULL_ROLE_ARN = "SavedEnvImgPullRoleArn";
export const SAVED_ENV_OUTPUT_MANAGE_ROLE_ARN = "SavedEnvImgManageRoleArn";
export const SAVED_ENV_OUTPUT_REPO_PREFIX = "SavedEnvRepoPrefix";
export const SAVED_ENV_OUTPUT_REGISTRY_READY = "SavedEnvRegistryReady";
export const SAVED_ENV_REGISTRY_OUTPUT_KEYS = [
  SAVED_ENV_OUTPUT_PUSH_ROLE_ARN, SAVED_ENV_OUTPUT_PULL_ROLE_ARN, SAVED_ENV_OUTPUT_MANAGE_ROLE_ARN, SAVED_ENV_OUTPUT_REPO_PREFIX, SAVED_ENV_OUTPUT_REGISTRY_READY,
] as const;
export const SAVED_ENV_REGISTRY_READY_VALUE = "1";

/** The broker's environment variables for the same four values (set by the control plane's template, named environments only). A missing variable means saved environments are not set up on this install. */
export const SAVED_ENV_PUSH_ROLE_ARN_VARIABLE = "ROVARA_SAVED_ENV_PUSH_ROLE_ARN";
export const SAVED_ENV_PULL_ROLE_ARN_VARIABLE = "ROVARA_SAVED_ENV_PULL_ROLE_ARN";
export const SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE = "ROVARA_SAVED_ENV_MANAGE_ROLE_ARN";
export const SAVED_ENV_REPO_PREFIX_VARIABLE = "ROVARA_SAVED_ENV_REPO_PREFIX";

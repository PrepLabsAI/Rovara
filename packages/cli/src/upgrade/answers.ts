// agentx upgrade's deploy answers, from the environment itself: the settings (FR-003's source of
// truth) for account, region, models and identity; the deployed stacks' own parameters for what the
// settings do not hold (the GitHub App, your own OIDC provider's admin claim, the operator
// principal). Operator-set parameters are carried by deployEnvironment (Task 1), not here, and the
// callback signing key comes from Secrets Manager.
import { writeFile } from "node:fs/promises";
import { agentXError } from "@agentx/contracts";
import { MAX_BUDGET_USD } from "../deploy/answer-schemas.js";
import { UpgradeDeployAnswersSchema } from "../deploy/commands.js";
import type { DeployAnswers } from "../deploy/deploy-environment.js";
import type { StackReader } from "../environments/adopt.js";
import type { EnvironmentSettings } from "../environments/settings.js";

export async function upgradeAnswers(input: { settings: EnvironmentSettings; stacks: StackReader; images?: { worker?: string; slack?: string } }): Promise<DeployAnswers> {
  const { settings } = input;
  const controlPlaneName = settings.stacks["control-plane"];
  const controlPlane = await input.stacks.describe(controlPlaneName);
  if (controlPlane === undefined) throw agentXError("CONFIG_INVALID", `stack ${controlPlaneName} does not exist; agentx doctor says what else is missing`);
  const parameter = (name: string): string => {
    const value = controlPlane.parameters[name];
    if (value === undefined || value === "") throw agentXError("CONFIG_INVALID", `stack ${controlPlaneName} has no ${name} parameter; run agentx doctor, and agentx init --resume if the install never finished`);
    return value;
  };
  let identity: DeployAnswers["identity"];
  if (settings.identity.mode === "cognito") {
    identity = { mode: "cognito" };
  } else {
    let adminValues: unknown;
    try { adminValues = JSON.parse(parameter("AdminValues")); } catch { adminValues = undefined; }
    if (!Array.isArray(adminValues) || adminValues.length === 0 || !adminValues.every((value) => typeof value === "string" && value !== "")) {
      throw agentXError("CONFIG_INVALID", `stack ${controlPlaneName}'s AdminValues parameter is not a list of admin values; fix it in the CloudFormation console, then run agentx upgrade again`);
    }
    identity = { mode: "oidc", issuer: settings.identity.issuer, audience: settings.identity.audience, clientId: settings.identity.clientId, adminClaim: parameter("AdminClaim"), adminValues: adminValues as string[] };
  }
  const credentialRef = controlPlane.parameters.GitHubAppCredentialRef;
  // Empty is an install's own: its control plane deployed before the GitHub App, and reads the id
  // from the private-key secret. The upgrade keeps it empty.
  const appId = controlPlane.parameters.GitHubAppId === "" ? "" : parameter("GitHubAppId");
  if (appId !== "" && !/^\d+$/.test(appId)) throw agentXError("CONFIG_INVALID", `stack ${controlPlaneName}'s GitHubAppId parameter is not a GitHub App id (a number); run agentx doctor, and agentx init --resume if the install never finished`);
  const privateKeySecretArn = parameter("GitHubAppPrivateKeySecretArn");
  if (!privateKeySecretArn.startsWith("arn:")) throw agentXError("CONFIG_INVALID", `stack ${controlPlaneName}'s GitHubAppPrivateKeySecretArn parameter is not an ARN; run agentx doctor, and agentx init --resume if the install never finished`);
  // An access stack the settings name but that is gone is refused, never read as "no operator
  // principal": the upgrade would otherwise deploy it again without one. An empty value is the
  // install's own choice (the parameter's default).
  let operatorPrincipalArn: string | undefined;
  if (settings.stacks.access !== undefined) {
    const access = await input.stacks.describe(settings.stacks.access);
    if (access === undefined) throw agentXError("CONFIG_INVALID", `stack ${settings.stacks.access} does not exist; agentx doctor says what else is missing`);
    operatorPrincipalArn = access.parameters.OperatorPrincipalArn;
  }
  const images = input.images === undefined || (input.images.worker === undefined && input.images.slack === undefined) ? undefined : {
    ...(input.images.worker === undefined ? {} : { worker: input.images.worker }),
    ...(input.images.slack === undefined ? {} : { slack: input.images.slack }),
  };
  return {
    env: settings.env,
    region: settings.region,
    account: settings.account,
    models: settings.models,
    identity,
    github: { appId, privateKeySecretArn, ...(credentialRef === undefined || credentialRef === "" ? {} : { credentialRef }) },
    ...(settings.access?.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: settings.access.permissionsBoundaryArn }),
    ...(operatorPrincipalArn === undefined || operatorPrincipalArn === "" ? {} : { operatorPrincipalArn }),
    ...(images === undefined ? {} : { images }),
  };
}

/**
 * `agentx upgrade --answers-from-deployed <file>`: the answers `agentx deploy --mode upgrade --answers`
 * reads, from the environment itself, without deploying anything and for either engine. The answers
 * come from upgradeAnswers (the settings and the deployed stacks), plus the control plane's deployed
 * budget and posted-message choice. An empty deployed GitHubAppId is written as no appId at all: an
 * upgrade then keeps the deployed (empty) one. The file is checked against the upgrade answers schema
 * before it is written, and an existing file is never overwritten. No secret is in it: the callback
 * signing key and every provider key stay in Secrets Manager (only ARNs are written).
 */
export async function writeAnswersFromDeployed(input: {
  file: string; settings: EnvironmentSettings; stacks: StackReader; images?: { worker?: string; slack?: string };
}): Promise<{ file: string }> {
  const answers = await upgradeAnswers({ settings: input.settings, stacks: input.stacks, ...(input.images === undefined ? {} : { images: input.images }) });
  const controlPlaneName = input.settings.stacks["control-plane"];
  // upgradeAnswers has already refused a missing control-plane stack.
  const deployed = (await input.stacks.describe(controlPlaneName))?.parameters ?? {};
  const budget = deployedBudget(deployed, controlPlaneName);
  const posted = deployed.SlackAppPostedMessages;
  if (posted !== undefined && posted !== "" && posted !== "accept" && posted !== "ignore") {
    throw agentXError("CONFIG_INVALID", `stack ${controlPlaneName}'s SlackAppPostedMessages parameter is not accept or ignore; nothing was written`);
  }
  const { appId, ...github } = answers.github;
  const file = {
    env: answers.env,
    region: answers.region,
    account: answers.account,
    ...(answers.partition === undefined ? {} : { partition: answers.partition }),
    models: answers.models,
    identity: answers.identity,
    github: { ...(appId === undefined || appId === "" ? {} : { appId }), ...github },
    ...(answers.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: answers.permissionsBoundaryArn }),
    ...(answers.operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn: answers.operatorPrincipalArn }),
    ...(answers.images === undefined ? {} : { images: answers.images }),
    ...(posted === "accept" || posted === "ignore" ? { slackAppPostedMessages: posted } : {}),
    ...(budget === undefined ? {} : { budget }),
  };
  const checked = UpgradeDeployAnswersSchema.safeParse(file);
  if (!checked.success) {
    throw agentXError("CONFIG_INVALID", `the answers read from environment ${answers.env} do not form valid upgrade answers (${checked.error.issues[0]?.path.join(".") ?? "?"}); nothing was written`);
  }
  try {
    await writeFile(input.file, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw agentXError("CONFIG_INVALID", `${input.file} already exists; choose a new file`);
    throw error;
  }
  return { file: input.file };
}

/** The control plane's deployed budget as an answer: none for an absent, empty or "0" budget; refused when malformed. */
function deployedBudget(parameters: Record<string, string>, stackName: string): { monthlyUsd: number; scope: "tag" | "account" } | undefined {
  const amount = parameters.BudgetMonthlyUsd;
  if (amount === undefined || amount === "" || amount === "0") return undefined;
  const scope = parameters.BudgetScope;
  const monthlyUsd = /^\d+$/.test(amount) ? Number(amount) : Number.NaN;
  if (!Number.isSafeInteger(monthlyUsd) || monthlyUsd > MAX_BUDGET_USD || (scope !== "tag" && scope !== "account")) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName}'s budget parameters (BudgetMonthlyUsd, BudgetScope) are not a budget agentx accepts; nothing was written`);
  }
  return { monthlyUsd, scope };
}

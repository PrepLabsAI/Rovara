// FR-017 and FR-022: before anything is created, show every stack, role, secret, app and setting
// init will create, and an estimated monthly cost at a stated usage, then ask. Prices are us-east-1
// list prices checked on the date in PRICES_CHECKED; the orchestrator per-turn figures come from the
// 2026-09-25 evaluation in the spec's Decisions.
import {
  defaultBoundaryName, environmentCloudFormationRoleName, environmentOperatorRoleName, environmentRolePath, environmentStackName,
} from "@agentx/contracts";
import { installOrder } from "../deploy/parameters.js";
import { callbackSigningKeySecretName } from "../deploy/signing-key.js";
import { openRouterSecretName } from "./answers.js";
import { count, estimateMonthlyCost, modelName, money, notCounted, PRICES_CHECKED, STATED_USAGE, type CostEstimate } from "./cost.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter } from "./prompts.js";
import { operatorStop } from "./stop.js";

export { estimateMonthlyCost, STATED_USAGE, type CostEstimate, type CostLine } from "./cost.js";

/** What the plan must say beyond the answers: an OpenRouter key init stores itself has no ARN yet. */
export interface PlanExtras { storesOpenRouterKey?: boolean; openRouterProviders?: readonly string[] }

export function installPlanText(answers: InitAnswers, estimate: CostEstimate, notes: readonly string[], extras: PlanExtras = {}): string {
  const { env } = answers;
  const stacks = installOrder(answers.identity.mode).map((part) => environmentStackName(env, part));
  const boundary = answers.permissionsBoundaryArn ?? defaultBoundaryName(env);
  const secrets = [
    callbackSigningKeySecretName(env), `agentx/${env}/github-app`, `agentx/${env}/slack`,
    ...(answers.alert.kind === "webhook" ? [answers.alert.secretName] : []),
    ...(extras.storesOpenRouterKey === true ? [openRouterSecretName(env)] : []),
  ];
  const routing = (providers: readonly string[] | undefined) => `provider allowlist ${providers?.join(", ") ?? "router-selected"}; fallbacks disabled, data_collection=deny`;
  const alerts = answers.alert.kind === "email"
    ? `email to ${answers.alert.address}`
    : answers.alert.kind === "webhook"
      ? `${answers.alert.display} (the full address is kept in ${answers.alert.secretName})`
      : "none";
  const provider = (role: "orchestrator" | "classifier" | "worker") => (answers.models.providers?.[role] === "openrouter" ? "OpenRouter" : "Amazon Bedrock");
  const engine = answers.engine === "templates" ? "published templates" : "AgentX's source code";
  const lines = [
    `AgentX will create the install ${env} in AWS account ${answers.account} (${answers.region}), from release ${answers.releaseVersion} with ${engine}:`,
    `- Stacks, in this order: ${stacks.join(", ")}`,
    `- IAM roles ${environmentCloudFormationRoleName(env)} (CloudFormation deploys through it) and ${environmentOperatorRoleName(env)} (day-2 commands), and the permission boundary ${boundary}, which every AgentX role carries; the stacks' own roles live under the IAM path ${environmentRolePath(env)}`,
    `- Secrets ${secrets.join(", ")}`,
    `- Settings under /agentx/${env}/`,
    `- In GitHub: an app named "${answers.github.appName}" owned by ${answers.github.account}, with read and write access to contents, pull requests and issues, and read access to metadata. No webhook.`,
    `- In Slack: an app named "${answers.slack.appName}".`,
    `- Models: main model ${modelName(answers.models.orchestrator)} (${provider("orchestrator")}), safety check model ${modelName(answers.models.classifier)} (${provider("classifier")}), coding model ${modelName(answers.models.worker)} (${provider("worker")})`,
    ...(answers.models.openRouter ? [`- OpenRouter: read existing secret ${answers.models.openRouter.secretArn}; ${routing(answers.models.openRouter.providers)}`] : []),
    ...(extras.storesOpenRouterKey === true ? [`- OpenRouter: your API key is stored in the new secret ${openRouterSecretName(env)}; ${routing(extras.openRouterProviders)}`] : []),
    `- Alerts: ${alerts}${answers.alert.kind === "none" ? "" : ", subscribed and tested at the end of the install"}`,
    answers.budget === undefined
      ? "- Budget: none"
      : `- Budget agentx-${env}-monthly: $${answers.budget.monthlyUsd} a month for ${answers.budget.scope === "tag" ? `costs tagged agentx:env=${env}` : "the whole account"}, alerting at 80% spent and 100% forecast`,
    `- AgentX never answers itself or other bots. Messages other apps post for people: ${answers.slack.appPostedMessages === "accept" ? "answered" : "ignored"}.`,
    ...notes.map((note) => `Note: ${note}`),
    "",
    "Estimated monthly cost:",
    ...estimate.lines.map((line) => `  ${(line.usd === undefined ? "not priced" : money(line.usd)).padStart(10)}  ${line.item} (${line.basis})`),
    `Estimated monthly total: ${money(estimate.totalUsd)} at ${count(STATED_USAGE.turnsPerMonth)} turns, ${count(STATED_USAGE.workerSessionsPerMonth)} coding sessions and ${STATED_USAGE.workerInstanceHoursPerMonth} machine-hours a month (us-east-1 list prices, ${PRICES_CHECKED}; your bill will differ)${notCounted(estimate).length > 0 ? `, not counting ${notCounted(estimate).join(" and ")}, whose price is not on file` : ""}.`,
    "",
    "To remove everything later, use the remove command in the ready summary. It deletes the coding machines' disks too.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function confirmInstallPlan(input: { answers: InitAnswers; notes: readonly string[]; prompter: Prompter; write: (text: string) => void; extras?: PlanExtras }): Promise<void> {
  input.write(installPlanText(input.answers, estimateMonthlyCost(input.answers.models), input.notes, input.extras));
  if (!(await input.prompter.confirm("Create all of this?", { defaultValue: false }))) {
    throw operatorStop("install declined; nothing was created");
  }
}

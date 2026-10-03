// FR-017 and FR-022: before anything is created, show every stack, role, secret, app and setting
// init will create, and an estimated monthly cost at a stated usage, then ask. Prices are us-east-1
// list prices checked on the date in PRICES_CHECKED; the orchestrator per-turn figures come from the
// 2026-09-25 evaluation in the spec's Decisions.
import {
  keyedProviderSecretName, KEYED_MODEL_PROVIDERS, defaultBoundaryName, environmentCloudFormationRoleName, environmentOperatorRoleName, environmentRolePath, environmentStackName,
} from "@agentx/contracts";
import type { DirectProvider } from "../deploy/answer-schemas.js";
import { installOrder } from "../deploy/parameters.js";
import { callbackSigningKeySecretName } from "../deploy/signing-key.js";
import { openRouterSecretName } from "./answers.js";
import { count, estimateMonthlyCost, modelName, money, notCounted, PRICES_CHECKED, STATED_USAGE, type CostEstimate } from "./cost.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter } from "./prompts.js";
import { operatorStop } from "./stop.js";
import { minutesText, phaseSeconds } from "./ui/journey.js";
import type { WizardPlan } from "./ui/protocol.js";

export { estimateMonthlyCost, STATED_USAGE, type CostEstimate, type CostLine } from "./cost.js";

/** What the plan must say beyond the answers: a key init stores itself has no ARN yet. */
export interface PlanExtras { storesOpenRouterKey?: boolean; openRouterProviders?: readonly string[]; storesProviderKeys?: readonly DirectProvider[] }

export function installPlanText(answers: InitAnswers, estimate: CostEstimate, notes: readonly string[], extras: PlanExtras = {}): string {
  const { env } = answers;
  const stacks = installOrder(answers.identity.mode).map((part) => environmentStackName(env, part));
  const boundary = answers.permissionsBoundaryArn ?? defaultBoundaryName(env);
  const secrets = [
    callbackSigningKeySecretName(env), `agentx/${env}/github-app`, `agentx/${env}/slack`,
    ...(answers.alert.kind === "webhook" ? [answers.alert.secretName] : []),
    ...(extras.storesOpenRouterKey === true ? [openRouterSecretName(env)] : []),
    ...(extras.storesProviderKeys ?? []).map((provider) => keyedProviderSecretName(env, provider)),
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
    ...(["anthropic", "openai"] as const).flatMap((provider) => {
      const { label } = KEYED_MODEL_PROVIDERS[provider];
      const existing = answers.models[provider]?.secretArn;
      if (existing !== undefined) return [`- ${label}: read existing secret ${existing}`];
      return extras.storesProviderKeys?.includes(provider) === true ? [`- ${label}: your API key is stored in the new secret ${keyedProviderSecretName(env, provider)}`] : [];
    }),
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

export type PlanAction = "create" | "change";

/** The plan's opening sentence for "In AWS": what the build creates, named plainly rather than by
 * stack (the stacks themselves are "Show every resource" only). */
const BUILD_PARTS = "The network and sign-in, the AgentX service and the Slack connection";

/** FR-029 and FR-030: what the plan says, in plain words, for the page's review screen. The full
 * text (`installPlanText`) still goes to the log file; its stack, role and secret lines become
 * `resources`, shown only behind "Show every resource" (they name flags, commands and spec phases
 * the copy-lint bans everywhere else on the page). */
export function planSummary(answers: InitAnswers, estimate: CostEstimate, notes: readonly string[], extras: PlanExtras = {}): WizardPlan {
  const signin = answers.signinMethods ?? "slack";
  const signinWords = signin === "slack" ? "with Slack" : signin === "oidc" ? "with your company sign-in" : "with Slack or your company sign-in";
  const alerts = answers.alert.kind === "email"
    ? `Alerts go to ${answers.alert.address}. AWS sends a confirmation email there while the build runs.`
    : answers.alert.kind === "webhook"
      ? `Alerts go to ${answers.alert.display}. It is subscribed while the build runs.`
      : "Alerts go nowhere for now. Nobody is told when AgentX stops working.";
  const missing = notCounted(estimate);
  const full = installPlanText(answers, estimate, notes, extras).split("\n");
  return {
    intro: "Here is what AgentX will create. Nothing is created until you press Create AgentX.",
    sections: [
      {
        title: "In AWS",
        lines: [
          `${BUILD_PARTS}, in AWS account ${answers.account} (${answers.region}).`,
          `Building them takes ${minutesText(Math.ceil(phaseSeconds("build") / 60))}, and you can leave while it runs.`,
        ],
      },
      { title: "In GitHub", lines: [`An app named "${answers.github.appName}" owned by ${answers.github.account}. It can read code and open pull requests in the repositories you choose.`] },
      {
        title: "In Slack",
        lines: [
          `An app named "${answers.slack.appName}" in the Slack workspace you choose.`,
          `Developers sign in to AgentX ${signinWords}. It is turned on with the Slack connection, with no separate approval.`,
        ],
      },
      {
        title: "Budget and alerts",
        lines: [
          answers.budget === undefined
            ? "No budget alert."
            : answers.budget.scope === "tag"
              ? `A budget alert at $${answers.budget.monthlyUsd} a month for AgentX's own costs, counted once someone with billing rights turns on its billing tag (up to a day later).`
              : `A budget alert at $${answers.budget.monthlyUsd} a month for the whole account.`,
          alerts,
        ],
      },
      { title: "To remove it later", lines: ["The ready screen gives you the command that removes everything, the coding machines' disks too."] },
    ],
    cost: {
      rows: estimate.lines.map((line) => ({ item: line.item, monthly: line.usd === undefined ? "not priced" : money(line.usd), basis: line.basis })),
      total: `About ${money(estimate.totalUsd)} a month${missing.length === 0 ? "" : `, not counting ${missing.join(" and ")}, whose price is not on file`}.`,
      usage: `At ${count(STATED_USAGE.turnsPerMonth)} turns, ${count(STATED_USAGE.workerSessionsPerMonth)} coding sessions and ${STATED_USAGE.workerInstanceHoursPerMonth} machine-hours a month, at us-east-1 list prices of ${PRICES_CHECKED}. Your bill will differ.`,
    },
    resources: full
      .filter((line) => line.startsWith("- Stacks") || line.startsWith("- IAM roles") || line.startsWith("- Secrets") || line.startsWith("- Settings"))
      .map((line) => line.slice(2)),
  };
}

export async function confirmInstallPlan(input: {
  answers: InitAnswers; notes: readonly string[]; prompter: Prompter; write: (text: string) => void; extras?: PlanExtras;
  /** The page asks Create AgentX and Change answers; the terminal keeps its own yes/no confirm, where
   * no is a stop and never a change. */
  page: boolean;
  /** The page's own review screen, built from the same answers and estimate as the log text. */
  show?: (plan: WizardPlan) => void;
}): Promise<PlanAction> {
  const estimate = estimateMonthlyCost(input.answers.models);
  input.write(installPlanText(input.answers, estimate, input.notes, input.extras));
  if (input.page) {
    input.show?.(planSummary(input.answers, estimate, input.notes, input.extras));
    // FR-029: Create AgentX is the primary button; Change answers goes back with every answer kept.
    return input.prompter.choose<PlanAction>("Create all of this?", [
      { value: "create", label: "Create AgentX" },
      { value: "change", label: "Change answers" },
    ], { flag: "--plan", defaultValue: "create" });
  }
  if (!(await input.prompter.confirm("Create all of this?", { defaultValue: false }))) throw operatorStop("install declined; nothing was created");
  return "create";
}

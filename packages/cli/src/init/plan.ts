// FR-017 and FR-022: before anything is created, show every stack, role, secret, app and setting
// init will create, and an estimated monthly cost at a stated usage, then ask. Prices are us-east-1
// list prices checked on the date in PRICES_CHECKED; the orchestrator per-turn figures come from the
// 2026-09-25 evaluation in the spec's Decisions.
//
// AgentCore may add its own charge on top of the EC2 and EBS lines below for the instances-ebs
// capacity provider mode; that charge is not confirmed here (Task 6 is a plan estimate, not a
// billed observation) and is called out in the plan text and the unpriced list. The real bill is
// checked during the live test (phase 15d1's manual verification step), not assumed here.
import {
  agentXError, defaultBoundaryName, environmentCloudFormationRoleName, environmentOperatorRoleName, environmentRolePath, environmentStackName,
} from "@agentx/contracts";
import { installOrder } from "../deploy/parameters.js";
import { callbackSigningKeySecretName } from "../deploy/signing-key.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter } from "./prompts.js";

const PRICES_CHECKED = "September 2026";
const HOURS_PER_MONTH = 730;

// Checked against the AWS pricing pages for PRICES_CHECKED (us-east-1 list prices):
// - NAT Gateway: https://aws.amazon.com/vpc/pricing/ ($0.045 per NAT Gateway-hour).
// - Fargate arm64: https://aws.amazon.com/fargate/pricing/ (Linux/ARM: $0.0000089944 per vCPU-second,
//   $0.0000009889 per GB-second, i.e. $0.03238 per vCPU-hour and $0.00356 per GB-hour).
// - EBS gp3: https://aws.amazon.com/ebs/pricing/ ($0.08 per GB-month baseline storage).
// EC2 m6g.medium on-demand ($0.0385/hour) is AWS's long-standing Graviton2 list price; Bedrock's
// current per-model on-demand tables render client-side and could not be scraped directly, so the
// model prices below are corroborated from AWS's own worked examples and documentation instead of
// the live pricing widget (see ORCHESTRATOR_PER_TURN, CLASSIFIER_PER_CHECK and WORKER_PER_SESSION).
const PRICES = {
  natGatewayHour: 0.045,
  fargateArmVcpuHour: 0.03238,
  fargateArmGbHour: 0.00356,
  m6gMediumHour: 0.0385,
  gp3GbMonth: 0.08,
  workspaceGiB: 20,
  smallServicesMonth: 10,
};
// The Sonnet 4.6 and GLM 4.7 figures come from the spec's 2026-09-25 evaluation (do not change).
const ORCHESTRATOR_PER_TURN: Record<string, number> = { "us.anthropic.claude-sonnet-4-6": 0.025, "zai.glm-4.7": 0.007 };
/** About 2,000 input and 100 output tokens per check. Nova Lite: $0.06/1M input, $0.24/1M output
 * (AWS Bedrock pricing, corroborated by AWS's own Nova fine-tuning cost-analysis worked example).
 * Claude Haiku 4.5 is assumed to price on Bedrock the same as Anthropic's own list price
 * ($1/1M input, $5/1M output); this is an assumption, not a confirmed Bedrock rate. */
const CLASSIFIER_PER_CHECK: Record<string, number> = { "amazon.nova-lite-v1:0": 0.00015, "us.anthropic.claude-haiku-4-5-20251001-v1:0": 0.0025 };
/** The model ids whose price above is an assumption, not a confirmed Bedrock rate: the printed plan says so. */
const ASSUMED_PRICES: ReadonlySet<string> = new Set(["us.anthropic.claude-haiku-4-5-20251001-v1:0"]);
/** About 200,000 input and 10,000 output tokens per session. Nova Pro: $0.8/1M input, $3.2/1M
 * output (AWS Bedrock pricing). */
const WORKER_PER_SESSION: Record<string, number> = { "amazon.nova-pro-v1:0": 0.192 };

export const STATED_USAGE = { turnsPerMonth: 1000, workerSessionsPerMonth: 100, workerInstanceHoursPerMonth: 60, keptWorkspaces: 10 };

export interface CostLine { item: string; usd: number | undefined; basis: string }
export interface CostEstimate { lines: CostLine[]; totalUsd: number; unpriced: string[] }

const cents = (usd: number) => Math.round(usd * 100);
const money = (usd: number) => `$${usd.toFixed(2)}`;
const count = (n: number) => n.toLocaleString("en-US");

export function estimateMonthlyCost(models: InitAnswers["models"], usage = STATED_USAGE): CostEstimate {
  const unpriced: string[] = [];
  const priced = (item: string, usd: number, basis: string): CostLine => ({ item, usd: cents(usd) / 100, basis });
  const perUse = (item: string, id: string, table: Record<string, number>, uses: number, what: string): CostLine => {
    const each = table[id];
    if (each === undefined) {
      unpriced.push(id);
      return { item, usd: undefined, basis: `not estimated: no price on file for ${id}` };
    }
    const assumed = ASSUMED_PRICES.has(id) ? ", assumed: no confirmed Bedrock rate" : "";
    return priced(item, each * uses, `${count(uses)} ${what} at about $${each} each${assumed}`);
  };
  const lines: CostLine[] = [
    priced("Two NAT gateways", 2 * PRICES.natGatewayHour * HOURS_PER_MONTH, `2 x $${PRICES.natGatewayHour}/hour, plus $0.045 per GB processed`),
    priced("Slack service (Fargate, 0.5 vCPU, 1 GB, arm64)", (0.5 * PRICES.fargateArmVcpuHour + 1 * PRICES.fargateArmGbHour) * HOURS_PER_MONTH, "one task, always on"),
    priced("Worker instances (m6g.medium)", PRICES.m6gMediumHour * usage.workerInstanceHoursPerMonth, `${usage.workerInstanceHoursPerMonth} instance-hours at $${PRICES.m6gMediumHour}/hour`),
    priced("Workspace volumes", usage.keptWorkspaces * PRICES.workspaceGiB * PRICES.gp3GbMonth, `${usage.keptWorkspaces} kept workspaces x ${PRICES.workspaceGiB} GiB gp3 at $${PRICES.gp3GbMonth}/GB-month`),
    priced("API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS and CloudWatch", PRICES.smallServicesMonth, "about, at this usage"),
    perUse(`Orchestrator model (${models.orchestrator})`, models.orchestrator, ORCHESTRATOR_PER_TURN, usage.turnsPerMonth, "turns"),
    perUse(`Classifier model (${models.classifier})`, models.classifier, CLASSIFIER_PER_CHECK, usage.turnsPerMonth, "checks"),
    perUse(`Worker model (${models.worker})`, models.worker, WORKER_PER_SESSION, usage.workerSessionsPerMonth, "sessions"),
  ];
  const totalCents = lines.reduce((sum, line) => sum + (line.usd === undefined ? 0 : cents(line.usd)), 0);
  return { lines, totalUsd: totalCents / 100, unpriced };
}

export function installPlanText(answers: InitAnswers, estimate: CostEstimate, notes: readonly string[]): string {
  const { env } = answers;
  const stacks = installOrder(answers.identity.mode).map((part) => environmentStackName(env, part));
  const boundary = answers.permissionsBoundaryArn ?? defaultBoundaryName(env);
  const secrets = [callbackSigningKeySecretName(env), `agentx/${env}/github-app`, `agentx/${env}/slack`, ...(answers.alert.kind === "webhook" ? [answers.alert.secretName] : [])];
  const alerts = answers.alert.kind === "email"
    ? `email to ${answers.alert.address}`
    : answers.alert.kind === "webhook"
      ? `${answers.alert.display} (the full address is kept in ${answers.alert.secretName})`
      : "none";
  const lines = [
    `AgentX will create environment ${env} in account ${answers.account} (${answers.region}) with the ${answers.engine} engine, release ${answers.releaseVersion}:`,
    `- Stacks, in this order: ${stacks.join(", ")}`,
    `- IAM roles ${environmentCloudFormationRoleName(env)} (CloudFormation deploys through it) and ${environmentOperatorRoleName(env)} (day-2 commands), and the permission boundary ${boundary}, which every AgentX role carries; the stacks' own roles live under the IAM path ${environmentRolePath(env)}`,
    `- Secrets ${secrets.join(", ")}`,
    `- Settings under /agentx/${env}/`,
    `- In GitHub: an app named "${answers.github.appName}" owned by ${answers.github.account}, with read and write access to contents, pull requests and issues, and read access to metadata. No webhook.`,
    `- In Slack: an app named "${answers.slack.appName}".`,
    `- Models: orchestrator ${answers.models.orchestrator}, classifier ${answers.models.classifier}, worker ${answers.models.worker}`,
    `- Alerts: ${alerts}`,
    `- AgentX never answers itself or other bots. Mentions people post through other apps: ${answers.slack.appPostedMessages} (slack.appPostedMessages).`,
    ...notes.map((note) => `Note: ${note}`),
    "",
    "Estimated monthly cost:",
    ...estimate.lines.map((line) => `  ${line.usd === undefined ? "    n/a" : money(line.usd).padStart(8)}  ${line.item} (${line.basis})`),
    `Estimated monthly total: ${money(estimate.totalUsd)} at ${count(STATED_USAGE.turnsPerMonth)} turns, ${count(STATED_USAGE.workerSessionsPerMonth)} worker sessions and ${STATED_USAGE.workerInstanceHoursPerMonth} worker instance-hours a month (us-east-1 list prices, ${PRICES_CHECKED}; your bill will differ)${estimate.unpriced.length > 0 ? `, not counting ${estimate.unpriced.join(", ")}` : ""}.`,
    "This does not include any separate AgentCore runtime charge on top of EC2 and EBS for the instances-ebs capacity provider mode, which has not been confirmed; the live test checks the real bill.",
    "",
    "To remove it later, follow the teardown guide (agentx destroy arrives in phase 15e). Deleting the capacity provider deletes every workspace volume.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function confirmInstallPlan(input: { answers: InitAnswers; notes: readonly string[]; prompter: Prompter; write: (text: string) => void }): Promise<void> {
  input.write(installPlanText(input.answers, estimateMonthlyCost(input.answers.models), input.notes));
  if (!(await input.prompter.confirm("Create all of this?", { defaultValue: false }))) {
    throw agentXError("CONFIG_INVALID", "install declined; nothing was created");
  }
}

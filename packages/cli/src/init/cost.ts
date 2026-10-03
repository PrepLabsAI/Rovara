// Spec 048 FR-023, FR-024 and FR-082: the prices behind the plan's estimate, the budget default
// (the estimate plus 20%) and the model choices' price labels. This moved out of plan.ts so
// answers.ts can price its choices without importing the plan (plan.ts would import answers.ts for
// openRouterSecretName, which would import plan.ts back). Prices are us-east-1 list prices checked
// on the date in PRICES_CHECKED; the orchestrator per-turn figures come from the 2026-09-25
// evaluation in the spec's Decisions.
import type { InitAnswers } from "./install-state.js";
import type { ModelRole } from "./prerequisites.js";

export const PRICES_CHECKED = "September 2026";
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
// Each running EC2 worker also carries its own 30 GiB gp3 root volume, deleted with the instance
// (infra/lib/ec2-workers.ts EC2_WORKER_ROOT_VOLUME_GIB); that is separate from the 20 GiB gp3
// workspace volume kept until the workspace closes.
const PRICES = {
  natGatewayHour: 0.045,
  fargateArmVcpuHour: 0.03238,
  fargateArmGbHour: 0.00356,
  m6gMediumHour: 0.0385,
  gp3GbMonth: 0.08,
  workspaceGiB: 20,
  ec2WorkerRootVolumeGiB: 30,
  smallServicesMonth: 10,
};
// The Sonnet 4.6 and GLM 4.7 figures come from the spec's 2026-09-25 evaluation (do not change).
const ORCHESTRATOR_PER_TURN: Record<string, number> = { "us.anthropic.claude-sonnet-4-6": 0.025, "zai.glm-4.7": 0.007 };
/** About 2,000 input and 100 output tokens per check. Claude Haiku 4.5 is assumed to price on Bedrock the same as Anthropic's own list price
 * ($1/1M input, $5/1M output); this is an assumption, not a confirmed Bedrock rate. */
const CLASSIFIER_PER_CHECK: Record<string, number> = { "us.anthropic.claude-haiku-4-5-20251001-v1:0": 0.0025 };
/** The model ids whose price above is an assumption, not a confirmed Bedrock rate: the printed plan says so. */
const ASSUMED_PRICES: ReadonlySet<string> = new Set(["us.anthropic.claude-haiku-4-5-20251001-v1:0"]);
/** About 200,000 input and 10,000 output tokens per session. Claude Sonnet 4.6 on Bedrock: $3/1M input and $15/1M output, the
 * same as Anthropic's list price, so $0.60 + $0.15 = $0.75 a session (spec 048 gap 16: the default
 * coding model had no price, so the plan left out its biggest cost). */
const WORKER_PER_SESSION: Record<string, number> = { "us.anthropic.claude-sonnet-4-6": 0.75 };

export const STATED_USAGE = { turnsPerMonth: 1000, workerSessionsPerMonth: 100, workerInstanceHoursPerMonth: 60, keptWorkspaces: 10 };

export interface CostLine { item: string; usd: number | undefined; basis: string }
export interface CostEstimate { lines: CostLine[]; totalUsd: number; unpriced: string[] }

const cents = (usd: number) => Math.round(usd * 100);
export const money = (usd: number) => `$${usd.toFixed(2)}`;
export const count = (n: number) => n.toLocaleString("en-US");

const TABLES: Readonly<Record<ModelRole, Record<string, number>>> = { orchestrator: ORCHESTRATOR_PER_TURN, classifier: CLASSIFIER_PER_CHECK, worker: WORKER_PER_SESSION };
const UNIT: Readonly<Record<ModelRole, string>> = { orchestrator: "a turn", classifier: "a check", worker: "a coding session" };
/** FR-080: the plain names of the three models. */
export const ROLE_NAMES: Readonly<Record<ModelRole, string>> = { orchestrator: "Main model", classifier: "Safety check model", worker: "Coding model" };
export const MODEL_NAMES: Readonly<Record<string, string>> = {
  "us.anthropic.claude-sonnet-4-6": "Claude Sonnet 4.6", "zai.glm-4.7": "GLM 4.7",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": "Claude Haiku 4.5",
};
export const PRICE_NOT_ON_FILE = "price not on file";
export const modelName = (id: string): string => MODEL_NAMES[id] ?? id;

/** One use of a model, in US dollars, or undefined when its price is not on file. OpenRouter's
 * prices are not on file. The plan's estimate and the choices' labels both read it. */
const pricePerUse = (role: ModelRole, id: string, provider: string | undefined): number | undefined =>
  (provider === "openrouter" ? undefined : TABLES[role][id]);

/** FR-024: a model's price as the choice that offers it shows it. */
export function modelPriceLabel(role: ModelRole, id: string, provider = "amazon-bedrock"): string {
  const each = pricePerUse(role, id, provider);
  return each === undefined ? PRICE_NOT_ON_FILE : `about $${each} ${UNIT[role]}`;
}

export function estimateMonthlyCost(models: InitAnswers["models"], usage = STATED_USAGE): CostEstimate {
  const unpriced: string[] = [];
  const priced = (item: string, usd: number, basis: string): CostLine => ({ item, usd: cents(usd) / 100, basis });
  const perUse = (role: ModelRole, uses: number, what: string): CostLine => {
    const id = models[role];
    const item = `${ROLE_NAMES[role]} (${modelName(id)})`;
    const each = pricePerUse(role, id, models.providers?.[role]);
    if (each === undefined) {
      unpriced.push(id);
      return { item, usd: undefined, basis: `not priced: ${PRICE_NOT_ON_FILE} for ${id}` };
    }
    const assumed = ASSUMED_PRICES.has(id) ? ", assumed: no confirmed Bedrock rate" : "";
    return priced(item, each * uses, `${count(uses)} ${what} at about $${each} each${assumed}`);
  };
  const lines: CostLine[] = [
    priced("Two NAT gateways", 2 * PRICES.natGatewayHour * HOURS_PER_MONTH, `2 x $${PRICES.natGatewayHour}/hour, plus $0.045 per GB processed`),
    priced("The Slack connection (Fargate, 0.5 vCPU, 1 GB, arm64)", (0.5 * PRICES.fargateArmVcpuHour + 1 * PRICES.fargateArmGbHour) * HOURS_PER_MONTH, "one task, always on"),
    priced("Coding machines (m6g.medium)", PRICES.m6gMediumHour * usage.workerInstanceHoursPerMonth, `${usage.workerInstanceHoursPerMonth} machine-hours at $${PRICES.m6gMediumHour}/hour`),
    priced(
      `Coding machine disks (${PRICES.ec2WorkerRootVolumeGiB} GiB gp3)`,
      usage.workerInstanceHoursPerMonth * PRICES.ec2WorkerRootVolumeGiB * (PRICES.gp3GbMonth / HOURS_PER_MONTH),
      `${usage.workerInstanceHoursPerMonth} machine-hours at ${PRICES.ec2WorkerRootVolumeGiB} GiB gp3 and $${PRICES.gp3GbMonth}/GB-month, the same usage as the coding machines above; each disk is deleted with its machine, unlike the kept workspaces below`,
    ),
    priced("Kept workspaces", usage.keptWorkspaces * PRICES.workspaceGiB * PRICES.gp3GbMonth, `${usage.keptWorkspaces} kept workspaces x ${PRICES.workspaceGiB} GiB gp3 at $${PRICES.gp3GbMonth}/GB-month`),
    priced("API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS (including the invocation-signing key) and CloudWatch", PRICES.smallServicesMonth, "about, at this usage"),
    perUse("orchestrator", usage.turnsPerMonth, "turns"),
    perUse("classifier", usage.turnsPerMonth, "checks"),
    perUse("worker", usage.workerSessionsPerMonth, "coding sessions"),
  ];
  const totalCents = lines.reduce((sum, line) => sum + (line.usd === undefined ? 0 : cents(line.usd)), 0);
  return { lines, totalUsd: totalCents / 100, unpriced };
}

/** FR-023: the estimate plus 20%, rounded up to a whole $10 so it is easy to read, and at least $10.
 * Worked in cents, so a total such as $100.00 gives $120, not $130 from floating point. */
export function suggestedBudgetUsd(estimate: CostEstimate): number {
  return Math.max(10, Math.ceil(Math.round(estimate.totalUsd * 120) / 1000) * 10);
}

/** The lines the total leaves out because their price is not on file. */
export function notCounted(estimate: CostEstimate): string[] {
  return estimate.lines.filter((line) => line.usd === undefined).map((line) => line.item);
}

/** FR-023 and FR-024: the line beside the budget field. */
export function budgetWhy(estimate: CostEstimate): string {
  const missing = notCounted(estimate);
  const left = missing.length === 0 ? "" : `, not counting ${missing.join(" and ")}, whose price is not on file`;
  return `AgentX's estimate is about ${money(estimate.totalUsd)} a month${left}. The suggested budget is the estimate plus 20%. AWS emails you when this month's costs pass 80% of it. 0 turns it off.`;
}

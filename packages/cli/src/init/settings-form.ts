// packages/cli/src/init/settings-form.ts
// Spec 048 FR-020 to FR-023 and FR-025: the settings as one form. Four fields on the default path
// (your email, the GitHub owner, the install name, the app name for both apps), then every other
// setting under Advanced settings, each with its recommended value. A field whose flag was typed is
// left out: the flag answers it. The page shows the form as one screen; the terminal asks the four,
// then ADVANCED_QUESTION (prompts.ts askForm).
import { DEFAULT_BEDROCK_MODELS } from "@agentx/model-runtime/config";
import { ENVIRONMENT_NAME_PATTERN, ENVIRONMENT_PLACEHOLDER, EnvironmentNameSchema } from "@agentx/contracts";
import { AlertEmailSchema, GITHUB_LOGIN_PATTERN, MAX_BUDGET_USD } from "../deploy/answer-schemas.js";
import type { InitFlags } from "./answers.js";
import { estimateMonthlyCost, modelName, modelPriceLabel, money, suggestedBudgetUsd } from "./cost.js";
import type { FormField } from "./prompts.js";
import { ALERT_FLAG } from "./ui/question-copy.js";

export const SETTINGS_TITLE = "Your settings";
export const SIGN_IN_GROUP = "How people sign in";
export const GITHUB_APP_NAME_LIMIT = 34;
export const SLACK_APP_NAME_LIMIT = 35;

export const SETTINGS_FIELD = {
  email: "email", githubAccount: "githubAccount", installName: "installName", appName: "appName",
  engine: "engine", identity: "identity", signin: "signin", modelProvider: "modelProvider",
  orchestratorModel: "orchestratorModel", classifierModel: "classifierModel", workerModel: "workerModel",
  permissionBoundary: "permissionBoundary", operatorPrincipal: "operatorPrincipal",
  budget: "budget", budgetScope: "budgetScope", appPostedMessages: "appPostedMessages", alertKind: "alertKind", alertEmail: "alertEmail",
} as const;
export type SettingsFieldName = (typeof SETTINGS_FIELD)[keyof typeof SETTINGS_FIELD];

const GLM = "zai.glm-4.7";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const NOVA_PRO = "amazon.nova-pro-v1:0";
const DEFAULT = DEFAULT_BEDROCK_MODELS;

export const ORCHESTRATOR_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT.orchestrator, label: `Claude Sonnet 4.6 (recommended; ${modelPriceLabel("orchestrator", DEFAULT.orchestrator)})` },
  { value: GLM, label: `GLM 4.7 (lower cost; ${modelPriceLabel("orchestrator", GLM)})` },
];
export const CLASSIFIER_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT.classifier, label: `Amazon Nova Lite (recommended; ${modelPriceLabel("classifier", DEFAULT.classifier)})` },
  { value: HAIKU, label: `Claude Haiku 4.5 (${modelPriceLabel("classifier", HAIKU)}; needs a one-time Anthropic form in Bedrock)` },
];
/** FR-021: the coding model is a choice too. */
export const WORKER_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT.worker, label: `Claude Sonnet 4.6 (recommended; ${modelPriceLabel("worker", DEFAULT.worker)})` },
  { value: NOVA_PRO, label: `Amazon Nova Pro (lower cost; ${modelPriceLabel("worker", NOVA_PRO)})` },
];
const OTHER_MODEL = { value: "other", label: "Another Bedrock model id" };

const ENGINE_CHOICES = [
  { value: "templates", label: "templates: published CloudFormation templates, no CDK setup (recommended)" },
  { value: "cdk", label: "cdk: deploy from AgentX's CDK code at the release tag" },
];
const IDENTITY_CHOICES = [
  { value: "cognito", label: "Create a Cognito user pool for AgentX (recommended)" },
  { value: "oidc", label: "Use your own OIDC provider" },
];
const SIGNIN_CHOICES = [
  { value: "slack", label: "Sign in with Slack (recommended)" },
  { value: "oidc", label: "Your company's sign-in (OIDC)" },
  { value: "both", label: "Both" },
];
const PROVIDER_CHOICES = [
  { value: "amazon-bedrock", label: "Amazon Bedrock (recommended)" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "anthropic", label: "Anthropic API (your own API key)" },
  { value: "openai", label: "OpenAI API (your own API key)" },
];
const BUDGET_SCOPE_CHOICES = [
  { value: "account", label: "The whole account (recommended)" },
  { value: "tag", label: "Only this environment's (tagged agentx:env; the tag must be activated in Billing)" },
];
const POSTED_CHOICES = [{ value: "accept", label: "Yes (accept)" }, { value: "ignore", label: "No, only mentions typed in Slack (ignore)" }];
const ALERT_CHOICES = [
  { value: "email", label: "An email address" },
  { value: "webhook", label: "A PagerDuty or Opsgenie integration address (kept secret)" },
  { value: "none", label: "Nowhere for now" },
];

export const emailProblem = (value: string): string | undefined => (AlertEmailSchema.safeParse(value).success ? undefined : "must be an email address");
const loginProblem = (value: string): string | undefined => (GITHUB_LOGIN_PATTERN.test(value) ? undefined : "must be a GitHub organization or user name");
/** The --env rules of main.ts, on the field: EnvironmentNameSchema (ENVIRONMENT_NAME_PATTERN, no
 * doubled hyphen, and its reserved names) and the placeholder main.ts refuses. The pattern's words
 * describe it exactly; any other refusal of the schema is a reserved name. */
export function installNameProblem(value: string): string | undefined {
  if (!ENVIRONMENT_NAME_PATTERN.test(value) || value.includes("--")) {
    return "use lowercase letters, numbers and single hyphens, starting with a letter and ending with a letter or number, at most 20 characters";
  }
  return !EnvironmentNameSchema.safeParse(value).success || value === ENVIRONMENT_PLACEHOLDER ? "that name is reserved; choose another" : undefined;
}
const appNameProblem = (value: string): string | undefined => (value === "" || value.length <= GITHUB_APP_NAME_LIMIT ? undefined : `must be at most ${GITHUB_APP_NAME_LIMIT} characters`);
/** FR-047's budget answer (moved from answers.ts, unchanged). */
export const budgetProblem = (value: string): string | undefined =>
  (/^(0|[1-9][0-9]{0,6})$/.test(value) && Number(value) <= MAX_BUDGET_USD) ? undefined : `must be a whole number of US dollars from 1 to ${MAX_BUDGET_USD}, or 0 for no budget`;
const optionalArn = (pattern: RegExp, what: string) => (value: string): string | undefined => (value === "" || pattern.test(value) ? undefined : `must be ${what}`);
const orEmpty = (check: (value: string) => string | undefined) => (value: string): string | undefined => (value === "" ? undefined : check(value));

export interface SettingsFieldsInput {
  env: string;
  flags: InitFlags;
  /** --admin-email (a finishing-step flag), which answers `email`. */
  adminEmail?: string;
  /** --signin (a developer sign-in flag), which answers `signin`. */
  signinMethods?: "slack" | "oidc" | "both";
  /** An export bundle's resume: engine, sign-in, models, boundary, operator and the name are decided. */
  fixed: boolean;
  /** The budget field's why line (cost.ts budgetWhy of the recommended models). */
  budgetWhy: string;
}

export function settingsFields(input: SettingsFieldsInput): FormField[] {
  const { flags } = input;
  const fields: FormField[] = [];
  const unless = (answered: unknown, field: FormField) => { if (answered === undefined) fields.push(field); };
  const advanced = (field: FormField): FormField => ({ ...field, section: "advanced" });
  const alertAnswered = flags.alerts === false || flags.alertEmail !== undefined || flags.alertWebhook !== undefined ? true : undefined;
  const fixed = input.fixed ? true : undefined;

  // Your own OIDC needs no admin email, so with the alerts answered by a flag nothing needs it (--yes
  // with --identity oidc and --no-alerts or --alert-webhook-* asks no email, as before phase 2).
  const noEmailNeeded = flags.identity === "oidc" && (flags.alerts === false || flags.alertWebhook !== undefined) ? true : undefined;
  unless(input.adminEmail ?? flags.alertEmail ?? noEmailNeeded, {
    name: SETTINGS_FIELD.email, question: "Your email, for your AgentX admin user and alerts", flag: "--admin-email", validate: emailProblem,
    help: { why: "AgentX uses it for your admin sign-in and, by default, for alerts." },
  });
  unless(flags.githubAccount, { name: SETTINGS_FIELD.githubAccount, question: "GitHub organization or user that will own the AgentX GitHub App", flag: "--github-account", validate: loginProblem });
  unless(fixed, { name: SETTINGS_FIELD.installName, question: "Install name", flag: "--env", defaultValue: input.env, validate: installNameProblem });
  unless(flags.githubAppName, { name: SETTINGS_FIELD.appName, question: "App name for GitHub and Slack (unique on GitHub)", flag: "--github-app-name", defaultValue: "", validate: appNameProblem });

  unless(fixed ?? flags.engine, advanced({ name: SETTINGS_FIELD.engine, question: "Deploy engine", flag: "--engine", defaultValue: "templates", choices: ENGINE_CHOICES }));
  unless(fixed ?? flags.identity, advanced({ name: SETTINGS_FIELD.identity, group: SIGN_IN_GROUP, question: "Sign-in", flag: "--identity", defaultValue: "cognito", choices: IDENTITY_CHOICES }));
  unless(input.signinMethods, advanced({ name: SETTINGS_FIELD.signin, group: SIGN_IN_GROUP, question: "How will developers sign in to AgentX from their AI tools?", flag: "--signin", defaultValue: "slack", choices: SIGNIN_CHOICES }));
  const providerPinned = [flags.modelProvider, flags.orchestratorProvider, flags.classifierProvider, flags.workerProvider, flags.orchestratorModel, flags.classifierModel, flags.workerModel]
    .some((value) => value !== undefined) ? true : undefined;
  unless(fixed ?? providerPinned, advanced({ name: SETTINGS_FIELD.modelProvider, question: "Model provider", flag: "--model-provider", defaultValue: "amazon-bedrock", choices: PROVIDER_CHOICES }));
  const bedrockChoices = flags.modelProvider === undefined || flags.modelProvider === "amazon-bedrock";
  if (bedrockChoices) {
    unless(fixed ?? flags.orchestratorModel ?? flags.orchestratorProvider, advanced({ name: SETTINGS_FIELD.orchestratorModel, question: "Orchestrator model", flag: "--orchestrator-model", defaultValue: DEFAULT.orchestrator, choices: [...ORCHESTRATOR_MODEL_CHOICES, OTHER_MODEL] }));
    unless(fixed ?? flags.classifierModel ?? flags.classifierProvider, advanced({ name: SETTINGS_FIELD.classifierModel, question: "Action-gate classifier model", flag: "--classifier-model", defaultValue: DEFAULT.classifier, choices: [...CLASSIFIER_MODEL_CHOICES, OTHER_MODEL] }));
    unless(fixed ?? flags.workerModel ?? flags.workerProvider, advanced({ name: SETTINGS_FIELD.workerModel, question: "Worker model", flag: "--worker-model", defaultValue: DEFAULT.worker, choices: [...WORKER_MODEL_CHOICES, OTHER_MODEL] }));
  }
  unless(fixed ?? flags.permissionBoundary, advanced({ name: SETTINGS_FIELD.permissionBoundary, question: "Permission boundary policy ARN (Enter for AgentX's default boundary)", flag: "--permission-boundary", defaultValue: "", validate: optionalArn(/^arn:aws[a-z-]*:iam::\d{12}:policy\/.+$/, "an IAM policy ARN") }));
  unless(fixed ?? flags.operatorPrincipal, advanced({ name: SETTINGS_FIELD.operatorPrincipal, question: "IAM principal allowed to assume the AgentX operator role (Enter for this account)", flag: "--operator-principal", defaultValue: "", validate: optionalArn(/^arn:aws[a-z-]*:(iam|sts)::\d{12}:.+$/, "an IAM principal ARN") }));
  // FR-023: empty is the estimate plus 20%; the amount for the recommended models is said in the
  // terminal's question (the terminal shows no hint) and in the page's hint.
  const suggested = suggestedBudgetUsd(estimateMonthlyCost(DEFAULT));
  unless(flags.budget, advanced({
    name: SETTINGS_FIELD.budget, question: `Monthly AWS budget for this environment, in US dollars (0 for none; empty for the estimate plus 20%, $${suggested})`, flag: "--budget", defaultValue: "",
    validate: orEmpty(budgetProblem), help: { why: input.budgetWhy, hint: `Optional. Leave empty to use the estimate plus 20% ($${suggested}).` },
  }));
  unless(flags.budgetScope, advanced({ name: SETTINGS_FIELD.budgetScope, question: "Which costs should the budget count?", flag: "--budget-scope", defaultValue: "account", choices: BUDGET_SCOPE_CHOICES }));
  unless(flags.slackAppPostedMessages, advanced({ name: SETTINGS_FIELD.appPostedMessages, question: "Answer mentions people post through other apps with their own Slack token?", flag: "--slack-app-posted-messages", defaultValue: "accept", choices: POSTED_CHOICES }));
  unless(alertAnswered, advanced({ name: SETTINGS_FIELD.alertKind, question: "Where should AgentX send alerts?", flag: ALERT_FLAG, defaultValue: "email", choices: ALERT_CHOICES }));
  unless(alertAnswered, advanced({ name: SETTINGS_FIELD.alertEmail, question: "Alert email address", flag: ALERT_FLAG, defaultValue: "", validate: orEmpty(emailProblem), help: { hint: "Optional. Leave empty to use your email." } }));
  return fields;
}

/** FR-020: the "Recommended settings" box, in plain words. */
export function recommendedSummary(input: { estimateUsd: number; suggestedBudgetUsd: number }): string[] {
  return [
    `Models: ${modelName(DEFAULT.orchestrator)} on Amazon Bedrock for the main and coding models, ${modelName(DEFAULT.classifier)} for the safety check.`,
    "Sign-in: AgentX's own sign-in for you, Sign in with Slack for developers.",
    `Budget alert: $${input.suggestedBudgetUsd} a month for the whole account (the estimate is about ${money(input.estimateUsd)}).`,
    "Alerts go to: your email.",
  ];
}

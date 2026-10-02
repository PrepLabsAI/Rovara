import { DEFAULT_BEDROCK_MODELS, OPENROUTER_KEY_MIN_LENGTH } from "@agentx/model-runtime/config";
// FR-016's questions, each with a flag (FR-020). Only flags the engineer typed arrive here, so a
// commander default never silently skips a question. An alert webhook carries its integration
// key, so it is a secret: it is never a flag value and never stored in the answers.
import { agentXError, ImageDigest } from "@agentx/contracts";
import { GITHUB_LOGIN_PATTERN, ModelsAnswersSchema } from "../deploy/answer-schemas.js";
import type { BundleAnswers } from "../deploy/export-bundle.js";
import { SecretAlreadyExistsError } from "../deploy/signing-key.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { budgetWhy, estimateMonthlyCost, suggestedBudgetUsd } from "./cost.js";
import { writeInstallAnswers, type InitAnswers } from "./install-state.js";
import { askForm, secretFromSource, type Prompter, type SecretSource } from "./prompts.js";
import {
  budgetProblem, emailProblem, GITHUB_APP_NAME_LIMIT, recommendedSummary, SETTINGS_FIELD, SETTINGS_TITLE, settingsFields, type SettingsFieldName,
} from "./settings-form.js";

// Spec 048 phase 2: the choice lists, the app name limit and the budget check moved to
// settings-form.ts, the one form they are asked on; they are re-exported here for their callers.
export { CLASSIFIER_MODEL_CHOICES, GITHUB_APP_NAME_LIMIT, ORCHESTRATOR_MODEL_CHOICES, WORKER_MODEL_CHOICES } from "./settings-form.js";

/** Spec 048 FR-026: one default name for the GitHub app and the Slack app, with the install name in
 * it. GitHub app names are unique across GitHub, so the owner is in it too; when that is longer
 * than GitHub's 34 characters, the owner is dropped at its word boundary. "AgentX (<install name>)"
 * always fits: install names are at most 20 characters. */
export function defaultAppName(input: { owner: string; env: string }): string {
  const full = `AgentX ${input.owner} (${input.env})`;
  return full.length <= GITHUB_APP_NAME_LIMIT ? full : `AgentX (${input.env})`;
}

export const DEFAULT_ORCHESTRATOR_MODEL = DEFAULT_BEDROCK_MODELS.orchestrator;
export const DEFAULT_CLASSIFIER_MODEL = DEFAULT_BEDROCK_MODELS.classifier;
export const DEFAULT_WORKER_MODEL = DEFAULT_BEDROCK_MODELS.worker;
const GLM = "zai.glm-4.7";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export const GLM_NOTE =
  "GLM 4.7 costs about $0.007 a turn against Claude Sonnet 4.6's $0.025, and passed as many evaluation cases (58 of 65), but it refused correctly in only 6 of 7 cases that needed a refusal (Sonnet 4.6: 7 of 7).";
export const HAIKU_NOTE =
  "Claude Haiku 4.5 needs Anthropic model access in this account: a one-time use-case form in the Bedrock console. The prerequisite check below tests it.";
const NO_ALERTS_NOTE = "No alert address: nobody is told when AgentX fails until you add one (agentx config set alerts.address, phase 15e).";

/** FR-047: shown in the plan and repeated by the `alerts` step (Task 12) whenever the budget scope
 * is "tag", since AWS Budgets reads $0 against a cost allocation tag until someone with billing
 * rights activates it. */
export const BUDGET_TAG_NOTE =
  "The budget counts costs tagged agentx:env. Someone with billing rights must activate that tag once in Billing, Cost allocation tags; it appears there up to 24 hours after the first tagged resource is billed. Until then the budget reads $0. For an account used only by AgentX, --budget-scope account needs no tag.";

export interface InitFlags {
  engine?: "templates" | "cdk";
  identity?: "cognito" | "oidc";
  oidcIssuer?: string; oidcAudience?: string; oidcClientId?: string; adminClaim?: string; adminValues?: string;
  orchestratorModel?: string; classifierModel?: string; workerModel?: string;
  /** --model-provider: sets all three providers; a per-component provider flag wins over it. */
  modelProvider?: string;
  orchestratorProvider?: string; classifierProvider?: string; workerProvider?: string;
  openrouterSecretArn?: string; openrouterProviders?: string;
  /** --openrouter-key-file / --openrouter-key-env: like the webhook, never a flag value. */
  openrouterKey?: SecretSource;
  permissionBoundary?: string; operatorPrincipal?: string;
  alertEmail?: string;
  /** --alert-webhook-file / --alert-webhook-env: there is deliberately no flag that takes the address itself. */
  alertWebhook?: SecretSource;
  /** false for --no-alerts */
  alerts?: boolean;
  /** --budget: whole US dollars a month; "0" for none. */
  budget?: string;
  budgetScope?: "tag" | "account";
  githubAccount?: string; githubAccountType?: "organization" | "user"; githubAppName?: string;
  slackAppName?: string; slackAppPostedMessages?: "accept" | "ignore";
  workerImage?: string; slackImage?: string;
}

export interface CollectedAnswers {
  answers: InitAnswers;
  /** the secret webhook address, never stored in answers */
  alertWebhook?: string;
  /** The OpenRouter API key init stores in openRouterSecretName(env) before saving the answers,
   * which then hold only the secret's ARN. Never stored in answers. */
  openRouterKey?: string;
  /** The --openrouter-providers allowlist that goes with openRouterKey's secret. */
  openRouterProviders?: string[];
  notes: string[];
  /** Spec 048 FR-029: the settings form's own values (never a secret), so Change answers starts from them. */
  settings: Record<string, string>;
}

export function openRouterSecretName(env: string): string {
  return `agentx/${env}/openrouter`;
}

const MODEL_PROVIDERS = ["amazon-bedrock", "openrouter"] as const;
type ModelProvider = (typeof MODEL_PROVIDERS)[number];
const isModelProvider = (value: string): value is ModelProvider => (MODEL_PROVIDERS as readonly string[]).includes(value);

export function alertWebhookSecretName(env: string): string {
  return `agentx/${env}/alert-endpoint`;
}

export function checkAlertWebhook(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw agentXError("CONFIG_INVALID", "an alert webhook must be an https:// address (your PagerDuty or Opsgenie integration address)");
  }
  if (parsed.protocol !== "https:") throw agentXError("CONFIG_INVALID", "an alert webhook must be an https:// address (your PagerDuty or Opsgenie integration address)");
  return url;
}

export function webhookDisplay(url: string): string {
  return `https://${new URL(url).host}/...`;
}

function digestFlag(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!ImageDigest.safeParse(value).success) throw agentXError("CONFIG_INVALID", `${flag} must be referenced by digest (repository@sha256:...)`);
  return value;
}

/** The engine, identity, models, boundary and operator principal: what an export bundle already
 * knows (`fixed`), or read from the settings form. */
type PlatformAnswers = Pick<InitAnswers, "engine" | "identity" | "models" | "permissionsBoundaryArn" | "operatorPrincipalArn">;
type SettingsValues = Readonly<Record<string, string>>;

/** Spec 048 FR-020 to FR-023 and FR-025: every setting comes from one form (settings-form.ts): four
 * fields, then the Advanced settings, each with its recommended value. A typed flag answers its
 * field, so the field is left out. Only the follow-ups (your own OIDC's values, a model id for
 * "Another Bedrock model id", OpenRouter's model ids and key, an alert webhook, and the GitHub
 * owner's type when GitHub cannot say) are asked after it. */
export async function collectInitAnswers(input: {
  env: string; region: string; account: string; releaseVersion: string;
  flags: InitFlags; prompter: Prompter; processEnv: NodeJS.ProcessEnv; now: () => number;
  readFile?: (path: string) => Promise<string>;
  /** An export bundle's answers (`init --resume --from-bundle`): their questions are not asked. */
  fixed?: BundleAnswers;
  /** --admin-email and --signin, from their own steps' flags: each answers one setting. */
  adminEmail?: string;
  signinMethods?: "slack" | "oidc" | "both";
  /** Change answers: the settings to start from (FR-029). */
  kept?: Readonly<Record<string, string>>;
  /** FR-020: the owner's type, from GitHub; undefined when GitHub cannot say, and then it is asked. */
  ownerType?: (login: string) => Promise<"organization" | "user" | undefined>;
}): Promise<CollectedAnswers> {
  const { flags, prompter } = input;
  const notes: string[] = [];
  const workerImage = digestFlag(flags.workerImage, "--worker-image");
  const slackImage = digestFlag(flags.slackImage, "--slack-image");
  const recommended = estimateMonthlyCost({ orchestrator: DEFAULT_ORCHESTRATOR_MODEL, classifier: DEFAULT_CLASSIFIER_MODEL, worker: DEFAULT_WORKER_MODEL });
  const fields = settingsFields({
    env: input.env, flags, fixed: input.fixed !== undefined, budgetWhy: budgetWhy(recommended),
    ...(input.adminEmail === undefined ? {} : { adminEmail: input.adminEmail }),
    ...(input.signinMethods === undefined ? {} : { signinMethods: input.signinMethods }),
  });
  const values: SettingsValues = fields.length === 0 ? {} : await askForm(prompter, SETTINGS_TITLE, fields, {
    summary: recommendedSummary({ estimateUsd: recommended.totalUsd, suggestedBudgetUsd: suggestedBudgetUsd(recommended) }),
    ...(input.kept === undefined ? {} : { values: input.kept }),
  });
  const typed = (name: SettingsFieldName): string | undefined => (values[name] === undefined || values[name] === "" ? undefined : values[name]);
  const env = input.fixed?.env ?? typed(SETTINGS_FIELD.installName) ?? input.env;
  const email = input.adminEmail ?? typed(SETTINGS_FIELD.email) ?? flags.alertEmail;

  let platform: PlatformAnswers;
  let openRouterKey: string | undefined;
  let openRouterProviders: string[] | undefined;
  if (input.fixed === undefined) {
    ({ platform, openRouterKey, openRouterProviders } = await platformFromSettings({ ...input, env }, values));
  } else {
    // The export took no OpenRouter key (it stores no secret), so a bundle's OpenRouter secret, if
    // any, is one the team made itself: nothing is stored here.
    const { engine, identity, models, permissionsBoundaryArn, operatorPrincipalArn } = input.fixed;
    platform = {
      engine, identity, models,
      ...(permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn }),
      ...(operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn }),
    };
  }
  if (platform.models.orchestrator === GLM) notes.push(GLM_NOTE);
  if (platform.models.classifier === HAIKU) notes.push(HAIKU_NOTE);

  let alert: InitAnswers["alert"] | undefined;
  let alertWebhook: string | undefined;
  const readWebhook = async (source: SecretSource) => checkAlertWebhook(await secretFromSource({
    what: "alert webhook address", flag: "--alert-webhook", source, processEnv: input.processEnv, prompter,
    ...(input.readFile === undefined ? {} : { readFile: input.readFile }),
  }));
  if (flags.alerts === false) {
    alert = { kind: "none" };
  } else if (flags.alertEmail !== undefined) {
    if (emailProblem(flags.alertEmail) !== undefined) throw agentXError("CONFIG_INVALID", `--alert-email ${flags.alertEmail} is not an email address`);
    alert = { kind: "email", address: flags.alertEmail };
  } else if (flags.alertWebhook !== undefined) {
    alertWebhook = await readWebhook(flags.alertWebhook);
  } else {
    const kind = values[SETTINGS_FIELD.alertKind] ?? "email";
    if (kind === "webhook") {
      alertWebhook = await readWebhook({});
    } else if (kind === "none") {
      alert = { kind: "none" };
    } else {
      // FR-025: alerts are on by default, to your email.
      const address = typed(SETTINGS_FIELD.alertEmail) ?? email;
      if (address === undefined) throw agentXError("CONFIG_INVALID", "alerts need an email address; pass --admin-email <address>, --alert-email <address>, or --no-alerts");
      if (emailProblem(address) !== undefined) throw agentXError("CONFIG_INVALID", `${address} is not an email address`);
      alert = { kind: "email", address };
    }
  }
  if (alertWebhook !== undefined) alert = { kind: "webhook", display: webhookDisplay(alertWebhook), secretName: alertWebhookSecretName(env) };
  if (alert === undefined) throw new Error("unreachable: every alert branch sets alert");
  if (alert.kind === "none") notes.push(NO_ALERTS_NOTE);

  // FR-023: an empty budget is the estimate of the models actually chosen, plus 20%.
  const estimate = estimateMonthlyCost(platform.models);
  const rawBudget = flags.budget ?? typed(SETTINGS_FIELD.budget) ?? String(suggestedBudgetUsd(estimate));
  const budgetIssue = budgetProblem(rawBudget);
  if (budgetIssue !== undefined) throw agentXError("CONFIG_INVALID", `--budget ${budgetIssue}`);
  let budget: InitAnswers["budget"];
  if (Number(rawBudget) > 0) {
    const scope = flags.budgetScope ?? (values[SETTINGS_FIELD.budgetScope] === "tag" ? "tag" : "account");
    budget = { monthlyUsd: Number(rawBudget), scope };
    if (scope === "tag") notes.push(BUDGET_TAG_NOTE);
  }

  const githubAccount = flags.githubAccount ?? typed(SETTINGS_FIELD.githubAccount) ?? "";
  if (!GITHUB_LOGIN_PATTERN.test(githubAccount)) throw agentXError("CONFIG_INVALID", `--github-account ${githubAccount} is not a GitHub organization or user name`);
  // FR-020: GitHub says what the owner is; the question is asked only when it cannot.
  const accountType = flags.githubAccountType ?? (await input.ownerType?.(githubAccount)) ?? (await prompter.choose<"organization" | "user">(`Is ${githubAccount} an organization or a personal account?`, [
    { value: "organization", label: "An organization" },
    { value: "user", label: "A personal account" },
  ], { flag: "--github-account-type", defaultValue: "organization" }));
  // FR-020 and FR-026: one name for both apps; empty is the default pattern for this owner and name.
  const appName = flags.githubAppName ?? typed(SETTINGS_FIELD.appName) ?? defaultAppName({ owner: githubAccount, env });
  const slackAppName = flags.slackAppName ?? appName;
  const appPostedMessages = flags.slackAppPostedMessages ?? (values[SETTINGS_FIELD.appPostedMessages] === "ignore" ? "ignore" : "accept");
  const signinValue = values[SETTINGS_FIELD.signin];
  const signinMethods = input.signinMethods ?? (signinValue === "oidc" || signinValue === "both" ? signinValue : "slack");

  const answers: InitAnswers = {
    schemaVersion: 1,
    env, region: input.region, account: input.account, engine: platform.engine, releaseVersion: input.releaseVersion,
    identity: platform.identity,
    models: platform.models,
    ...(platform.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: platform.permissionsBoundaryArn }),
    ...(platform.operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn: platform.operatorPrincipalArn }),
    ...(workerImage === undefined && slackImage === undefined
      ? {}
      : { images: { ...(workerImage === undefined ? {} : { worker: workerImage }), ...(slackImage === undefined ? {} : { slack: slackImage }) } }),
    alert,
    ...(budget === undefined ? {} : { budget }),
    github: { account: githubAccount, accountType, appName },
    slack: { appName: slackAppName, appPostedMessages },
    ...(email === undefined ? {} : { adminEmail: email }),
    signinMethods,
    createdAt: new Date(input.now()).toISOString(),
  };
  return {
    answers, notes, settings: { ...values },
    ...(alertWebhook === undefined ? {} : { alertWebhook }),
    ...(openRouterKey === undefined ? {} : { openRouterKey, ...(openRouterProviders === undefined ? {} : { openRouterProviders }) }),
  };
}

/** The settings an export bundle answers instead (engine, identity, models, boundary, operator),
 * from the form's values: a typed flag first, then the field, then its recommended value. */
async function platformFromSettings(
  input: { env: string; region: string; account: string; flags: InitFlags; prompter: Prompter; processEnv: NodeJS.ProcessEnv; readFile?: (path: string) => Promise<string> },
  values: SettingsValues,
): Promise<{ platform: PlatformAnswers; openRouterKey?: string; openRouterProviders?: string[] }> {
  const { flags, prompter } = input;
  const engine = flags.engine ?? (values[SETTINGS_FIELD.engine] === "cdk" ? "cdk" : "templates");

  const identityMode = flags.identity ?? (values[SETTINGS_FIELD.identity] === "oidc" ? "oidc" : "cognito");
  let identity: InitAnswers["identity"] = { mode: "cognito" };
  if (identityMode === "oidc") {
    const https = (value: string) => (/^https:\/\/\S+$/.test(value) ? undefined : "must be an https:// URL");
    const issuer = flags.oidcIssuer ?? (await prompter.ask("OIDC issuer URL", { flag: "--oidc-issuer", validate: https }));
    const audience = flags.oidcAudience ?? (await prompter.ask("OIDC audience", { flag: "--oidc-audience" }));
    const clientId = flags.oidcClientId ?? (await prompter.ask("OIDC client id for agentx login", { flag: "--oidc-client-id" }));
    const adminClaim = flags.adminClaim ?? (await prompter.ask("Claim that marks AgentX administrators", { flag: "--admin-claim", defaultValue: "groups" }));
    const rawValues = flags.adminValues ?? (await prompter.ask("Values of that claim that mark an administrator, comma-separated", { flag: "--admin-values" }));
    const adminValues = rawValues.split(",").map((value) => value.trim()).filter((value) => value !== "");
    if (adminValues.length === 0) throw agentXError("CONFIG_INVALID", "--admin-values must name at least one value");
    identity = { mode: "oidc", issuer, audience, clientId, adminClaim, adminValues };
  }

  // The provider field is left out when a provider or model flag pins the answer already: a
  // per-component flag keeps today's meaning (unset components stay on Bedrock), so mixed setups
  // still come from flags.
  const providerFlagGiven = [flags.orchestratorProvider, flags.classifierProvider, flags.workerProvider].some((value) => value !== undefined);
  const modelFlagGiven = [flags.orchestratorModel, flags.classifierModel, flags.workerModel].some((value) => value !== undefined);
  const allProvider = flags.modelProvider ?? (providerFlagGiven || modelFlagGiven ? "amazon-bedrock" : values[SETTINGS_FIELD.modelProvider] ?? "amazon-bedrock");
  const providers = {
    orchestrator: flags.orchestratorProvider ?? allProvider,
    classifier: flags.classifierProvider ?? allProvider,
    worker: flags.workerProvider ?? allProvider,
  };
  if (!Object.values(providers).every(isModelProvider)) {
    throw agentXError("CONFIG_INVALID", "model providers must be amazon-bedrock or openrouter");
  }
  /** A Bedrock model from the form: its value, its default when empty, or a follow-up for "other". */
  const fromForm = async (name: SettingsFieldName, question: string, flag: string, fallback: string): Promise<string> => {
    const picked = values[name];
    if (picked === "other") return prompter.ask(`${question} id`, { flag });
    return picked === undefined || picked === "" ? fallback : picked;
  };
  const orchestrator = providers.orchestrator === "openrouter"
    ? flags.orchestratorModel ?? await prompter.ask("OpenRouter orchestrator model id", { flag: "--orchestrator-model" })
    : flags.orchestratorModel ?? await fromForm(SETTINGS_FIELD.orchestratorModel, "Orchestrator model", "--orchestrator-model", DEFAULT_ORCHESTRATOR_MODEL);
  const classifier = providers.classifier === "openrouter"
    ? flags.classifierModel ?? await prompter.ask("OpenRouter classifier model id", { flag: "--classifier-model" })
    : flags.classifierModel ?? await fromForm(SETTINGS_FIELD.classifierModel, "Action-gate classifier model", "--classifier-model", DEFAULT_CLASSIFIER_MODEL);
  const worker = providers.worker === "openrouter"
    ? flags.workerModel ?? await prompter.ask("OpenRouter worker model id", { flag: "--worker-model" })
    : flags.workerModel ?? await fromForm(SETTINGS_FIELD.workerModel, "Worker model", "--worker-model", DEFAULT_WORKER_MODEL);
  const usesOpenRouter = Object.values(providers).includes("openrouter");
  const secretArn = flags.openrouterSecretArn;
  if (secretArn !== undefined && flags.openrouterKey !== undefined) {
    throw agentXError("CONFIG_INVALID", "--openrouter-secret-arn names a secret you made yourself, so it cannot go with --openrouter-key-file or --openrouter-key-env; pass one or the other");
  }
  // Without a secret of your own, init asks for the key and stores it itself (openRouterSecretName).
  const openRouterKey = secretArn === undefined && (usesOpenRouter || flags.openrouterKey !== undefined)
    ? await readOpenRouterKeyAnswer({ source: flags.openrouterKey ?? {}, processEnv: input.processEnv, prompter, ...(input.readFile === undefined ? {} : { readFile: input.readFile }) })
    : undefined;
  if (flags.openrouterProviders && !secretArn && openRouterKey === undefined) {
    throw agentXError("CONFIG_INVALID", "--openrouter-providers needs OpenRouter: choose it as a model provider, or pass --openrouter-secret-arn");
  }
  const openRouterProviders = flags.openrouterProviders ? flags.openrouterProviders.split(",") : undefined;
  const modelsInput = { orchestrator, classifier, worker, ...(usesOpenRouter ? { providers } : {}) };
  // The stored key's ARN is known only once init stores it, after the plan; a stand-in ARN checks
  // the provider slugs now, so nothing is created for answers that would be refused.
  const checkArn = secretArn ?? (openRouterKey === undefined ? undefined : `arn:aws:secretsmanager:${input.region}:${input.account}:secret:${openRouterSecretName(input.env)}-XXXXXX`);
  const parsedModels = ModelsAnswersSchema.safeParse({
    ...modelsInput,
    ...(checkArn === undefined ? {} : { openRouter: { secretArn: checkArn, ...(openRouterProviders === undefined ? {} : { providers: openRouterProviders }) } }),
  });
  if (!parsedModels.success) throw agentXError("CONFIG_INVALID", "invalid model configuration; check providers and the OpenRouter secret ARN/provider slugs");
  const models: InitAnswers["models"] = secretArn === undefined ? ModelsAnswersSchema.parse(modelsInput) : parsedModels.data;

  const boundary = flags.permissionBoundary ?? values[SETTINGS_FIELD.permissionBoundary] ?? "";
  const operator = flags.operatorPrincipal ?? values[SETTINGS_FIELD.operatorPrincipal] ?? "";

  return {
    platform: {
      engine, identity, models,
      ...(boundary === "" ? {} : { permissionsBoundaryArn: boundary }),
      ...(operator === "" ? {} : { operatorPrincipalArn: operator }),
    },
    ...(openRouterKey === undefined ? {} : { openRouterKey, ...(openRouterProviders === undefined ? {} : { openRouterProviders }) }),
  };
}

export async function readOpenRouterKeyAnswer(input: { source: SecretSource; processEnv: NodeJS.ProcessEnv; prompter: Prompter; readFile?: (path: string) => Promise<string> }): Promise<string> {
  let key: string;
  try {
    key = await secretFromSource({ what: "OpenRouter API key", flag: "--openrouter-key", ...input });
  } catch (error) {
    // With --yes, the refusal also names the bring-your-own-secret flag.
    if (error instanceof Error && /needs an answer; with --yes/.test(error.message)) {
      throw agentXError("CONFIG_INVALID", `${error.message.replace(/^[A-Z_]+: /, "")}, or --openrouter-secret-arn <arn> for a secret you made yourself`);
    }
    throw error;
  }
  if (key.length < OPENROUTER_KEY_MIN_LENGTH) throw agentXError("CONFIG_INVALID", "the OpenRouter API key is too short; copy it again from openrouter.ai/settings/keys");
  return key;
}

/** How a resume check's value is normalized before comparing (Fix round 1, item 2): a person
 * retyping the same flag on a resumed run should not be refused over formatting, only over an
 * actually different answer. Every kind starts from a trimmed value. */
type ResumeCheckKind = "url" | "login" | "email";

const RESUME_CHECKS: Array<{ flag: string; key: keyof InitFlags; kind?: ResumeCheckKind; stored: (answers: InitAnswers) => string | undefined }> = [
  { flag: "--engine", key: "engine", stored: (a) => a.engine },
  { flag: "--identity", key: "identity", stored: (a) => a.identity.mode },
  { flag: "--oidc-issuer", key: "oidcIssuer", kind: "url", stored: (a) => (a.identity.mode === "oidc" ? a.identity.issuer : undefined) },
  { flag: "--oidc-audience", key: "oidcAudience", stored: (a) => (a.identity.mode === "oidc" ? a.identity.audience : undefined) },
  { flag: "--oidc-client-id", key: "oidcClientId", stored: (a) => (a.identity.mode === "oidc" ? a.identity.clientId : undefined) },
  { flag: "--admin-claim", key: "adminClaim", stored: (a) => (a.identity.mode === "oidc" ? a.identity.adminClaim : undefined) },
  { flag: "--orchestrator-model", key: "orchestratorModel", stored: (a) => a.models.orchestrator },
  { flag: "--classifier-model", key: "classifierModel", stored: (a) => a.models.classifier },
  { flag: "--model-provider", key: "modelProvider", stored: (a) => {
    const { orchestrator = "amazon-bedrock", classifier = "amazon-bedrock", worker = "amazon-bedrock" } = a.models.providers ?? {};
    return orchestrator === classifier && classifier === worker ? worker : "mixed";
  } },
  { flag: "--orchestrator-provider", key: "orchestratorProvider", stored: (a) => a.models.providers?.orchestrator ?? "amazon-bedrock" },
  { flag: "--classifier-provider", key: "classifierProvider", stored: (a) => a.models.providers?.classifier ?? "amazon-bedrock" },
  { flag: "--worker-provider", key: "workerProvider", stored: (a) => a.models.providers?.worker ?? "amazon-bedrock" },
  { flag: "--openrouter-secret-arn", key: "openrouterSecretArn", stored: (a) => a.models.openRouter?.secretArn },
  { flag: "--openrouter-providers", key: "openrouterProviders", stored: (a) => a.models.openRouter?.providers?.join(",") },
  { flag: "--worker-model", key: "workerModel", stored: (a) => a.models.worker },
  { flag: "--permission-boundary", key: "permissionBoundary", stored: (a) => a.permissionsBoundaryArn ?? "" },
  { flag: "--operator-principal", key: "operatorPrincipal", stored: (a) => a.operatorPrincipalArn ?? "" },
  { flag: "--alert-email", key: "alertEmail", kind: "email", stored: (a) => (a.alert.kind === "email" ? a.alert.address : undefined) },
  { flag: "--budget", key: "budget", stored: (a) => String(a.budget?.monthlyUsd ?? 0) },
  { flag: "--budget-scope", key: "budgetScope", stored: (a) => a.budget?.scope },
  { flag: "--github-account", key: "githubAccount", kind: "login", stored: (a) => a.github.account },
  { flag: "--github-account-type", key: "githubAccountType", stored: (a) => a.github.accountType },
  { flag: "--github-app-name", key: "githubAppName", stored: (a) => a.github.appName },
  { flag: "--slack-app-name", key: "slackAppName", stored: (a) => a.slack.appName },
  { flag: "--slack-app-posted-messages", key: "slackAppPostedMessages", stored: (a) => a.slack.appPostedMessages },
  { flag: "--worker-image", key: "workerImage", stored: (a) => a.images?.worker },
  { flag: "--slack-image", key: "slackImage", stored: (a) => a.images?.slack },
];

/** Trims, then applies the one further normalization `kind` calls for: a URL (the OIDC issuer)
 * drops a trailing slash, and a login or an email address lowercases (GitHub logins and email
 * addresses are not case-sensitive; everything else here is compared as typed). */
function normalizeResumeValue(value: string, kind: ResumeCheckKind | undefined): string {
  const trimmed = value.trim();
  if (kind === "url") return trimmed.replace(/\/+$/, "");
  if (kind === "login" || kind === "email") return trimmed.toLowerCase();
  return trimmed;
}

function resumeMismatch(flagDisplay: string, was: string | undefined): never {
  throw agentXError(
    "CONFIG_INVALID",
    `${flagDisplay} differs from what this install started with (${was ?? "not set"}); an install's answers cannot change halfway. Run agentx init without that flag to continue`,
  );
}

export function webhookFlagDisplay(source: SecretSource): string {
  if (source.file !== undefined) return `--alert-webhook-file ${source.file}`;
  if (source.envName !== undefined) return `--alert-webhook-env ${source.envName}`;
  return "--alert-webhook";
}

/** Every field a stored install's `alert` can take, in words a person who typed a conflicting flag
 * recognizes: what this install already decided, not the (possibly secret) value behind it. */
function alertKindWord(alert: InitAnswers["alert"]): string {
  return alert.kind;
}

/** `--admin-values` as a set of trimmed, non-empty entries: order and spacing around the commas
 * are not part of the answer, so a resume that retypes the same values in a different order or
 * without the space after a comma must not be refused over it. */
function adminValuesSet(raw: string): Set<string> {
  return new Set(raw.split(",").map((value) => value.trim()).filter((value) => value !== ""));
}

function sameSet(given: Set<string>, was: Set<string>): boolean {
  return given.size === was.size && [...given].every((value) => was.has(value));
}

/** Refuses a typed flag that differs from what this install started with (F10: also the OIDC
 * flags, --alert-webhook-file/--alert-webhook-env, and --no-alerts, none of which fit the
 * string-flag loop above, since an OIDC field can share the loop but a webhook source and a
 * boolean cannot: the loop only ever compares strings, and a webhook's real value is secret).
 * Every comparison first normalizes both sides (Fix round 1, item 2), so a resume is refused only
 * over an actually different answer, never over whitespace, a trailing slash on a URL, letter
 * case in a GitHub login or email address, or the order admin values were typed in. */
export function assertResumeFlagsMatch(stored: InitAnswers, flags: InitFlags): void {
  for (const check of RESUME_CHECKS) {
    const given = flags[check.key];
    if (given === undefined || typeof given !== "string") continue;
    const was = check.stored(stored);
    const normalizedWas = was === undefined ? undefined : normalizeResumeValue(was, check.kind);
    if (normalizeResumeValue(given, check.kind) !== normalizedWas) resumeMismatch(`${check.flag} ${given}`, was);
  }
  if (flags.adminValues !== undefined) {
    const was = stored.identity.mode === "oidc" ? stored.identity.adminValues : undefined;
    if (!sameSet(adminValuesSet(flags.adminValues), new Set(was ?? []))) {
      resumeMismatch(`--admin-values ${flags.adminValues}`, was === undefined ? undefined : was.join(", "));
    }
  }
  if (flags.alerts === false && stored.alert.kind !== "none") {
    resumeMismatch("--no-alerts", alertKindWord(stored.alert));
  }
  if (flags.alertWebhook !== undefined && stored.alert.kind !== "webhook") {
    resumeMismatch(webhookFlagDisplay(flags.alertWebhook), alertKindWord(stored.alert));
  }
  // A key flag on a resume replaces the key init stored; an install that reads a secret you made
  // yourself, or uses no OpenRouter, has no such key to replace.
  if (flags.openrouterKey !== undefined && !storesOwnOpenRouterKey(stored)) {
    resumeMismatch(openRouterKeyFlagDisplay(flags.openrouterKey), stored.models.openRouter?.secretArn);
  }
}

/** True when the install's OpenRouter secret is the one init created, openRouterSecretName(env). */
export function storesOwnOpenRouterKey(answers: InitAnswers): boolean {
  const arn = answers.models.openRouter?.secretArn;
  return arn !== undefined && arn.split(":secret:")[1]?.replace(/-[A-Za-z0-9]{6}$/, "") === openRouterSecretName(answers.env);
}

function openRouterKeyFlagDisplay(source: SecretSource): string {
  if (source.file !== undefined) return `--openrouter-key-file ${source.file}`;
  if (source.envName !== undefined) return `--openrouter-key-env ${source.envName}`;
  return "--openrouter-key";
}

export interface AlertSecretWriter { create(name: string, value: string): Promise<void>; put(name: string, value: string): Promise<void> }

/** Creates the secret, or replaces its value when it already exists. */
async function createOrReplaceSecret(secrets: AlertSecretWriter, secretName: string, value: string): Promise<void> {
  try {
    await secrets.create(secretName, value);
  } catch (error) {
    if (!(error instanceof SecretAlreadyExistsError)) throw error;
    await secrets.put(secretName, value);
  }
}

/** Creates the alert webhook secret, or replaces its value when it already exists. */
export async function storeAlertWebhook(secrets: AlertSecretWriter, secretName: string, address: string): Promise<void> {
  await createOrReplaceSecret(secrets, secretName, address);
}

export interface InitSecretWriter extends AlertSecretWriter {
  /** The secret's full ARN, or undefined when it does not exist. Needed only to store an OpenRouter key. */
  arn?(name: string): Promise<string | undefined>;
}

/** Stores the raw OpenRouter key (not JSON: the runtime reads the secret string as the key),
 * replacing a value left by a run that stopped before saving its answers, and returns its ARN. */
export async function storeOpenRouterKey(secrets: InitSecretWriter, env: string, key: string): Promise<string> {
  const name = openRouterSecretName(env);
  await createOrReplaceSecret(secrets, name, key);
  const arn = await secrets.arn?.(name);
  if (arn === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `secret ${name} was just stored but cannot be described; run agentx init again`);
  return arn;
}

/** Stores every secret the answers point to, then saves the answers, and returns what was saved.
 * The secrets go first, so a secret that fails to store leaves no answers behind and the next run
 * starts again from the questions; once the answers are saved, a rerun resumes and asks nothing. */
export async function persistInitAnswers(input: { store: ParameterStore; secrets: InitSecretWriter; collected: CollectedAnswers }): Promise<InitAnswers> {
  const { alertWebhook, openRouterKey, openRouterProviders } = input.collected;
  let answers = input.collected.answers;
  if (alertWebhook !== undefined && answers.alert.kind === "webhook") await storeAlertWebhook(input.secrets, answers.alert.secretName, alertWebhook);
  if (openRouterKey !== undefined) {
    const secretArn = await storeOpenRouterKey(input.secrets, answers.env, openRouterKey);
    answers = { ...answers, models: ModelsAnswersSchema.parse({ ...answers.models, openRouter: { secretArn, ...(openRouterProviders === undefined ? {} : { providers: openRouterProviders }) } }) };
  }
  await writeInstallAnswers(input.store, answers);
  return answers;
}

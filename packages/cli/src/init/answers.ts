import { DEFAULT_BEDROCK_MODELS } from "@agentx/model-runtime/config";
// FR-016's questions, each with a flag (FR-020). Only flags the engineer typed arrive here, so a
// commander default never silently skips a question. An alert webhook carries its integration
// key, so it is a secret: it is never a flag value and never stored in the answers.
import { agentXError, ImageDigest } from "@agentx/contracts";
import { AlertEmailSchema, GITHUB_LOGIN_PATTERN, ModelsAnswersSchema } from "../deploy/answer-schemas.js";
import { SecretAlreadyExistsError } from "../deploy/signing-key.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { writeInstallAnswers, type InitAnswers } from "./install-state.js";
import { secretFromSource, type Prompter, type SecretSource } from "./prompts.js";

export const DEFAULT_ORCHESTRATOR_MODEL = DEFAULT_BEDROCK_MODELS.orchestrator;
export const DEFAULT_CLASSIFIER_MODEL = DEFAULT_BEDROCK_MODELS.classifier;
export const DEFAULT_WORKER_MODEL = DEFAULT_BEDROCK_MODELS.worker;
const GLM = "zai.glm-4.7";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export const ORCHESTRATOR_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT_ORCHESTRATOR_MODEL, label: "Claude Sonnet 4.6 (recommended; about $0.025 a turn)" },
  { value: GLM, label: "GLM 4.7 (lower cost; about $0.007 a turn)" },
];
export const CLASSIFIER_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT_CLASSIFIER_MODEL, label: "Amazon Nova Lite (default)" },
  { value: HAIKU, label: "Claude Haiku 4.5 (needs Anthropic model access in Bedrock)" },
];
export const GLM_NOTE =
  "GLM 4.7 costs about $0.007 a turn against Claude Sonnet 4.6's $0.025, and passed as many evaluation cases (58 of 65), but it refused correctly in only 6 of 7 cases that needed a refusal (Sonnet 4.6: 7 of 7).";
export const HAIKU_NOTE =
  "Claude Haiku 4.5 needs Anthropic model access in this account: a one-time use-case form in the Bedrock console. The prerequisite check below tests it.";
const NO_ALERTS_NOTE = "No alert address: nobody is told when AgentX fails until you add one (agentx config set alerts.address, phase 15e).";

export interface InitFlags {
  engine?: "templates" | "cdk";
  identity?: "cognito" | "oidc";
  oidcIssuer?: string; oidcAudience?: string; oidcClientId?: string; adminClaim?: string; adminValues?: string;
  orchestratorModel?: string; classifierModel?: string; workerModel?: string;
  orchestratorProvider?: string; classifierProvider?: string; workerProvider?: string;
  openrouterSecretArn?: string; openrouterProviders?: string;
  permissionBoundary?: string; operatorPrincipal?: string;
  alertEmail?: string;
  /** --alert-webhook-file / --alert-webhook-env: there is deliberately no flag that takes the address itself. */
  alertWebhook?: SecretSource;
  /** false for --no-alerts */
  alerts?: boolean;
  githubAccount?: string; githubAccountType?: "organization" | "user"; githubAppName?: string;
  slackAppName?: string; slackAppPostedMessages?: "accept" | "ignore";
  workerImage?: string; slackImage?: string;
}

export interface CollectedAnswers { answers: InitAnswers; /** the secret webhook address, never stored in answers */ alertWebhook?: string; notes: string[] }

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

const optionalArn = (pattern: RegExp, what: string) => (value: string): string | undefined =>
  value === "" || pattern.test(value) ? undefined : `must be ${what}`;

const checkEmail = (value: string): string | undefined => (AlertEmailSchema.safeParse(value).success ? undefined : "must be an email address");

async function modelChoice(prompter: Prompter, flagValue: string | undefined, question: string, flag: string, choices: ReadonlyArray<{ value: string; label: string }>, defaultValue: string): Promise<string> {
  if (flagValue !== undefined) return flagValue;
  const picked = await prompter.choose<string>(question, [...choices, { value: "other", label: "Another Bedrock model id" }], { flag, defaultValue });
  return picked === "other" ? prompter.ask(`${question} id`, { flag }) : picked;
}

function digestFlag(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!ImageDigest.safeParse(value).success) throw agentXError("CONFIG_INVALID", `${flag} must be referenced by digest (repository@sha256:...)`);
  return value;
}

export async function collectInitAnswers(input: {
  env: string; region: string; account: string; releaseVersion: string;
  flags: InitFlags; prompter: Prompter; processEnv: NodeJS.ProcessEnv; now: () => number;
  readFile?: (path: string) => Promise<string>;
}): Promise<CollectedAnswers> {
  const { flags, prompter } = input;
  const notes: string[] = [];
  const workerImage = digestFlag(flags.workerImage, "--worker-image");
  const slackImage = digestFlag(flags.slackImage, "--slack-image");

  const engine = flags.engine ?? (await prompter.choose<"templates" | "cdk">("Deploy engine", [
    { value: "templates", label: "templates: published CloudFormation templates, no CDK setup (recommended)" },
    { value: "cdk", label: "cdk: deploy from AgentX's CDK code at the release tag" },
  ], { flag: "--engine", defaultValue: "templates" }));

  const identityMode = flags.identity ?? (await prompter.choose<"cognito" | "oidc">("Sign-in", [
    { value: "cognito", label: "Create a Cognito user pool for AgentX (recommended)" },
    { value: "oidc", label: "Use your own OIDC provider" },
  ], { flag: "--identity", defaultValue: "cognito" }));
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

  const providers = {
    orchestrator: flags.orchestratorProvider ?? "amazon-bedrock",
    classifier: flags.classifierProvider ?? "amazon-bedrock",
    worker: flags.workerProvider ?? "amazon-bedrock",
  };
  if (Object.values(providers).some((value) => value !== "amazon-bedrock" && value !== "openrouter")) {
    throw agentXError("CONFIG_INVALID", "model providers must be amazon-bedrock or openrouter");
  }
  const orchestrator = providers.orchestrator === "openrouter"
    ? flags.orchestratorModel ?? await prompter.ask("OpenRouter orchestrator model id", { flag: "--orchestrator-model" })
    : await modelChoice(prompter, flags.orchestratorModel, "Orchestrator model", "--orchestrator-model", ORCHESTRATOR_MODEL_CHOICES, DEFAULT_ORCHESTRATOR_MODEL);
  const classifier = providers.classifier === "openrouter"
    ? flags.classifierModel ?? await prompter.ask("OpenRouter classifier model id", { flag: "--classifier-model" })
    : await modelChoice(prompter, flags.classifierModel, "Action-gate classifier model", "--classifier-model", CLASSIFIER_MODEL_CHOICES, DEFAULT_CLASSIFIER_MODEL);
  const worker = flags.workerModel ?? await prompter.ask("Worker model id", { flag: "--worker-model", ...(providers.worker === "amazon-bedrock" ? { defaultValue: DEFAULT_WORKER_MODEL } : {}) });
  const usesOpenRouter = Object.values(providers).includes("openrouter");
  const secretArn = flags.openrouterSecretArn ?? (usesOpenRouter ? await prompter.ask("OpenRouter Secrets Manager ARN (leave blank to use the default Bedrock model)", { flag: "--openrouter-secret-arn", defaultValue: "" }) : undefined);
  if (flags.openrouterProviders && !secretArn) throw agentXError("CONFIG_INVALID", "--openrouter-providers requires --openrouter-secret-arn");
  const parsedModels = ModelsAnswersSchema.safeParse({ orchestrator, classifier, worker,
    ...(usesOpenRouter ? { providers } : {}),
    ...(secretArn ? { openRouter: { secretArn, ...(flags.openrouterProviders ? { providers: flags.openrouterProviders.split(",") } : {}) } } : {}),
  });
  if (!parsedModels.success) throw agentXError("CONFIG_INVALID", "invalid model configuration; check providers and the OpenRouter secret ARN/provider slugs");

  if (orchestrator === GLM) notes.push(GLM_NOTE);
  if (classifier === HAIKU) notes.push(HAIKU_NOTE);

  const boundary = flags.permissionBoundary ?? (await prompter.ask("Permission boundary policy ARN (Enter for AgentX's default boundary)", {
    flag: "--permission-boundary", defaultValue: "", validate: optionalArn(/^arn:aws[a-z-]*:iam::\d{12}:policy\/.+$/, "an IAM policy ARN"),
  }));
  const operator = flags.operatorPrincipal ?? (await prompter.ask("IAM principal allowed to assume the AgentX operator role (Enter for this account)", {
    flag: "--operator-principal", defaultValue: "", validate: optionalArn(/^arn:aws[a-z-]*:(iam|sts)::\d{12}:.+$/, "an IAM principal ARN"),
  }));

  let alert: InitAnswers["alert"] | undefined;
  let alertWebhook: string | undefined;
  const emailFlag = "--alert-email (or --alert-webhook-file, --alert-webhook-env, --no-alerts)";
  const readWebhook = async (source: SecretSource) => checkAlertWebhook(await secretFromSource({
    what: "alert webhook address", flag: "--alert-webhook", source, processEnv: input.processEnv, prompter,
    ...(input.readFile === undefined ? {} : { readFile: input.readFile }),
  }));
  if (flags.alerts === false) {
    alert = { kind: "none" };
  } else if (flags.alertEmail !== undefined) {
    if (checkEmail(flags.alertEmail) !== undefined) throw agentXError("CONFIG_INVALID", `--alert-email ${flags.alertEmail} is not an email address`);
    alert = { kind: "email", address: flags.alertEmail };
  } else if (flags.alertWebhook !== undefined) {
    alertWebhook = await readWebhook(flags.alertWebhook);
  } else {
    const kind = await prompter.choose<"email" | "webhook" | "none">("Where should AgentX send alerts?", [
      { value: "email", label: "An email address" },
      { value: "webhook", label: "A PagerDuty or Opsgenie integration address (kept secret)" },
      { value: "none", label: "Nowhere for now" },
    ], { flag: emailFlag, defaultValue: "email" });
    if (kind === "email") {
      alert = { kind: "email", address: await prompter.ask("Alert email address", { flag: emailFlag, validate: checkEmail }) };
    } else if (kind === "webhook") {
      alertWebhook = await readWebhook({});
    } else {
      alert = { kind: "none" };
    }
  }
  if (alertWebhook !== undefined) alert = { kind: "webhook", display: webhookDisplay(alertWebhook), secretName: alertWebhookSecretName(input.env) };
  if (alert === undefined) throw new Error("unreachable: every alert branch sets alert");
  if (alert.kind === "none") notes.push(NO_ALERTS_NOTE);

  const githubAccount = flags.githubAccount ?? (await prompter.ask("GitHub organization or user that will own the AgentX GitHub App", {
    flag: "--github-account", validate: (value) => (GITHUB_LOGIN_PATTERN.test(value) ? undefined : "must be a GitHub organization or user name"),
  }));
  if (!GITHUB_LOGIN_PATTERN.test(githubAccount)) throw agentXError("CONFIG_INVALID", `--github-account ${githubAccount} is not a GitHub organization or user name`);
  const accountType = flags.githubAccountType ?? (await prompter.choose<"organization" | "user">(`Is ${githubAccount} an organization or a personal account?`, [
    { value: "organization", label: "An organization" },
    { value: "user", label: "A personal account" },
  ], { flag: "--github-account-type", defaultValue: "organization" }));
  const appName = flags.githubAppName ?? (await prompter.ask("GitHub App name (must be unique on GitHub)", {
    flag: "--github-app-name", defaultValue: `AgentX ${githubAccount} ${input.env}`.slice(0, 34),
    validate: (value) => (value.length <= 34 ? undefined : "must be at most 34 characters"),
  }));
  const slackAppName = flags.slackAppName ?? (await prompter.ask("Slack app name", {
    flag: "--slack-app-name", defaultValue: "AgentX", validate: (value) => (value.length <= 35 ? undefined : "must be at most 35 characters"),
  }));
  const appPostedMessages = flags.slackAppPostedMessages ?? (await prompter.choose<"accept" | "ignore">("Answer mentions people post through other apps with their own Slack token?", [
    { value: "accept", label: "Yes (accept)" },
    { value: "ignore", label: "No, only mentions typed in Slack (ignore)" },
  ], { flag: "--slack-app-posted-messages", defaultValue: "accept" }));

  const answers: InitAnswers = {
    schemaVersion: 1,
    env: input.env, region: input.region, account: input.account, engine, releaseVersion: input.releaseVersion,
    identity,
    models: parsedModels.data,
    ...(boundary === "" ? {} : { permissionsBoundaryArn: boundary }),
    ...(operator === "" ? {} : { operatorPrincipalArn: operator }),
    ...(workerImage === undefined && slackImage === undefined
      ? {}
      : { images: { ...(workerImage === undefined ? {} : { worker: workerImage }), ...(slackImage === undefined ? {} : { slack: slackImage }) } }),
    alert,
    github: { account: githubAccount, accountType, appName },
    slack: { appName: slackAppName, appPostedMessages },
    createdAt: new Date(input.now()).toISOString(),
  };
  return { answers, notes, ...(alertWebhook === undefined ? {} : { alertWebhook }) };
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
  { flag: "--orchestrator-provider", key: "orchestratorProvider", stored: (a) => a.models.providers?.orchestrator ?? "amazon-bedrock" },
  { flag: "--classifier-provider", key: "classifierProvider", stored: (a) => a.models.providers?.classifier ?? "amazon-bedrock" },
  { flag: "--worker-provider", key: "workerProvider", stored: (a) => a.models.providers?.worker ?? "amazon-bedrock" },
  { flag: "--openrouter-secret-arn", key: "openrouterSecretArn", stored: (a) => a.models.openRouter?.secretArn },
  { flag: "--openrouter-providers", key: "openrouterProviders", stored: (a) => a.models.openRouter?.providers?.join(",") },
  { flag: "--worker-model", key: "workerModel", stored: (a) => a.models.worker },
  { flag: "--permission-boundary", key: "permissionBoundary", stored: (a) => a.permissionsBoundaryArn ?? "" },
  { flag: "--operator-principal", key: "operatorPrincipal", stored: (a) => a.operatorPrincipalArn ?? "" },
  { flag: "--alert-email", key: "alertEmail", kind: "email", stored: (a) => (a.alert.kind === "email" ? a.alert.address : undefined) },
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
}

export interface AlertSecretWriter { create(name: string, value: string): Promise<void>; put(name: string, value: string): Promise<void> }

/** Creates the alert webhook secret, or replaces its value when it already exists. */
export async function storeAlertWebhook(secrets: AlertSecretWriter, secretName: string, address: string): Promise<void> {
  try {
    await secrets.create(secretName, address);
  } catch (error) {
    if (!(error instanceof SecretAlreadyExistsError)) throw error;
    await secrets.put(secretName, address);
  }
}

export async function persistInitAnswers(input: { store: ParameterStore; secrets: AlertSecretWriter; collected: CollectedAnswers }): Promise<void> {
  const { answers, alertWebhook } = input.collected;
  if (alertWebhook !== undefined && answers.alert.kind === "webhook") await storeAlertWebhook(input.secrets, answers.alert.secretName, alertWebhook);
  await writeInstallAnswers(input.store, answers);
}

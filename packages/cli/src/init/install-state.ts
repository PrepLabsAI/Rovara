// `agentx init`'s own state in SSM, beside the environment settings: the answers (never a secret)
// and the progress (step outcomes, and the GitHub and Slack facts collected so far). Settings are
// written only by deployEnvironment once the Slack stack exists; these two let a stopped init
// resume before that, from any machine with access to the account.
import { z } from "zod";
import { agentXError, AGENTX_NAME_PATTERN, EnvironmentNameSchema, environmentSettingsPrefix, ImageDigest } from "@agentx/contracts";
import { AlertEmailSchema, ACCOUNT_PATTERN, BudgetAnswersSchema, GITHUB_LOGIN_PATTERN, IdentityAnswersSchema, ModelsAnswersSchema, REGION_PATTERN } from "../deploy/answer-schemas.js";
import type { ParameterStore } from "../environments/parameter-store.js";

export const INIT_STEP_IDS = [
  "prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service", "developer-signin",
  // Phase 15d2, appended so no earlier id moves (resume skips done steps in this order).
  "admin-user", "first-project", "connectors", "alerts", "e2e",
] as const;
export type InitStepId = (typeof INIT_STEP_IDS)[number];

export const CONNECTOR_TYPES = ["linear", "jira", "asana"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
export const CONNECTOR_LABELS = { linear: "Linear", jira: "Jira", asana: "Asana" } as const;
export const SSM_STANDARD_VALUE_LIMIT = 4096;

const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;

// Host and an optional port only: no userinfo (`user@` or `user:pass@`), so a webhook integration
// key pasted as part of the URL cannot slip into the stored, and later displayed, value.
const WEBHOOK_DISPLAY_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/\.\.\.$/;

const AlertAnswersSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), address: AlertEmailSchema }).strict(),
  z.object({ kind: z.literal("webhook"), display: z.string().regex(WEBHOOK_DISPLAY_PATTERN), secretName: z.string().regex(/^agentx\/[a-z0-9-]+\/alert-endpoint$/) }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

/** A webhook's secretName must be this environment's own alert-endpoint secret: nothing stops a
 * hand-edited or copied answers file from naming another environment's secret otherwise. Nothing
 * reads the address from it yet (a later AgentX release subscribes it to the alerts topic), and
 * that reader will trust this field as-is. */
function requireWebhookSecretMatchesEnv(answers: { env: string; alert: z.infer<typeof AlertAnswersSchema> }, context: z.RefinementCtx): void {
  if (answers.alert.kind !== "webhook") return;
  const expected = `agentx/${answers.env}/alert-endpoint`;
  if (answers.alert.secretName !== expected) {
    context.addIssue({ code: "custom", path: ["alert", "secretName"], message: `must be ${expected} for this environment's own alert secret` });
  }
}

export const InitAnswersSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  region: z.string().regex(REGION_PATTERN),
  account: z.string().regex(ACCOUNT_PATTERN),
  engine: z.enum(["templates", "cdk"]),
  releaseVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  identity: IdentityAnswersSchema,
  models: ModelsAnswersSchema,
  permissionsBoundaryArn: z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:policy\/.+$/).optional(),
  operatorPrincipalArn: z.string().regex(/^arn:aws[a-z-]*:(iam|sts)::\d{12}:.+$/).optional(),
  images: z.object({ worker: ImageDigest.optional(), slack: ImageDigest.optional() }).strict().optional(),
  alert: AlertAnswersSchema,
  budget: BudgetAnswersSchema.optional(),
  github: z.object({ account: z.string().regex(GITHUB_LOGIN_PATTERN), accountType: z.enum(["organization", "user"]), appName: z.string().min(1).max(34) }).strict(),
  slack: z.object({ appName: z.string().min(1).max(35), appPostedMessages: z.enum(["accept", "ignore"]) }).strict(),
  createdAt: z.iso.datetime(),
}).strict().superRefine(requireWebhookSecretMatchesEnv);

export type InitAnswers = z.infer<typeof InitAnswersSchema>;

const StepRecordSchema = z.object({ status: z.enum(["done", "waiting"]), at: z.iso.datetime(), note: z.string().max(300).optional() }).strict();
export type StepRecord = z.infer<typeof StepRecordSchema>;

export const InstallProgressSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  steps: z.partialRecord(z.enum(INIT_STEP_IDS), StepRecordSchema),
  github: z.object({
    account: z.string().regex(GITHUB_LOGIN_PATTERN),
    appId: z.string().regex(/^\d+$/),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    privateKeySecretArn: z.string().regex(SECRET_ARN),
    installationId: z.string().regex(/^\d+$/).optional(),
  }).strict().optional(),
  slack: z.object({ appId: z.string().regex(/^A[A-Z0-9]+$/), teamId: z.string().regex(/^T[A-Z0-9]+$/), botUserId: z.string().regex(/^[UW][A-Z0-9]+$/) }).strict().optional(),
  admin: z.object({ username: z.string().min(3).max(128), mode: z.enum(["cognito", "oidc"]) }).strict().optional(),
  project: z.object({
    name: z.string().regex(AGENTX_NAME_PATTERN),
    revision: z.number().int().positive(),
    channelName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/).optional(),
    channelId: z.string().regex(/^[CG][A-Z0-9]{8,}$/).optional(),
    teamId: z.string().regex(/^T[A-Z0-9]+$/).optional(),
  }).strict().optional(),
  // warning: a connector saved with a caution (owner decision 6: a Jira account that sees other
  // projects), kept so 15e's doctor can show it again. At most 300 characters, never a secret.
  connectors: z.array(z.object({ type: z.enum(CONNECTOR_TYPES), ref: z.string().regex(AGENTX_NAME_PATTERN), warning: z.string().min(1).max(300).optional() }).strict()).max(3).optional(),
  alerts: z.object({ subscribed: z.boolean(), tested: z.boolean() }).strict().optional(),
  updatedAt: z.iso.datetime(),
}).strict();

export type InstallProgress = z.infer<typeof InstallProgressSchema>;

export function installAnswersParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}install/answers`;
}

export function installProgressParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}install/progress`;
}

export function emptyProgress(env: string, now: number): InstallProgress {
  return { schemaVersion: 1, env, steps: {}, updatedAt: new Date(now).toISOString() };
}

/** The size-limit error's advice for the answers parameter: unlike progress, an answer that grows
 * too large is something the person typing it in can actually shorten. */
const ANSWERS_SIZE_HINT = "shorten the longest answer (for example the admin values list)";

/** The size-limit error's advice for the progress parameter: nothing a person enters here can be
 * shortened (every field comes from GitHub, Slack or agentx itself), so this is agentx's own bug to
 * fix, not something to work around; deleting the parameter is always safe because the answers
 * (which everything else needs to resume) live in a separate parameter. */
const PROGRESS_SIZE_HINT = "this is an internal limit, not something you did; report it as an AgentX bug, and delete the install/progress parameter to restart agentx init safely (its answers are stored separately and are unaffected)";

async function writeJson(store: ParameterStore, name: string, what: string, env: string, hint: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json);
  if (bytes > SSM_STANDARD_VALUE_LIMIT) {
    throw agentXError("CONFIG_INVALID", `${what} for environment ${env} are ${bytes} bytes, more than SSM's ${SSM_STANDARD_VALUE_LIMIT}-byte limit; ${hint}`);
  }
  await store.put(name, json);
}

/** Drops any step id `INIT_STEP_IDS` no longer has, so progress written by an agentx version that
 * added, removed or renamed a step can still be read: a step this agentx doesn't recognize carries
 * no state it can use, but refusing the whole parameter over it would strand every other step's
 * already-recorded progress too. Only `readInstallProgress` uses this; writing progress stays fully
 * strict (this agentx never itself writes an id `INIT_STEP_IDS` doesn't have). */
function dropUnknownSteps(json: unknown): unknown {
  if (typeof json !== "object" || json === null) return json;
  const record = json as Record<string, unknown>;
  const steps = record.steps;
  if (typeof steps !== "object" || steps === null) return json;
  const known = new Set<string>(INIT_STEP_IDS);
  const filteredSteps = Object.fromEntries(Object.entries(steps as Record<string, unknown>).filter(([id]) => known.has(id)));
  return { ...record, steps: filteredSteps };
}

/** Parses `stored` against `schema` (through `sanitize` first, when given), then confirms its own
 * `env` field names the environment this parameter was read for: a value copied or restored under
 * the wrong environment's parameter name would otherwise pass schema validation (its `env` is still
 * a well-formed environment name) and silently resume, or report progress for, the wrong
 * environment. */
async function readJson<T extends { env: string }>(store: ParameterStore, name: string, schema: z.ZodType<T>, env: string, invalid: string, sanitize?: (json: unknown) => unknown): Promise<T | undefined> {
  const stored = await store.get(name);
  if (stored === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(stored.value);
  } catch {
    throw agentXError("CONFIG_INVALID", invalid);
  }
  const parsed = schema.safeParse(sanitize === undefined ? json : sanitize(json));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", invalid);
  if (parsed.data.env !== env) {
    throw agentXError(
      "CONFIG_INVALID",
      `${name} is stored for environment ${env} but names environment ${parsed.data.env}; run agentx init --env ${parsed.data.env}, or delete ${name} to start over`,
    );
  }
  return parsed.data;
}

export async function readInstallAnswers(store: ParameterStore, env: string): Promise<InitAnswers | undefined> {
  return readJson(store, installAnswersParameterName(env), InitAnswersSchema, env, `install answers for environment ${env} are invalid or were written by a newer agentx; upgrade agentx and run it again`);
}

export async function writeInstallAnswers(store: ParameterStore, answers: InitAnswers): Promise<void> {
  const parsed = InitAnswersSchema.safeParse(answers);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `install answers are invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  await writeJson(store, installAnswersParameterName(answers.env), "install answers", answers.env, ANSWERS_SIZE_HINT, parsed.data);
}

export async function readInstallProgress(store: ParameterStore, env: string): Promise<InstallProgress | undefined> {
  return readJson(
    store, installProgressParameterName(env), InstallProgressSchema, env,
    `install progress for environment ${env} is invalid or was written by a newer agentx; upgrade agentx and run it again`,
    dropUnknownSteps,
  );
}

export async function writeInstallProgress(store: ParameterStore, progress: InstallProgress): Promise<void> {
  const parsed = InstallProgressSchema.safeParse(progress);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `install progress is invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  await writeJson(store, installProgressParameterName(progress.env), "install progress", progress.env, PROGRESS_SIZE_HINT, parsed.data);
}

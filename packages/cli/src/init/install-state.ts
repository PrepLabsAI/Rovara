// `agentx init`'s own state in SSM, beside the environment settings: the answers (never a secret)
// and the progress (step outcomes, and the GitHub and Slack facts collected so far). Settings are
// written only by deployEnvironment once the Slack stack exists; these two let a stopped init
// resume before that, from any machine with access to the account.
import { z } from "zod";
import { agentXError, EnvironmentNameSchema, environmentSettingsPrefix, ImageDigest } from "@agentx/contracts";
import { AlertEmailSchema, ACCOUNT_PATTERN, IdentityAnswersSchema, ModelsAnswersSchema, REGION_PATTERN } from "../deploy/answer-schemas.js";
import type { ParameterStore } from "../environments/parameter-store.js";

export const INIT_STEP_IDS = ["prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service"] as const;
export type InitStepId = (typeof INIT_STEP_IDS)[number];
export const SSM_STANDARD_VALUE_LIMIT = 4096;

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;

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
  alert: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("email"), address: AlertEmailSchema }).strict(),
    z.object({ kind: z.literal("webhook"), display: z.string().regex(/^https:\/\/[^/\s]+\/\.\.\.$/), secretName: z.string().regex(/^agentx\/[a-z0-9-]+\/alert-endpoint$/) }).strict(),
    z.object({ kind: z.literal("none") }).strict(),
  ]),
  github: z.object({ account: z.string().regex(GITHUB_LOGIN), accountType: z.enum(["organization", "user"]), appName: z.string().min(1).max(34) }).strict(),
  slack: z.object({ appName: z.string().min(1).max(35), appPostedMessages: z.enum(["accept", "ignore"]) }).strict(),
  createdAt: z.iso.datetime(),
}).strict();

export type InitAnswers = z.infer<typeof InitAnswersSchema>;

const StepRecordSchema = z.object({ status: z.enum(["done", "waiting"]), at: z.iso.datetime(), note: z.string().max(300).optional() }).strict();
export type StepRecord = z.infer<typeof StepRecordSchema>;

export const InstallProgressSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  steps: z.partialRecord(z.enum(INIT_STEP_IDS), StepRecordSchema),
  github: z.object({
    account: z.string().regex(GITHUB_LOGIN),
    appId: z.string().regex(/^\d+$/),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    privateKeySecretArn: z.string().regex(SECRET_ARN),
    installationId: z.string().regex(/^\d+$/).optional(),
  }).strict().optional(),
  slack: z.object({ appId: z.string().regex(/^A[A-Z0-9]+$/), teamId: z.string().regex(/^T[A-Z0-9]+$/), botUserId: z.string().regex(/^[UW][A-Z0-9]+$/) }).strict().optional(),
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

async function writeJson(store: ParameterStore, name: string, what: string, env: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json);
  if (bytes > SSM_STANDARD_VALUE_LIMIT) {
    throw agentXError("CONFIG_INVALID", `${what} for environment ${env} are ${bytes} bytes, more than SSM's ${SSM_STANDARD_VALUE_LIMIT}-byte limit; shorten the longest answer (for example the admin values list)`);
  }
  await store.put(name, json);
}

/** Parses `stored` against `schema`, then confirms its own `env` field names the environment this
 * parameter was read for: a value copied or restored under the wrong environment's parameter name
 * would otherwise pass schema validation (its `env` is still a well-formed environment name) and
 * silently resume, or report progress for, the wrong environment. */
async function readJson<T extends { env: string }>(store: ParameterStore, name: string, schema: z.ZodType<T>, env: string, invalid: string): Promise<T | undefined> {
  const stored = await store.get(name);
  if (stored === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(stored.value);
  } catch {
    throw agentXError("CONFIG_INVALID", invalid);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", invalid);
  if (parsed.data.env !== env) {
    throw agentXError("CONFIG_INVALID", `${name} is stored for environment ${env} but names environment ${parsed.data.env}`);
  }
  return parsed.data;
}

export async function readInstallAnswers(store: ParameterStore, env: string): Promise<InitAnswers | undefined> {
  return readJson(store, installAnswersParameterName(env), InitAnswersSchema, env, `install answers for environment ${env} are invalid or were written by a newer agentx; upgrade agentx and run it again`);
}

export async function writeInstallAnswers(store: ParameterStore, answers: InitAnswers): Promise<void> {
  const parsed = InitAnswersSchema.safeParse(answers);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `install answers are invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  await writeJson(store, installAnswersParameterName(answers.env), "install answers", answers.env, parsed.data);
}

export async function readInstallProgress(store: ParameterStore, env: string): Promise<InstallProgress | undefined> {
  return readJson(store, installProgressParameterName(env), InstallProgressSchema, env, `install progress for environment ${env} is invalid or was written by a newer agentx; upgrade agentx and run it again`);
}

export async function writeInstallProgress(store: ParameterStore, progress: InstallProgress): Promise<void> {
  const parsed = InstallProgressSchema.safeParse(progress);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `install progress is invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  await writeJson(store, installProgressParameterName(progress.env), "install progress", progress.env, parsed.data);
}

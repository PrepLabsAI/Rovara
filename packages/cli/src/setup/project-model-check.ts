// MODEL1 (M1.4 Task 4.10D): a project's default and approved models are checked when a revision is registered, so a model the account cannot use is found before the first task that
// switches to it. The check is the shared single-call model check; what is stored with a pair is a class and a time, never a message, a signal or provider text.
import { MODEL_PROVIDERS, ProjectDefinitionSchema, agentXError, modelCheckClassSentence, modelKey, type ModelCheckRecord, type ModelProvider, type ModelRef, type ProjectDefinition } from "@agentx/contracts";
import type { ModelCheckResult } from "@agentx/model-runtime/model-check";
import { environmentProjectFiles } from "./project-add.js";
import { check as doctorCheck, type DoctorCheck, type DoctorContext } from "../doctor/checks.js";
import { runModelCheck } from "../init/run-model-check.js";

/** One single-call check of a provider and model, with the environment's own keys and region. */
export type ProjectModelChecker = (pair: { provider: ModelProvider; modelId: string }) => Promise<ModelCheckResult>;

/** The most pairs a project may approve (ProjectModelsSchema), and so the most one registration checks. */
export const PROJECT_MODEL_CHECK_MAX_PAIRS = 16;
/** One pair's check is cut off here: a model that never answers is an outage, not a hang. */
export const PROJECT_MODEL_CHECK_LIMIT_MS = 30_000;

const isCheckableProvider = (provider: string): provider is ModelProvider => (MODEL_PROVIDERS as readonly string[]).includes(provider);
const describePair = (model: ModelRef): string => (model.label === undefined ? `${model.provider}/${model.modelId}` : `${model.label} (${model.provider}/${model.modelId})`);

async function bounded(check: ProjectModelChecker, pair: { provider: ModelProvider; modelId: string }, timeoutMs: number): Promise<ModelCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<ModelCheckResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, class: "provider-outage", signal: "timeout", error: new Error("the check was cut off") }), timeoutMs);
  });
  try { return await Promise.race([check(pair), cut]); }
  finally { clearTimeout(timer); }
}

/**
 * Checks the default model first, then every other approved pair, one at a time. A failing default refuses the registration with the class sentence; a failing approved pair is a warning,
 * and registers. Each checked pair carries its result (`lastCheck`) in the returned definition. A definition without models, a missing checker, and a provider this agentx cannot
 * check leave the definition as it was.
 */
export async function checkProjectModels(input: {
  definition: ProjectDefinition; check: ProjectModelChecker | undefined; now?: (() => number) | undefined; timeoutMs?: number;
}): Promise<{ definition: ProjectDefinition; warnings: string[] }> {
  const models = input.definition.models;
  if (models === undefined || input.check === undefined) return { definition: input.definition, warnings: [] };
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? PROJECT_MODEL_CHECK_LIMIT_MS;
  const defaultKey = modelKey(models.default);
  const ordered = [...models.approved.filter((model) => modelKey(model) === defaultKey), ...models.approved.filter((model) => modelKey(model) !== defaultKey)].slice(0, PROJECT_MODEL_CHECK_MAX_PAIRS);
  const records = new Map<string, ModelCheckRecord>();
  const warnings: string[] = [];
  for (const model of ordered) {
    if (!isCheckableProvider(model.provider)) continue;
    const result = await bounded(input.check, { provider: model.provider, modelId: model.modelId }, timeoutMs);
    const checkedAt = new Date(now()).toISOString();
    if (result.ok) { records.set(modelKey(model), { status: "ok", checkedAt }); continue; }
    const sentence = modelCheckClassSentence({ provider: model.provider, modelId: model.modelId, class: result.class });
    if (modelKey(model) === defaultKey) {
      throw agentXError("CONFIG_INVALID", `${sentence} Project ${input.definition.name} was not registered; fix its default model, then register again.`);
    }
    records.set(modelKey(model), { status: "failed", class: result.class, checkedAt });
    warnings.push(`The approved model ${describePair(model)} failed its check, and is registered anyway: ${sentence}`);
  }
  const withRecord = (model: ModelRef): ModelRef => { const record = records.get(modelKey(model)); return record === undefined ? model : { ...model, lastCheck: record }; };
  const definition = ProjectDefinitionSchema.parse({ ...input.definition, models: { default: withRecord(models.default), approved: models.approved.map(withRecord) } });
  return { definition, warnings };
}

/** doctor: every approved pair of every project this environment's commands registered, each distinct pair checked once. A failing default is an error, another approved pair a warning. */
export async function projectModelChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, services } = context;
  const files = await environmentProjectFiles(services.configDir, env);
  const results = new Map<string, ModelCheckResult>();
  const found: DoctorCheck[] = [];
  for (const file of files) {
    if (file.error !== undefined) continue;
    const parsed = ProjectDefinitionSchema.safeParse(file.definition);
    const models = parsed.success ? parsed.data.models : undefined;
    if (models === undefined) continue;
    for (const model of models.approved.slice(0, PROJECT_MODEL_CHECK_MAX_PAIRS)) {
      if (!isCheckableProvider(model.provider)) continue;
      const key = `${model.provider}/${model.modelId}`;
      let result = results.get(key);
      if (result === undefined) {
        result = await runModelCheck({ provider: model.provider, modelId: model.modelId, region: settings.region, checks: services.checks, config: settings.models, sleep: services.sleep });
        results.set(key, result);
      }
      const name = `${file.name}: ${model.label ?? key}`;
      if (result.ok) { found.push(doctorCheck("models", name, "ok", `${model.modelId} answers a one-token test call`)); continue; }
      const isDefault = modelKey(model) === modelKey(models.default);
      found.push(doctorCheck("models", name, isDefault ? "fail" : "warn", modelCheckClassSentence({ provider: model.provider, modelId: model.modelId, class: result.class }),
        `choose another model in ${file.path} and register it again, or fix the account's access to ${model.modelId}`));
    }
  }
  return found;
}

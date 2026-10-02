import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { ThinkingLevelSchema, type ModelIdentifier, type ModelRef, type ProjectModels, type ThinkingLevel } from "@agentx/contracts";

/**
 * Spec 053 FR-003: whether the model can run at an admin's thinking level. Pi clamps an unsupported
 * level to a supported one (pi-ai `clampThinkingLevel`), so an admin's "medium" on GLM 5.3 would
 * silently run at "high"; checking at save time refuses it instead. The catalogs are the ones the
 * runtime resolves models from. A model neither catalog knows passes here and is checked at first use.
 * The supported list names only levels AgentX can set: Pi's own "max" is left out.
 */
export type ThinkingLevelSupport = { ok: true } | { ok: false; supported: string[] };

let catalogs: Map<string, ReadonlyMap<string, Model<Api>>> | undefined;

function catalogModel(model: ModelIdentifier): Model<Api> | undefined {
  catalogs ??= new Map([
    ["openrouter", new Map(openrouterProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
    ["amazon-bedrock", new Map(amazonBedrockProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
  ]);
  return catalogs.get(model.provider)?.get(model.modelId);
}

export function thinkingLevelSupport(model: ModelIdentifier, level: ThinkingLevel): ThinkingLevelSupport {
  const known = catalogModel(model);
  if (known === undefined) return { ok: true };
  const settable: readonly string[] = ThinkingLevelSchema.options;
  const supported = getSupportedThinkingLevels(known).filter((entry: string) => settable.includes(entry));
  return supported.includes(level) ? { ok: true } : { ok: false, supported };
}

/** The save-time refusal for one model whose level is unsupported. */
export function thinkingLevelRefusal(label: string, level: ThinkingLevel, supported: readonly string[]): string {
  const choices = supported.length === 0 ? "it supports no thinking level AgentX can set" : `supported: ${supported.join(", ")}`;
  return `${label} does not support thinking level "${level}"; ${choices}`;
}

/** One refusal per distinct unsupported level among the default and the approved models. */
export function unsupportedThinkingLevels(models: ProjectModels): string[] {
  const problems = new Set<string>();
  for (const entry of [...models.approved, models.default]) {
    if (entry.thinkingLevel === undefined) continue;
    const support = thinkingLevelSupport(entry, entry.thinkingLevel);
    if (support.ok) continue;
    const label = labelOf(entry, models.approved);
    problems.add(thinkingLevelRefusal(label, entry.thinkingLevel, support.supported));
  }
  return [...problems];
}

function labelOf(entry: ModelRef, approved: readonly ModelRef[]): string {
  const label = entry.label ?? approved.find((model) => model.provider === entry.provider && model.modelId === entry.modelId)?.label;
  return label === undefined ? entry.modelId : `${label} (${entry.modelId})`;
}

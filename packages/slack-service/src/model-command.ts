import type { ModelRef, ProjectModelOptions } from "@agentx/contracts";
import { escapeText } from "./slack-format.js";

export type ModelCommand = { kind: "list" } | { kind: "use"; selector: string };

export function parseModelCommand(text: string): ModelCommand | undefined {
  const command = text.replace(/^\s*<@[A-Z0-9]+>\s*/iu, "").trim();
  if (/^models[.!?]*$/iu.test(command)) return { kind: "list" };
  const use = /^use(?:\s+(.*?))?[.!?]*$/iu.exec(command);
  return use ? { kind: "use", selector: (use[1] ?? "").trim() } : undefined;
}

export function matchApprovedModel(selector: string, approved: readonly ModelRef[]): ModelRef[] {
  const sought = selector.toLocaleLowerCase("en-US");
  if (sought.length === 0) return [];
  const exact = approved.filter((model) => modelNames(model).some((name) => name.toLocaleLowerCase("en-US") === sought));
  if (exact.length > 0) return exact;
  return approved.filter((model) => modelNames(model).some((name) => name.toLocaleLowerCase("en-US").includes(sought)));
}

export function modelOptionsMessage(options: ProjectModelOptions, introduction = "Approved coding models for this project:"): string {
  const currentKey = `${options.current.provider}\0${options.current.modelId}`;
  return [
    introduction,
    ...options.approved.map((model) => {
      const selected = `${model.provider}\0${model.modelId}` === currentKey ? " _(current)_" : "";
      const thinking = model.thinkingLevel === undefined ? "" : ` (thinking: ${model.thinkingLevel})`;
      return `• ${escapeText(modelName(model))}${thinking} — \`${escapeText(model.provider)}/${escapeText(model.modelId)}\`${selected}`;
    }),
    "Choose one with `@agentx use <name>`.",
  ].join("\n");
}

export function modelName(model: ModelRef): string {
  return model.label ?? `${model.provider}/${model.modelId}`;
}

function modelNames(model: ModelRef): string[] {
  return [model.label, model.modelId, `${model.provider}/${model.modelId}`].filter((value): value is string => value !== undefined);
}

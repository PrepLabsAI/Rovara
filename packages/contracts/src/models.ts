import { z } from "zod";

export const ModelIdentifierSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(256),
}).strict();

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const ModelRefSchema = ModelIdentifierSchema.extend({
  thinkingLevel: ThinkingLevelSchema.optional(),
  label: z.string().trim().min(1).max(64).optional(),
}).strict();

/** A model plus the thinking level to run it at, as carried by an invocation or an eval run. */
export const ModelSelectionSchema = ModelIdentifierSchema.extend({
  thinkingLevel: ThinkingLevelSchema.optional(),
}).strict();

export const ProjectModelsSchema = z.object({
  default: ModelRefSchema,
  approved: z.array(ModelRefSchema).min(1).max(16),
}).strict().superRefine((models, context) => {
  const identifiers = new Set<string>();
  const labels = new Set<string>();
  for (const [index, model] of models.approved.entries()) {
    const identifier = modelKey(model);
    if (identifiers.has(identifier)) {
      context.addIssue({ code: "custom", path: ["approved", index], message: "approved models must have unique provider/modelId pairs" });
    }
    identifiers.add(identifier);
    if (model.label !== undefined) {
      const label = model.label.toLocaleLowerCase("en-US");
      if (labels.has(label)) {
        context.addIssue({ code: "custom", path: ["approved", index, "label"], message: "approved model labels must be unique ignoring case" });
      }
      labels.add(label);
    }
  }
  if (!identifiers.has(modelKey(models.default))) {
    context.addIssue({ code: "custom", path: ["default"], message: "default model must appear in approved" });
  }
});

export const ProjectModelOptionsSchema = z.object({
  projectName: z.string().min(1).max(63),
  approved: z.array(ModelRefSchema).min(1).max(16),
  current: ModelRefSchema,
  source: z.enum(["selection", "default"]),
}).strict();

export const ProjectModelSelectionRequestSchema = ModelIdentifierSchema;

export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export type ModelIdentifier = z.infer<typeof ModelIdentifierSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type ProjectModels = z.infer<typeof ProjectModelsSchema>;
export type ProjectModelOptions = z.infer<typeof ProjectModelOptionsSchema>;

export function modelKey(model: ModelIdentifier): string {
  return `${model.provider}\0${model.modelId}`;
}

import { z } from "zod";
import { EVIDENCE_TRUST_CLASS_WORDS } from "@agentx/contracts";
import { isSageMakerContract, type SageMakerContract, type SageMakerShape } from "./sagemaker-contract.js";

const RatesSchema = z.object({ modelError: z.number().min(0).max(1), throttled: z.number().min(0).max(1), timeout: z.number().min(0).max(1) }).strict().refine((rates) => rates.modelError + rates.throttled + rates.timeout <= 1);
const ControlsSchema = z.object({ latencyMs: z.number().int().min(0).max(60_000), errorRates: RatesSchema }).strict();
type Variant = "typical" | "edge" | "low_score" | "high_score";
function output(shape: SageMakerShape, variant: Variant): unknown {
  switch (shape.type) {
    case "object": return Object.fromEntries(shape.fields.map((field) => [field.name, output(field.shape, variant)]));
    case "array": return variant === "edge" ? [] : [output(shape.items, variant)];
    case "string": return variant === "edge" ? "" : "example";
    case "boolean": return variant !== "edge";
    case "null": return null;
    case "number": case "integer": {
      let low = shape.minimum ?? Math.min(0, shape.maximum ?? 0);
      let high = shape.maximum ?? Math.max(1, low);
      if (shape.type === "integer") { low = Math.ceil(low); high = Math.floor(high); }
      const n = variant === "high_score" ? high : variant === "typical" ? low / 2 + high / 2 : low;
      return shape.type === "integer" ? Math.round(n) : n;
    }
  }
}
function matches(value: unknown, shape: SageMakerShape, depth = 0): boolean {
  if (depth > 12) return false;
  switch (shape.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const entries = Object.entries(value);
      return entries.every(([key]) => shape.fields.some((field) => field.name === key)) && shape.fields.every((field) => !Object.hasOwn(value, field.name) ? !field.required : entries.some(([key, entry]) => key === field.name && matches(entry, field.shape, depth + 1)));
    }
    case "array": return Array.isArray(value) && value.length <= 256 && value.every((entry: unknown) => matches(entry, shape.items, depth + 1));
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string" && value.length <= 65_536;
    case "number": case "integer": return typeof value === "number" && Number.isFinite(value) && (shape.type !== "integer" || Number.isInteger(value)) && (shape.minimum === undefined || value >= shape.minimum) && (shape.maximum === undefined || value <= shape.maximum);
  }
}
const scenario = <T extends Variant>(name: T) => z.object({ scenario: z.literal(name), conformsToContract: z.literal(true), body: z.unknown() }).strict();
/** A versioned document for part B, deliberately not a record or runtime backing.
 * The empty response is an intentional invalid-response exercise when the contract
 * is non-null. Generated values never carry proof authority; the separate provenance
 * lane must enforce exclusion before wiring these functions into a running system. */
export const SageMakerMockConfigSchema = z.object({
  version: z.literal(1),
  trust: z.literal("made_by_rovara"),
  label: z.literal(EVIDENCE_TRUST_CLASS_WORDS.made_by_rovara),
  contract: z.custom<SageMakerContract>(isSageMakerContract),
  outputs: z.tuple([
    scenario("typical"), scenario("edge"), scenario("low_score"), scenario("high_score"),
    z.object({ scenario: z.literal("empty"), conformsToContract: z.boolean(), body: z.null() }).strict(),
  ]),
  errors: z.tuple([
    z.object({ scenario: z.literal("model_error"), status: z.literal(424) }).strict(),
    z.object({ scenario: z.literal("throttled"), status: z.literal(429) }).strict(),
    z.object({ scenario: z.literal("timeout") }).strict(),
  ]),
  ...ControlsSchema.shape,
}).strict().superRefine((config, ctx) => {
  if (!isSageMakerContract(config.contract)) return;
  for (const entry of config.outputs) {
    if (matches(entry.body, config.contract.shape) !== entry.conformsToContract) ctx.addIssue({ code: "custom", message: "Output does not match its stated contract conformance" });
  }
});
export type SageMakerMockConfig = z.infer<typeof SageMakerMockConfigSchema>;
export interface SageMakerMockOptions { latencyMs?: number; errorRates?: z.infer<typeof RatesSchema> }

export function generateSageMakerMock(contract: SageMakerContract, options: SageMakerMockOptions = {}): SageMakerMockConfig {
  if (!isSageMakerContract(contract)) throw new Error("Invalid SageMaker contract");
  const controls = ControlsSchema.parse({ latencyMs: options.latencyMs ?? 0, errorRates: options.errorRates ?? { modelError: 0, throttled: 0, timeout: 0 } });
  return SageMakerMockConfigSchema.parse({
    version: 1, trust: "made_by_rovara", label: EVIDENCE_TRUST_CLASS_WORDS.made_by_rovara,
    contract: structuredClone(contract),
    outputs: [
      ...(["typical", "edge", "low_score", "high_score"] as const).map((variant) => ({ scenario: variant, conformsToContract: true, body: output(contract.shape, variant) })),
      { scenario: "empty", conformsToContract: contract.shape.type === "null", body: null },
    ],
    errors: [{ scenario: "model_error", status: 424 }, { scenario: "throttled", status: 429 }, { scenario: "timeout" }],
    ...controls,
  });
}

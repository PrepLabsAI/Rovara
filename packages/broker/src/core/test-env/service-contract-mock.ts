import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { EVIDENCE_TRUST_CLASS_WORDS } from "@agentx/contracts";
import { isServiceContract, type AnswerShape, type ContractAdapter, type ServiceContract } from "./service-contract.js";

// Generic "answer shape -> labelled mock config" step of the contract finder (TE-G6). The adapter names the service, its
// error cases and the keys of its independent error rates; everything else is the same for every outside service.
// The scenario names low_score and high_score mean the low and high end of a numeric field, for any service.
const ratesSchema = (adapter: ContractAdapter) => z.object(Object.fromEntries(adapter.errorRateKeys.map((key) => [key, z.number().min(0).max(1)]))).strict()
  .refine((rates) => Object.values(rates).reduce((sum, rate) => sum + rate, 0) <= 1);
const controlsSchema = (adapter: ContractAdapter) => z.object({ latencyMs: z.number().int().min(0).max(60_000), errorRates: ratesSchema(adapter) }).strict();
type Variant = "typical" | "edge" | "low_score" | "high_score";
function output(shape: AnswerShape, variant: Variant): unknown {
  switch (shape.type) {
    case "object": return Object.fromEntries(shape.fields.map((field) => [field.name, output(field.shape, variant)]));
    case "array": return variant === "edge" ? [] : [output(shape.items, variant)];
    case "string": return variant === "edge" ? "" : "example";
    case "boolean": return variant !== "edge";
    case "null": return null;
    case "number": case "integer": {
      const minimum = shape.type === "integer" && shape.minimum !== undefined ? Math.ceil(shape.minimum) : shape.minimum;
      const maximum = shape.type === "integer" && shape.maximum !== undefined ? Math.floor(shape.maximum) : shape.maximum;
      const low = minimum ?? Math.min(0, maximum ?? 0);
      const high = maximum ?? Math.max(1, low);
      const n = variant === "high_score" ? high : variant === "typical" ? low / 2 + high / 2 : low;
      return shape.type === "integer" ? Math.round(n) : n;
    }
  }
}
function matches(value: unknown, shape: AnswerShape, depth = 0): boolean {
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

/** The versioned document for the later stand-in, deliberately not a record or runtime backing.
 * The empty response is an intentional invalid-response exercise when the contract
 * is non-null. Generated values never carry proof authority; the separate provenance
 * lane must enforce exclusion before wiring these functions into a running system. */
export function serviceMockConfigSchema(adapter: ContractAdapter) {
  return z.object({
    version: z.literal(1),
    service: z.literal(adapter.service),
    trust: z.literal("made_by_rovara"),
    label: z.literal(EVIDENCE_TRUST_CLASS_WORDS.made_by_rovara),
    contract: z.custom<ServiceContract>(isServiceContract),
    outputs: z.tuple([
      scenario("typical"), scenario("edge"), scenario("low_score"), scenario("high_score"),
      z.object({ scenario: z.literal("empty"), conformsToContract: z.boolean(), body: z.null() }).strict(),
    ]),
    errors: z.array(z.object({ scenario: z.string(), status: z.number().int().optional() }).strict()),
    ...controlsSchema(adapter).shape,
  }).strict().superRefine((config, ctx) => {
    if (!isDeepStrictEqual(config.errors, adapter.errorCases)) ctx.addIssue({ code: "custom", message: "Error cases do not match the service's error cases" });
    if (!isServiceContract(config.contract)) return;
    if (!adapter.kinds.includes(config.contract.source.kind)) ctx.addIssue({ code: "custom", message: "Contract source kind is not one of the service's source kinds" });
    for (const entry of config.outputs) {
      if (matches(entry.body, config.contract.shape) !== entry.conformsToContract) ctx.addIssue({ code: "custom", message: "Output does not match its stated contract conformance" });
    }
  });
}
export type ServiceMockConfig = z.infer<ReturnType<typeof serviceMockConfigSchema>>;
export interface ServiceMockOptions { latencyMs?: number; errorRates?: Record<string, number> }

export function generateServiceMock(adapter: ContractAdapter, contract: ServiceContract, options: ServiceMockOptions = {}): ServiceMockConfig {
  if (!isServiceContract(contract)) throw new Error("Invalid service contract");
  const controls = controlsSchema(adapter).parse({ latencyMs: options.latencyMs ?? 0, errorRates: options.errorRates ?? Object.fromEntries(adapter.errorRateKeys.map((key) => [key, 0])) });
  return serviceMockConfigSchema(adapter).parse({
    version: 1, service: adapter.service, trust: "made_by_rovara", label: EVIDENCE_TRUST_CLASS_WORDS.made_by_rovara,
    contract: structuredClone(contract),
    outputs: [
      ...(["typical", "edge", "low_score", "high_score"] as const).map((variant) => ({ scenario: variant, conformsToContract: true, body: output(contract.shape, variant) })),
      { scenario: "empty", conformsToContract: contract.shape.type === "null", body: null },
    ],
    errors: structuredClone(adapter.errorCases),
    ...controls,
  });
}

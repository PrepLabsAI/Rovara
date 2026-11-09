// Service mock additions (owner decision Q9, 2026-10-30): a mock covers the OLD cases (the pinned fixture set) and the NEW cases the change introduces. A new case gets a new mock answer, created in the task from the
// schema or recorded from pre-prod, and the evidence LISTS it. The pinned set is never edited by a task: additions are a separate, task-scoped set that extends one base set by digest, and they are served only after
// the base set has no recording. A request neither has still fails loudly.
// Nothing here imports a Node module.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { ServiceMockEntrySchema } from "./service-mocks.js";
import { sha256Hex } from "./web-hash.js";

export const SERVICE_MOCK_ADDITIONS_MAX = 100;
/** Where a new answer came from: the schema (deterministic, synthetic) or a recording from pre-prod (a person-reviewed source). */
export const SERVICE_MOCK_ADDITION_ORIGINS = ["schema", "preprod"] as const;

export const ServiceMockAdditionSchema = z.object({ origin: z.enum(SERVICE_MOCK_ADDITION_ORIGINS), entry: ServiceMockEntrySchema }).strict();

export const ServiceMockAdditionSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    service: z.string().min(1).max(80),
    /** The digest of the pinned fixture set these additions extend; a mock serves them only with exactly that base. */
    baseFixtureDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    additions: z.array(ServiceMockAdditionSchema).max(SERVICE_MOCK_ADDITIONS_MAX),
  })
  .strict()
  .superRefine((set, context) => {
    if (new Set(set.additions.map((addition) => addition.entry.requestHash)).size !== set.additions.length) context.addIssue({ code: "custom", path: ["additions"], message: "a request has one new answer" });
  });
export type ServiceMockAdditionSet = z.infer<typeof ServiceMockAdditionSetSchema>;

export function serviceMockAdditionSetDigest(set: ServiceMockAdditionSet): string {
  return sha256Hex(canonicalJson(ServiceMockAdditionSetSchema.parse(set)));
}

/** What the evidence lists: which service, which base set, how many new answers and where each came from. No bodies. */
export const ServiceMockAdditionsListingSchema = z
  .object({
    service: z.string().min(1).max(80),
    baseFixtureDigest: z.string().regex(/^[a-f0-9]{64}$/),
    additionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    bySchema: z.number().int().min(0).max(SERVICE_MOCK_ADDITIONS_MAX),
    byPreprod: z.number().int().min(0).max(SERVICE_MOCK_ADDITIONS_MAX),
    requestHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(SERVICE_MOCK_ADDITIONS_MAX),
  })
  .strict();
export type ServiceMockAdditionsListing = z.infer<typeof ServiceMockAdditionsListingSchema>;

export function serviceMockAdditionsListing(set: ServiceMockAdditionSet): ServiceMockAdditionsListing {
  return {
    service: set.service,
    baseFixtureDigest: set.baseFixtureDigest,
    additionsDigest: serviceMockAdditionSetDigest(set),
    bySchema: set.additions.filter((addition) => addition.origin === "schema").length,
    byPreprod: set.additions.filter((addition) => addition.origin === "preprod").length,
    requestHashes: set.additions.map((addition) => addition.entry.requestHash),
  };
}

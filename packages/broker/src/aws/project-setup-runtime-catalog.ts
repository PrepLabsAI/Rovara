import { createHash } from "node:crypto";
import { canonicalJson, Ec2RuntimeBindingSchema, ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema, type Ec2RuntimeBinding } from "@agentx/contracts";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();

/** Operator-managed readiness for an already configured verifier. This row never provisions it. */
export const ProjectSetupRuntimeRecordSchema = z.object({
  schemaVersion: z.literal(1), entityType: z.literal("PROJECT_SETUP_RUNTIME"),
  runtimeCatalogId: z.string().min(1).max(160), catalogRevision: z.number().int().positive(),
  bindingDigest: digest, binding: Ec2RuntimeBindingSchema, manifestDigest: digest,
  runnerEnvironmentDigest: digest, runnerEnvironment: ProjectSetupRunnerEnvironmentSchema,
  runnerToolchainDigest: digest, runnerToolchain: ProjectSetupRunnerToolchainSchema,
  endpoint: z.string().url().max(512), generation: z.number().int().positive(), transportCorrelationId: z.string().uuid(),
  supportedSetupScopes: z.array(z.enum(["source-interface"])).min(1).max(1),
  state: z.enum(["READY", "PARKED", "UNAVAILABLE"]), qualifiedAt: timestamp, expiresAt: timestamp,
}).strict().superRefine((row, context) => {
  const expected = createHash("sha256").update(canonicalJson(row.binding)).digest("hex");
  if (expected !== row.bindingDigest) context.addIssue({ code: "custom", path: ["bindingDigest"], message: "binding digest must identify the exact runtime binding" });
  const expectedEnvironment = createHash("sha256").update(canonicalJson(row.runnerEnvironment)).digest("hex");
  if (expectedEnvironment !== row.runnerEnvironmentDigest) context.addIssue({ code: "custom", path: ["runnerEnvironmentDigest"], message: "runner environment digest must identify the qualified runner environment" });
  const expectedToolchain = createHash("sha256").update(canonicalJson(row.runnerToolchain)).digest("hex");
  if (expectedToolchain !== row.runnerToolchainDigest) context.addIssue({ code: "custom", path: ["runnerToolchainDigest"], message: "runner toolchain digest must identify the exact qualified Node executable and host" });
  if (Date.parse(row.qualifiedAt) >= Date.parse(row.expiresAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "catalog expiry must follow qualification" });
});
export type ProjectSetupRuntimeRecord = z.infer<typeof ProjectSetupRuntimeRecordSchema>;

export function projectSetupRuntimeKey(runtimeCatalogId: string, bindingDigest: string): { pk: string; sk: string } {
  return { pk: `PROJECT_SETUP_RUNTIME#${runtimeCatalogId}`, sk: `BINDING#${bindingDigest}` };
}

export function projectSetupBindingDigest(binding: Ec2RuntimeBinding): string {
  return createHash("sha256").update(canonicalJson(Ec2RuntimeBindingSchema.parse(binding))).digest("hex");
}

/** Returns only an exact, current, qualified registry match. Caller performs a fresh DDB read. */
export function admitProjectSetupRuntime(
  record: ProjectSetupRuntimeRecord,
  input: { runtimeCatalogId: string; binding: Ec2RuntimeBinding; scope: "source-interface" | "feature-execution"; now: number },
): ProjectSetupRuntimeRecord | undefined {
  const parsed = ProjectSetupRuntimeRecordSchema.safeParse(record);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  const expectedDigest = projectSetupBindingDigest(input.binding);
  if (value.state !== "READY" || input.scope !== "source-interface" || value.runtimeCatalogId !== input.runtimeCatalogId
    || value.bindingDigest !== expectedDigest || canonicalJson(value.binding) !== canonicalJson(input.binding)
    || !value.supportedSetupScopes.includes("source-interface") || Date.parse(value.qualifiedAt) > input.now || Date.parse(value.expiresAt) <= input.now) return undefined;
  return value;
}

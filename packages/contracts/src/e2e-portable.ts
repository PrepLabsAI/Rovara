import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = (max = 160) => z.string().trim().min(1).max(max);
export const E2ECallableSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("named"), exportName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/) }).strict(),
]);
export type E2ECallableSelector = z.infer<typeof E2ECallableSelectorSchema>;
export const E2EPortablePurposeSchema = z.enum(["source-interface", "feature-invocation"]);
export type E2EPortablePurpose = z.infer<typeof E2EPortablePurposeSchema>;
export const E2EPortableOperationRegistrationSchema = z.object({
  schemaVersion: z.literal("portable-source-operation/v1"), operationId: id(120), applicationId: id(120),
  purpose: E2EPortablePurposeSchema, packageExportSubpath: z.string().regex(/^(?:\.|\.\/[A-Za-z0-9_./-]{1,160})$/),
  moduleSpecifier: z.string().regex(/^\.\.?\/[A-Za-z0-9_./-]{1,512}$/), callableSelector: E2ECallableSelectorSchema.nullable(),
  expectedExportNames: z.array(id(255)).max(256).nullable(),
  sourceRefs: z.array(z.object({ path: id(1024), sha256: digest }).strict()).min(1).max(4), descriptorDigest: digest,
}).strict().superRefine((registration, context) => {
  if (registration.purpose === "feature-invocation" && registration.callableSelector === null) context.addIssue({ code: "custom", path: ["callableSelector"], message: "feature invocation requires an explicit callable selector" });
  if (registration.purpose === "feature-invocation" && registration.expectedExportNames !== null) context.addIssue({ code: "custom", path: ["expectedExportNames"], message: "feature invocation does not carry module-inspection expectations" });
  if (registration.purpose === "source-interface" && registration.callableSelector !== null) context.addIssue({ code: "custom", path: ["callableSelector"], message: "source-interface inspection must not invent a callable selector" });
  if (registration.purpose === "source-interface" && (registration.expectedExportNames === null || registration.expectedExportNames.length === 0)) context.addIssue({ code: "custom", path: ["expectedExportNames"], message: "source-interface inspection requires an approved expected export-name inventory" });
  if (registration.expectedExportNames && new Set(registration.expectedExportNames).size !== registration.expectedExportNames.length) context.addIssue({ code: "custom", path: ["expectedExportNames"], message: "expected export names must be unique" });
});
export type E2EPortableOperationRegistration = z.infer<typeof E2EPortableOperationRegistrationSchema>;
export const E2ESyntheticAccountContextSchema = z.object({
  schemaVersion: z.literal("synthetic-account-context/v1"), contextId: id(120), profileId: id(120), applicationId: id(120), scope: z.literal("SYNTHETIC"),
  fixture: z.object({ version: z.literal("synthetic-fixture/v1"), sourcePath: id(1024), sourceSha256: digest, definition: z.unknown() }).strict(),
  sourceRefs: z.array(z.object({ path: id(1024), sha256: digest }).strict()).min(1).max(4),
  approval: z.object({ artifactId: id(160), digest, planDigest: digest }).strict(),
}).strict();
export type E2ESyntheticAccountContext = z.infer<typeof E2ESyntheticAccountContextSchema>;
export const E2EPortableApprovalBindingSchema = z.object({
  schemaVersion: z.literal("portable-approval-binding/v1"), planDigest: digest,
  bindingDigest: digest,
  semanticApproval: z.object({ artifactId: id(160), digest }).strict(),
  operations: z.array(E2EPortableOperationRegistrationSchema).max(64),
  accountContexts: z.array(E2ESyntheticAccountContextSchema).max(64),
}).strict().superRefine((binding, context) => {
  if (new Set(binding.operations.map((item) => item.operationId)).size !== binding.operations.length) context.addIssue({ code: "custom", path: ["operations"], message: "operation registrations must be unique" });
  if (new Set(binding.accountContexts.map((item) => item.contextId)).size !== binding.accountContexts.length || new Set(binding.accountContexts.map((item) => `${item.applicationId}\0${item.profileId}`)).size !== binding.accountContexts.length) context.addIssue({ code: "custom", path: ["accountContexts"], message: "synthetic account context IDs and application/profile pairs must be unique" });
  const { bindingDigest, ...body } = binding;
  if (createHash("sha256").update(canonicalJson(body)).digest("hex") !== bindingDigest) context.addIssue({ code: "custom", path: ["bindingDigest"], message: "portable approval binding digest mismatch" });
});
export type E2EPortableApprovalBinding = z.infer<typeof E2EPortableApprovalBindingSchema>;
export const E2E_CANDIDATE_RESPONSE_SCOPE = "contained-candidate-process-response/v1" as const;
export const E2E_CANDIDATE_ADAPTER_VERSION = 1 as const;
export const E2E_CANDIDATE_INSPECTION_PROTOCOL = "registered-module-export-inventory/v1" as const;
export const E2E_CANDIDATE_INSPECTION_ADAPTER_VERSION = 1 as const;
export function e2eSourceInterfaceAssertion(registration: Pick<E2EPortableOperationRegistration, "expectedExportNames">): Readonly<Record<string, unknown>> {
  if (registration.expectedExportNames === null) throw new Error("source-interface registration has no approved export-name inventory");
  return { kind: "state", probeId: "module-export-names", equals: registration.expectedExportNames, pollTimeoutMs: 1000 };
}
export const E2E_FIXED_CANDIDATE_BOOTSTRAP_SHA256 = "a6565dab541b51f8777e59d24e58421de488b02228914ef794189b346c4b68ff" as const;
export const E2E_CANDIDATE_ADAPTER_IDENTITY = Object.freeze({ schemaVersion: "contained-candidate-process-response-adapter/v1", scope: E2E_CANDIDATE_RESPONSE_SCOPE, adapterVersion: E2E_CANDIDATE_ADAPTER_VERSION, fixedBootstrapSha256: E2E_FIXED_CANDIDATE_BOOTSTRAP_SHA256, hostRequest: { version: "contained-candidate-host-request/v1", fields: ["requestId", "input"] }, appWire: { version: "contained-candidate-app-wire/v1", requestFields: ["wireId", "input"], responseFields: ["wireId", "output"] }, moduleInspection: { protocol: E2E_CANDIDATE_INSPECTION_PROTOCOL, adapterVersion: E2E_CANDIDATE_INSPECTION_ADAPTER_VERSION, hostPort: "trusted-supervisor-inspect-contract-rpc/v1", projection: { schemaVersion: "module-export-name-projection/v1", probeId: "module-export-names", shape: "sorted-export-name-array/v1" } } });
export function e2ePortableOperationDescriptorDigest(registration: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ ...registration, adapter: E2E_CANDIDATE_ADAPTER_IDENTITY })).digest("hex");
}
export function e2EPortableApprovalBindingDigest(binding: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(binding)).digest("hex");
}

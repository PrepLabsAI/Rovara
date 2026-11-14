import { z } from "zod";

export const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const id = (max = 120) => z.string().trim().min(1).max(max);

export const positiveInt = z.number().int().positive();

export const E2E_PROJECT_CHECK_ID = "project-e2e" as const;

export const E2EQualifiedRoundSchema = z.object({ candidateDigest: digest, contractDigest: digest, policyDigest: digest, bundleDigest: digest,
  executionPlanDigest: digest, roundId: z.string().uuid(), groupRunIds: z.array(z.string().uuid()).min(1).max(4),
  admissionSha256: digest, evidenceSha256: digest }).strict();

export const E2EFailedRoundSchema = z.object({ status: z.literal("FAILED"), candidateDigest: digest, roundId: z.string().uuid(),
  groupRunIds: z.array(z.string().uuid()).min(1).max(4), admissionSha256: digest, evidenceSha256: digest }).strict();

/** Bounded notifier display cache. It is never qualification or action authority. */
export const E2EWorkflowDisplayRefSchema = z.object({ schemaVersion: z.literal(1), key: z.string().regex(/^private\/[^/]+\/[^/]+\/workflow-e2e-display\/[a-f0-9]{64}\.json$/),
  sha256: digest, byteLength: positiveInt.max(262_144), candidateDigest: digest, roundId: z.string().uuid(), groupRunIds: z.array(z.string().uuid()).min(1).max(4), admissionSha256: digest, evidenceSha256: digest }).strict();

/**
 * What plan approval derived for a plan that carries a v2 application intent: the digests that identify the approved selection, the targets that
 * can run application scenarios, the criteria that will wait (and why), and the READY runtime rows it was derived against. Dispatch re-reads the
 * rows and re-derives the selection (Ruling AL); this record is what the Owner approved, never authority to run.
 */
export const E2EApplicationSelectionRecordSchema = z.object({
  schemaVersion: z.literal("e2e-application-selection/v1"),
  /** sha256 of the whole canonical intent, portable scenarios included (the facade digests only the application part). */
  intentDigest: digest,
  /** The approval-time plan identity the selection was derived under (the canonical artifact; not the dispatch-time plan digest). */
  planDigest: digest,
  semanticApproval: z.object({ artifactId: id(120), digest }).strict(),
  setupApproval: z.object({ artifactId: id(120), digest }).strict(),
  /** The application approval binding of the executable subset; null when no target can run application scenarios yet. */
  applicationApprovalBindingDigest: digest.nullable(),
  /**
   * The application execution plan and scenario bundle derived at approval from the application scenarios only (template `trusted-e2e-application/v1`,
   * under `planDigest`). They are not `workflow.e2e.executionPlanDigest`/`bundleDigest`, which identify the approved intent and its portable bundle
   * (`trusted-e2e/v1`) exactly as for a v1 plan. Dispatch derives its own plan, so these identify what the Owner approved and are never compared with it.
   */
  applicationExecutionPlanDigest: digest,
  applicationBundleDigest: digest,
  executableTargetIds: z.array(id(80)).max(12),
  unavailableCriteria: z.array(z.object({ criterionId: id(120), reason: id(500) }).strict()).max(64),
  runtimeRows: z.array(z.object({ kind: z.enum(["web", "api"]), profileId: id(120), runtimeCatalogId: id(120), catalogRevision: positiveInt, generation: positiveInt,
    bindingDigest: digest, capabilityDigest: digest, expiresAt: id(40) }).strict()).max(2),
  /**
   * The account refs the approval pinned, one per executable (application, account profile): the registry's latest at approval (owner decision D5). Dispatch and
   * verification re-read the registry and refuse any other (`accounts-changed-reapprove`). A record approved under M1.2 has none: its plan's refs are the
   * recipe-derived stand-ins, which are read as they are.
   */
  accountRefs: z.array(z.object({ applicationId: id(120), profileId: id(120), revision: positiveInt, definitionDigest: digest }).strict()).max(12).default([]),
  evaluatedAt: id(40),
}).strict();

export const E2EApplicationSelectionFingerprintSchema = z.object({ selectionDigest: digest, intentDigest: digest, executableTargetIds: z.array(id(80)).max(12), runtimeRowsDigest: digest }).strict();

/**
 * The owner's re-approval of an application plan against the runtime rows READY now (a retry after the approved selection changed): who, why, when, and the selection
 * it replaced and the one it recorded. Appended, never overwritten, so what the owner authorized can always be reconstructed.
 */
export const E2EApplicationReapprovalSchema = z.object({ requestId: id(120), actorId: id(200), reason: id(500), at: id(40),
  previous: E2EApplicationSelectionFingerprintSchema, current: E2EApplicationSelectionFingerprintSchema,
  /** Which test accounts moved: one entry per (application, account profile) whose pinned ref differs, with the revisions before and after (null: none pinned then or now). */
  accounts: z.array(z.object({ applicationId: id(120), profileId: id(120), from: positiveInt.nullable(), to: positiveInt.nullable() }).strict()).max(24).optional() }).strict();

export const E2EWorkflowProgressSchema = z.object({ contractDigest: digest, policyDigest: digest, bundleDigest: digest, executionPlanDigest: digest, required: z.boolean(), currentRoundId: z.string().uuid().optional(), currentGroupRunIds: z.array(z.string().uuid()).max(12), resultRefs: z.array(id(200)).max(64), qualifiedRound: E2EQualifiedRoundSchema.optional(), failedRound: E2EFailedRoundSchema.optional(), displayRef: E2EWorkflowDisplayRefSchema.optional(), applicationSelection: E2EApplicationSelectionRecordSchema.optional(), applicationReapprovals: z.array(E2EApplicationReapprovalSchema).max(20).optional() }).strict();

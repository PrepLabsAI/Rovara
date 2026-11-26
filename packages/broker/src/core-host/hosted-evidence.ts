// L4-HW4: the evidence of a task's checks, kept on a hosted company (the laptop's `evidence.keepAfterChecks`, core-host/app/evidence.ts, over the company-bound object store). When a run's checks are recorded for a
// candidate, the keeper assembles the pack (per-check output tails, the failing tests with the change that most likely broke each (TE-A6), the baseline words (TE-C1)) with the SAME data guard, caps and
// redaction as the laptop, and keeps it where the Proof route (`GET /v1/dev/tasks/{id}/evidence`) reads it back. Informational: a fault or a slow store only means there is no pack for this code.
import { createKnownFailing, verificationResultsEnabled } from "../core/test-env/known-failing.js";
import type { DocumentStore, ObjectStorage, OrgId } from "@agentx/contracts";
import { createLocalEvidence, type LocalEvidence } from "./app/evidence.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { createCompanyEvidenceBlobs, type CompanyEvidenceBlobsOptions } from "./company-evidence-blobs.js";

/**
 * The object tags the deployed bucket's lifecycle rules read (infra/lib/control-plane.ts `ExpireEvidenceShort`, `ExpireEvidenceStd`: prefix `private/`, tag `rovara-retention=<class>`). The keeper writes `evidence-std`
 * (the pack, its baseline and dependency facts, the output tails) and `evidence-short` (video and trace, not gathered here); without the tag an object is kept until it is deleted (the erase walks still remove it). The
 * tagged put needs `s3:PutObjectTagging`, which the broker's bucket grant already holds. The key is written out here (not imported from the contracts) so the retention-tag guard test, which pins every file that names the screenshot tag, stays as it is;
 * tests/unit/hosted-evidence-retention.test.ts pins it equal to the contracts' key. The broker passes this map as `retentionTags` of its object storage (aws/broker.ts), kept on one line so the company inventory's line-pinned forwarding rows stay valid.
 */
export const EVIDENCE_RETENTION_TAGS = {
  "evidence-short": { key: "rovara-retention", value: "evidence-short" },
  "evidence-std": { key: "rovara-retention", value: "evidence-std" },
} as const;

export interface HostedEvidenceOptions {
  /** The registry's shared `object-storage` point (every company's objects in one bucket); never used as it is. */
  blobs: ObjectStorage;
  /** The company's own store (the registry's `storage`). */
  store: DocumentStore;
  companyId: OrgId;
  env: NodeJS.ProcessEnv;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  refused?: CompanyEvidenceBlobsOptions["refused"];
}

/** The company-bound store the evidence is written to and read from (the Proof route reads through the same one). */
export function hostedEvidenceBlobs(options: Pick<HostedEvidenceOptions, "blobs" | "store" | "companyId" | "refused">): ObjectStorage {
  return createCompanyEvidenceBlobs({ blobs: options.blobs, store: options.store, companyId: options.companyId, ...(options.refused === undefined ? {} : { refused: options.refused }) });
}

export function createHostedEvidence(options: HostedEvidenceOptions): LocalEvidence {
  const { store, companyId, log } = options;
  return createLocalEvidence({
    flow: { store, companyId, log: (entry) => { log({ companyId, ...entry }); } },
    blobs: hostedEvidenceBlobs(options),
    // TE-C1: the baseline the plan offered, looked up in this company's own records, only while the baseline switch is on.
    testEnv: { store, now: options.now, env: options.env },
  });
}

/** The flow's `keepEvidence` seam for one company (the laptop's `keepEvidence: (input) => evidence.keepAfterChecks(input)`). */
export function hostedKeepEvidence(options: HostedEvidenceOptions): NonNullable<TaskFlowDeps["keepEvidence"]> {
  const evidence = createHostedEvidence(options);
  return async (input) => {
    const result = await evidence.keepAfterChecks(input);
    if (!verificationResultsEnabled(options.env) || result?.kept !== true) return result;
    const pack = await evidence.packOf(input.task, input.candidateDigest);
    if (pack !== undefined) await createKnownFailing({ store: options.store, now: options.now, env: options.env, mayMaintain: async () => false, evidenceOf: async () => pack }).observe({ companyId: options.companyId, project: input.task.project, taskId: input.task.taskId, workflow: { ...input.workflow, candidate: { ...input.workflow.candidate!, digest: input.candidateDigest } }, evidence: pack });
    return result;
  };
}

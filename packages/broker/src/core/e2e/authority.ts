// What the verification of a browser and API round asks of the install, and what it is built on. The verification is Cloud's; who the creator is, which project policy, source and runtime the
// round may still stand on, are the install's: Cloud answers from its project, member and runtime tables, Code from its own owner, project source and runtime registrations. A round whose
// authority cannot be shown is UNKNOWN, never a pass, so the default (`failClosedAuthority`) refuses everything.
import type { CandidateManifestSchema, DocumentStore, E2EApplicationExecutionAdmission, E2ESourceSnapshot, ObjectStorage, TransactItem } from "@agentx/contracts";
import type { z } from "zod";
import type { TaskRecord } from "../task-flow/records.js";
import type { E2EStateStore } from "./state.js";

/** The task and the candidate a verification judges, as the stage machine holds them. */
export type VerifiedCandidate = ReturnType<typeof CandidateManifestSchema.parse>;

export interface E2EVerificationDiagnostic {
  reason?: string;
  /** Set when the evidence verified was an application round's, whose reasons are safe and useful to show the owner. */
  application?: true;
  /** Set once current authority was judged (valid or not): a reason found without it is about the evidence, not about authority. */
  authorityEvaluated?: true;
  /**
   * Why an application round's authority moved, when it was the runtime: `requalified` (the admitted row was replaced; the owner approves the plan again against the new row) or `unusable`
   * (no ready row of that kind). `accounts`: a test account the plan was approved with is not the registered one now.
   */
  runtimeChange?: "requalified" | "unusable" | "accounts";
  /** The rows validated for this result, as conditions the transaction that records the verdict carries, so it fails if any of them moved after they were checked. */
  authorityChecks?: TransactItem[];
}

/**
 * Whether the round's verdict may stand on what is current now. Each answer is true only when every one of these still holds exactly as at admission: the owner's approval of the plan,
 * the project's policy, the creator's right to run it, the candidate's exported source and the runtime rows. On true, `diagnostic.authorityChecks` holds the rows as conditions.
 */
export interface E2EAuthority {
  portable(input: { task: TaskRecord; candidate: VerifiedCandidate; admission: Record<string, unknown>; snapshot: E2ESourceSnapshot }, diagnostic?: E2EVerificationDiagnostic): Promise<boolean>;
  application(input: { task: TaskRecord; candidate: VerifiedCandidate; admission: E2EApplicationExecutionAdmission }, diagnostic?: E2EVerificationDiagnostic): Promise<boolean>;
}

/** The authority of an install that has none to offer: every round is judged unverifiable. */
export const failClosedAuthority: E2EAuthority = {
  async portable(_input, diagnostic) { if (diagnostic !== undefined) diagnostic.reason = "no-current-authority-source"; return false; },
  async application(_input, diagnostic) {
    if (diagnostic !== undefined) { diagnostic.authorityEvaluated = true; diagnostic.reason = "no-current-authority-source"; }
    return false;
  },
};

export interface E2EVerificationDeps {
  /** The document store (records, the model route registry, upload receipts) and the clock. */
  state: E2EStateStore;
  /** Where admissions and evidence are kept. */
  objects: ObjectStorage;
  authority: E2EAuthority;
  /** The task a round belongs to, as the flow holds it; undefined when it is gone. */
  readTask(taskId: string): Promise<TaskRecord | undefined>;
  log?: (entry: Record<string, unknown>) => void;
}

export type { DocumentStore, z };

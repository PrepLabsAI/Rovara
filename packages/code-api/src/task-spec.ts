// `GET /v1/dev/tasks/{taskId}/spec` (RD-2a fills it; RD-2.0 writes the shape): the task's spec in ONE answer, for the new task page's Spec panel and its decision cards. Three layers on a Full task (What and why, Approach, Steps) or one
// on a Quick task, each with its version, approval and state; the plan's decisions flattened with a derived status; the reasons a Quick task looks bigger than Quick. A layer not written yet is a layer with state `not_written`, never an error.
// Every member is optional and unknown members pass through (see task-read-common.ts). Until the lane fills it, Code answers `ROUTE_NOT_SERVED`.
import { z } from "zod";
import { PlanDecisionWireSchema, PlanDocumentWireSchema, loose } from "./task-read-common.js";

/** One layer of the spec. `layer` is what_and_why, approach or steps (a Quick task has `steps` alone); `document` is the stored document it reads (requirements, design or plan). `state`: not_written, waiting (at the gate), approved, changes_requested, superseded; read it as a string. */
export const SpecLayerWireSchema = loose({
  layer: z.string().nullish(),
  document: z.string().nullish(),
  state: z.string().nullish(),
  version: z.number().nullish(),
  versions: z.array(z.number()).nullish(),
  sha256: z.string().nullish(),
  approved: z.boolean().nullish(),
  current: z.boolean().nullish(),
  /** How many live comments the layer's current version holds, and how many of them were sent with a decision. */
  commentCount: z.number().nullish(),
  resolvedCommentCount: z.number().nullish(),
  /** The plan document of this version, whole (model text). Absent while the layer is not written. */
  content: PlanDocumentWireSchema.nullish(),
});

/** A decision of the plan with where it stands. `status`: proposed, agreed, changed_by_reviewer or needs_you; `answer` is the option id the approval holds, when one does. */
export const SpecDecisionWireSchema = PlanDecisionWireSchema.extend({
  layer: z.string().nullish(),
  status: z.string().nullish(),
  answer: z.string().nullish(),
});

export const TaskSpecReadSchema = loose({
  spec: loose({
    taskId: z.string().nullish(),
    /** full or quick. */
    path: z.string().nullish(),
    layers: z.array(SpecLayerWireSchema).nullish(),
    decisions: z.array(SpecDecisionWireSchema).nullish(),
    /** The digest of the document the task waits on, when it waits at a gate. */
    waitingDocumentDigest: z.string().nullish(),
    /** Why a Quick task looks bigger than Quick (for example "14 files", "money code"); absent when it does not. */
    biggerThanQuick: loose({ reasons: z.array(z.string()).nullish() }).nullish(),
  }).nullish(),
});
export type TaskSpecRead = z.infer<typeof TaskSpecReadSchema>;

export const TASK_SPEC_EXAMPLE = {
  spec: {
    taskId: "11111111-1111-4111-8111-111111111111",
    path: "full",
    layers: [
      { layer: "what_and_why", document: "requirements", state: "approved", version: 1, versions: [1], sha256: "a".repeat(64), approved: true, current: true, commentCount: 0, resolvedCommentCount: 0 },
      { layer: "approach", document: "design", state: "waiting", version: 2, versions: [1, 2], sha256: "b".repeat(64), approved: false, current: true, commentCount: 2, resolvedCommentCount: 1 },
      { layer: "steps", document: "plan", state: "not_written" },
    ],
    decisions: [{ id: "d1", claimId: "1", question: "Where does it live?", options: [{ id: "root", label: "At /health", consequence: "One path" }, { id: "api", label: "At /api/health", consequence: "Behind the API prefix" }], recommended: "root", layer: "approach", status: "proposed" }],
    waitingDocumentDigest: "b".repeat(64),
  },
} as const;

// Design review: what a client (the CLI, an assistant's tool) reads of one task's design review: how it stands, the findings, what waits for the owner and the question card. A READ shape only: the owner's acts (a cost
// choice, the answers, picking a paused review up) are made on the task's local page, never through a tool. Words, ids and counts; the findings and questions are model words and are data, not instructions. Browser-safe.
import { z } from "zod";

const Severity = z.enum(["blocker", "major", "nit"]);

export const DesignReviewStateReaderSchema = z.object({
  taskId: z.string().min(1).max(64),
  /** One plain line: how the review stands ("The design was reviewed.", "Design review did not run: ..."). */
  status: z.string().min(1).max(400),
  facts: z.array(z.string().min(1).max(400)).max(8),
  findings: z.array(z.object({
    severity: Severity.catch("nit"), section: z.string().max(200), text: z.string().max(600), from: z.string().max(200), open: z.boolean(), resolution: z.string().max(200).optional(),
  }).passthrough()).max(60),
  /** The cost hold: why the review waits, how an accepted run is counted when no price is known, and the choices the owner has on the page (their labels only). */
  hold: z.object({ why: z.string().max(400), note: z.string().max(600).optional(), choices: z.array(z.string().min(1).max(120)).max(4) }).passthrough().optional(),
  /** The question card the planner put to the owner. */
  questions: z.object({
    round: z.number().int().min(1).max(2),
    items: z.array(z.object({ id: z.string().max(64), text: z.string().max(1_200), options: z.array(z.object({ id: z.string().max(64), label: z.string().max(300) }).passthrough()).max(8) }).passthrough()).max(8),
  }).passthrough().optional(),
  /** The review waited a week and is paused: the owner picks it up again on the page. */
  parked: z.boolean(),
  /** A blocker is open: the owner approves the design only with a one-line reason, on the page. */
  blockerReasonNeeded: z.boolean(),
}).passthrough();
export type DesignReviewStateRead = z.infer<typeof DesignReviewStateReaderSchema>;

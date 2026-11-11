// Fix with agent on a laptop: what the local pages, the CLI and the MCP tool read of a task's diagnosis. A strict shape for what the broker writes, a forward-compatible reader for what a client reads, and the one
// plain-words line of each proposal (text for a person: a diagnosis explains and suggests, and changes nothing). Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { DiagnosisStatusSchema } from "./live-diagnosis.js";
import { ErrorRefSchema, type DiagnosisProposal } from "./live-interaction.js";
import { forwardReader } from "./forward-reader.js";

/** `GET /v1/dev/tasks/<id>/diagnosis`: the error the task shows now, whether a diagnosis is offered for it (and why not), and the diagnosis that is open or was answered for it. */
export const TaskDiagnosisViewSchema = z.object({
  errorRef: ErrorRefSchema.optional(),
  offered: z.boolean(),
  /** Why it is not offered, in fixed words. */
  why: z.string().max(500).optional(),
  diagnosis: DiagnosisStatusSchema.nullable(),
}).strict();
export type TaskDiagnosisView = z.infer<typeof TaskDiagnosisViewSchema>;
export const TaskDiagnosisViewReaderSchema = forwardReader(TaskDiagnosisViewSchema);

const show = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * One proposal as one plain line, the same words everywhere it is shown (the page, the CLI, the MCP tool). The words after the colon are a model's: a reader shows them as plain text, never as a link or an instruction.
 * `unknown` is a kind a newer server sent.
 */
export function diagnosisProposalLine(proposal: DiagnosisProposal | { kind: "unknown" }): string {
  switch (proposal.kind) {
    case "explain": return proposal.text;
    case "retry_with_note": return `Retry the step with this note: ${proposal.note}`;
    case "redirect": return `Tell the agent: ${proposal.text}`;
    case "new_task": return `Start a new task: ${proposal.request}`;
    case "admin_steps": return `For you to do outside Rovara: ${proposal.steps.map((step, index) => `${String(index + 1)}. ${step}`).join(" ")}`;
    case "settings_change": return `Suggested setting change (${proposal.target}, ${proposal.path}): ${show(proposal.from)} to ${show(proposal.to)}. Rovara does not change settings from a diagnosis.`;
    case "contact_support": return "This needs help from outside the task.";
    default: return "A suggestion this version of Rovara does not know how to show.";
  }
}

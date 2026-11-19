// Standing instructions, hosted: what a task pins at its start so that a dispatcher that cannot reach the code host or the company's rules store still puts them in front of every step.
// The broker (which has the code host and the company-instructions point) reads the project's How we work file and the company's rules ONCE, when the task starts, and keeps the checked copy on the
// task's own workspace record. The dispatcher reads it back from that record (a record it already reads at every dispatch) and builds the block from it: no repository access and no new store read there.
// One task therefore runs under one How we work and one set of company rules, whatever is edited while it runs. The laptop does not pin content (it reads the file at the pinned commit and the company's
// file at every step), so a laptop's task record never carries this.
//
// The copy is data read back from a store, so it is never trusted: it is parsed again with the schemas, the size limits are checked again, and the block is built from it by the same code that builds
// a block from a live read (standing-block.ts makes every line of repository text inert, quoted and escaped, and cannot be forged out of).
import { z } from "zod";
import { CompanyInstructionsSnapshotSchema, PlaybookFileSchema, agentXError, type CompanyInstructionsSnapshot, type PlaybookFile } from "@agentx/contracts";
import { inertPlaybook } from "../playbook/file.js";
import { checkedCompanyInstructions } from "./company-source.js";

const COMMIT = /^[a-f0-9]{40,128}$/u;

/** What the broker keeps on the task's workspace record when the task starts. Either part may be absent (no How we work file, no company rules). */
export const PinnedStandingSchema = z.object({
  /** The project's How we work as it was at `commit` (the checked, inert file: its project-wide rules and each stage's rules; nothing else is kept). */
  playbook: z.object({ commit: z.string().regex(COMMIT), file: PlaybookFileSchema }).strict().optional(),
  /** The company's rules as the company-instructions point answered when the task started, and their version. */
  company: CompanyInstructionsSnapshotSchema.optional(),
}).strict();
export type PinnedStanding = z.infer<typeof PinnedStandingSchema>;

export const PINNED_STANDING_UNREADABLE = "The rules this task was started under can't be read, so this step did not start. Start the task again.";

/** The copy to keep for a file: only what a step reads (project-wide rules and each stage's text); the design review setting and the rest stay out. */
export function pinnedPlaybookFile(file: PlaybookFile): PlaybookFile {
  return { version: file.version, ...(file.rules === undefined ? {} : { rules: file.rules }), ...(file.stages === undefined ? {} : { stages: file.stages }) };
}

/**
 * The pin as a step may use it, or a refusal (`CONFIG_INVALID`: it does not pass by waiting). The file is checked and made inert again, and the company's rules are held to the same size limits as a live
 * read. `undefined` for a record that holds no pin.
 */
export function readPinnedStanding(value: unknown): { playbook?: { commit: string; file: PlaybookFile }; company?: CompanyInstructionsSnapshot } | undefined {
  if (value === undefined) return undefined;
  const parsed = PinnedStandingSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", PINNED_STANDING_UNREADABLE);
  const out: { playbook?: { commit: string; file: PlaybookFile }; company?: CompanyInstructionsSnapshot } = {};
  if (parsed.data.playbook !== undefined) {
    const inert = inertPlaybook(parsed.data.playbook.file);
    if (!inert.ok) throw agentXError("CONFIG_INVALID", PINNED_STANDING_UNREADABLE);
    out.playbook = { commit: parsed.data.playbook.commit, file: inert.file };
  }
  const company = checkedCompanyInstructions(parsed.data.company);
  if (company !== undefined) out.company = company;
  return out;
}

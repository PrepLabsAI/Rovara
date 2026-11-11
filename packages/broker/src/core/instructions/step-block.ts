// Standing instructions: the block one operation carries in its system prompt. The company's rules (read at every step, from the `company-instructions` port) and the project's "How we work" (from the
// playbook file) are put in front of the step as ONE text, in the order of authority (`standing-block.ts`). The dispatch asks here when it builds the worker's invocation, so a step started
// after the rules changed carries the newest ones (a running task uses the newest approved version at its next step).
//
// Fails closed: a company source that fails, a rule file over the limits, a playbook file that cannot be used, or a block too long to send refuses the step with a sentence; nothing is ever cut or
// skipped. The refusals that will not pass by waiting are `CONFIG_INVALID` or `PROCESS_UNAVAILABLE`; a read that may pass is `RUNTIME_UNAVAILABLE`.
import { STANDING_INSTRUCTIONS_MAX_BYTES, agentXError, type CompanyInstructionsSource, type OrgId, type StandingInstructionsPayload } from "@agentx/contracts";
import { stepForMode, type PlaybookMode, type PlaybookService } from "../playbook/service.js";
import { runningProcessOf } from "../playbook/process.js";
import { isReviewingStage } from "../playbook/process-reviewers.js";
import { readCompanyInstructions } from "./company-source.js";
import { buildStandingInstructions } from "./standing-block.js";

/**
 * The modes whose operations do not carry the block: verification (`CHECKS` runs the project's checks in the harness; a check step takes no instructions), the setup run that runs commands, and the
 * spec write (a rendering of the approved plan, not a judgement). A deep diagnosis carries none either.
 */
const WITHOUT_BLOCK: ReadonlySet<PlaybookMode> = new Set<PlaybookMode>(["CHECKS", "SETUP_AGENT", "SPEC_WRITE"]);

export interface StandingOperation {
  project: string;
  /** The operation's workflow mode; absent means a task started without the workflow, which runs like an IMPLEMENT. */
  mode: PlaybookMode | undefined;
  /** The task's purpose when it is not ordinary work (`diagnosis`): such a task carries no block. */
  purpose?: string | undefined;
  /** The commit of the project's playbook the task pinned when it started: the file is read at it, so one task runs under one playbook. Absent: the head of the default branch. */
  playbookCommit?: string | undefined;
}

export interface StandingInstructions {
  /** The block of one operation, or `undefined` when it carries none (its mode takes none, or there is nothing to say). */
  forOperation(input: StandingOperation): Promise<StandingInstructionsPayload | undefined>;
  /** What a task starting now pins: the playbook commit its steps will read (undefined when there is no playbook source). Refuses like `forOperation`, so a task is not started under rules that cannot be read. */
  pin(project: string): Promise<string | undefined>;
}

export interface StandingInstructionsOptions {
  companyId: OrgId;
  /** The company's rules. Absent: none (the Code default). */
  company?: CompanyInstructionsSource | undefined;
  /** The project's How we work. Absent: no project rules. */
  playbook?: Pick<PlaybookService, "layersFor" | "pin"> | undefined;
}

export const STANDING_BLOCK_TOO_LONG = "The standing instructions for this step are too long to send to the worker. Shorten the company rules or the project's How we work file.";

export function createStandingInstructions(options: StandingInstructionsOptions): StandingInstructions {
  return {
    async forOperation(input) {
      if ((input.mode !== undefined && WITHOUT_BLOCK.has(input.mode)) || input.purpose === "diagnosis") return undefined;
      const company = await readCompanyInstructions(options.company, options.companyId);
      const howWeWork = options.playbook === undefined ? [] : await options.playbook.layersFor(input.project, input.mode, input.playbookCommit);
      // Whether the stage checks work (plan check, review, feedback review): its company section also tells it to judge the change against the rules.
      const checking = isReviewingStage(stepForMode(runningProcessOf(undefined).recipe, input.mode));
      const block = buildStandingInstructions({ company, howWeWork, checking });
      if (block !== undefined && Buffer.byteLength(block.text, "utf8") > STANDING_INSTRUCTIONS_MAX_BYTES) throw agentXError("CONFIG_INVALID", STANDING_BLOCK_TOO_LONG);
      return block;
    },
    pin: (project) => (options.playbook === undefined ? Promise.resolve(undefined) : options.playbook.pin(project)),
  };
}

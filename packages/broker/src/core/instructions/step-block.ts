// Standing instructions: the block one operation carries in its system prompt. The company's rules (read at every step, from the `company-instructions` port) and the project's "How we work" (from the
// playbook file) are put in front of the step as ONE text, in the order of authority (`standing-block.ts`). The dispatch asks here when it builds the worker's invocation, so a step started
// after the rules changed carries the newest ones (a running task uses the newest approved version at its next step).
//
// Fails closed: a company source that fails, a rule file over the limits, a playbook file that cannot be used, or a block too long to send refuses the step with a sentence; nothing is ever cut or
// skipped. The refusals that will not pass by waiting are `CONFIG_INVALID` or `PROCESS_UNAVAILABLE`; a read that may pass is `RUNTIME_UNAVAILABLE`.
import { STANDING_INSTRUCTIONS_MAX_BYTES, agentXError, type CompanyInstructionsSource, type OrgId, type StandingInstructionsPayload } from "@agentx/contracts";
import { playbookLayersOf, stepForMode, type PlaybookMode, type PlaybookService } from "../playbook/service.js";
import { playbookIsEmpty } from "../playbook/file.js";
import { runningProcessOf } from "../playbook/process.js";
import { isReviewingStage } from "../playbook/process-reviewers.js";
import { readCompanyInstructions } from "./company-source.js";
import { PINNED_STANDING_UNREADABLE, pinnedPlaybookFile, readPinnedStanding, type PinnedStanding } from "./pinned.js";
import { buildStandingInstructions, type StandingLayer } from "./standing-block.js";

/**
 * The modes whose operations do not carry the block: verification (`CHECKS` runs the project's checks in the harness; a check step takes no instructions), the setup run that runs commands, and the
 * spec write (a rendering of the approved plan, not a judgement). A deep diagnosis carries none either.
 */
const WITHOUT_BLOCK: ReadonlySet<PlaybookMode> = new Set<PlaybookMode>(["CHECKS", "SETUP_AGENT", "WIKI_BUILD", "SPEC_WRITE"]);

export interface StandingOperation {
  project: string;
  /** The operation's workflow mode; absent means a task started without the workflow, which runs like an IMPLEMENT. */
  mode: PlaybookMode | undefined;
  /** The task's purpose when it is not ordinary work (`diagnosis`): such a task carries no block. */
  purpose?: string | undefined;
  /** The commit of the project's playbook the task pinned when it started: the file is read at it, so one task runs under one playbook. Absent: the head of the default branch. */
  playbookCommit?: string | undefined;
  /** The files the step works on, when it knows them: a team rule scoped to other paths is then left out. Absent: every rule of the step's stage goes, each saying where it applies. */
  files?: readonly string[] | undefined;
  /**
   * What the task pinned at its start (hosted: read from the task's workspace record). Present: the company's rules and the project's How we work come from it ONLY, never from a live read, so one
   * task runs under one set of rules and the caller needs no code host and no company store. Absent (a laptop's task, or a hosted task that started before this was kept): read live, as before.
   */
  pinned?: unknown;
}

/**
 * The project's team rules (lessons phase 4): rules a person made permanent from proven lessons, kept in Rovara's own store and scoped to a code area. Read at every step, like the company's rules, from THIS
 * company's rows only. A read that fails refuses the step with `RUNTIME_UNAVAILABLE` (fail closed: running without the project's rules would be a silent switch).
 */
export interface TeamRulesSource { layersFor(input: { project: string; mode: PlaybookMode | undefined; files?: readonly string[] | undefined }): Promise<StandingLayer[]> }

export interface StandingInstructions {
  /** The block of one operation, or `undefined` when it carries none (its mode takes none, or there is nothing to say). */
  forOperation(input: StandingOperation): Promise<StandingInstructionsPayload | undefined>;
  /** What a task starting now pins: the playbook commit its steps will read (undefined when there is no playbook source). Refuses like `forOperation`, so a task is not started under rules that cannot be read. */
  pin(project: string): Promise<string | undefined>;
  /**
   * Only where the task's rules are kept on the task (a hosted install: the dispatcher cannot read the code host or the company's rules). The copy of the project's How we work at `playbookCommit` (the
   * commit `pin` answered) and of the company's rules, read now, for the task's workspace record. Refuses like `pin`. Absent on a laptop, which reads both at every step.
   */
  pinContent?(project: string, playbookCommit: string | undefined): Promise<PinnedStanding | undefined>;
}

export interface StandingInstructionsOptions {
  companyId: OrgId;
  /** The company's rules. Absent: none (the Code default). */
  company?: CompanyInstructionsSource | undefined;
  /** The project's How we work. Absent: no project rules. */
  playbook?: Pick<PlaybookService, "layersFor" | "pin" | "current"> | undefined;
  /** The project's team rules, read after the playbook's layers. Absent: none. */
  teamRules?: TeamRulesSource | undefined;
  /** True on the hosted broker: the task's rules are copied at its start (`pinContent`) so a dispatcher can build the block from the task's own record. Never set on a laptop. */
  pinsContent?: boolean | undefined;
}

export const TEAM_RULES_UNREADABLE = "The project's team rules can't be read right now";

export const STANDING_BLOCK_TOO_LONG = "The standing instructions for this step are too long to send to the worker. Shorten the company rules, the project's How we work file or the project's team rules.";

/** The layers of a pinned file. A file that parses but fails the recipe's own guards is a fixed refusal (it will not pass by waiting), never a raw error that retries until the queue gives up. */
function pinnedLayersOf(file: Parameters<typeof playbookLayersOf>[0], mode: PlaybookMode | undefined): StandingLayer[] {
  try { return playbookLayersOf(file, mode); } catch { throw agentXError("CONFIG_INVALID", PINNED_STANDING_UNREADABLE); }
}

export function createStandingInstructions(options: StandingInstructionsOptions): StandingInstructions {
  const instructions: StandingInstructions = {
    async forOperation(input) {
      if ((input.mode !== undefined && WITHOUT_BLOCK.has(input.mode)) || input.purpose === "diagnosis") return undefined;
      // A pinned task takes both parts from its own record (checked again); any other task reads them live. Team rules are the project's own and are always read at the step.
      const pinned = readPinnedStanding(input.pinned);
      const company = pinned !== undefined ? pinned.company : await readCompanyInstructions(options.company, options.companyId);
      const playbookLayers = pinned !== undefined ? pinnedLayersOf(pinned.playbook?.file, input.mode)
        : options.playbook === undefined ? [] : await options.playbook.layersFor(input.project, input.mode, input.playbookCommit);
      let teamLayers: StandingLayer[] = [];
      if (options.teamRules !== undefined) {
        try { teamLayers = await options.teamRules.layersFor({ project: input.project, mode: input.mode, ...(input.files === undefined ? {} : { files: input.files }) }); }
        catch { throw agentXError("RUNTIME_UNAVAILABLE", `${TEAM_RULES_UNREADABLE}. Try again in a moment.`); }
      }
      const howWeWork = [...playbookLayers, ...teamLayers];
      // Whether the stage checks work (plan check, review, feedback review): its company section also tells it to judge the change against the rules.
      const checking = isReviewingStage(stepForMode(runningProcessOf(undefined).recipe, input.mode));
      const block = buildStandingInstructions({ company, howWeWork, checking });
      if (block !== undefined && Buffer.byteLength(block.text, "utf8") > STANDING_INSTRUCTIONS_MAX_BYTES) throw agentXError("CONFIG_INVALID", STANDING_BLOCK_TOO_LONG);
      return block;
    },
    pin: (project) => (options.playbook === undefined ? Promise.resolve(undefined) : options.playbook.pin(project)),
  };
  if (options.pinsContent !== true) return instructions;
  return {
    ...instructions,
    async pinContent(project, playbookCommit) {
      // The company's rules first (checked against the size limits: a company whose rules cannot be used refuses the start, as a step would be refused), then the file at the commit `pin` answered.
      const company = await readCompanyInstructions(options.company, options.companyId);
      let playbook: PinnedStanding["playbook"];
      if (options.playbook !== undefined && playbookCommit !== undefined) {
        const read = await options.playbook.current(project, { commit: playbookCommit });
        if (read.file !== undefined && !playbookIsEmpty(read.file)) {
          playbook = { commit: playbookCommit, file: pinnedPlaybookFile(read.file) };
          // The file must be one every step can build from (the recipe's own guards): checked now, so a start is refused with the reason instead of every step failing later.
          try { playbookLayersOf(playbook.file, undefined); } catch { throw agentXError("PROCESS_UNAVAILABLE", "This project's How we work file can't be used right now. Fix .rovara/playbook.yaml on the default branch, then try again."); }
        }
      }
      return company === undefined && playbook === undefined ? undefined : { ...(playbook === undefined ? {} : { playbook }), ...(company === undefined ? {} : { company }) };
    },
  };
}

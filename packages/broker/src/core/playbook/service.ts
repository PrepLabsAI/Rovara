// "How we work" in Rovara Code: the playbook service. It joins the three parts: the source (the repository's file at the default branch's head), the store (the item Cloud's readers read) and the
// view (what a person reads). It is what the dispatch, the local page, the CLI and the MCP tool ask; none of them reads a repository or the store themselves.
//
// What each answer means to the work (fail closed, as Cloud does for a process it cannot read):
//  - no file: Rovara Code as it is;
//  - a file that is there and cannot be used: the step does not start, and says why in words (never the file's text). Running without the project's rules would be a silent switch;
//  - a host that did not answer: the step waits and tries again.
import {
  agentXError,
  type AuditSink,
  type CodeSettings,
  type DocumentStore,
  type HowWeWorkView,
  type InstructionLayer,
  type OrgId,
  type PlaybookFile,
  type PlaybookProblem,
  type ProjectPlaybook,
  type ResolvedRecipe,
  type ResolvedStep,
  type CodingStepKind,
} from "@agentx/contracts";
import type { CodeSettingsReader } from "../merge/seams.js";
import { fixedCodeSettings } from "../merge/defaults.js";
import type { ProjectSource } from "../task-flow/deps.js";
import { parsePlaybookText, playbookIsEmpty } from "./file.js";
import { runningProcessOf } from "./process.js";
import { stepInstructionLayers, wholeAgentLayers } from "./process-reviewers.js";
import type { PlaybookReading, PlaybookSource } from "./source.js";
import { designReviewFileRefusal, readProjectPlaybook, syncProjectPlaybook, type PlaybookSyncResult } from "./store.js";
import { computeHowWeWork } from "./view.js";

/** The workflow modes a coding operation runs in. */
export type PlaybookMode = "UNDERSTAND" | "PLAN" | "PLAN_CRITIQUE" | "IMPLEMENT" | "REVIEW" | "CHECKS" | "FEEDBACK_REVIEW" | "SETUP_DRAFT" | "SETUP_AGENT" | "SPEC_WRITE";

// Understand is not a recipe step: it runs with the plan step's settings (so a recipe cannot remove the question-asking). SETUP_DRAFT and SPEC_WRITE are read-only looks at the code and run as the plan step too.
const KIND_OF_MODE: Record<PlaybookMode, CodingStepKind> = {
  UNDERSTAND: "plan", PLAN: "plan", SETUP_DRAFT: "plan", SETUP_AGENT: "plan", SPEC_WRITE: "plan", PLAN_CRITIQUE: "plan_critic", IMPLEMENT: "build", REVIEW: "review", CHECKS: "check", FEEDBACK_REVIEW: "pull_request",
};

/** The recipe step an operation is: the first step of the kind its mode runs; undefined when the recipe has none. */
export function stepForMode(recipe: ResolvedRecipe, mode: PlaybookMode | undefined): ResolvedStep | undefined {
  const kind = KIND_OF_MODE[mode ?? "IMPLEMENT"];
  return recipe.steps.find((step) => step.kind === kind);
}

/** What a step says when the code host could not give the file: the true cause, whatever the step then does. */
export const COULD_NOT_READ_RULES = "Couldn't read the project's rules from the code host";
export const NO_SUCH_PROJECT_MESSAGE = "this project is not registered";

/** The words a refused step says when the file cannot be used. It names where the first fault is, never what the file said. */
export function playbookRefusal(problems: readonly PlaybookProblem[]): string {
  const first = problems[0];
  const where = first === undefined ? "" : ` (${first.path}: ${first.message})`;
  return `This project's How we work file can't be used right now${where}. Fix .rovara/playbook.yaml on the default branch, then try again.`;
}

/** The project's playbook as the page and the tools show it: the effective process, and where it came from. */
export interface HowWeWorkState {
  view: HowWeWorkView;
  file: PlaybookFileState;
  playbook: ProjectPlaybook;
}
export type PlaybookFileState =
  | { status: "none" }
  | { status: "ok"; digest: string; commit: string; repository: string; text: string }
  | { status: "invalid"; problems: PlaybookProblem[]; commit: string; repository: string; text?: string }
  | { status: "unreadable"; reason: string };

export interface PlaybookService {
  /**
   * Reads the file at the head of the default branch, makes the stored item match it, and answers the playbook. A file that cannot be used is a refusal (`PROCESS_UNAVAILABLE`), a host that did not answer
   * `RUNTIME_UNAVAILABLE`. With `commit` it reads that exact commit and writes nothing (a task's later steps, pinned at its start, must not move the item back to an older file).
   */
  current(project: string, options?: { commit?: string }): Promise<{ file: PlaybookFile | undefined; playbook: ProjectPlaybook; reading: PlaybookReading }>;
  /** The commit a task starting now is pinned to (the head `current` read), or undefined when there is nowhere to read a file from. Refuses as `current` does. */
  pin(project: string): Promise<string | undefined>;
  /** The effective view, with the file's state. Never refuses for a file that cannot be used, and writes nothing: the page shows what is wrong, and the stored item is brought up to the file when a task starts or a step is sent. */
  state(project: string): Promise<HowWeWorkState>;
  /** The view a draft of the file would make, and what is wrong with it. Nothing is written: a draft is looked at, never applied. */
  preview(project: string, draft: string): Promise<{ problems: PlaybookProblem[] } | { view: HowWeWorkView }>;
  /** The instruction layers a step of this mode is given from the file, in order: whole-process rules (not for a reviewing stage), then the stage's own. Empty for no file. `commit`: the task's pinned commit. */
  layersFor(project: string, mode: PlaybookMode | undefined, commit?: string): Promise<Array<{ agentName: string; text: string }>>;
}

export interface PlaybookServiceDeps {
  companyId: OrgId;
  store: Pick<DocumentStore, "get" | "transact">;
  audit: AuditSink;
  projects: Pick<ProjectSource, "latest">;
  source: PlaybookSource;
  codeSettings?: CodeSettingsReader;
  now?: () => Date;
}

const stateOf = (reading: PlaybookReading): PlaybookFileState =>
  reading.status === "none" ? { status: "none" } : reading.status === "ok" ? { status: "ok", digest: reading.digest, commit: reading.commit, repository: reading.repository, text: reading.text }
    : reading.status === "invalid" ? { status: "invalid", problems: reading.problems, commit: reading.commit, repository: reading.repository, ...(reading.text === undefined ? {} : { text: reading.text }) } : { status: "unreadable", reason: reading.reason };

export function createPlaybookService(deps: PlaybookServiceDeps): PlaybookService {
  const now = deps.now ?? ((): Date => new Date());
  const settings = deps.codeSettings ?? fixedCodeSettings();
  const sync = async (project: string, file: PlaybookFile | undefined, digest: string | undefined): Promise<PlaybookSyncResult> =>
    syncProjectPlaybook({ store: deps.store, companyId: deps.companyId, audit: deps.audit, now }, project, { file, digest });

  async function current(project: string, options: { commit?: string } = {}): Promise<{ file: PlaybookFile | undefined; playbook: ProjectPlaybook; reading: PlaybookReading }> {
    const reading = await deps.source.read(project, options.commit === undefined ? undefined : { commit: options.commit });
    if (reading.status === "unreadable") throw agentXError("RUNTIME_UNAVAILABLE", `${COULD_NOT_READ_RULES}: ${reading.reason}. Try again in a moment.`);
    if (reading.status === "invalid") throw agentXError("PROCESS_UNAVAILABLE", playbookRefusal(reading.problems));
    const file = reading.status === "ok" && !playbookIsEmpty(reading.file) ? reading.file : undefined;
    // A task's pinned read never writes: the item says what the head of the default branch says, and an older file must not take it back.
    if (options.commit !== undefined) return { file, playbook: await readProjectPlaybook({ store: deps.store, companyId: deps.companyId }, project), reading };
    const synced = await sync(project, file, file === undefined ? undefined : reading.status === "ok" ? reading.digest : undefined);
    return { file, playbook: synced.playbook, reading };
  }

  const codeSettingsOf = async (project: string): Promise<CodeSettings> => settings.read(deps.companyId, project);

  return {
    current,
    async state(project) {
      const registered = await deps.projects.latest(project);
      if (registered === undefined) throw agentXError("NOT_FOUND", NO_SUCH_PROJECT_MESSAGE);
      const reading = await deps.source.read(project);
      const codeSettings = await codeSettingsOf(project);
      const file = reading.status === "ok" && !playbookIsEmpty(reading.file) ? reading.file : undefined;
      // A company's lock a file's design review setting is looser than: said here as a problem of the file (a read), so the page shows why steps are refused.
      let shown: PlaybookReading = reading;
      if (reading.status === "ok" && file?.designReview !== undefined) {
        const refusal = await designReviewFileRefusal(deps.store, deps.companyId, file.designReview);
        if (refusal !== undefined) shown = { status: "invalid", problems: [{ path: "designReview", message: refusal }], commit: reading.commit, repository: reading.repository, text: reading.text };
      }
      const stored = await readProjectPlaybook({ store: deps.store, companyId: deps.companyId }, project);
      return {
        view: computeHowWeWork({ project, playbookRevision: stored.revision, file: shown.status === "ok" ? file : undefined, definition: registered?.definition, codeSettings }),
        file: stateOf(shown),
        playbook: stored,
      };
    },
    async preview(project, draft) {
      const parsed = parsePlaybookText(draft);
      if (!parsed.ok) return { problems: parsed.problems };
      const registered = await deps.projects.latest(project);
      const file = playbookIsEmpty(parsed.file) ? undefined : parsed.file;
      const stored = await readProjectPlaybook({ store: deps.store, companyId: deps.companyId }, project);
      return { view: computeHowWeWork({ project, playbookRevision: stored.revision, file, definition: registered?.definition, codeSettings: await codeSettingsOf(project) }) };
    },
    async pin(project) {
      const { reading } = await current(project);
      return reading.status === "ok" || reading.status === "none" ? reading.commit : undefined;
    },
    async layersFor(project, mode, commit) {
      const { file } = await current(project, commit === undefined ? {} : { commit });
      if (file === undefined) return [];
      const recipe = runningProcessOf(file).recipe;
      const step = stepForMode(recipe, mode);
      const builtin = new Set(recipe.chain.filter((entry) => entry.builtin).map((entry) => entry.name));
      const layers: InstructionLayer[] = [...wholeAgentLayers(recipe, step), ...stepInstructionLayers(recipe, step, mode)];
      // Rovara's own layers (the built-in's plan and build guidance) are Rovara's, not the project's process: only what the file wrote is the project's.
      return layers.filter((layer) => layer.text.length > 0 && !builtin.has(layer.agentName)).map((layer) => ({ agentName: layer.agentName, text: layer.text }));
    },
  };
}

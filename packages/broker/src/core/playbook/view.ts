// "How we work" in Rovara Code: the effective view of a project's process, read-only. It is Cloud's view (`HowWeWorkView`: one stage at a time, six rows each, every value marked with where it comes
// from), worked out from the recipe the project runs (Rovara Code, then the playbook file's layer), the project definition and the project's code settings. A value written in the file is the
// project's; anything else is Rovara's. There is no company guardrail layer in Code, so nothing is locked by "company" (the company's rules are the standing block's, a separate file). A value that
// Rovara keeps for safety is locked by Rovara.
//
// Reviewing stages (the plan check, the review that runs the code and security reviewers, and the pull request feedback review) are not given the file's project-wide rules (`wholeAgentLayers`), so
// those rules are left out of their instructions here too, and the stage carries a fixed note the page can show.
import {
  HOW_WE_WORK_INSTRUCTION_MAX,
  HOW_WE_WORK_ITEMS_MAX,
  HOW_WE_WORK_LAYERS_MAX,
  HOW_WE_WORK_LINE_MAX,
  HOW_WE_WORK_REVIEWER_NOTE,
  HOW_WE_WORK_TOOLS_MAX,
  HOW_WE_WORK_TOOL_MAX,
  READ_ONLY_TOOLS,
  ROVARA_CODE_AGENT_ID,
  agentXError,
  developerTaskPolicy,
  redactText,
  type CodeSettings,
  type HowWeWorkSource,
  type HowWeWorkStage,
  type HowWeWorkView,
  type InstructionLayer,
  type Marked,
  type PlaybookFile,
  type ResolvedRecipe,
  type ResolvedStep,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import { runningProcessOf, type RunningProcess } from "./process.js";
import { isReviewingStage, wholeAgentLayers } from "./process-reviewers.js";

type Lock = "company" | "rovara";
const mark = <T>(value: T, source: HowWeWorkSource, lockedBy?: Lock): Marked<T> => (lockedBy === undefined ? { value, source, locked: false } : { value, source, locked: true, lockedBy });
/** A line of the page: redacted and cut to the contract's limit after it is composed, by code points. */
const fit = (text: string): string => clip(redactText(text), HOW_WE_WORK_LINE_MAX);
const rovara = (text: string, lockedBy?: Lock): Marked<string> => mark(fit(text), "rovara", lockedBy);
const project = (text: string): Marked<string> => mark(fit(text), "project");

const clip = (text: string, max: number): string => {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
};
/** A line a person wrote, redacted and bounded for the page. */
const line = fit;
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

interface Inputs {
  running: RunningProcess;
  definition: StoredProjectDefinition | undefined;
  codeSettings: CodeSettings;
}

const commandLabel = (command: { executable: string; args: string[] }): string => clip(fit(`${command.executable} ${command.args.join(" ")}`.trim()), 80);

type StepSettings = { model?: { provider: string; modelId: string; thinkingLevel?: string } | null; thinkingLevel?: string | null; tools?: string[]; differentCompanyFrom?: string | null; instructions?: InstructionLayer[] };

/** Who a layer of instructions is from, by the chain entry of the agent that wrote it. */
function layerSource(recipe: ResolvedRecipe, layer: InstructionLayer): HowWeWorkSource {
  const entry = recipe.chain.find((candidate) => candidate.name === layer.agentName);
  if (entry === undefined || entry.builtin) return "rovara";
  return entry.process === true ? "project" : "company";
}
const layerRows = (recipe: ResolvedRecipe, layers: readonly InstructionLayer[]): Array<Marked<string>> =>
  layers.filter((layer) => layer.text.length > 0).slice(0, HOW_WE_WORK_LAYERS_MAX).map((layer) => mark(clip(redactText(layer.text), HOW_WE_WORK_INSTRUCTION_MAX), layerSource(recipe, layer)));

/** The kinds whose tools are read-only by design, and the kinds that may not change the repository at all. */
const READ_ONLY_KINDS = new Set<string>(["plan", "plan_critic", "review"]);
const CANNOT_WRITE_KINDS = new Set<string>(["plan", "plan_critic", "review", "agent", "approval"]);

function stageOf(step: ResolvedStep, inputs: Inputs): HowWeWorkStage {
  const { running, definition, codeSettings } = inputs;
  const { recipe, base, overlay } = running;
  const settings = step.settings as StepSettings;
  const baseSettings = base.steps.find((candidate) => candidate.id === step.id)?.settings as StepSettings | undefined;
  /** The project's when its process layer set the field; the company's when a layer between set it; otherwise Rovara's. */
  const origin = (field: keyof StepSettings): HowWeWorkSource => {
    const written = (overlay?.steps?.[step.id] as StepSettings | undefined)?.[field];
    if (written !== undefined) return "project";
    return sameJson(settings[field], baseSettings?.[field]) ? "rovara" : "company";
  };

  // Who
  // V3: no model is decided here. The stage models (what runs, why, and what can be chosen) come from the model resolver's own read (`GET /v1/app/projects/{p}/stage-models`); these two rows
  // stay in the view's shape for older readers and always say "not decided here".
  const model = mark<string | null>(null, "rovara");
  const thinking = mark<string | null>(null, "rovara");
  // No company guardrail in Code: the only way a stage must differ in company from an earlier one is its own setting.
  const named = settings.differentCompanyFrom;
  const targets = typeof named === "string" ? [named] : [];
  const differentCompanyFrom = targets.length > 0 ? mark(targets, origin("differentCompanyFrom")) : mark<string[]>([], "rovara");

  // Knows
  const reviewing = isReviewingStage(step);
  const instructions = layerRows(recipe, [...wholeAgentLayers(recipe, step), ...(settings.instructions ?? [])]);

  // May
  const tools = READ_ONLY_KINDS.has(step.kind)
    ? mark<string[] | null>([...(settings.tools ?? READ_ONLY_TOOLS)].slice(0, HOW_WE_WORK_TOOLS_MAX).map((tool) => clip(tool, HOW_WE_WORK_TOOL_MAX)), settings.tools === undefined ? "rovara" : origin("tools"), "rovara")
    : mark<string[] | null>(settings.tools === undefined ? null : settings.tools.slice(0, HOW_WE_WORK_TOOLS_MAX).map((tool) => clip(tool, HOW_WE_WORK_TOOL_MAX)), settings.tools === undefined ? "rovara" : origin("tools"));

  const checked: Array<Marked<string>> = [];
  const evidence: Array<Marked<string>> = [];
  const approves: Array<Marked<string>> = [];

  if (step.kind === "check") {
    for (const command of definition?.readiness ?? []) checked.push(project(`Required: ${commandLabel(command)}`));
    if (definition !== undefined) for (const optional of developerTaskPolicy(definition).optionalWorkflowChecks ?? []) checked.push(project(`Optional: ${line(optional.label)}`));
    const capture = definition?.e2e?.capture;
    if (capture !== undefined) {
      for (const [name, on] of [["Screenshots", capture.screenshots], ["Traces", capture.traces], ["Video", capture.video], ["Downloads", capture.downloads]] as const) evidence.push(project(`${name}: ${on ? "on" : "off"}`));
    }
  }
  if (step.kind === "review") {
    for (const reviewer of step.reviewers) checked.push(rovara(reviewer === "code" ? "Code review" : "Security review"));
    if (step.onFindings !== undefined) {
      const back = recipe.steps.find((candidate) => candidate.id === step.onFindings?.backTo);
      const rounds = step.onFindings.maxRounds;
      checked.push(rovara(`Findings go back to ${line(back?.name ?? step.onFindings.backTo)}, up to ${String(rounds)} ${rounds === 1 ? "round" : "rounds"}`));
    }
  }
  if (step.kind === "plan") approves.push(rovara("A person approves the plan before any code is written", "rovara"));
  if (step.kind === "pull_request") {
    for (const section of ["Plan summary", "What changed", "Tests", "Reviews", "Risk"]) evidence.push(rovara(section));
    approves.push(rovara("Rovara never merges on its own: a person merges the pull request", "rovara"));
    // The code settings are the project's once it has saved them (a saved item has a revision); until then these are Rovara's defaults.
    const own = (text: string): Marked<string> => (codeSettings.revision > 0 ? project(text) : rovara(text));
    approves.push(own(`Self-approval: ${codeSettings.allowSelfApproval ? "allowed" : "not allowed"}`));
    approves.push(own(`Merge method: ${codeSettings.mergeMethod}`));
    if (codeSettings.codeReviewers.length > 0) approves.push(own(`Reviewers asked: ${codeSettings.codeReviewers.join(", ")}`));
  }

  return {
    id: step.id,
    name: line(step.name),
    kind: step.kind,
    who: { model, thinking, differentCompanyFrom },
    knows: { instructions, ...(reviewing ? { note: HOW_WE_WORK_REVIEWER_NOTE } : {}) },
    may: { tools, readOnly: CANNOT_WRITE_KINDS.has(step.kind) },
    checked: { items: checked.slice(0, HOW_WE_WORK_ITEMS_MAX) },
    evidence: { items: evidence.slice(0, HOW_WE_WORK_ITEMS_MAX) },
    approves: { items: approves.slice(0, HOW_WE_WORK_ITEMS_MAX) },
  };
}

/** What the view is made from: the project's name, the playbook revision stored for it, the file as read (undefined: none), the project definition and the code settings. */
export interface HowWeWorkInput {
  project: string;
  playbookRevision: number;
  file: PlaybookFile | undefined;
  definition: StoredProjectDefinition | undefined;
  codeSettings: CodeSettings;
}

/**
 * The project's process as the How we work page shows it. Pure: nothing is read or written here. The process is always Rovara Code (a file is a layer on it, not another process); where the
 * file's layer has something to say, its text is marked as the project's.
 */
export function computeHowWeWork(input: HowWeWorkInput): HowWeWorkView {
  const running = runningProcessOf(input.file);
  if (running.recipe.steps.length === 0) throw agentXError("CONFIG_INVALID", "this project's process has no stages");
  const inputs: Inputs = { running, definition: input.definition, codeSettings: input.codeSettings };
  return {
    project: input.project,
    playbookRevision: input.playbookRevision,
    process: { kind: "builtin", agentId: ROVARA_CODE_AGENT_ID },
    stages: running.recipe.steps.map((step) => stageOf(step, inputs)),
    rules: layerRows(running.recipe, running.recipe.instructions),
    modelsEditable: false,
  };
}

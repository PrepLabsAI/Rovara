// The spec renderer plug-in interface and its registry.
//
// A renderer turns the approved-plan `SpecDraft` into the files of one format, and reads a format's files back into checkable requirements (so a review can walk a spec a person
// has edited). Kiro is one renderer among several; a team's own format is a renderer registered under another id. Nothing here knows a customer or a tool by name.
import { agentXError, SPEC_FILES_MAX, SPEC_FILE_MAX_BYTES, SPEC_REVIEW_REQUIREMENTS_MAX, nextFenceState, specFileNameProblem, unescapeMarkdown, specFolderProblem, specPathProblem, specSlug, type SpecDraft, type SpecFile, type SpecRequirementRef, type SpecTarget } from "@agentx/contracts";

/** What a renderer is given. All of it is data the broker already trusts (the draft is cleaned by its schema); `template` is meta-repo text read at the task's `knowledgeCommit`. */
export interface SpecRenderInput {
  draft: SpecDraft;
  target: SpecTarget;
  /** The task's key (for `{taskKey}`), and the ticket it came from (for `{ticket}`), when there is one. Both are cleaned before use in a path. */
  taskKey: string;
  ticket?: string | undefined;
  /** Names of the folders already in the spec folder's parent (for `{n}`), as the meta repo has them at the commit the spec is based on. */
  existingFolders: readonly string[];
  /** `team_template`: the template folder's files (paths relative to the folder). */
  template?: readonly SpecFile[] | undefined;
  /** The project's own knowledge folders (steering, skills, runbooks, key docs): a spec is never written into one. */
  forbiddenFolders?: readonly string[] | undefined;
}

export interface RenderedSpec {
  /** The folder the files are in, with a trailing `/`. */
  folder: string;
  files: SpecFile[];
}

export interface SpecRenderer {
  /** The id a project's `specTarget.format` names. */
  readonly format: string;
  readonly label: string;
  /** The folder template when the project names none. */
  readonly defaultPathTemplate: string;
  render(input: SpecRenderInput): RenderedSpec;
  /** The checkable statements of this format's files. Never throws: a file it cannot read gives no requirements. */
  extractRequirements(files: readonly SpecFile[]): SpecRequirementRef[];
}

const registry = new Map<string, SpecRenderer>();

/** Registers a renderer. A second renderer under the same id is refused, so a plug-in cannot silently replace a built-in. */
export function registerSpecRenderer(renderer: SpecRenderer): void {
  if (!/^[a-z][a-z0-9_]{0,31}$/u.test(renderer.format)) throw new Error(`spec format id "${renderer.format}" is not a valid id`);
  if (registry.has(renderer.format)) throw new Error(`a spec renderer for "${renderer.format}" is already registered`);
  registry.set(renderer.format, renderer);
}

export function specRendererFor(format: string): SpecRenderer | undefined {
  return registry.get(format);
}

export function specFormats(): string[] {
  return [...registry.keys()].sort();
}

/** Test seam: removes a renderer a test registered. */
export function unregisterSpecRenderer(format: string): void {
  registry.delete(format);
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------------------------------------------------

/** A path token's value, made safe for one path segment: letters, digits, `-`, `_`, `.` only, no leading dot, at most 48 characters. */
export function pathToken(value: string): string {
  const cleaned = value.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "").slice(0, 48).replace(/[.-]+$/u, "");
  return cleaned === "" ? "x" : cleaned;
}

/** The next free three-digit number among folders named `NNN-...` (Spec Kit's numbering): the highest number present plus one, never reusing a gap, `001` for none. */
export function nextFolderNumber(existingFolders: readonly string[]): string {
  let highest = 0;
  for (const name of existingFolders) {
    const match = /^(\d{1,4})(?:-|$)/u.exec(name);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  if (highest >= 999) throw agentXError("CONFIG_INVALID", "the spec folder is full: there is no free three-digit number");
  return String(highest + 1).padStart(3, "0");
}

/** The spec's folder: the template (the project's or the format's) with its tokens filled, checked as a safe relative folder. Throws CONFIG_INVALID with a fixed sentence. */
export function resolveSpecFolder(renderer: Pick<SpecRenderer, "defaultPathTemplate">, input: SpecRenderInput): string {
  const template = input.target.pathTemplate ?? renderer.defaultPathTemplate;
  const values: Record<string, string> = {
    slug: specSlug(input.draft.title),
    taskKey: pathToken(input.taskKey),
    ticket: pathToken(input.ticket ?? input.taskKey),
    n: template.includes("{n}") ? nextFolderNumber(input.existingFolders) : "000",
  };
  const folder = template.replace(/\{(slug|taskKey|ticket|n)\}/gu, (_whole, token: string) => values[token]!).replace(/\/+$/u, "");
  if (specPathProblem(folder) !== undefined) throw agentXError("CONFIG_INVALID", "the spec folder is not a safe path");
  if (specFolderProblem(folder, input.forbiddenFolders) !== undefined) throw agentXError("CONFIG_INVALID", "the spec folder is a rules, steering, skills, config or automation folder");
  return `${folder}/`;
}

/** Checks a rendered spec against the bounds every format shares. Throws CONFIG_INVALID. */
export function assertRenderedSpec(rendered: RenderedSpec): RenderedSpec {
  if (rendered.files.length === 0 || rendered.files.length > SPEC_FILES_MAX) throw agentXError("CONFIG_INVALID", `a spec has 1 to ${String(SPEC_FILES_MAX)} files`);
  const seen = new Set<string>();
  for (const file of rendered.files) {
    const problem = specPathProblem(file.path);
    if (problem !== undefined || !file.path.startsWith(rendered.folder)) throw agentXError("CONFIG_INVALID", "a spec file is outside the spec folder");
    if (seen.has(file.path.toLowerCase())) throw agentXError("CONFIG_INVALID", "a spec has two files at one path");
    if (specFileNameProblem(file.path) !== undefined) throw agentXError("CONFIG_INVALID", "a spec cannot hold a rules, steering or ownership file");
    seen.add(file.path.toLowerCase());
    if (new TextEncoder().encode(file.content).byteLength > SPEC_FILE_MAX_BYTES) throw agentXError("CONFIG_INVALID", "a spec file is larger than 64 KiB");
  }
  return rendered;
}

/** A label followed by a statement, as every shipped format writes a requirement: `1.2. WHEN ... SHALL ...`, `- **FR-001**: ...`, `R1.2 ...`. */
const LABELLED_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?((?:FR|DEF)-\d{1,4}|R?\d{1,2}\.\d{1,2})(?:\*\*)?[.:)]?\s+(.+?)\s*$/u;

/** The labelled requirement lines of one file. `defect` is the heading (lower-cased, contains) whose lines describe a fault rather than a promise; the headings that start a requirement section limit where lines count. */
export function extractLabelledLines(file: SpecFile, options: { sectionHeadings?: RegExp; defectHeading?: RegExp } = {}): SpecRequirementRef[] {
  const out: SpecRequirementRef[] = [];
  let inSection = options.sectionHeadings === undefined;
  let defect = false;
  let fence: ReturnType<typeof nextFenceState>;
  for (const raw of file.content.split("\n")) {
    const wasOpen = fence !== undefined;
    fence = nextFenceState(fence, raw);
    if (wasOpen || fence !== undefined) continue;
    if (/^ {0,3}(?:`{3,}|~{3,})/u.test(raw)) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(raw);
    if (heading !== null) {
      const title = heading[2] ?? "";
      if (options.sectionHeadings !== undefined) inSection = options.sectionHeadings.test(title) || (inSection && heading[1]!.length > 2);
      defect = options.defectHeading?.test(title) === true;
      continue;
    }
    if (!inSection) continue;
    const match = LABELLED_LINE.exec(raw);
    if (match === null) continue;
    const text = unescapeMarkdown((match[2] ?? "").trim());
    if (text === "" || !/\b(?:SHALL|MUST)\b/u.test(text) && !defect) continue;
    out.push({ id: (match[1] ?? "").replace(/^R(?=\d)/u, ""), text: text.slice(0, 440), kind: defect ? "defect" : "requirement", path: file.path });
    if (out.length >= SPEC_REVIEW_REQUIREMENTS_MAX + 1) break;
  }
  return out;
}

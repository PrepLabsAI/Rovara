// What a meta repo's config file would change in a project, worked out without writing anything.
//
// The file is the source of truth for the settings it names, and is NEVER applied directly (design 3.1): the broker reads it from the meta repo's default branch,
// plans the change against the project's latest revision, and a maintainer applies it (config-import.ts). This module is the pure part: parse a file's text and plan.
//
// What a release applies: `repositories` (add; remove only when a person confirms), `setup` and `tests` (the project's setup and test commands, per repository).
// Every other section is validated and carried, never applied here: it is listed in `deferred` for the lane that owns it (`checks`, `knowledge`, `specTarget`, `sources`,
// `intake`). A lane that adds a section adds its items to `planMetaConfigChange`; nothing else moves.
//
// A value a person typed is never replaced silently: when the project's value of a field was set by a person and differs from the file's, the item carries
// `conflict: "person_value"`, and apply replaces it only when the maintainer names that field in `useFile`.
import { parseDocument } from "yaml";
import {
  META_CONFIG_MAX_BYTES,
  META_CONFIG_FILE_PATHS,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  AgentXError,
  canonicalJson,
  codeRepositoriesOf,
  formatCommandLine,
  metaConfigReferenceProblems,
  metaRepositoryOf,
  parseCommandLine,
  parseMetaProjectConfig,
  parseMetaProjectConfigJson,
  projectMetaShape,
  safePathPart,
  specFolderProblem,
  settingOriginOf,
  type MetaConfigParse,
  type MetaConfigProblem,
  type MetaProjectConfig,
  type ProjectCommand,
  type StoredProjectDefinition,
} from "@agentx/contracts";

export { META_CONFIG_FILE_PATHS };

const YAML_MAX_ALIASES = 10;

/**
 * A config file's text as a config. JSON by its extension, YAML otherwise. The file is a repository's data: it is bounded in size before it is read, YAML aliases are
 * capped (no expansion bomb), merge keys and duplicate keys are refused, only the core schema's plain values are read, and nothing in a parse error (which can quote the file)
 * is passed on: a failure is a fixed sentence.
 */
export function parseMetaConfigFile(path: string, text: string): MetaConfigParse {
  if (new TextEncoder().encode(text).byteLength > META_CONFIG_MAX_BYTES) return { ok: false, problems: [{ path: "(file)", message: `the file is larger than ${String(META_CONFIG_MAX_BYTES)} bytes` }] };
  if (path.endsWith(".json")) return parseMetaProjectConfigJson(text);
  let value: unknown;
  try {
    const document = parseDocument(text, { merge: false, uniqueKeys: true, version: "1.2", schema: "core", prettyErrors: false });
    if (document.errors.length > 0) return { ok: false, problems: [{ path: "(file)", message: "the file is not valid YAML" }] };
    value = document.toJS({ maxAliasCount: YAML_MAX_ALIASES });
  } catch {
    return { ok: false, problems: [{ path: "(file)", message: "the file is not valid YAML" }] };
  }
  return parseMetaProjectConfig(value);
}

/** The sections of a config this release validates and carries but does not apply; the lane that owns each one applies it. */
export const DEFERRED_CONFIG_SECTIONS = ["checks", "knowledge", "sources", "intake"] as const;

/** The project fields a config applies, by the name the project record's `origins` gives them. */
export type ConfigField = "repositories" | "setup" | "readiness" | "specTarget";

export type PlanBlockReason =
  /** Only repositories on github.com can be added until another code host's plug-in lands. */
  | "unsupported_host"
  /** The project's one repository is its own meta repo; adding code means making a separate meta repo first. */
  | "self_meta_project"
  /** The name or path is not one a repository of this project may have. */
  | "invalid";

export interface PlanItem {
  /** Stable within a plan: `repositories:add:<name>`, `repositories:remove:<name>`, `setup`, `readiness`. */
  id: string;
  field: ConfigField;
  kind: "add_repository" | "remove_repository" | "set_commands" | "set_spec_target";
  repository?: string;
  url?: string;
  /** For an added repository: the folder it gets in the workspace (always `repo/<name>`), shown so the maintainer sees what they apply. */
  path?: string;
  /** For a command list: the project's commands now and the file's, one line each, as `repository: command`. At most 64. */
  before?: string[];
  after?: string[];
  /** For a command list: how many of the project's commands the file removes (more before than after), so the app can say "removes N commands". */
  removes?: number;
  /** The project's value was set by a person and differs from the file's: apply replaces it only when the maintainer names the field in `useFile`. */
  conflict?: "person_value";
  /** Applied only when the maintainer confirms it by name (a removal). */
  needsConfirmation?: true;
  /** Never applied; says why. */
  blocked?: PlanBlockReason;
}

export interface MetaConfigPlan {
  items: PlanItem[];
  /** Sections the file carries that this release does not apply. */
  deferred: string[];
  problems: MetaConfigProblem[];
}

type Repository = StoredProjectDefinition["repositories"][number];

/** `owner/name` of a GitHub repository URL, lower-cased, or undefined for any other host or shape. */
export function githubFullName(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const parts = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    return parts.length === 2 ? parts.join("/").toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** The repository a config entry means: the project's own repository with the same GitHub name (any other host is matched by exact URL). */
function matchRepository(repositories: readonly Repository[], url: string): Repository | undefined {
  const wanted = githubFullName(url);
  return repositories.find((repository) => wanted === undefined ? repository.url.toLowerCase() === url.toLowerCase() : githubFullName(repository.url) === wanted);
}

const DISPLAY_LINES_MAX = 64;

/** A repository's path in the project once the change is made: the file's own, or the default. */
export function configRepositoryPath(entry: { name: string; path?: string | undefined }): string {
  // The config schema allows no other folder; this is the same rule where a plan is made from a stored config.
  return `repo/${entry.name}`;
}

export interface DesiredCommands { commands: ProjectCommand[]; lines: string[]; problems: MetaConfigProblem[] }

/**
 * The project's setup (or test) commands as the file would have them: each repository's list, in the order of the project's repositories after the change, run in that
 * repository's folder.
 */
export function desiredCommands(
  section: "setup" | "tests",
  config: MetaProjectConfig,
  repositoriesAfter: ReadonlyArray<{ name: string; path: string }>,
): DesiredCommands {
  const commands: ProjectCommand[] = [];
  const lines: string[] = [];
  const problems: MetaConfigProblem[] = [];
  const timeout = section === "setup" ? SETUP_TIMEOUT : TEST_TIMEOUT;
  for (const repository of repositoriesAfter) {
    // Own properties only: a repository may be called `constructor`, which a plain lookup would find on the prototype.
    const named = section === "setup" ? config.setup : config.tests;
    const entry = named === undefined || !Object.hasOwn(named, repository.name) ? undefined : section === "setup" ? config.setup![repository.name] : config.tests![repository.name]!.commands;
    for (const [index, line] of (entry ?? []).entries()) {
      try {
        commands.push(parseCommandLine(line, repository.path, timeout));
        lines.push(`${repository.name}: ${line}`);
      } catch (error) {
        problems.push({ path: `${section}.${safePathPart(repository.name)}${section === "tests" ? ".commands" : ""}.${String(index)}`, message: error instanceof AgentXError ? error.message.replace(/^[A-Z_]+: /, "") : "the command cannot be read" });
      }
    }
  }
  if (commands.length > 64) problems.push({ path: section, message: "a project keeps at most 64 commands in all" });
  return { commands, lines, problems };
}

const currentLines = (commands: readonly ProjectCommand[], repositories: readonly Repository[]): string[] => commands.map((command) => {
  const owner = repositories.find((repository) => command.cwd === repository.path || command.cwd.startsWith(`${repository.path}/`));
  return `${owner?.name ?? command.cwd}: ${formatCommandLine(command)}`;
});

/**
 * The change a config makes to a project, item by item. Nothing is written. `problems` (a command that cannot be read, a name the project does not have) leave the
 * item out and are shown to the maintainer; a plan with problems still lists what is clear.
 */
export function planMetaConfigChange(input: { config: MetaProjectConfig; definition: StoredProjectDefinition }): MetaConfigPlan {
  const { config, definition } = input;
  const meta = metaRepositoryOf(definition);
  const shape = projectMetaShape(definition);
  const items: PlanItem[] = [];
  const problems: MetaConfigProblem[] = [];
  if (meta === undefined) {
    return { items, deferred: [], problems: [{ path: "(project)", message: "this project has no meta repository" }] };
  }
  // A file with no `repositories` section leaves the project's repositories as they are, so their names are known to its commands.
  problems.push(...metaConfigReferenceProblems(config, meta.name, config.repositories === undefined ? codeRepositoriesOf(definition).map((repository) => repository.name) : []));

  // Repositories: the file lists the code repositories; the meta repo is the one the file is in.
  let repositoriesAfter: Array<{ name: string; path: string }> = codeRepositoriesOf(definition).map((repository) => ({ name: repository.name, path: repository.path }));
  if (config.repositories !== undefined) {
    const code = codeRepositoriesOf(definition);
    const kept = new Set<Repository>();
    const added: Array<{ name: string; path: string }> = [];
    for (const entry of config.repositories) {
      const found = matchRepository(code, entry.url);
      if (found !== undefined) {
        kept.add(found);
        if (found.name !== entry.name) problems.push({ path: `repositories.${entry.name}`, message: `is already in this project as ${found.name}; a repository is renamed in settings, not by the file` });
        continue;
      }
      let blocked: PlanBlockReason | undefined;
      if (githubFullName(entry.url) === undefined) blocked = "unsupported_host";
      else if (shape === "self") blocked = "self_meta_project";
      else if (code.some((repository) => repository.name === entry.name) || meta.name === entry.name) blocked = "invalid";
      items.push({ id: `repositories:add:${entry.name}`, field: "repositories", kind: "add_repository", repository: entry.name, url: entry.url, path: configRepositoryPath(entry), ...(blocked === undefined ? {} : { blocked }) });
      if (blocked === undefined) added.push({ name: entry.name, path: configRepositoryPath(entry) });
    }
    if (shape === "separate") {
      for (const repository of code) {
        if (kept.has(repository)) continue;
        items.push({ id: `repositories:remove:${repository.name}`, field: "repositories", kind: "remove_repository", repository: repository.name, url: repository.url, needsConfirmation: true });
      }
    }
    // Commands run in the repositories the project will have: the ones kept, and the ones added; a removal is applied only when confirmed, so its repository still counts.
    repositoriesAfter = [...repositoriesAfter, ...added];
  }

  // A repository that is the meta repo and not code holds no code a command could run in.
  const metaIsNotCode = shape === "separate";
  for (const [section, field] of [["setup", "setup"], ["tests", "readiness"]] as const) {
    const named = config[section];
    if (named === undefined) continue;
    if (metaIsNotCode && Object.hasOwn(named, meta.name)) {
      problems.push({ path: `${section}.${safePathPart(meta.name)}`, message: "names the meta repository, which holds no code: commands cannot run there" });
    }
    const desired = desiredCommands(section, config, repositoriesAfter);
    problems.push(...desired.problems);
    if (desired.problems.length > 0) continue;
    const current = field === "setup" ? definition.setup : definition.readiness;
    if (canonicalJson(current) === canonicalJson(desired.commands)) continue;
    const personTyped = current.length > 0 && settingOriginOf(definition, field) === "person";
    items.push({
      id: field, field, kind: "set_commands",
      before: currentLines(current, definition.repositories).slice(0, DISPLAY_LINES_MAX),
      after: desired.lines.slice(0, DISPLAY_LINES_MAX),
      ...(current.length > desired.commands.length ? { removes: current.length - desired.commands.length } : {}),
      ...(personTyped ? { conflict: "person_value" as const } : {}),
    });
  }

  // the file may not point the specs into the folders it names as its own rules, steering, skills, runbooks or key docs.
  const template = config.specTarget?.pathTemplate;
  if (template !== undefined) {
    const segments = template.replace(/\/$/u, "").split("/");
    const firstToken = segments.findIndex((segment) => /\{/u.test(segment));
    const literal = (firstToken === -1 ? segments : segments.slice(0, firstToken)).join("/");
    const own = [config.knowledge?.steering, config.knowledge?.skills, config.knowledge?.runbooks, config.knowledge?.keyDocs].flatMap((paths) => paths ?? []);
    if (specFolderProblem(literal, own) !== undefined) problems.push({ path: "specTarget.pathTemplate", message: "points the specs into a rules, steering, skills, runbooks or key docs folder" });
  }
  // where the project's specs are written and in which format. Shown as JSON lines, one key each, so the maintainer sees what they apply.
  if (config.specTarget !== undefined && canonicalJson(definition.specTarget ?? null) !== canonicalJson(config.specTarget)) {
    const lines = (target: object | undefined) => target === undefined ? [] : Object.entries(target as Record<string, unknown>).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).slice(0, DISPLAY_LINES_MAX);
    const personTyped = definition.specTarget !== undefined && settingOriginOf(definition, "specTarget") === "person";
    items.push({
      id: "specTarget", field: "specTarget", kind: "set_spec_target", before: lines(definition.specTarget), after: lines(config.specTarget),
      ...(personTyped ? { conflict: "person_value" as const } : {}),
    });
  }

  const deferred = DEFERRED_CONFIG_SECTIONS.filter((section) => config[section] !== undefined);
  return { items, deferred, problems };
}

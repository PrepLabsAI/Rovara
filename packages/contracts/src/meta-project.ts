// Meta repo lane A (K1): the config file a meta repo may carry, and the body that creates a project from a meta repo.
//
// The meta repo is the project: it holds the project's config, its knowledge (steering, rules, runbooks, skills, specs) and, by default, the specs Rovara writes.
// This file defines only the small, generic contract the other lanes build on:
//   - `MetaProjectConfig`: the config file (`.rovara/project.yaml`, or `.yml` or `.json`) read from the meta repo's default branch. It is NEVER applied directly:
//     the broker turns a change into a pending change that a maintainer applies (see broker/src/meta-repo/config-import.ts). Limits come only from settings.
//   - `CreateProjectFromMetaBodySchema`: `POST /v1/app/projects` with a `metaRepository`.
//   - the default knowledge locations, so every lane names the same folders.
// Nothing here names a company, a code host or a tool: Kiro, Cursor and the like are only the first folders and formats Rovara understands.
//
// The config is data from a repository, so it is parsed strictly, bounded in size and depth, and carries names only: no endpoint, no credential, no secret.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { AgentXNameSchema } from "./names.js";
import { RelativeWorkspacePathSchema } from "./project.js";
import { GitBranchNameSchema } from "./git-branch.js";
import { SpecTargetSchema } from "./spec-target.js";
import { IntakeChannelRefSchema } from "./intake.js";

/** The config file's places, in the order they are tried. The first that exists is the file. */
export const META_CONFIG_FILE_PATHS = [".rovara/project.yaml", ".rovara/project.yml", ".rovara/project.json"] as const;
/** A config file bigger than this is refused unread. */
export const META_CONFIG_MAX_BYTES = 262_144;
export const META_CONFIG_VERSION = 1;
/** One of the project's 32 repositories is the meta repo, so the config lists at most 31 more. */
export const META_CONFIG_MAX_REPOSITORIES = 31;
export const META_CONFIG_MAX_COMMANDS_PER_REPOSITORY = 20;
export const META_CONFIG_COMMAND_MAX = 500;
export const META_CONFIG_MAX_CHECKS = 20;
export const META_CONFIG_MAX_SOURCES = 16;
export const META_CONFIG_MAX_INTAKE = 16;
export const META_CONFIG_MAX_KNOWLEDGE_PATHS = 16;

/** Where each kind of knowledge lives in the meta repo when the config does not say. The knowledge resolver (lane C) and the setup agent (lane B) read these. */
export const META_KNOWLEDGE_DEFAULTS = {
  steering: [".kiro/steering", ".rovara/rules", ".cursor/rules", ".claude/rules", ".github/instructions"],
  skills: [".agents/skills", ".claude/skills", ".kiro/skills"],
  specs: [".kiro/specs", "specs"],
  runbooks: ["runbooks", "docs/runbooks"],
  keyDocs: [] as string[],
} as const;
export const META_KNOWLEDGE_KINDS = ["steering", "skills", "specs", "runbooks", "keyDocs"] as const;
export type MetaKnowledgeKind = (typeof META_KNOWLEDGE_KINDS)[number];

/** A repository-relative path inside the meta repo; never into Git's own folder. */
const KnowledgePathSchema = RelativeWorkspacePathSchema.refine((path) => path.split("/")[0] !== ".git", "a knowledge path cannot be inside .git");
const knowledgePaths = z.array(KnowledgePathSchema).max(META_CONFIG_MAX_KNOWLEDGE_PATHS).refine((paths) => new Set(paths).size === paths.length, "paths must be unique");

const CommandLineSchema = z.string().trim().min(1).max(META_CONFIG_COMMAND_MAX);
const commandList = z.array(CommandLineSchema).max(META_CONFIG_MAX_COMMANDS_PER_REPOSITORY);

/** A repository's URL as a config may name it: https, no user or password in it. */
const ConfigRepositoryUrlSchema = z.string().max(2_048).superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "url must be an https URL" });
    return;
  }
  if (url.protocol !== "https:") context.addIssue({ code: "custom", message: "url must use https" });
  if (url.username !== "" || url.password !== "") context.addIssue({ code: "custom", message: "url must not carry a user or password" });
});

export const MetaConfigRepositorySchema = z.object({
  name: AgentXNameSchema,
  url: ConfigRepositoryUrlSchema,
  /** The folder a repository gets is always `repo/<name>` (a tenant's file does not choose workspace folders); a file may repeat it, nothing else. */
  path: RelativeWorkspacePathSchema.optional(),
  defaultBranch: GitBranchNameSchema.optional(),
  /** Only `code` repositories are listed here: the meta repo is the one the file was read from. */
  role: z.literal("code").optional(),
}).strict().superRefine((repository, context) => {
  if (repository.path !== undefined && repository.path !== `repo/${repository.name}`) {
    context.addIssue({ code: "custom", path: ["path"], message: `a repository's folder is repo/${repository.name}` });
  }
});
export type MetaConfigRepository = z.infer<typeof MetaConfigRepositorySchema>;

/**
 * A section another lane owns (the spec target, the intake channels). Lane A accepts it as bounded plain JSON so a file that carries it is not refused, and
 * the broker carries it unchanged and unapplied. When that lane's contract lands, its schema replaces `OpaqueSectionSchema` for that one key in
 * `MetaProjectConfigSchema` (one line each) and its apply handler joins `planMetaConfigChange`.
 */
const OPAQUE_SECTION_MAX_BYTES = 8_192;
const OPAQUE_SECTION_MAX_DEPTH = 6;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function opaqueProblem(value: unknown, depth: number): string | undefined {
  if (depth > OPAQUE_SECTION_MAX_DEPTH) return "is nested too deeply";
  if (Array.isArray(value)) {
    for (const item of value) { const problem = opaqueProblem(item, depth + 1); if (problem !== undefined) return problem; }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) return "has a reserved key";
      const problem = opaqueProblem(item, depth + 1);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  return value === null || ["string", "number", "boolean"].includes(typeof value) ? undefined : "holds a value JSON cannot";
}

// Checked on the raw value, before any record parsing, because a parser may drop a reserved key (`__proto__`) and so hide it.
export const OpaqueSectionSchema = z.unknown().superRefine((value, context) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { context.addIssue({ code: "custom", message: "section must be an object" }); return; }
  const problem = opaqueProblem(value, 0);
  if (problem !== undefined) { context.addIssue({ code: "custom", message: `section ${problem}` }); return; }
  if (Object.keys(value).some((key) => key.length > 64)) { context.addIssue({ code: "custom", message: "section has a key longer than 64 characters" }); return; }
  if (canonicalJson(value).length > OPAQUE_SECTION_MAX_BYTES) context.addIssue({ code: "custom", message: `section is larger than ${String(OPAQUE_SECTION_MAX_BYTES)} bytes` });
}).transform((value) => value as Record<string, unknown>);

export const MetaConfigCheckSchema = z.object({
  name: z.string().trim().min(1).max(80),
  repo: AgentXNameSchema,
  command: CommandLineSchema,
}).strict();

export const MetaConfigTestsSchema = z.object({
  commands: commandList,
  /** The command that lists the tests a change affects (the test-selection hook of the test-environment design). Carried, not run by lane A. */
  affected: CommandLineSchema.optional(),
}).strict();

/** A source is named, never described: the connection (an org connection's id or label) holds the endpoint and the secret. */
export const MetaConfigSourceSchema = z.object({
  connection: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, "a connection is a name or id, never an address"),
  label: z.string().trim().min(1).max(80).optional(),
}).strict();

const recordOf = <Value extends z.ZodType>(value: Value) => z.record(AgentXNameSchema, value)
  .refine((entries) => Object.keys(entries).length <= META_CONFIG_MAX_REPOSITORIES + 1, "too many repositories named");

export const MetaProjectConfigSchema = z.object({
  version: z.literal(META_CONFIG_VERSION),
  repositories: z.array(MetaConfigRepositorySchema).max(META_CONFIG_MAX_REPOSITORIES).optional(),
  /** Per repository (by its name in this file, or the meta repo's own name): the commands that set a workspace up. */
  setup: recordOf(commandList).optional(),
  tests: recordOf(MetaConfigTestsSchema).optional(),
  checks: z.array(MetaConfigCheckSchema).max(META_CONFIG_MAX_CHECKS).optional(),
  knowledge: z.object({
    steering: knowledgePaths.optional(),
    skills: knowledgePaths.optional(),
    specs: knowledgePaths.optional(),
    runbooks: knowledgePaths.optional(),
    keyDocs: knowledgePaths.optional(),
  }).strict().optional(),
  /** Lane D: where a task's spec is written, and in which format (spec-target.ts). */
  specTarget: SpecTargetSchema.optional(),
  sources: z.array(MetaConfigSourceSchema).max(META_CONFIG_MAX_SOURCES).optional(),
  /** Meta repo lane F: the places work is asked for. Like everything in this file it is never applied directly; a maintainer approves turning an intake source on. */
  intake: z.array(IntakeChannelRefSchema).max(META_CONFIG_MAX_INTAKE).optional(),
}).strict().superRefine((config, context) => {
  const names = new Set<string>();
  for (const [index, repository] of (config.repositories ?? []).entries()) {
    if (names.has(repository.name)) context.addIssue({ code: "custom", path: ["repositories", index, "name"], message: "repository names must be unique" });
    names.add(repository.name);
  }
  const checks = new Set<string>();
  for (const [index, check] of (config.checks ?? []).entries()) {
    const key = check.name.toLowerCase();
    if (checks.has(key)) context.addIssue({ code: "custom", path: ["checks", index, "name"], message: "check names must be unique" });
    checks.add(key);
  }
  const connections = new Set<string>();
  for (const [index, source] of (config.sources ?? []).entries()) {
    const key = source.connection.toLowerCase();
    if (connections.has(key)) context.addIssue({ code: "custom", path: ["sources", index, "connection"], message: "a connection is listed once" });
    connections.add(key);
  }
});
export type MetaProjectConfig = z.infer<typeof MetaProjectConfigSchema>;

/**
 * Cross-checks that need to know the meta repo's own name (a file cannot say it): every repository that `setup`, `tests` or `checks` names must be one
 * the project will have (`alsoKnown`: repositories the project already has and the file does not list, when the file has no `repositories` section). Returns the
 * problems, empty when the config is consistent with the project.
 */
export function metaConfigReferenceProblems(config: MetaProjectConfig, metaRepositoryName: string, alsoKnown: readonly string[] = []): Array<{ path: string; message: string }> {
  const known = new Set<string>([metaRepositoryName, ...alsoKnown, ...(config.repositories ?? []).map((repository) => repository.name)]);
  const problems: Array<{ path: string; message: string }> = [];
  for (const section of ["setup", "tests"] as const) {
    for (const name of Object.keys(config[section] ?? {})) {
      if (!known.has(name)) problems.push({ path: `${section}.${safePathPart(name)}`, message: "names a repository this project does not have" });
    }
  }
  for (const [index, check] of (config.checks ?? []).entries()) {
    if (!known.has(check.repo)) problems.push({ path: `checks.${String(index)}.repo`, message: "names a repository this project does not have" });
  }
  if ((config.repositories ?? []).some((repository) => repository.name === metaRepositoryName)) {
    problems.push({ path: "repositories", message: "the meta repo is the repository the file is in; do not list it" });
  }
  return problems;
}

export interface MetaConfigProblem { path: string; message: string }

/** A key of a file made fit to be shown: only plain characters, cut short. Keys are the file's own words, never trusted as text. */
export function safePathPart(part: string | number | symbol): string {
  return String(part).replace(/[^A-Za-z0-9_-]/g, "?").slice(0, 40);
}

/**
 * The problems a failed parse reports: where (a path made of plain characters) and what is wrong (our own wording or a fixed zod message, never the value).
 * At most 20.
 */
export function metaConfigProblems(error: z.ZodError): MetaConfigProblem[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(safePathPart).join(".") || "(file)",
    message: issue.code === "unrecognized_keys" ? "has a setting this release does not know" : issue.message.slice(0, 200),
  }));
}

export type MetaConfigParse = { ok: true; config: MetaProjectConfig } | { ok: false; problems: MetaConfigProblem[] };

/** A `__proto__` key anywhere in the raw value (checked before parsing, because a record parse may drop it and so hide it). Depth-bounded. */
function hasProtoKey(value: unknown, depth = 0): boolean {
  if (depth > 12 || typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => hasProtoKey(item, depth + 1));
  return Object.keys(value).some((key) => key === "__proto__" || hasProtoKey((value as Record<string, unknown>)[key], depth + 1));
}

/** An already-parsed JSON or YAML value as a config. Never throws. */
export function parseMetaProjectConfig(value: unknown): MetaConfigParse {
  if (hasProtoKey(value)) return { ok: false, problems: [{ path: "(file)", message: "has a reserved key" }] };
  const parsed = MetaProjectConfigSchema.safeParse(value);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, problems: metaConfigProblems(parsed.error) };
}

/** JSON text as a config: refused above `META_CONFIG_MAX_BYTES` before it is read. (YAML is parsed by the broker, which has the parser, into the same value.) */
export function parseMetaProjectConfigJson(text: string): MetaConfigParse {
  if (new TextEncoder().encode(text).byteLength > META_CONFIG_MAX_BYTES) return { ok: false, problems: [{ path: "(file)", message: `the file is larger than ${String(META_CONFIG_MAX_BYTES)} bytes` }] };
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, problems: [{ path: "(file)", message: "the file is not valid JSON" }] };
  }
  return parseMetaProjectConfig(value);
}

const REPOSITORY_FULL_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const repositoryFullName = z.string().regex(REPOSITORY_FULL_NAME, "must be owner/name").refine((value) => !/\/(\.{1,2}|\.git)$/.test(value), "must be owner/name");

/**
 * `POST /v1/app/projects` with a `metaRepository`: a project that starts from a meta repo.
 *   - With `codeRepositories`: the meta repo is a separate repository and the others are the code (1 to 31).
 *   - Without: one repository that acts as its own meta repo (config in `.rovara/`, knowledge in its own rule files). A person may later move to a separate
 *     meta repo.
 * The setup agent and the config file propose everything else; creation only records which repositories there are.
 */
export const CreateProjectFromMetaBodySchema = z.object({
  requestId: z.string().uuid(),
  metaRepository: repositoryFullName,
  codeRepositories: z.array(repositoryFullName).min(1).max(META_CONFIG_MAX_REPOSITORIES).optional(),
  name: AgentXNameSchema.optional(),
  description: z.string().max(280).optional(),
}).strict().superRefine((body, context) => {
  const seen = new Set<string>([body.metaRepository.toLowerCase()]);
  for (const [index, repository] of (body.codeRepositories ?? []).entries()) {
    if (seen.has(repository.toLowerCase())) context.addIssue({ code: "custom", path: ["codeRepositories", index], message: "is listed twice or is the meta repository" });
    seen.add(repository.toLowerCase());
  }
});
export type CreateProjectFromMetaBody = z.infer<typeof CreateProjectFromMetaBodySchema>;

/** Whether a request body asks for a project from a meta repo (the route picks this body or the single-repository one). */
export function isCreateFromMetaBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) && Object.hasOwn(body, "metaRepository");
}

/**
 * The meta repository a worker brings into the workspace beside the code (lane A, task A3). The prepare payload carries it next to the project, which no longer lists a meta
 * repository that is not also code. `repository` is the minimum a clone needs (never the installation pins); `paths` are the knowledge files and folders to materialize, read-only, at the
 * default branch's head. Sent only to a worker that lists `prepare.metaRepo`.
 */
export const PrepareMetaSchema = z.object({
  repository: z.object({
    name: AgentXNameSchema,
    url: ConfigRepositoryUrlSchema,
    path: RelativeWorkspacePathSchema,
    defaultBranch: GitBranchNameSchema,
    credentialRef: AgentXNameSchema,
  }).strict(),
  paths: z.array(KnowledgePathSchema).min(1).max(64).refine((paths) => new Set(paths).size === paths.length, "paths must be unique"),
  /**
   * The commit to read: the meta repository's default-branch head, as the BROKER read it from GitHub when it built this invocation. The worker materializes exactly this commit
   * (and refuses if its clone does not hold it or it is not on the default branch), so a task's `knowledgeCommit` is never the worker's own choice.
   */
  commit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type PrepareMeta = z.infer<typeof PrepareMetaSchema>;

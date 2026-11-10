import { z } from "zod";
import { redactText } from "./redaction.js";
import { AgentXNameSchema } from "./names.js";
import { RelativeWorkspacePathSchema, ProjectCommandSchema, DeveloperShareModeSchema } from "./project.js";
import { StoredAllowedDomainSchema, firstRefusedDomainIndex, ALLOWED_DOMAIN_MESSAGE } from "./app-projects.js";
import { ProjectModelsSchema } from "./models-node.js";
import { GitHubMcpPolicySchema, type GitHubMcpPolicy } from "./github-mcp.js";
import { ActionPolicySchema, actionPolicyProblems } from "./action-policy-node.js";
import { E2EPolicySchema } from "./e2e-node.js";
import { ConnectorsSchema, StoredConnectorsSchema, type GitHubConnectorConfig } from "./connectors-node.js";
import { E2E_PROJECT_CHECK_ID } from "./e2e.js";
import { SettingOriginSchema, type SettingOrigin } from "./provenance.js";
import { SpecTargetSchema } from "./spec-target.js";
import { ExternalIdSchema, PluginKindSchema } from "./plugins/common.js";
import { ProjectRegistriesSchema } from "./project-registries.js";

export const OCI_DIGEST_PATTERN = /@sha256:[a-f0-9]{64}$/;

import { GitBranchNameSchema } from "./git-branch.js";
export { GitBranchNameSchema } from "./git-branch.js";

const HttpsOrLoopbackUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    context.addIssue({ code: "custom", message: "URL must use HTTPS (loopback HTTP is test-only)" });
  }
});

/**
 * Names a registration may not put in a command's `env` (#54), compared in upper case. The worker
 * sets or relies on them (Git's safe directory, AWS access, the agent shell's PI_* variables), or
 * they change how a process is found, loaded or started. PATH is refused too: put tools at a full
 * path, or set PATH in the devcontainer's own configuration.
 */
const RESERVED_ENV_NAMES = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "IFS", "ENV", "BASH_ENV"]);

const RESERVED_ENV_PREFIXES = ["AGENTX_", "AWS_", "GIT_", "LD_", "DYLD_", "PI_"];

/** A name whose last word is one of these looks like a credential. */
const CREDENTIAL_ENV_LAST_WORDS = new Set([
  "TOKEN", "TOKENS", "SECRET", "SECRETS", "PASSWORD", "PASSWD", "PASS", "PWD",
  "CREDENTIAL", "CREDENTIALS", "CREDS", "APIKEY",
]);

/** So does a name with one of these word pairs anywhere, or ending in one of these words. */
const CREDENTIAL_ENV_PAIRS = ["API_KEY", "PRIVATE_KEY", "ACCESS_KEY", "SECRET_KEY"];

const CREDENTIAL_ENV_SUFFIXES = ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "APIKEY"];

/** A URL with a user and password in it, such as postgres://user:password@host. */
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]*@/i;

function reservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_ENV_NAMES.has(upper) || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function credentialEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  const words = upper.split("_");
  return CREDENTIAL_ENV_LAST_WORDS.has(words.at(-1) ?? "")
    || CREDENTIAL_ENV_PAIRS.some((pair) => `_${upper}_`.includes(`_${pair}_`))
    || CREDENTIAL_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

function secretEnvValue(value: string): boolean {
  return URL_WITH_PASSWORD.test(value) || redactText(value) !== value;
}

/**
 * What registration refuses in a command's `env` (#54): names AgentX, the worker or the system rely
 * on, and names or values that look like credentials. Only `ProjectDefinitionSchema` applies it, so
 * a later, stricter rule never stops a stored revision from being read. Messages name a variable,
 * never its value.
 */
export function projectCommandEnvProblems(env: Readonly<Record<string, string>>): Array<{ name: string; message: string }> {
  const problems: Array<{ name: string; message: string }> = [];
  for (const [name, value] of Object.entries(env)) {
    if (reservedEnvName(name)) {
      problems.push({ name, message: `env name ${name} is reserved for AgentX, the worker or the system` });
    } else if (credentialEnvName(name)) {
      problems.push({ name, message: `env name ${name} looks like a credential; env is not for secrets, use a credential reference` });
    } else if (secretEnvValue(value)) {
      problems.push({ name, message: `env value of ${name} looks like a secret; env is not for secrets, use a credential reference` });
    }
  }
  return problems;
}

export const CodeBuildGateDefinitionSchema = z
  .object({
    name: AgentXNameSchema,
    projectName: z
      .string()
      .min(2)
      .max(255)
      .regex(/^agentx-[A-Za-z0-9_-]+$/, "CodeBuild projectName must begin with agentx-"),
    timeoutMinutes: z.number().int().min(5).max(420),
  })
  .strict();

/**
 * Plug-in foundations, task P7: where a repository lives, by plug-in kind. A GitHub host carries the installation and the immutable repository id that
 * `installationId` / `githubRepositoryId` carried at the top of the record (both stay readable for one release: see `repositoryHostOf`). Any other kind
 * is a plug-in registered by its adapter; it carries one opaque reference of its own. Control-plane only, like the pins: a worker never reads it.
 */
export const RepositoryHostSchema = z.union([
  z.object({ kind: z.literal("github"), installationId: z.number().int().positive().optional(), repositoryId: z.number().int().positive().optional() }).strict(),
  z.object({ kind: PluginKindSchema.refine((kind) => kind !== "github", "github is the other variant"), ref: ExternalIdSchema.optional() }).strict(),
]);
export type RepositoryHost = z.infer<typeof RepositoryHostSchema>;

export const RepositoryDefinitionSchema = z
  .object({
    name: AgentXNameSchema,
    url: HttpsOrLoopbackUrlSchema,
    path: RelativeWorkspacePathSchema,
    defaultBranch: GitBranchNameSchema,
    credentialRef: AgentXNameSchema,
    codeBuildGates: z.array(CodeBuildGateDefinitionSchema).max(8).optional(),
    /**
     * a hosted install (Plan 2, Tasks 15 and 16): the GitHub installation, and the repository's immutable GitHub id, the project was registered
     * against. When set, a task start refuses the project if the repository is now reached through another installation, so a transferred
     * repository cannot quietly change installation. Control-plane only: a worker never reads either (`workerProjectDefinition`).
     */
    installationId: z.number().int().positive().optional(),
    githubRepositoryId: z.number().int().positive().optional(),
    /**
     * Meta repo lane A: what the repository is to the project. Absent means `code`, as every repository of a project that predates it. The one `meta` repository holds
     * the project's config and knowledge (see `metaRepositoryOf`). `alsoCode` marks a one-repository project whose only repository is its own meta repo.
     * Control-plane only, like the pins above: a worker never reads either (`workerProjectDefinition`).
     */
    role: z.enum(["code", "meta"]).optional(),
    alsoCode: z.boolean().optional(),
    /** P7: the code host this repository lives on. Absent means GitHub, as every repository that predates it (`repositoryHostOf`). */
    host: RepositoryHostSchema.optional(),
  })
  .strict()
  .superRefine((repository, context) => {
    // Dual read: while both spellings exist they must agree, so a record can never say two things about where its repository lives.
    if (repository.host !== undefined) {
      const host: { kind: string; installationId?: number | undefined; repositoryId?: number | undefined } = repository.host;
      if (host.kind !== "github") {
        for (const field of ["installationId", "githubRepositoryId"] as const) {
          if (repository[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: "a repository on another code host has no GitHub pins" });
        }
      } else {
        if (repository.installationId !== undefined && host.installationId !== repository.installationId) {
          context.addIssue({ code: "custom", path: ["installationId"], message: "installationId must match host.installationId" });
        }
        if (repository.githubRepositoryId !== undefined && host.repositoryId !== repository.githubRepositoryId) {
          context.addIssue({ code: "custom", path: ["githubRepositoryId"], message: "githubRepositoryId must match host.repositoryId" });
        }
      }
    }
    if (repository.alsoCode !== undefined && repository.role !== "meta") {
      context.addIssue({ code: "custom", path: ["alsoCode"], message: "alsoCode is only for the meta repository" });
    }
    const names = new Set<string>();
    const projects = new Set<string>();
    for (const [index, gate] of (repository.codeBuildGates ?? []).entries()) {
      if (names.has(gate.name)) {
        context.addIssue({
          code: "custom",
          path: ["codeBuildGates", index, "name"],
          message: "CodeBuild gate names must be unique",
        });
      }
      if (projects.has(gate.projectName)) {
        context.addIssue({
          code: "custom",
          path: ["codeBuildGates", index, "projectName"],
          message: "CodeBuild projects must be unique within a repository",
        });
      }
      names.add(gate.name);
      projects.add(gate.projectName);
    }
    const totalTimeout = (repository.codeBuildGates ?? [])
      .reduce((total, gate) => total + gate.timeoutMinutes, 0);
    if (totalTimeout > 420) {
      context.addIssue({
        code: "custom",
        path: ["codeBuildGates"],
        message: "total CodeBuild gate timeout must not exceed 420 minutes",
      });
    }
  });

/**
 * The development container a project's commands run in (#121): `setup`, `readiness` and the
 * agent's shell. `configPath` is relative to the repository and defaults to
 * `.devcontainer/devcontainer.json`. Only EC2 workers can run one; registration refuses it on
 * other deployment modes.
 */
export const DevcontainerDefinitionSchema = z
  .object({
    repository: AgentXNameSchema,
    configPath: RelativeWorkspacePathSchema.optional(),
  })
  .strict();

/**
 * The websites a project's machines may reach beyond the install-wide defaults (Plan 2, Task 17). The revision stores what a maintainer
 * asked for; whether each is approved is the egress item's to say (Task 18). Control-plane only: a worker never reads it, so the broker
 * leaves it out of every invocation (`workerProjectDefinition`), and a worker of an earlier release, whose definition is strict, still parses one.
 * Only the shape of a domain is checked here, so a stored revision stays readable when the Public Suffix List is refreshed; the list is
 * checked wherever a definition is written (`ProjectDefinitionSchema`).
 */
export const ProjectNetworkSchema = z.object({ allowedDomains: z.array(StoredAllowedDomainSchema).max(50) }).strict();

export type ProjectNetwork = z.infer<typeof ProjectNetworkSchema>;

export const DEFAULT_DEVCONTAINER_CONFIG_PATH = ".devcontainer/devcontainer.json";

/**
 * Fields the project definition carried while AgentX had a local client. `schemaVersion` marked a
 * file format, `controlPlaneUrl` and `auth` told that client where to connect, and
 * `environment.image` pinned nothing: the runtime runs the image the release deployed. Definitions
 * registered before they were removed still contain them, so readers drop them and registration
 * refuses them.
 */
export const LEGACY_PROJECT_FIELDS = ["schemaVersion", "controlPlaneUrl", "auth", "environment"] as const;

export const WorkflowOptionalCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(80),
  command: ProjectCommandSchema,
}).strict();

export type WorkflowOptionalCheck = z.infer<typeof WorkflowOptionalCheckSchema>;

/** Spec 025 FR-014: how a project treats tasks started from an AI tool. Part of the revision. */
export const DeveloperTaskPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    share: z.enum(["optional", "required"]).default("optional"),
    shareMode: z
      .object({
        default: DeveloperShareModeSchema.default("view"),
        allowContinue: z.boolean().default(true),
      })
      .strict()
      .default({ default: "view", allowContinue: true }),
    channelMembersMayUse: z.boolean().default(true),
    /** Project-approved extra checks task owners may select for the native workflow. */
    optionalWorkflowChecks: z.array(WorkflowOptionalCheckSchema).max(20).optional(),
    /**
     * M1.3 Task 3.7b (owner decision D2): the informational baseline round, the approved browser and API scenarios run once on the unchanged code when a plan is approved. On unless
     * this is false. It lives here, not in the E2E policy, because that policy is bound by digest to the approved setup, and a switch that needed the setup approved again would not be one.
     */
    e2eBaselineRound: z.boolean().optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    const ids = new Set<string>();
    for (const [index, check] of (policy.optionalWorkflowChecks ?? []).entries()) {
      if (ids.has(check.id)) context.addIssue({ code: "custom", path: ["optionalWorkflowChecks", index, "id"], message: "optional workflow check IDs must be unique" });
      ids.add(check.id);
    }
  });

export type DeveloperTaskPolicy = z.output<typeof DeveloperTaskPolicySchema>;

export const DEFAULT_DEVELOPER_TASK_POLICY: DeveloperTaskPolicy = DeveloperTaskPolicySchema.parse({});

/**
 * The policy a stored definition carries, or the defaults when it has none. A value that no longer
 * parses turns tasks and channel access off, so a damaged record never widens access.
 */
export function developerTaskPolicy(definition: { developerTasks?: unknown }): DeveloperTaskPolicy {
  // Only a missing value takes the defaults; a stored null is damaged and fails closed.
  const parsed = DeveloperTaskPolicySchema.safeParse(definition.developerTasks === undefined ? {} : definition.developerTasks);
  return parsed.success ? parsed.data : { ...DEFAULT_DEVELOPER_TASK_POLICY, enabled: false, channelMembersMayUse: false };
}

/** The settings a person, an agent or a meta repo's config file can set, by the name the project record gives them (see `ProjectOriginsSchema`). */
export const PROJECT_ORIGIN_FIELDS = ["repositories", "setup", "readiness", "devcontainer", "network", "checks", "knowledge", "specTarget", "sources", "intake"] as const;
export type ProjectOriginField = (typeof PROJECT_ORIGIN_FIELDS)[number];

/**
 * Meta repo lane A: who last set each setting. A field with no entry was set by a person (a project that predates origins). Control-plane only
 * (`workerProjectDefinition` leaves it out). Only fields that were set by an agent or a file are worth an entry; a person's edit removes the entry.
 */
export const ProjectOriginsSchema = z.partialRecord(z.enum(PROJECT_ORIGIN_FIELDS), SettingOriginSchema);
export type ProjectOrigins = z.infer<typeof ProjectOriginsSchema>;

function projectDefinitionObject<Connectors extends z.ZodTypeAny>(connectorsSchema: Connectors) {
  return z
    .object({
      name: AgentXNameSchema,
      revision: z.number().int().positive(),
      repositories: z.array(RepositoryDefinitionSchema).min(1).max(32),
      setup: z.array(ProjectCommandSchema).max(64),
      readiness: z.array(ProjectCommandSchema).max(64),
      devcontainer: DevcontainerDefinitionSchema.optional(),
      network: ProjectNetworkSchema.optional(),
      /** N9 (INTG2): the project's private package registries. Where they are and which credential reference reaches them, never a token. Control-plane only (`workerProjectDefinition`). */
      registries: ProjectRegistriesSchema.optional(),
      orchestratorInstructions: z.string().min(1).max(32_768),
      models: ProjectModelsSchema.optional(),
      integrations: z.object({
        githubMcp: GitHubMcpPolicySchema.optional(),
        connectors: connectorsSchema.optional(),
      }).strict().optional(),
      actionPolicy: ActionPolicySchema.optional(),
      developerTasks: DeveloperTaskPolicySchema.optional(),
      /** Optional trusted-scenario policy. Absence preserves the legacy workflow. */
      e2e: E2EPolicySchema.optional(),
      /** K1 lane D: where this project's specs are written (spec-target.ts). Absent: no spec is written. */
      specTarget: SpecTargetSchema.optional(),
      origins: ProjectOriginsSchema.optional(),
    })
    .strict();
}

/**
 * Shared by `ProjectDefinitionSchema` and `StoredProjectDefinitionSchema`. A connector's `scopes`
 * is checked against registered repository names only for a `github` entry: an entry of a type
 * this release's schema does not know (from `StoredConnectorsSchema`'s passthrough branch) may
 * carry any shape there, which this release does not interpret.
 */
function checkProjectDefinition(
  project: {
    repositories: ReadonlyArray<{ name: string; path: string; role?: "code" | "meta" | undefined; alsoCode?: boolean | undefined }>;
    devcontainer?: { repository: string } | undefined;
    integrations?: {
      githubMcp?: unknown;
      connectors?: ReadonlyArray<{ name: string; type: string; scopes?: unknown }> | undefined;
    } | undefined;
  },
  context: z.RefinementCtx,
): void {
  const names = new Set<string>();
  for (const [index, repository] of project.repositories.entries()) {
    if (names.has(repository.name)) {
      context.addIssue({
        code: "custom",
        path: ["repositories", index, "name"],
        message: "repository names must be unique",
      });
    }
    names.add(repository.name);
  }
  const paths = project.repositories.map((repository) => repository.path).sort();
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1];
    const current = paths[index];
    if (previous && current && (current === previous || current.startsWith(`${previous}/`))) {
      context.addIssue({ code: "custom", path: ["repositories"], message: "repository paths overlap" });
    }
  }
  if (project.devcontainer && !names.has(project.devcontainer.repository)) {
    context.addIssue({ code: "custom", path: ["devcontainer", "repository"], message: `devcontainer names unregistered repository ${project.devcontainer.repository}` });
  }
  // Meta repo lane A: at most one meta repository (a project that predates meta repos has none). A meta repository that is not also code needs a code
  // repository beside it; one that is also code is the whole project. The devcontainer runs code, so it never names a pure meta repository.
  const metas = project.repositories.map((repository, index) => ({ repository, index })).filter(({ repository }) => repository.role === "meta");
  if (metas.length > 1) {
    context.addIssue({ code: "custom", path: ["repositories", metas[1]!.index, "role"], message: "a project has at most one meta repository" });
  }
  const meta = metas[0]?.repository;
  if (meta !== undefined) {
    if (meta.alsoCode === true && project.repositories.length !== 1) {
      context.addIssue({ code: "custom", path: ["repositories", metas[0]!.index, "alsoCode"], message: "a repository that is both meta and code must be the project's only repository; make the meta repository a separate one first" });
    }
    if (meta.alsoCode !== true && project.repositories.length < 2) {
      context.addIssue({ code: "custom", path: ["repositories"], message: "a meta repository that is not also code needs at least one code repository" });
    }
    if (meta.alsoCode !== true && project.devcontainer?.repository === meta.name) {
      context.addIssue({ code: "custom", path: ["devcontainer", "repository"], message: "the devcontainer cannot be in a meta repository that is not also code" });
    }
  }
  if (project.integrations?.githubMcp && project.integrations.connectors) {
    context.addIssue({ code: "custom", path: ["integrations"], message: "use either integrations.githubMcp or integrations.connectors, not both" });
  }
  for (const connector of project.integrations?.connectors ?? []) {
    if (connector.type !== "github") continue;
    const scopes = connector.scopes;
    if (scopes === "all-repositories") continue;
    for (const name of scopes as string[]) {
      if (!names.has(name)) {
        context.addIssue({ code: "custom", path: ["integrations", "connectors"], message: `connector ${connector.name} scopes unregistered repository ${name}` });
      }
    }
  }
}

export const ProjectDefinitionSchema = projectDefinitionObject(ConnectorsSchema)
  .superRefine(checkProjectDefinition)
  .superRefine((project, context) => {
    if ((project.e2e?.targets ?? []).some((target) => target.targetId === E2E_PROJECT_CHECK_ID)) {
      context.addIssue({ code: "custom", path: ["e2e", "targets"], message: "project-e2e is a reserved check identity, not a target ID" });
    }
  })
  // P7 / Opus review I5: this release READS a repository's `host` (a record written by a later release, or by the lazy rewrite in a later release) but does not WRITE one. Two reasons:
  // the release before this one parses a repository strictly and would refuse the whole project, so a rollback would take it dark; and nothing routes by `host` yet, so a save that
  // said a repository lives elsewhere would still be cloned and pushed through GitHub. A later release turns writes on, for the kinds an install has registered.
  .superRefine((project, context) => {
    project.repositories.forEach((repository, index) => {
      if (repository.host !== undefined) context.addIssue({ code: "custom", path: ["repositories", index, "host"], message: "a repository's code host is not set by this release; leave host out" });
    });
  })
  // Registration and settings saves: the Public Suffix List is consulted when a domain is written, never when a stored revision is read.
  .superRefine((project, context) => {
    const index = firstRefusedDomainIndex(project.network?.allowedDomains ?? []);
    if (index !== undefined) context.addIssue({ code: "custom", path: ["network", "allowedDomains", index], message: ALLOWED_DOMAIN_MESSAGE });
  })
  // Runs wherever ProjectDefinitionSchema parses a project: registration, the developer CLI's
  // local project-file check, and the local broker. A stored revision is read with
  // StoredProjectDefinitionSchema, which does not re-check.
  .superRefine((project, context) => {
    for (const message of actionPolicyProblems(project)) context.addIssue({ code: "custom", path: ["actionPolicy"], message });
  })
  // Registration only (#54): a stored revision is read without these name and value rules.
  .superRefine((project, context) => {
    for (const stage of ["setup", "readiness"] as const) {
      for (const [index, command] of project[stage].entries()) {
        for (const { name, message } of projectCommandEnvProblems(command.env ?? {})) {
          context.addIssue({ code: "custom", path: [stage, index, "env", name], message });
        }
      }
    }
  });

/**
 * A project definition already on record: an `integrations.connectors` entry of a type this
 * release's schema does not know (for example one written by a later control plane, before a
 * rollback) passes through as `{name, type, ...}` instead of failing the parse. A `github` entry
 * still validates exactly as strictly as `ProjectDefinitionSchema` does. Registration always uses
 * `ProjectDefinitionSchema`, which keeps refusing an unknown connector type.
 */
const StoredProjectDefinitionObjectSchema = projectDefinitionObject(StoredConnectorsSchema).superRefine(checkProjectDefinition);

/** Parses a definition that may predate the removal of {@link LEGACY_PROJECT_FIELDS}, and that may
 * carry a connector of a type this release does not know (see `StoredConnectorsSchema`). */
export const StoredProjectDefinitionSchema = z.preprocess(
  (value) => withoutFields(value, LEGACY_PROJECT_FIELDS),
  StoredProjectDefinitionObjectSchema,
);

/** The legacy fields a value carries, so a caller can name them in its own error. */
export function legacyProjectFields(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return LEGACY_PROJECT_FIELDS.filter((field) => Object.hasOwn(value, field));
}

function withoutFields(value: unknown, fields: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const remaining: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of fields) delete remaining[field];
  return remaining;
}

export type ProjectDefinition = z.infer<typeof ProjectDefinitionSchema>;

/**
 * A project definition as a worker is sent it: without `network`, and without any repository's `installationId` and `githubRepositoryId`.
 * Workers of an earlier release parse the definition with a strict schema that does not know the fields, and they are the control plane's
 * alone (the DNS firewall enforces `network`, the broker's start check the pins).
 * `includeMeta` keeps a meta repository that is not also code, for the one run that reads it whole (the setup draft).
 */
export function workerProjectDefinition<Definition extends object>(definition: Definition, options: { includeMeta?: boolean } = {}): Omit<Definition, "network" | "origins" | "specTarget" | "registries"> {
  const rest: Record<string, unknown> = { ...(definition as Record<string, unknown>) };
  delete rest.network;
  // N9: the registries reach a worker as the prepare payload's `registries` (where, never how), only if it lists `prepare.registries.v1`; an earlier worker's strict schema does not know the field.
  delete rest.registries;
  // Meta repo lane A: who set each setting is the control plane's too.
  delete rest.origins;
  // Lane D: where specs are written is the control plane's (the broker renders and publishes them); an earlier worker's strict schema does not know it.
  delete rest.specTarget;
  // The same for the repository pins (`installationId`, `githubRepositoryId`) and the meta role: the repository entry of an earlier worker is strict too.
  if (Array.isArray(rest.repositories)) {
    rest.repositories = rest.repositories
      // A meta repository that is not also code is not code to a worker: it is never cloned as a checkout, changed or published. A worker that can read one is
      // sent it beside the project (the prepare payload's `meta`, lane A task A3).
      // `includeMeta`: a setup draft reads the meta repository in full, as an ordinary read-only checkout (it has no `meta` request), so its knowledge and citations are there.
      .filter((entry: unknown) => options.includeMeta === true || !(isPureMetaRepository(entry)))
      .map((entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const repository: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
        delete repository.installationId;
        delete repository.githubRepositoryId;
        delete repository.host;
        delete repository.role;
        delete repository.alsoCode;
        return repository;
      });
  }
  return rest as Omit<Definition, "network" | "origins" | "specTarget" | "registries">;
}

function isPureMetaRepository(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const repository = entry as { role?: unknown; alsoCode?: unknown };
  return repository.role === "meta" && repository.alsoCode !== true;
}

/** A project definition as `StoredProjectDefinitionSchema` parses it: its connectors may include
 * an entry of a type this release's schema does not know, passed through unexamined. */
export type StoredProjectDefinition = z.infer<typeof StoredProjectDefinitionSchema>;

export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;

export type DevcontainerDefinition = z.infer<typeof DevcontainerDefinitionSchema>;

export type CodeBuildGateDefinition = z.infer<typeof CodeBuildGateDefinitionSchema>;

export type RepositoryDefinition = z.infer<typeof RepositoryDefinitionSchema>;

/**
 * P7 dual read: the host of a repository record. The explicit `host` wins; a record without one (every record written before P7) is a GitHub repository with
 * the pins it carried. Never throws, never returns a kind the record did not name or imply.
 */
export function repositoryHostOf(repository: Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">): RepositoryHost {
  if (repository.host !== undefined) return repository.host;
  return {
    kind: "github",
    ...(repository.installationId === undefined ? {} : { installationId: repository.installationId }),
    ...(repository.githubRepositoryId === undefined ? {} : { repositoryId: repository.githubRepositoryId }),
  };
}

/**
 * The lazy rewrite of a record on its way to storage. A GitHub repository is NOT given a `host` in this release: its old pins say the same thing, the release before this one reads only
 * those, and a rewrite that added `host` would make the project unreadable after a rollback (the exact step if a later release has written it: save the project again with this
 * release, which drops `host`). So this returns the record unchanged; it exists so the day writes are turned on there is one place that decides, and a test that fails if it starts writing early.
 */
export function withRepositoryHost<Repository extends Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">>(repository: Repository): Repository {
  return repository;
}

export interface ResolvedGitHubConnector {
  name: string;
  repositories: RepositoryDefinition[];
  policy: GitHubMcpPolicy;
  attribution: boolean;
}

/**
 * The project's GitHub connector from either configuration form. Definitions registered with the
 * feature 007 `githubMcp` policy read as a connector named `github` over every repository.
 */
export function githubConnectorOf(project: Pick<ProjectDefinition, "repositories" | "integrations">): ResolvedGitHubConnector | undefined {
  const legacy = project.integrations?.githubMcp;
  if (legacy) return { name: "github", repositories: project.repositories, policy: legacy, attribution: true };
  const connector = project.integrations?.connectors?.find((entry): entry is GitHubConnectorConfig => entry.type === "github");
  if (!connector) return undefined;
  const scopes = connector.scopes;
  const repositories = scopes === "all-repositories"
    ? project.repositories
    : project.repositories.filter((repository) => scopes.includes(repository.name));
  return { name: connector.name, repositories, policy: { tools: connector.tools }, attribution: connector.attribution ?? true };
}

/** How a project relates to its meta repo: `separate` (a meta repository beside the code), `self` (its one repository is its own meta repo), `none` (a project that predates meta repos). */
export type ProjectMetaShape = "separate" | "self" | "none";

type RepositoryRoleFields = { role?: "code" | "meta" | undefined; alsoCode?: boolean | undefined };

/** The project's meta repository, or undefined when it has none. */
export function metaRepositoryOf<Repository extends RepositoryRoleFields>(project: { repositories: readonly Repository[] }): Repository | undefined {
  return project.repositories.find((repository) => repository.role === "meta");
}

export function projectMetaShape(project: { repositories: readonly RepositoryRoleFields[] }): ProjectMetaShape {
  const meta = metaRepositoryOf(project);
  if (meta === undefined) return "none";
  return meta.alsoCode === true ? "self" : "separate";
}

/** The repositories that hold code: every one but a meta repository that is not also code. */
export function codeRepositoriesOf<Repository extends RepositoryRoleFields>(project: { repositories: readonly Repository[] }): Repository[] {
  return project.repositories.filter((repository) => repository.role !== "meta" || repository.alsoCode === true);
}

/** Who last set a setting: a field with no entry was set by a person. */
export function settingOriginOf(project: { origins?: ProjectOrigins | undefined }, field: ProjectOriginField): SettingOrigin {
  return project.origins?.[field] ?? "person";
}

/** The settings a meta repo's config file manages (read-only in the app; changed by changing the file). */
export function fileManagedFields(project: { origins?: ProjectOrigins | undefined }): ProjectOriginField[] {
  return PROJECT_ORIGIN_FIELDS.filter((field) => project.origins?.[field] === "file");
}

/**
 * The origins after `fields` were set by `origin`. A person's edit removes the entry (no entry means a person), so the record only holds what an agent or a
 * file set; an empty record is left out.
 */
export function withSettingOrigins(origins: ProjectOrigins | undefined, fields: readonly ProjectOriginField[], origin: SettingOrigin): ProjectOrigins | undefined {
  const next: Record<string, SettingOrigin> = { ...(origins ?? {}) };
  for (const field of fields) {
    if (origin === "person") delete next[field];
    else next[field] = origin;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

export { AGENTX_NAME_PATTERN } from "./names.js";

export { AgentXNameSchema } from "./names.js";

export { RelativeWorkspacePathSchema, PROJECT_COMMAND_ENV_MAX_ENTRIES, PROJECT_COMMAND_ENV_VALUE_MAX, PROJECT_COMMAND_ENV_TOTAL_MAX_BYTES, ENV_NAME_PATTERN, ProjectCommandEnvSchema, ProjectCommandSchema, DeveloperShareModeSchema } from "./project.js";

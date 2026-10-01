import { posix } from "node:path";
import { z } from "zod";
import { ActionPolicySchema, actionPolicyProblems } from "./action-policy.js";
import { GitHubMcpPolicySchema } from "./github-mcp.js";
import { ConnectorsSchema, StoredConnectorsSchema } from "./connectors.js";
import type { GitHubConnectorConfig } from "./connectors.js";
import type { GitHubMcpPolicy } from "./github-mcp.js";
import { ProjectModelsSchema } from "./models.js";
import { redactText } from "./redaction.js";

import { AGENTX_NAME_PATTERN } from "./names.js";

export { AGENTX_NAME_PATTERN };
export const OCI_DIGEST_PATTERN = /@sha256:[a-f0-9]{64}$/;

export const AgentXNameSchema = z.string().regex(AGENTX_NAME_PATTERN);

export const GitBranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "defaultBranch contains unsupported characters")
  .superRefine((value, context) => {
    const segments = value.split("/");
    if (
      value === "@" ||
      value.endsWith(".") ||
      value.endsWith("/") ||
      value.includes("..") ||
      value.includes("//") ||
      value.includes("@{") ||
      segments.some(
        (segment) => segment.startsWith(".") || segment === ".." || segment.endsWith(".lock"),
      )
    ) {
      context.addIssue({ code: "custom", message: "defaultBranch is not a safe Git branch name" });
    }
  });

export const RelativeWorkspacePathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, context) => {
    if (value.startsWith("/") || value.includes("\\")) {
      context.addIssue({ code: "custom", message: "path must be relative POSIX syntax" });
      return;
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      context.addIssue({ code: "custom", message: "path cannot contain empty, . or .. segments" });
      return;
    }
    if (posix.normalize(value) !== value) {
      context.addIssue({ code: "custom", message: "path must already be normalized" });
    }
  });

const HttpsOrLoopbackUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    context.addIssue({ code: "custom", message: "URL must use HTTPS (loopback HTTP is test-only)" });
  }
});

export const PROJECT_COMMAND_ENV_MAX_ENTRIES = 64;
export const PROJECT_COMMAND_ENV_VALUE_MAX = 4_096;
export const PROJECT_COMMAND_ENV_TOTAL_MAX_BYTES = 32_768;

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
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/**
 * Environment variables for one project command (#54): the structure only, which stored revisions
 * and worker payloads are held to as well. Values are plain configuration, not secrets: a revision
 * is stored and shown in full, so a secret belongs in a credential reference. Messages here name a
 * variable, never its value.
 */
export const ProjectCommandEnvSchema = z
  .unknown()
  // zod drops a __proto__ key from a record without an error; refuse it instead.
  .superRefine((raw, context) => {
    if (raw !== null && typeof raw === "object" && Object.hasOwn(raw, "__proto__")) {
      context.addIssue({ code: "custom", path: ["__proto__"], message: "env names must be POSIX environment variable names" });
    }
  })
  .pipe(z
    .record(
      z.string(),
      z.string()
        .max(PROJECT_COMMAND_ENV_VALUE_MAX, `env values must be at most ${PROJECT_COMMAND_ENV_VALUE_MAX.toLocaleString("en-US")} characters`)
        .refine((value) => !value.includes("\u0000"), "env values cannot contain a NUL byte"),
    )
    .superRefine((env, context) => {
      const names = Object.keys(env);
      if (names.length > PROJECT_COMMAND_ENV_MAX_ENTRIES) {
        context.addIssue({ code: "custom", message: `env may have at most ${PROJECT_COMMAND_ENV_MAX_ENTRIES} entries` });
      }
      let bytes = 0;
      for (const name of names) {
        if (name.length > 128 || !ENV_NAME_PATTERN.test(name)) {
          context.addIssue({ code: "custom", path: [name], message: "env names must be POSIX environment variable names" });
        }
        bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(env[name] ?? "", "utf8") + 2;
      }
      if (bytes > PROJECT_COMMAND_ENV_TOTAL_MAX_BYTES) {
        context.addIssue({ code: "custom", message: `env is larger than ${PROJECT_COMMAND_ENV_TOTAL_MAX_BYTES.toLocaleString("en-US")} bytes` });
      }
    }));

export const ProjectCommandSchema = z
  .object({
    cwd: RelativeWorkspacePathSchema,
    executable: z.string().min(1).max(256),
    args: z.array(z.string().max(8_192)).max(256),
    timeoutSeconds: z.number().int().positive().max(86_400),
    /** Variables for this command only (#54). Not for secrets; see ProjectCommandEnvSchema. */
    env: ProjectCommandEnvSchema.optional(),
  })
  .strict();

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

export const RepositoryDefinitionSchema = z
  .object({
    name: AgentXNameSchema,
    url: HttpsOrLoopbackUrlSchema,
    path: RelativeWorkspacePathSchema,
    defaultBranch: GitBranchNameSchema,
    credentialRef: AgentXNameSchema,
    codeBuildGates: z.array(CodeBuildGateDefinitionSchema).max(8).optional(),
  })
  .strict()
  .superRefine((repository, context) => {
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

export const DEFAULT_DEVCONTAINER_CONFIG_PATH = ".devcontainer/devcontainer.json";

/**
 * Fields the project definition carried while AgentX had a local client. `schemaVersion` marked a
 * file format, `controlPlaneUrl` and `auth` told that client where to connect, and
 * `environment.image` pinned nothing: the runtime runs the image the release deployed. Definitions
 * registered before they were removed still contain them, so readers drop them and registration
 * refuses them.
 */
export const LEGACY_PROJECT_FIELDS = ["schemaVersion", "controlPlaneUrl", "auth", "environment"] as const;

export const DeveloperShareModeSchema = z.enum(["view", "continue"]);

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
  })
  .strict();
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

function projectDefinitionObject<Connectors extends z.ZodTypeAny>(connectorsSchema: Connectors) {
  return z
    .object({
      name: AgentXNameSchema,
      revision: z.number().int().positive(),
      repositories: z.array(RepositoryDefinitionSchema).min(1).max(32),
      setup: z.array(ProjectCommandSchema).max(64),
      readiness: z.array(ProjectCommandSchema).max(64),
      devcontainer: DevcontainerDefinitionSchema.optional(),
      orchestratorInstructions: z.string().min(1).max(32_768),
      models: ProjectModelsSchema.optional(),
      integrations: z.object({
        githubMcp: GitHubMcpPolicySchema.optional(),
        connectors: connectorsSchema.optional(),
      }).strict().optional(),
      actionPolicy: ActionPolicySchema.optional(),
      developerTasks: DeveloperTaskPolicySchema.optional(),
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
    repositories: ReadonlyArray<{ name: string; path: string }>;
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
/** A project definition as `StoredProjectDefinitionSchema` parses it: its connectors may include
 * an entry of a type this release's schema does not know, passed through unexamined. */
export type StoredProjectDefinition = z.infer<typeof StoredProjectDefinitionSchema>;
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export type DevcontainerDefinition = z.infer<typeof DevcontainerDefinitionSchema>;
export type CodeBuildGateDefinition = z.infer<typeof CodeBuildGateDefinitionSchema>;

export type RepositoryDefinition = z.infer<typeof RepositoryDefinitionSchema>;

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

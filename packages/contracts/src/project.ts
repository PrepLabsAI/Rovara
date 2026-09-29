import { posix } from "node:path";
import { z } from "zod";
import { ActionPolicySchema, actionPolicyProblems } from "./action-policy.js";
import { GitHubMcpPolicySchema } from "./github-mcp.js";
import { ConnectorsSchema, StoredConnectorsSchema } from "./connectors.js";
import type { GitHubConnectorConfig } from "./connectors.js";
import type { GitHubMcpPolicy } from "./github-mcp.js";
import { ProjectModelsSchema } from "./models.js";

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

export const ProjectCommandSchema = z
  .object({
    cwd: RelativeWorkspacePathSchema,
    executable: z.string().min(1).max(256),
    args: z.array(z.string().max(8_192)).max(256),
    timeoutSeconds: z.number().int().positive().max(86_400),
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

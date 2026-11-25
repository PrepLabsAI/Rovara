import { z } from "zod";
import { redactText } from "./redaction.js";
import { AgentXError, agentXError, errorStatus } from "./errors.js";
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
import { GeneralFakesSettingSchema } from "./general-fakes.js";
import { PromptLocationsSchema } from "./prompt-locations.js";
import { ExternalIdSchema, PluginKindSchema } from "./plugins/common.js";
import { ProjectRegistriesSchema, StoredProjectRegistriesSchema } from "./project-registries.js";

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

/** The check-runner provider whose checks a worker of this release runs: the provider name of the CodeBuild runner (`CODEBUILD_RUNNER_KIND`). */
export const CODEBUILD_CHECK_PROVIDER = "codebuild";
/** The providers whose external checks something in this release runs. A project that names another is refused when it is saved and when a task starts, never after a machine has started. */
export const RUNNABLE_EXTERNAL_CHECK_PROVIDERS: readonly string[] = [CODEBUILD_CHECK_PROVIDER];
export const UNRUNNABLE_EXTERNAL_CHECK_MESSAGE = "This project has an external check that nothing in this release runs, so a task cannot start. Remove that check, or use a build system this release runs.";

/**
 * Item C5: a gate that runs outside the worker, in a build system, as the project record states it: which provider runs it, the name it is reported under and the provider's own handle for what to run (`reference`: for
 * CodeBuild its project name; opaque to everything but the provider's adapter). `codeBuildGates` is the same thing in CodeBuild's words and stays readable as an alias: the two lists are one list, with one set of names.
 */
export const ExternalCheckSchema = z
  .object({
    provider: PluginKindSchema,
    name: AgentXNameSchema,
    reference: z.string().min(1).max(255),
    timeoutMinutes: z.number().int().min(5).max(420),
  })
  .strict();
export type ExternalCheck = z.infer<typeof ExternalCheckSchema>;

/** CodeBuild's gate as the generic external check it is. */
export function externalCheckOfGate(gate: CodeBuildGateDefinition): ExternalCheck {
  return { provider: CODEBUILD_CHECK_PROVIDER, name: gate.name, reference: gate.projectName, timeoutMinutes: gate.timeoutMinutes };
}

/**
 * An external check as the CodeBuild gate the worker's job line carries. Throws (CONFIG_INVALID) for another provider's check: nothing in this release runs it, and a gate that is not run must never be skipped silently.
 * This is the last line of defence. A project like that is already refused when it is saved (`ProjectDefinitionSchema`) and when a task starts (`unrunnableExternalCheck`), and the dispatcher turns this throw into a failed operation.
 */
export function gateOfExternalCheck(check: ExternalCheck): CodeBuildGateDefinition {
  if (check.provider !== CODEBUILD_CHECK_PROVIDER) throw agentXError("CONFIG_INVALID", UNRUNNABLE_EXTERNAL_CHECK_MESSAGE);
  return CodeBuildGateDefinitionSchema.parse({ name: check.name, projectName: check.reference, timeoutMinutes: check.timeoutMinutes });
}

/**
 * Plug-in foundations, task P7: where a repository lives, by plug-in kind. A GitHub host carries the installation and the immutable repository id that
 * `installationId` / `githubRepositoryId` carried at the top of the record (both stay readable for one release: see `repositoryHostOf`). Any other kind
 * is a plug-in registered by its adapter; it carries one opaque reference of its own. Control-plane only, like the pins: a worker never reads it.
 */
export const RepositoryHostSchema = z.union([
  z.object({ kind: z.literal("github"), installationId: z.number().int().positive().optional(), repositoryId: z.number().int().positive().optional() }).strict(),
  // Item C2/M3: a connection of another name (`github-company`) says which provider it is with `provider`, and a GitHub-provider connection carries the same pins as `github` does, so the check that a
  // transferred repository cannot quietly change installation applies to it too. A connection of any other provider has no pins.
  z.object({
    kind: PluginKindSchema.refine((kind) => kind !== "github", "github is the other variant"), provider: PluginKindSchema.optional(), ref: ExternalIdSchema.optional(),
    installationId: z.number().int().positive().optional(), repositoryId: z.number().int().positive().optional(),
  }).strict().refine((host) => host.provider === "github" || (host.installationId === undefined && host.repositoryId === undefined), "only a GitHub connection has GitHub pins"),
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
    /** Item C5: the generic form of `codeBuildGates` (see `ExternalCheckSchema`). Both may be present; together they are at most 8 checks with unique names. Control-plane only: a worker is sent the CodeBuild ones as `codeBuildGates`. */
    externalChecks: z.array(ExternalCheckSchema).max(8).optional(),
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
    /** P7, C2: the code host connection this repository lives on, by name. Absent means the default GitHub connection, as every repository that predates it (`repositoryHostOf`). */
    host: RepositoryHostSchema.optional(),
  })
  .strict()
  .superRefine((repository, context) => {
    // Dual read: while both spellings exist they must agree, so a record can never say two things about where its repository lives.
    if (repository.host !== undefined) {
      const host: { kind: string; provider?: string | undefined; installationId?: number | undefined; repositoryId?: number | undefined } = repository.host;
      if (host.kind !== "github" && host.provider !== "github") {
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
    for (const [index, check] of (repository.externalChecks ?? []).entries()) {
      if (names.has(check.name)) context.addIssue({ code: "custom", path: ["externalChecks", index, "name"], message: "external check names must be unique (also across codeBuildGates)" });
      names.add(check.name);
      if (check.provider === CODEBUILD_CHECK_PROVIDER) {
        // The CodeBuild rules, held at registration as before: the project must begin with agentx- and be used once.
        if (!CodeBuildGateDefinitionSchema.shape.projectName.safeParse(check.reference).success) {
          context.addIssue({ code: "custom", path: ["externalChecks", index, "reference"], message: "CodeBuild projectName must begin with agentx-" });
        } else if (projects.has(check.reference)) {
          context.addIssue({ code: "custom", path: ["externalChecks", index, "reference"], message: "CodeBuild projects must be unique within a repository" });
        }
        projects.add(check.reference);
      }
    }
    if ((repository.codeBuildGates?.length ?? 0) + (repository.externalChecks?.length ?? 0) > 8) {
      context.addIssue({ code: "custom", path: ["externalChecks"], message: "a repository has at most 8 gates in codeBuildGates and externalChecks together" });
    }
    const totalTimeout = (repository.codeBuildGates ?? []).reduce((total, gate) => total + gate.timeoutMinutes, 0)
      + (repository.externalChecks ?? []).reduce((total, check) => total + check.timeoutMinutes, 0);
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

/**
 * DEC 254zzz495 / N3: where a setup run may say it looked for tests, as fixed words (never free text: the line is shown on the setup card and written to the log, and nothing from a repository can be added).
 * `testPlacesLooked` (broker `setup-agent/end-summary.ts`) picks them from a run's commands.
 */
export const SETUP_TEST_PLACES = ["pytest_config", "tests_folder", "test_py_files", "conftest", "package_scripts", "js_test_files", "go_test_files", "java_src_test", "makefile", "ci_workflows", "readme"] as const;
export type SetupTestPlace = (typeof SETUP_TEST_PLACES)[number];

/**
 * DEC 254zzz495 / N3: the project's setup was APPROVED with no test command ("Ready, no automated tests"): `at` is when the candidate that carried it was made, `looked` where the setup run looked for tests (fixed words).
 * A fact of the project's own approved revision, kept as an attribute of the revision ROW beside `definition` (like `setupApproval` and `runtimeBinding`), NOT inside the strict `definition`: an older release parses only
 * `definition` and ignores unknown row attributes, so a rollback stays safe. Written only by a setup candidate (`confirmSetupAgent` through `storeSetupCandidate`) that a person approves; no registration body can carry it
 * (it is not a definition field). It means something only while the revision's `readiness` is empty (`noAutomatedTestsOf`): a revision that gains a test command ignores it, and a candidate with test commands drops it.
 */
export const NoAutomatedTestsSchema = z.object({
  at: z.string().datetime(),
  looked: z.array(z.enum(SETUP_TEST_PLACES)).max(SETUP_TEST_PLACES.length),
}).strict();
export type NoAutomatedTests = z.infer<typeof NoAutomatedTestsSchema>;

/**
 * The no-automated-tests fact of a project revision, or undefined. Fail-safe: a revision that has any test (readiness) command reads as having tests whatever the stored fact says, so a person who adds a test command turns
 * the tests-before-a-PR rule back on without anyone clearing a flag. Pure.
 */
export function noAutomatedTestsOf(definition: { readiness?: readonly unknown[] | undefined; noAutomatedTests?: NoAutomatedTests | undefined }): NoAutomatedTests | undefined {
  return definition.noAutomatedTests !== undefined && (definition.readiness?.length ?? 0) === 0 ? definition.noAutomatedTests : undefined;
}

/** The no-automated-tests fact as a revision ROW holds it (`row.noAutomatedTests`), read through its schema again; undefined when the row has none or it does not read. Pure. */
export function noAutomatedTestsOfRow(row: unknown): NoAutomatedTests | undefined {
  const value = typeof row === "object" && row !== null ? (row as { noAutomatedTests?: unknown }).noAutomatedTests : undefined;
  return value === undefined ? undefined : NoAutomatedTestsSchema.safeParse(value).data;
}

/**
 * M7 slice 2: the project's `afterMergeWatch` setting (decision 160 item 5: its own setting, not an automation). OFF unless `enabled` is true. `windowMinutes` (default 30) is how long the project's alarms are watched after a
 * deploy of a merge Rovara made; `environments` names the environments that count (compared without case; empty: all); `revert` says whether a revert is only reported on or also offered (a person's press still starts it).
 * Control-plane only (`workerProjectDefinition`). The watcher checks the stored value again every time it reads it (a value that does not check is off).
 */
export const AfterMergeWatchSettingSchema = z.object({
  enabled: z.boolean(),
  windowMinutes: z.number().int().min(1).max(1_440).optional(),
  environments: z.array(z.string().min(1).max(64)).max(20).optional(),
  revert: z.enum(["report_only", "offer_revert"]).optional(),
}).strict();
export type AfterMergeWatchSetting = z.infer<typeof AfterMergeWatchSettingSchema>;

function projectDefinitionObject<Connectors extends z.ZodTypeAny, Registries extends z.ZodTypeAny = typeof ProjectRegistriesSchema>(connectorsSchema: Connectors, registriesSchema: Registries = ProjectRegistriesSchema as unknown as Registries) {
  return z
    .object({
      name: AgentXNameSchema,
      revision: z.number().int().positive(),
      repositories: z.array(RepositoryDefinitionSchema).min(1).max(32),
      setup: z.array(ProjectCommandSchema).max(64),
      readiness: z.array(ProjectCommandSchema).max(64),
      devcontainer: DevcontainerDefinitionSchema.optional(),
      network: ProjectNetworkSchema.optional(),
      /** N9 (INTG2): the project's private package registries. A CodeArtifact registry: where it is, never a token (a company's package tokens are the company's, set once; a generic registry here is refused). Control-plane only (`workerProjectDefinition`). */
      registries: registriesSchema.optional(),
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
      /** General fakes (DEC 234, general-fakes.ts): Rovara-made fakes from the project's OpenAPI descriptions for outside services its checks call. Absent: off. Control-plane only (`workerProjectDefinition`); a CHECKS run gets `generalFakes` in its payload instead. */
      generalFakes: GeneralFakesSettingSchema.optional(),
      /** M7 slice 2: the after-merge watcher's own setting. Absent: off. */
      afterMergeWatch: AfterMergeWatchSettingSchema.optional(),
      /** L4-EVP: where the project's AI prompts live inside code (prompt-locations.ts). Proposed by the setup agent and confirmed with the setup revision; read by the change tier (an `eval_hint`) at the task's starting revision. Absent: none. Control-plane only (`workerProjectDefinition`). */
      promptLocations: PromptLocationsSchema.optional(),
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
  // Item C2 (decision 60): a repository's `host` may be written. It names a code host CONNECTION (`github`, `github-company`) or a provider whose default connection serves it; whether this install has registered it is
  // checked where it is used (a task start refuses a repository whose host is not registered, before any work is spent), because the schema cannot know what an install registered. Code has no older release to roll back to.
  // Item C5 (review M2): an external check nothing in this release runs is refused when the project is saved, with the clear sentence.
  .superRefine((project, context) => {
    project.repositories.forEach((repository, repositoryIndex) => {
      (repository.externalChecks ?? []).forEach((check, index) => {
        if (!RUNNABLE_EXTERNAL_CHECK_PROVIDERS.includes(check.provider)) context.addIssue({ code: "custom", path: ["repositories", repositoryIndex, "externalChecks", index, "provider"], message: UNRUNNABLE_EXTERNAL_CHECK_MESSAGE });
      });
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
const StoredProjectDefinitionObjectSchema = projectDefinitionObject(StoredConnectorsSchema, StoredProjectRegistriesSchema).superRefine(checkProjectDefinition);

/** Parses a definition that may predate the removal of {@link LEGACY_PROJECT_FIELDS}, and that may
 * carry a connector of a type this release does not know (see `StoredConnectorsSchema`). */
export const StoredProjectDefinitionSchema = z.preprocess(
  (value) => withoutFields(value, LEGACY_PROJECT_FIELDS),
  StoredProjectDefinitionObjectSchema,
);

/**
 * REGISTRY-TOLERANT-READ (arch rule 8): how a STORED project revision is read by the broker's own readers (task start, edits, setup status, application readiness). Not the input schema: a person's new input still goes
 * through `ProjectDefinitionSchema`, and an edit is checked by it again before anything is written. The shape is the same as `ProjectDefinitionSchema`'s (so the value is a `ProjectDefinition`), except that:
 *   - the legacy keys of {@link LEGACY_PROJECT_FIELDS} are dropped, as `StoredProjectDefinitionSchema` does;
 *   - `registries` drops a generic npm/pypi/maven entry (see `StoredProjectRegistriesSchema`);
 *   - the rules that judge what a person typed are not applied: a reserved or secret-looking command `env`, the Public Suffix List on `network.allowedDomains`, a rule that matches no tool in the `actionPolicy`, a reserved
 *     E2E check id, an external check nothing in this release runs. Some of those do safety work where a record is USED, so `projectUseRefusal` asks them again at the point of use (task start, and the dispatcher's
 *     prepare), and refuses there with a stable rule id. The `actionPolicy`'s own shape stays in the read (`ActionPolicySchema`); a rule that matches no tool is inert in the action gate, so it is dropped.
 * A connector of a type this release does not know still fails the read, as before (`StoredProjectDefinitionSchema` passes it through, but then the value is not a `ProjectDefinition`).
 */
const StoredProjectReadObjectSchema = projectDefinitionObject(ConnectorsSchema, StoredProjectRegistriesSchema).superRefine(checkProjectDefinition);
export const StoredProjectReadSchema = z.preprocess((value) => withoutFields(value, LEGACY_PROJECT_FIELDS), StoredProjectReadObjectSchema);

/** Reads a stored project revision's `definition` (see `StoredProjectReadSchema`). Never throws. */
export function readStoredProject(value: unknown): { success: true; data: ProjectDefinition } | { success: false } {
  const parsed = StoredProjectReadSchema.safeParse(value);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

/** Arch rule 9: what is said when a project's CURRENT revision cannot be read. The stable id ends the sentence; nothing is run on another revision instead. The one definition: every reader refuses with it. */
export const PROJECT_REVISION_UNREADABLE = "This project's current settings can't be read, so nothing was started. Ask an admin to look at the project's settings. [project_revision_unreadable]";
export const PROJECT_REVISION_UNREADABLE_RULE = "project_revision_unreadable";

/**
 * The refusal of a project whose current revision cannot be read (missing, or does not read). A class, so a reader that must leave ONE such project out of a list (or count it) decides by `instanceof`, never by the text.
 * Its name stays "AgentXError": code that recognises an AgentX error by name keeps doing so. CONFIG_INVALID, as the sentence has always said.
 */
export class ProjectRevisionUnreadableError extends AgentXError {
  constructor() { super("CONFIG_INVALID", PROJECT_REVISION_UNREADABLE, errorStatus("CONFIG_INVALID")); }
}

/** The stable ids of the rules a stored project is held to when it is USED (they are not applied when it is read). */
export const PROJECT_USE_RULES = ["project_external_check", "project_allowed_domain", "project_command_env", "project_e2e_reserved_id"] as const;
export type ProjectUseRule = (typeof PROJECT_USE_RULES)[number];

/** Fixed sentences, one per rule: they name no value (a refusal reaches logs and other people's screens). The external check's is the one a task start has always said. */
export const PROJECT_USE_MESSAGES: Readonly<Record<ProjectUseRule, string>> = {
  project_external_check: UNRUNNABLE_EXTERNAL_CHECK_MESSAGE,
  project_allowed_domain: "This project allows a website address that is not allowed any more (a whole public domain or an address that is not a name), so nothing was started. Remove or correct it in the project's allowed websites.",
  project_command_env: "A setup or test command of this project sets an environment variable that is reserved or looks like a secret, so nothing was started. Remove it from the command, and use a credential reference for a secret.",
  project_e2e_reserved_id: "This project has an end-to-end target named for Rovara's own check (project-e2e), so nothing was started. Rename the target.",
};

/** The rules of {@link PROJECT_USE_RULES} that a stored project breaks, in a fixed order. Pure; empty when the project may be used. */
export function projectUseProblems(project: Pick<ProjectDefinition, "repositories" | "setup" | "readiness"> & { network?: ProjectDefinition["network"]; e2e?: ProjectDefinition["e2e"] }): ProjectUseRule[] {
  const broken: ProjectUseRule[] = [];
  if (unrunnableExternalCheck(project.repositories) !== undefined) broken.push("project_external_check");
  if (firstRefusedDomainIndex(project.network?.allowedDomains ?? []) !== undefined) broken.push("project_allowed_domain");
  if ([...project.setup, ...project.readiness].some((command) => projectCommandEnvProblems(command.env ?? {}).length > 0)) broken.push("project_command_env");
  if ((project.e2e?.targets ?? []).some((target) => target.targetId === E2E_PROJECT_CHECK_ID)) broken.push("project_e2e_reserved_id");
  return broken;
}

/**
 * The refusal for a stored project that may not be used, or undefined. CONFIG_INVALID with the rule's fixed sentence; every rule but the external check's (whose sentence is unchanged) ends with its stable id in
 * brackets, so a log line or a person's report names the rule. The first broken rule is the one said.
 */
export function projectUseRefusal(project: Parameters<typeof projectUseProblems>[0]): AgentXError | undefined {
  const rule = projectUseProblems(project)[0];
  if (rule === undefined) return undefined;
  return agentXError("CONFIG_INVALID", rule === "project_external_check" ? PROJECT_USE_MESSAGES[rule] : `${PROJECT_USE_MESSAGES[rule]} [${rule}]`);
}

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
export function workerProjectDefinition<Definition extends object>(definition: Definition, options: { includeMeta?: boolean } = {}): Omit<Definition, "network" | "origins" | "specTarget" | "registries" | "generalFakes" | "afterMergeWatch" | "promptLocations"> {
  const rest: Record<string, unknown> = { ...(definition as Record<string, unknown>) };
  delete rest.network;
  // N9: the registries reach a worker as the prepare payload's `registries` (where, never how), only if it lists `prepare.registries.v1`; an earlier worker's strict schema does not know the field.
  delete rest.registries;
  // Meta repo lane A: who set each setting is the control plane's too.
  delete rest.origins;
  // Lane D: where specs are written is the control plane's (the broker renders and publishes them); an earlier worker's strict schema does not know it.
  delete rest.specTarget;
  // General fakes: the setting is the control plane's; a CHECKS run that may use them is sent `generalFakes` in its payload, only to a worker that lists the feature.
  delete rest.generalFakes;
  // M7 slice 2: whether the after-merge watcher is on for the project is the control plane's; an earlier worker's strict schema does not know it.
  delete rest.afterMergeWatch;
  // L4-EVP: the prompt locations are the control plane's (the change tier reads them); a CHECKS run that asks for the eval is sent `evalPromptLocations` in its payload, only to a worker that lists the feature.
  delete rest.promptLocations;
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
        // Item C5: a worker's job line carries CodeBuild gates only (an earlier worker's strict schema does not know `externalChecks`): the generic checks come to them. A check no runner runs refuses the dispatch.
        if (repository.externalChecks !== undefined) {
          const gates = codeBuildGatesOf(repository);
          delete repository.externalChecks;
          if (gates.length > 0) repository.codeBuildGates = gates;
        }
        return repository;
      });
  }
  return rest as Omit<Definition, "network" | "origins" | "specTarget" | "registries" | "generalFakes" | "afterMergeWatch" | "promptLocations">;
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

/** Item C5: every external check of a repository, generic ones first, then the CodeBuild gates in their generic form. */
export function repositoryExternalChecks(repository: Pick<RepositoryDefinition, "codeBuildGates" | "externalChecks">): ExternalCheck[] {
  return [...(repository.externalChecks ?? []), ...(repository.codeBuildGates ?? []).map(externalCheckOfGate)];
}

/** The first external check of these repositories whose provider nothing in this release runs, or undefined. Asked when a project is saved and when a task starts. */
export function unrunnableExternalCheck(repositories: ReadonlyArray<Pick<RepositoryDefinition, "externalChecks">>): ExternalCheck | undefined {
  for (const repository of repositories) {
    const found = (repository.externalChecks ?? []).find((check) => !RUNNABLE_EXTERNAL_CHECK_PROVIDERS.includes(check.provider));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Item C5: the CodeBuild gates a repository's checks come to, in the shape the worker's job line and the broker's publication scope carry (that line is unchanged), in the order of `repositoryExternalChecks`.
 * It throws when a check names a provider no runner of this release runs (a project like that is refused when it is saved and when a task starts; this is the backstop, so a gate is never run without it).
 */
export function codeBuildGatesOf(repository: Pick<RepositoryDefinition, "codeBuildGates" | "externalChecks">): CodeBuildGateDefinition[] {
  return [...(repository.externalChecks ?? []).map(gateOfExternalCheck), ...(repository.codeBuildGates ?? [])];
}

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

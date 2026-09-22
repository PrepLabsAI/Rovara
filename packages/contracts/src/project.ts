import { posix } from "node:path";
import { z } from "zod";

export const AGENTX_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
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

export const ProjectDefinitionSchema = z
  .object({
    schemaVersion: z.literal(2),
    name: AgentXNameSchema,
    revision: z.number().int().positive(),
    controlPlaneUrl: HttpsOrLoopbackUrlSchema,
    auth: z
      .object({
        issuer: HttpsOrLoopbackUrlSchema,
        clientId: z.string().min(1).max(256),
        audience: z.string().min(1).max(256),
      })
      .strict(),
    environment: z
      .object({ image: z.string().regex(OCI_DIGEST_PATTERN, "image must be pinned by sha256 digest") })
      .strict(),
    repositories: z.array(RepositoryDefinitionSchema).min(1).max(32),
    setup: z.array(ProjectCommandSchema).max(64),
    readiness: z.array(ProjectCommandSchema).max(64),
    orchestratorInstructions: z.string().min(1).max(32_768),
  })
  .strict()
  .superRefine((project, context) => {
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
  });

export type ProjectDefinition = z.infer<typeof ProjectDefinitionSchema>;
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export type CodeBuildGateDefinition = z.infer<typeof CodeBuildGateDefinitionSchema>;

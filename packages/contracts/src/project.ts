import { posix } from "node:path";
import { z } from "zod";

export const AGENTX_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const OCI_DIGEST_PATTERN = /@sha256:[a-f0-9]{64}$/;
export const FULL_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const AgentXNameSchema = z.string().regex(AGENTX_NAME_PATTERN);

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

export const RepositoryDefinitionSchema = z
  .object({
    name: AgentXNameSchema,
    url: HttpsOrLoopbackUrlSchema,
    path: RelativeWorkspacePathSchema,
    initialCommit: z.string().regex(FULL_COMMIT_PATTERN, "initialCommit must be a full commit ID"),
    credentialRef: AgentXNameSchema,
  })
  .strict();

export const ProjectDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
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

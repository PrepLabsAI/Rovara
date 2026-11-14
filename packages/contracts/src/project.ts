import { z } from "zod";

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
    // RULING Q3: the segment checks above already reject every POSIX normalization change.
  });

export const PROJECT_COMMAND_ENV_MAX_ENTRIES = 64;

export const PROJECT_COMMAND_ENV_VALUE_MAX = 4_096;

export const PROJECT_COMMAND_ENV_TOTAL_MAX_BYTES = 32_768;

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
        bytes += new TextEncoder().encode(name).length + new TextEncoder().encode(env[name] ?? "").length + 2;
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

export const DeveloperShareModeSchema = z.enum(["view", "continue"]);

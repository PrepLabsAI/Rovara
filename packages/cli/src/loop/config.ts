// rovara loop (#355): a repository's own settings, in .rovara/loop.yaml, committed with the code:
// who may start a loop or answer it, and which agent does the work.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const LOOP_CONFIG_PATH = ".rovara/loop.yaml";

/** A GitHub login, as GitHub allows them. */
const LoginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "a GitHub login such as octocat");

export const LoopRepoConfigSchema = z.object({
  version: z.literal(1),
  /** The only people whose comments start, steer or stop a loop. Everyone else's are never read as instructions. */
  collaborators: z.array(LoginSchema).min(1).max(100),
  harness: z.object({
    name: z.literal("claude-code"),
    /** Extra arguments for the agent, such as a permission mode. Claude Code starts in its default mode otherwise. */
    args: z.array(z.string().max(200)).max(20).default([]),
  }).strict().default({ name: "claude-code", args: [] }),
}).strict();
export type LoopRepoConfig = z.infer<typeof LoopRepoConfigSchema>;

/** The repository's config, or an error that says what is wrong with it and how to make one. */
export async function readLoopConfig(repoPath: string): Promise<LoopRepoConfig> {
  let text: string;
  try {
    text = await readFile(join(repoPath, LOOP_CONFIG_PATH), "utf8");
  } catch (error) {
    throw new Error(`${LOOP_CONFIG_PATH} is missing in ${repoPath}; run rovara loop init there`, { cause: error });
  }
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw new Error(`${LOOP_CONFIG_PATH} is not valid YAML: ${(error as Error).message.split("\n")[0] ?? ""}`, { cause: error });
  }
  const parsed = LoopRepoConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${LOOP_CONFIG_PATH}: ${issue?.path.join(".") || "the file"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** The file `rovara loop init` writes, with the developer as the one collaborator. */
export function initialLoopConfig(login: string): string {
  return [
    "# rovara loop: who may start, steer or stop a loop on this repository's issues, and which agent works.",
    "# Only these GitHub logins are obeyed; everyone else's comments are ignored.",
    "version: 1",
    "collaborators:",
    `  - ${login}`,
    "harness:",
    "  name: claude-code",
    "  # Claude Code starts in its default permission mode: watch and answer it with tmux attach.",
    "  args: []",
    "",
  ].join("\n");
}

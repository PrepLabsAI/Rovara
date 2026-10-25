import { z } from "zod";
import { RelativeWorkspacePathSchema } from "./project.js";
import { redactText } from "./redaction.js";

/**
 * A check as a model proposes it: a coding plan's `agentx-checks` entry, or a corrected check a PR feedback reviewer
 * proposes beside its fix. Both follow the same rules, so this module holds them once.
 */

export const WORKFLOW_PROPOSED_CHECK_DEFAULT_TIMEOUT_SECONDS = 600;
const BARE_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const RELATIVE_EXECUTABLE = /^\.\/[A-Za-z0-9._+/-]{1,254}$/;

/** True when the text holds a character below U+0020 (line breaks and tabs included) or U+007F. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A plain program name, or a `./` path inside the repository. */
export function proposedCheckExecutableAllowed(value: string): boolean {
  return BARE_EXECUTABLE.test(value) || (RELATIVE_EXECUTABLE.test(value) && RelativeWorkspacePathSchema.safeParse(value.slice(2)).success);
}

const ExecutableSchema = z.string().refine(proposedCheckExecutableAllowed);
const PlainText = (schema: z.ZodString) => schema.refine((value) => !hasControlCharacter(value));

export const WorkflowProposedCheckInputSchema = z.object({
  label: PlainText(z.string().trim().min(1).max(80)),
  cwd: RelativeWorkspacePathSchema,
  executable: ExecutableSchema,
  args: z.array(PlainText(z.string().max(1_024))).max(32),
  timeoutSeconds: z.number().int().min(1).max(1_800).optional(),
}).strict();
export type WorkflowProposedCheckInput = z.infer<typeof WorkflowProposedCheckInputSchema>;

/** A planner's own prediction of how a proposed check does on the unchanged code: "fail" means the check tests new behaviour. */
export const WorkflowCheckExpectOnBaseSchema = z.enum(["pass", "fail"]);
export type WorkflowCheckExpectOnBase = z.infer<typeof WorkflowCheckExpectOnBaseSchema>;

/**
 * Built-in check kinds with fixed meanings, so a plan never needs a hand-written `grep` to test that a file holds, or
 * lacks, a piece of text. The planner names the kind, the file and the literal text; AgentX writes the command (below),
 * so the exit code can only mean what the kind says: `file-contains` passes when the text is in the file;
 * `file-not-contains` passes only when the file is readable and the text is not in it (a missing file fails both).
 */
export const WORKFLOW_BUILTIN_CHECK_KINDS = ["file-contains", "file-not-contains"] as const;
export type WorkflowBuiltinCheckKind = (typeof WORKFLOW_BUILTIN_CHECK_KINDS)[number];
/** The longest literal text a built-in file check looks for. */
export const WORKFLOW_BUILTIN_CHECK_TEXT_MAX = 300;

/** The fixed script of each built-in kind: `$1` is the literal text, `$2` the file (relative to the check's folder). */
const BUILTIN_SCRIPTS: Record<WorkflowBuiltinCheckKind, string> = {
  "file-contains": 'grep -qF -e "$1" -- "$2"',
  // grep exits 1 for "no match" and 2 for a trouble (such as a missing file); only "no match" passes.
  "file-not-contains": 'grep -qF -e "$1" -- "$2"; test "$?" -eq 1',
};

/** A built-in check as the planner writes it in a plan's `checks` member: the kind, a file in its folder and the exact text. */
export const WorkflowBuiltinCheckInputSchema = z.object({
  label: PlainText(z.string().trim().min(1).max(80)),
  kind: z.enum(WORKFLOW_BUILTIN_CHECK_KINDS),
  cwd: RelativeWorkspacePathSchema,
  path: RelativeWorkspacePathSchema,
  text: PlainText(z.string().min(1).max(WORKFLOW_BUILTIN_CHECK_TEXT_MAX)),
  timeoutSeconds: z.number().int().min(1).max(1_800).optional(),
}).strict();
export type WorkflowBuiltinCheckInput = z.infer<typeof WorkflowBuiltinCheckInputSchema>;

/** The command a built-in check runs. */
export function builtinFileCheckCommand(input: Pick<WorkflowBuiltinCheckInput, "kind" | "cwd" | "path" | "text">): { cwd: string; executable: string; args: string[] } {
  return { cwd: input.cwd, executable: "sh", args: ["-c", BUILTIN_SCRIPTS[input.kind], "sh", input.text, input.path] };
}

/** What a stored command is when AgentX wrote it for a built-in check; undefined for any other command. */
export function builtinFileCheckOf(command: { executable: string; args: readonly string[] }): { kind: WorkflowBuiltinCheckKind; text: string; path: string } | undefined {
  const [flag, script, name, text, path, ...rest] = command.args;
  if (command.executable !== "sh" || flag !== "-c" || name !== "sh" || text === undefined || path === undefined || rest.length > 0) return undefined;
  const kind = WORKFLOW_BUILTIN_CHECK_KINDS.find((candidate) => BUILTIN_SCRIPTS[candidate] === script);
  return kind === undefined ? undefined : { kind, text, path };
}

const CHECK_FIELDS = new Set(["label", "cwd", "executable", "args", "timeoutSeconds"]);

/**
 * What is wrong with one proposed check, in plain words (never echoing its text), or undefined when it follows every
 * rule. With `repositoryPaths`, it must also run in one of those repositories or a folder inside one.
 */
export function proposedCheckProblem(value: unknown, repositoryPaths?: readonly string[]): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !CHECK_FIELDS.has(key))) {
    return "it must have only label, cwd, executable, args and timeoutSeconds";
  }
  const { label, cwd, executable, args, timeoutSeconds } = value as Record<string, unknown>;
  if (typeof label !== "string" || label.trim().length === 0 || label.trim().length > 80 || hasControlCharacter(label.trim())) {
    return "its label must be 1 to 80 characters on one line";
  }
  if (typeof executable !== "string" || !proposedCheckExecutableAllowed(executable)) {
    return "its program must be a plain program name or a ./ path inside the repository";
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return "its arguments must be a list of text";
  if ((args as string[]).some(hasControlCharacter)) return "its arguments may not contain line breaks or control characters";
  if (args.length > 32 || (args as string[]).some((arg) => arg.length > 1_024)) return "it may have at most 32 arguments of at most 1,024 characters each";
  if (timeoutSeconds !== undefined && (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1_800)) {
    return "its timeout must be a whole number of seconds from 1 to 1800";
  }
  const insideRepository = typeof cwd === "string" && RelativeWorkspacePathSchema.safeParse(cwd).success
    && (repositoryPaths === undefined || repositoryPaths.some((path) => cwd === path || cwd.startsWith(`${path}/`)));
  if (!insideRepository) return "it must run in one of the task's repositories";
  return WorkflowProposedCheckInputSchema.safeParse(value).success ? undefined : "it must have only label, cwd, executable, args and timeoutSeconds";
}

/**
 * A check's command as the owner reads it before approving it: the program, then each argument (quoted when it holds
 * anything but plain characters). Past `max` characters only the arguments are cut, ending in "…": the program always shows.
 */
export function workflowCheckCommandText(command: { executable: string; args: readonly string[] }, max = 160): string {
  const args = command.args.map((arg) => /^[A-Za-z0-9._/=:@+,-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" ");
  const full = args.length === 0 ? command.executable : `${command.executable} ${args}`;
  if (full.length <= max) return full;
  const room = Math.max(0, max - command.executable.length - 2);
  return `${command.executable} ${args.slice(0, room).trimEnd()}…`;
}

/** The longest command (program and arguments joined by spaces) a corrected check from PR feedback may have. */
export const WORKFLOW_FEEDBACK_CHECK_COMMAND_MAX = 300;
const PLAIN_TEXT = /^[\x20-\x7e]*$/;
const PLAIN_FOLDER = /^[A-Za-z0-9._/+-]+$/;
/** The longest folder a corrected check from PR feedback may run in. */
export const WORKFLOW_FEEDBACK_CHECK_FOLDER_MAX = 120;

/**
 * What is wrong with a corrected check a PR feedback reviewer proposes, or undefined. Besides the coding plan's rules,
 * it must be short and plain so the owner reads exactly what runs before approving it: the label, folder, program and
 * arguments only printable ASCII, the whole command at most 300 characters, and no argument with ` or $(.
 */
export function feedbackReplacementCheckProblem(value: unknown, repositoryPaths?: readonly string[]): string | undefined {
  const planProblem = proposedCheckProblem(value, repositoryPaths);
  if (planProblem !== undefined) return planProblem;
  const parsed = WorkflowProposedCheckInputSchema.safeParse(value);
  if (!parsed.success) return "it must have only label, cwd, executable, args and timeoutSeconds";
  const { label, cwd, executable, args } = parsed.data;
  const command = [executable, ...args].join(" ");
  // The label as given: the schema trims it, and a hidden character at either end must be refused too.
  const rawLabel = (value as { label: string }).label;
  const plainCode = (text: string) => PLAIN_TEXT.test(text) && !text.includes("`") && !text.includes("$(");
  if (!plainCode(cwd) || cwd.length > WORKFLOW_FEEDBACK_CHECK_FOLDER_MAX) return "keep its folder to at most 120 plain characters without ` or $(";
  // The folder as given: the schema trims it, and a space at either end (or inside) would run elsewhere than the card reads.
  if (!PLAIN_FOLDER.test((value as { cwd: string }).cwd)) return "keep its folder to letters, digits and . _ / + - only, with no spaces";
  if ([rawLabel, label, executable].some((text) => !PLAIN_TEXT.test(text)) || !args.every(plainCode) || command.length > WORKFLOW_FEEDBACK_CHECK_COMMAND_MAX) {
    return "keep the command to at most 300 plain characters without ` or $(";
  }
  // A card shows model text redacted; a check whose text redaction would change could not be shown as it runs.
  if ([label, cwd, workflowCheckCommandText({ executable, args }, Number.POSITIVE_INFINITY)].some((text) => redactText(text) !== text)) {
    return "the command looks like it contains a secret; checks must not include secrets";
  }
  return undefined;
}

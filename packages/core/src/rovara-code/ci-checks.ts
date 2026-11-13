// Rovara Code (version 2 plan quality): the checks a repository's CI requires, read from its workflow files, so a plan's Checks section never depends on the planner remembering to look. The
// result is a proposal like any other: it joins the planner's proposed checks (`withCiChecks`), is shown to the person in the plan, and runs only after they approve it. Nothing here runs a
// command or believes the repository: the files are parsed as data, only plain single-program commands that verify code are kept (no shell syntax at all), and every folder stays inside the
// repository. Anything that can't be read leaves the plan as it was.
import { parse } from "yaml";
import { WORKFLOW_PROPOSED_CHECKS_MAX, hasControlCharacter, proposedCheckProblem, type CiCheckInput } from "@rovara-code/contracts";

/**
 * What the reading of a repository's CI definition needs of a host: the entries of a directory and a file's text, read-only, at one commit of the default branch. A host gives this view
 * (GitHub's is the org's read-only reader); nothing here is GitHub's type. The CodeHost port carries file reads (`fileAtRevision`) but no directory listing, so a host without this view
 * leaves a plan's checks as the planner proposed them.
 */
export interface CiDefinitionReader {
  /** The entries of a directory (undefined when the path is not a directory). */
  list(path: string): Promise<{ entries: ReadonlyArray<{ name: string; path: string; type: string }>; truncated: boolean } | undefined>;
  /** A file's text when it is at most `maxBytes` (undefined when the path is not a file). */
  read(path: string, maxBytes: number): Promise<({ tooLarge: true } | { tooLarge?: false; text: string }) | undefined>;
}

/** A check the CI requires: the command, the folder it runs in (inside the repository) and the workflow it comes from. */
export interface CiCheck extends CiCheckInput { source: string }

/** The most CI checks one repository adds to a plan: the most a plan may propose. */
export const CI_CHECKS_MAX = WORKFLOW_PROPOSED_CHECKS_MAX;
export const WORKFLOW_FOLDER = ".github/workflows";
/** At most this many workflow files are read, each at most this many bytes. */
const WORKFLOW_FILES_MAX = 20;
const WORKFLOW_FILE_MAX_BYTES = 64 * 1024;
const LABEL_MAX = 80;

/** Events that make a workflow part of what a change must pass. */
const CHECKING_EVENTS = new Set(["push", "pull_request", "pull_request_target"]);
/** The script and make-target names that verify code. */
const VERIFY_NAME = /^(?:test|tests|lint|typecheck|type-check|types|check|checks|verify|build|ci|e2e|format:check|(?:test|lint|check|typecheck|type-check|build|e2e)[:_-][a-z0-9:_-]+)$/u;
/** Programs whose every plain invocation is a check, with the first argument they need (absent: any). */
const CHECK_PROGRAMS: Readonly<Record<string, RegExp | undefined>> = {
  pytest: undefined, tox: undefined, nox: undefined, mypy: undefined, pyright: undefined, flake8: undefined, pylint: undefined, eslint: undefined, tsc: undefined, vitest: undefined,
  jest: undefined, mocha: undefined, ruff: /^check$/u, go: /^(?:test|vet|build)$/u, cargo: /^(?:test|clippy|check|fmt|build)$/u, rspec: undefined, rubocop: undefined, phpunit: undefined,
  mvn: /^(?:test|verify|check)$/u,
};
/** A flag that makes a tool rewrite files: a check never does. */
const WRITING_FLAGS = new Set(["--fix", "--write"]);
const NODE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NODE_BIN_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const SAFE_FOLDER = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u;
/** Anything that is shell syntax rather than a plain word. */
const SHELL_SYNTAX = /[|;&<>()`$"'\\*?~!{}[\]#]/u;
/** A word of a plain command: letters, digits and the punctuation of paths, flags and `--flag=value`. */
const PLAIN_WORD = /^[A-Za-z0-9._@+:,/=%-]+$/u;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether the workflow's `on` includes an event that checks a change. */
function checksChanges(on: unknown): boolean {
  if (typeof on === "string") return CHECKING_EVENTS.has(on);
  if (Array.isArray(on)) return on.some((event) => typeof event === "string" && CHECKING_EVENTS.has(event));
  return isRecord(on) && Object.keys(on).some((event) => CHECKING_EVENTS.has(event));
}

/** A folder that stays inside the repository, joined to its path; undefined for anything else (an absolute path, `..`, a variable, a space). */
function folderUnder(base: string, folder: string): string | undefined {
  const trimmed = folder.trim().replace(/\/+$/u, "");
  if (trimmed === "" || trimmed === ".") return base;
  if (!SAFE_FOLDER.test(trimmed) || trimmed.split("/").some((part) => part === "." || part === "..")) return undefined;
  return `${base}/${trimmed.replace(/^\.\//u, "")}`;
}

/** The words of a plain command, or undefined when the text holds any shell syntax. */
function plainWords(command: string): string[] | undefined {
  if (SHELL_SYNTAX.test(command)) return undefined;
  const words = command.trim().split(/\s+/u).filter((word) => word !== "");
  return words.length > 0 && words.every((word) => PLAIN_WORD.test(word)) ? words : undefined;
}

/** Whether the words are a verification command: a test, lint, type-check or build run by a known program. */
function verifies(words: readonly string[]): boolean {
  const [program = "", first = "", second = ""] = words;
  if (words.some((word) => WRITING_FLAGS.has(word))) return false;
  // Formatting is a check only when it reports instead of rewriting.
  if (program === "cargo" && first === "fmt") return words.includes("--check");
  if (NODE_RUNNERS.has(program)) {
    if (first === "test" || first === "t") return true;
    if (first === "run" || first === "run-script") return VERIFY_NAME.test(second);
    // yarn and pnpm run a script by its bare name; npm and bun do not.
    return (program === "yarn" || program === "pnpm") && VERIFY_NAME.test(first);
  }
  if (NODE_BIN_RUNNERS.has(program)) return first !== "" && Object.hasOwn(CHECK_PROGRAMS, first) && verifies(words.slice(1));
  if (program === "make") return VERIFY_NAME.test(first);
  if (program === "python" || program === "python3") return first === "-m" && ["pytest", "mypy", "unittest", "flake8", "pylint"].includes(second);
  if (program === "uv") return first === "run" && Object.hasOwn(CHECK_PROGRAMS, second) && verifies(words.slice(2));
  if (!Object.hasOwn(CHECK_PROGRAMS, program)) return false;
  const needs = CHECK_PROGRAMS[program];
  return needs === undefined || needs.test(first);
}

/** The commands of a `run` text: one per line, a line ended with a backslash joined to the next, and a chain written with `&&` split, a leading `cd <folder>` moving the rest of the chain. */
function commandsOf(run: string, base: string): Array<{ words: string[]; cwd: string }> {
  const lines = run.replace(/\\\r?\n[ \t]*/gu, " ").split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => entry !== "" && !entry.startsWith("#"));
  const found: Array<{ words: string[]; cwd: string }> = [];
  for (const line of lines) {
    let cwd: string | undefined = base;
    for (const part of line.split("&&")) {
      const words = plainWords(part);
      // A move to a folder this reader can't place leaves the rest of the line somewhere unknown: nothing after it is a check.
      if (/^(?:cd|pushd|popd)(?:\s|$)/u.test(part.trim())) { cwd = words !== undefined && words[0] === "cd" && words.length === 2 && cwd !== undefined ? folderUnder(cwd, words[1]!) : undefined; continue; }
      if (words !== undefined && cwd !== undefined && verifies(words)) found.push({ words, cwd });
    }
  }
  return found;
}

const oneLine = (value: string): string => Array.from(value, (char) => (hasControlCharacter(char) ? " " : char)).join("").replace(/\s+/gu, " ").trim();

/**
 * The checks a repository's workflow files require, in workflow-file name order and step order, each once. `repositoryPath` is the repository's folder in the workspace: the checks run there, or in a
 * folder under it that a step's `working-directory` or a `cd` names. Only workflows that run on a push or a pull request count.
 */
export function ciChecksFromWorkflows(files: ReadonlyArray<{ path: string; text: string }>, repositoryPath: string): CiCheck[] {
  const checks: CiCheck[] = [];
  const seen = new Set<string>();
  for (const file of [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    let workflow: unknown;
    try {
      workflow = parse(file.text, { maxAliasCount: 50 });
    } catch {
      continue;
    }
    // YAML 1.1 readers turn the key `on` into `true`; this parser doesn't, but a workflow written for one is still read.
    if (!isRecord(workflow) || !checksChanges(workflow["on"] ?? workflow["true"]) || !isRecord(workflow["jobs"])) continue;
    for (const job of Object.values(workflow["jobs"])) {
      if (!isRecord(job) || !Array.isArray(job["steps"])) continue;
      const defaults = isRecord(job["defaults"]) && isRecord(job["defaults"]["run"]) ? job["defaults"]["run"]["working-directory"] : undefined;
      for (const step of job["steps"] as unknown[]) {
        if (!isRecord(step) || typeof step["run"] !== "string") continue;
        const folder = step["working-directory"] ?? defaults;
        const base = folder === undefined ? repositoryPath : typeof folder === "string" ? folderUnder(repositoryPath, folder) : undefined;
        if (base === undefined) continue;
        for (const { words, cwd } of commandsOf(step["run"], base)) {
          const [executable = "", ...args] = words;
          const key = `${cwd}\n${words.join(" ")}`;
          if (seen.has(key)) continue;
          const name = typeof step["name"] === "string" ? oneLine(step["name"]) : "";
          const label = `CI: ${name === "" ? words.join(" ") : name}`.slice(0, LABEL_MAX).trim();
          const check: CiCheck = { label, cwd, executable, args, source: file.path };
          // A command the rules for a proposed check would refuse is not one: it would make every check of the plan unreadable.
          if (proposedCheckProblem({ label, cwd, executable, args }, [repositoryPath]) !== undefined) continue;
          seen.add(key);
          checks.push(check);
          if (checks.length >= CI_CHECKS_MAX) return checks;
        }
      }
    }
  }
  return checks;
}

/**
 * The CI checks of a repository, read through a read-only reader of its default branch: the `yml` and `yaml` files of `.github/workflows`. Empty (never an error) when there is no such folder, a file is
 * too large, or GitHub can't answer: a plan is not held up for a check it can't read.
 */
export async function readCiChecks(reader: CiDefinitionReader, repositoryPath: string): Promise<CiCheck[]> {
  try {
    const listing = await reader.list(WORKFLOW_FOLDER);
    if (listing === undefined) return [];
    const names = listing.entries.filter((entry) => entry.type === "file" && /\.ya?ml$/iu.test(entry.name)).map((entry) => entry.path).sort().slice(0, WORKFLOW_FILES_MAX);
    const files: Array<{ path: string; text: string }> = [];
    for (const path of names) {
      const file = await reader.read(path, WORKFLOW_FILE_MAX_BYTES);
      if (file !== undefined && file.tooLarge !== true) files.push({ path, text: file.text });
    }
    return ciChecksFromWorkflows(files, repositoryPath);
  } catch {
    return [];
  }
}

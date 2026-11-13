// One test id (NH-1 fix 1; contracts `test-id.ts`): puts a parsed report's tests into the form every consumer matches on, `file::name`, where for pytest that is the test's own node id
// (`tests/test_cart_rules.py::TestRules::test_discount_fails[x]`). Pytest's default JUnit XML (xunit2) writes `classname="tests.test_cart_rules.TestRules" name="test_discount_fails[x]"` and NO file, so the file and the classes are
// found by looking at the test files themselves: the longest dotted prefix of the classname that is a `.py` file under the check's directory is the file, and what is left of the classname is the class path. A report that
// names the file (`file=`, pytest's xunit1 family) gives the file directly. An absolute path (vitest and jest write one) is made relative to the check's directory, so the same test has the same id on any worker.
// Nothing is rewritten that is not a path or a class path; an id with whitespace stays what it is and `isSafeTestId` keeps it out of every list that is matched.
import { stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { isRerunnableTestId, type ProjectCommand } from "@rovara-code/contracts";
import { counted, type ParsedTestReport, type ReportedTest } from "./test-report.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A dotted pytest classname as a file and a class path, given a way to ask whether a `.py` file (relative to the check's directory) exists. The longest file wins; undefined when no prefix is a file. */
export async function pytestFileOf(classname: string, exists: (path: string) => Promise<boolean>): Promise<{ file: string; classes: string[] } | undefined> {
  const parts = classname.split(".");
  if (parts.length === 0 || !parts.every((part) => IDENTIFIER.test(part))) return undefined;
  for (let take = parts.length; take >= 1; take -= 1) {
    const file = `${parts.slice(0, take).join("/")}.py`;
    if (await exists(file)) return { file, classes: parts.slice(take) };
  }
  return undefined;
}

export interface TestIdContext {
  /** The workspace root. */
  root: string;
  /** The check's directory, relative to the root (its `cwd`): test files are looked for here, and absolute paths are made relative to it. */
  cwd: string;
}

/** A path made relative to the check's directory (or the workspace root) when it is absolute and lies under one of them; otherwise as it is, with forward slashes. */
function relativeFile(file: string, context: TestIdContext): string {
  const slashed = file.replaceAll("\\", "/");
  if (!isAbsolute(slashed)) return posix.normalize(slashed);
  const base = resolve(context.root, context.cwd);
  const under = relative(base, slashed);
  if (under !== "" && !under.startsWith("..") && !isAbsolute(under)) return under.split("\\").join("/");
  const fromRoot = relative(resolve(context.root), slashed);
  if (fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)) return fromRoot.split("\\").join("/");
  return slashed;
}

/** Finds a test's id file and class path for a series of tests of one check (the file checks are remembered). */
export function testIdResolver(context: TestIdContext): (test: { file?: string | undefined; name: string; classname?: string | undefined; fileGiven?: boolean | undefined }) => Promise<{ file?: string; name: string }> {
  const known = new Map<string, boolean>();
  const exists = async (file: string): Promise<boolean> => {
    const path = join(resolve(context.root, context.cwd), file);
    const cached = known.get(path);
    if (cached !== undefined) return cached;
    const found = await stat(path).then((info) => info.isFile(), () => false);
    known.set(path, found);
    return found;
  };
  return async (test) => {
    const { classname, fileGiven } = test;
    const asIs = { ...(test.file === undefined ? {} : { file: relativeFile(test.file, context) }), name: test.name };
    if (classname === undefined) return asIs;
    let file: string | undefined;
    let classes: string[] = [];
    if (fileGiven === true && test.file !== undefined) {
      // The report names the file; the classes are what the classname has after the file's own dotted form.
      file = relativeFile(test.file, context);
      const dotted = file.replace(/\.py$/u, "").split("/").join(".");
      classes = classname.startsWith(`${dotted}.`) ? classname.slice(dotted.length + 1).split(".") : [];
    } else {
      const found = await pytestFileOf(classname, exists);
      if (found !== undefined) ({ file, classes } = found);
    }
    // Not pytest (or not a file this check holds): as it was.
    return file === undefined ? asIs : { file, name: [...classes, test.name].join("::") };
  };
}

/** The report with each test in id form. Counts, statuses and durations are unchanged; a test that cannot be resolved keeps the file and name it had (made relative if it was an absolute path). */
export async function withTestIds(report: ParsedTestReport, context: TestIdContext): Promise<ParsedTestReport> {
  const resolveOne = testIdResolver(context);
  const tests: ReportedTest[] = [];
  for (const test of report.tests) {
    const { classname: _classname, fileGiven: _fileGiven, ...rest } = test; // eslint-disable-line @typescript-eslint/no-unused-vars -- the resolved file and name replace them
    if (report.format !== "junit") { tests.push({ ...rest, ...(rest.file === undefined ? {} : { file: relativeFile(rest.file, context) }) }); continue; }
    const found = await resolveOne(test);
    tests.push({ ...rest, ...(found.file === undefined ? {} : { file: found.file }), name: found.name });
  }
  return counted(report.format, tests);
}

// ---- a rerun that the runner understands

/** The test runners whose rerun of named tests Rovara knows how to ask for. */
export type SelectingRunner = "pytest" | "vitest" | "jest";
const baseName = (executable: string): string => executable.slice(executable.lastIndexOf("/") + 1);
const firstProgram = (args: readonly string[]): string | undefined => args.find((arg) => !arg.startsWith("-"));

/** The runner a test command starts: directly, as `python -m pytest`, or through `npx`, `bunx`, `pnpm exec|dlx` or `yarn exec|dlx`. Undefined for anything else (`make test`, `npm test`, mocha, go test). */
export function runnerOf(command: { executable: string; args: readonly string[] }): SelectingRunner | undefined {
  const name = baseName(command.executable);
  const known = (program: string | undefined): SelectingRunner | undefined => {
    const base = program === undefined ? undefined : baseName(program);
    return base === "pytest" || base === "vitest" || base === "jest" ? base : undefined;
  };
  if (known(name) !== undefined) return known(name);
  if (/^python(?:3(?:\.\d{1,2})?)?$/u.test(name)) return command.args[0] === "-m" && command.args[1] === "pytest" ? "pytest" : undefined;
  if (name === "npx" || name === "bunx") return known(firstProgram(command.args));
  if ((name === "pnpm" || name === "yarn") && (command.args[0] === "exec" || command.args[0] === "dlx")) return known(firstProgram(command.args.slice(1)));
  return undefined;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** The most commands one check's rerun makes (one per test file for vitest and jest). */
export const RERUN_COMMANDS_MAX = 50;

/**
 * The commands that run again exactly the given failing tests, or undefined when the runner is not one whose syntax is known (then those tests are counted and listed but not rerun: they are never called flaky).
 * pytest takes the node ids as arguments, in the check's approved `{tests}` place. vitest and jest take a test FILE and a `-t` pattern of the full names, one command per file (the pattern is the names, escaped, whole).
 * Arguments are separate elements and no shell reads them, so a space or a bracket in a name is only text. An id that starts with `-` or `@` is never passed.
 */
export function rerunCommandsOf(check: { command: ProjectCommand; selectArgs?: readonly string[] | undefined }, ids: readonly string[], selectIn: (command: ProjectCommand, selectArgs: readonly string[], ids: readonly string[]) => ProjectCommand): ProjectCommand[] | undefined {
  if (check.selectArgs === undefined || ids.length === 0 || !ids.every(isRerunnableTestId)) return undefined;
  const runner = runnerOf(check.command);
  if (runner === "pytest") {
    const command = selectIn(check.command, check.selectArgs, ids);
    return command === check.command ? undefined : [command];
  }
  if (runner === "vitest" || runner === "jest") {
    const byFile = new Map<string, string[]>();
    for (const id of ids) {
      const at = id.indexOf("::");
      if (at <= 0) return undefined;
      const file = id.slice(0, at);
      if (!isRerunnableTestId(file) || file.startsWith("/")) return undefined;
      byFile.set(file, [...(byFile.get(file) ?? []), id.slice(at + 2)]);
    }
    if (byFile.size > RERUN_COMMANDS_MAX) return undefined;
    return [...byFile].map(([file, names]) => ({ ...check.command, args: [...check.command.args, file, "-t", `^(?:${names.map(escapeRegExp).join("|")})$`] }));
  }
  return undefined;
}

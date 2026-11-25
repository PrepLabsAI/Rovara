// DEC 254zzz495 / N1: "Nothing found" is not "Failed". ONE classifier (`setupResultOf`) for every reader: nothing_found only for exit 1 + empty output + a PURE search or listing command;
// stderr present, exit 2 or more, a `source`, `||`, `;`, `&&` chains with a non-search step, command substitutions and package managers all stay failed.
import { describe, expect, it } from "vitest";
import { SETUP_NOTHING_FOUND_WORDS, SETUP_RESULT_WORDS, isPureSearchCommand, setupResultOf, type SetupResultWord } from "../../packages/contracts/src/index.js";

const result = (command: string, over: { exitCode?: number | null; timedOut?: boolean; tail?: string } = {}): SetupResultWord =>
  setupResultOf({ command, exitCode: 1, timedOut: false, tail: "", ...over });

describe("setupResultOf: exit 1 with nothing printed, by command", () => {
  const nothingFound = [
    "grep -r pytest .",
    "grep -rn pytest . 2>&1",
    "grep -rq 'def test_' src tests 2>/dev/null",
    "egrep -r 'pytest|unittest' .",
    "fgrep -r pytest .",
    "rg -n pytest",
    "rg --files | rg test_",
    "test -d tests",
    "[ -f pytest.ini ]",
    "which pytest",
    "type pytest",
    "command -v pytest",
    "cd repo/x && grep -r pytest .",
    "cd repo/x && rg -n foo | grep -v node_modules",
    "cd -- repo/x && grep -rq pytest .",
    "find . -name '*test*' | grep -v node_modules",
    "find . -type f -name '*.py' | xargs grep -l pytest | grep -v vendor",
    "ls tests | grep -i unit",
    "cat pyproject.toml | grep pytest",
    "find . -name conftest.py | sort | head -5 | grep conftest",
    "cd a && cd b && grep -r x .",
    "grep -r \"a && b\" .",
    "grep -r 'a | b ; c || d' .",
    "grep -rn 'x' .",
  ];
  it.each(nothingFound)("%s -> nothing_found", (command) => { expect(result(command)).toBe("nothing_found"); });

  const stayFailed: Array<[string, string]> = [
    ["the real beta case", 'cd repo/x && source .venv/bin/activate && find . -name "*test*" | grep -v node_modules'],
    ["source", "source .venv/bin/activate && grep -r pytest ."],
    ["the dot command", ". .venv/bin/activate && grep -r pytest ."],
    ["an or", "grep -r pytest . || true"],
    ["an or after a search", "grep -r pytest . || echo none"],
    ["a semicolon", "grep -r pytest . ; echo done"],
    ["a trailing background &", "grep -r pytest . &"],
    ["a command substitution", "grep -r $(cat patterns) ."],
    ["a command substitution in quotes", 'grep -r "$(cat patterns)" .'],
    ["a backtick", "grep -r `cat patterns` ."],
    ["pipefail", "set -o pipefail && grep -r pytest ."],
    ["pip", "pip install -r requirements.txt"],
    ["pip in a chain", "cd repo/x && pip install -r requirements.txt && grep -r pytest ."],
    ["python", "python -m pytest --collect-only"],
    ["python after a search", "grep -r pytest . && python -m pytest"],
    ["npm", "npm test"],
    ["a build tool as a stage", "cd repo/x && make test && grep -r x ."],
    ["find alone (find exits 0 on no match, so exit 1 is an error)", "find . -name '*test*'"],
    ["find with exec", "find . -name '*test*' -exec grep -l pytest {} +"],
    ["find with delete", "find . -name '*.pyc' -delete | grep x"],
    ["rg with a pre-processor", "rg --pre ./run.sh pytest"],
    ["sort writing a file", "grep -r x . | sort -o out.txt"],
    ["a write redirect", "grep -r pytest . > found.txt"],
    ["an append redirect", "grep -r pytest . >> found.txt"],
    ["an input redirect", "grep pytest < patterns"],
    ["a subshell", "(grep -r pytest .)"],
    ["a brace group", "{ grep -r pytest .; }"],
    ["an environment assignment", "FOO=1 grep -r pytest ."],
    ["a relative program path", "./grep -r pytest ."],
    ["a negation", "! grep -r pytest ."],
    ["a comment", "grep -r pytest . # nothing"],
    ["a newline", "grep -r pytest .\nrm -rf x"],
    ["a search that is not the last to run", "grep -r pytest . && ls"],
    ["a search before a non-search", "grep -r pytest . | python -c 'import sys'"],
    ["xargs as the last program (its exit is 123 when a run exits 1, never 1)", "find . -type f -name '*.py' | xargs grep -l pytest"],
    ["xargs of a non-read-only program", "find . -name '*.py' | xargs rm"],
    ["cd with a redirect", "cd missing 2>/dev/null && grep -r x ."],
    ["a discarded error on a non-last program", "find missing 2>/dev/null | grep x"],
    ["an unterminated quote", "grep -r 'pytest ."],
    ["ag (it has no exit code of its own for an error)", "ag pytest"],
    ["ag with its errors discarded", "ag pytest 2>/dev/null"],
    ["an empty command", ""],
    ["a lone pipe", "grep x . |"],
    ["a doubled and", "grep x . && && grep y ."],
    ["an eval", "eval grep -r pytest ."],
    ["bash -c", "bash -c 'grep -r pytest .'"],
  ];
  it.each(stayFailed)("%s -> failed", (_name, command) => { expect(result(command)).toBe("failed"); });
});

describe("setupResultOf: the other facts of an entry", () => {
  it("any output at all keeps a search failed (the tail is the merged, redacted output, so an error message is output)", () => {
    expect(result("grep -r pytest .", { tail: "grep: ./x: Permission denied\n" })).toBe("failed");
    expect(result("grep -r pytest .", { tail: "match.py:1:pytest" })).toBe("failed");
    expect(result("grep -r pytest .", { tail: "  \n\t" })).toBe("nothing_found");
  });
  it("exit 2 or more is failed (an error, per grep's and rg's own manuals), whatever the command", () => {
    expect(result("grep -r pytest .", { exitCode: 2 })).toBe("failed");
    expect(result("rg pytest", { exitCode: 2 })).toBe("failed");
    expect(result("grep -r pytest .", { exitCode: 127 })).toBe("failed");
    expect(result("grep -r pytest .", { exitCode: 255 })).toBe("failed");
  });
  it("an exit that is not known (a command that did not finish) is failed", () => {
    expect(result("grep -r pytest .", { exitCode: null })).toBe("failed");
    expect(result("grep -r pytest .", { exitCode: Number.NaN })).toBe("failed");
    expect(result("grep -r pytest .", { exitCode: -1 })).toBe("failed");
  });
  it("a timed-out search is timed_out, never nothing_found; exit 0 is worked, untouched", () => {
    expect(result("grep -r pytest .", { timedOut: true })).toBe("timed_out");
    expect(result("grep -r pytest .", { timedOut: true, exitCode: null })).toBe("timed_out");
    expect(result("cd x && rg -n foo | head", { exitCode: 0 })).toBe("worked");
    expect(result("npm ci", { exitCode: 0 })).toBe("worked");
    expect(result("npm test", { exitCode: 1, tail: "" })).toBe("failed");
  });
  it("the words are fixed", () => {
    expect([...SETUP_RESULT_WORDS]).toEqual(["worked", "nothing_found", "timed_out", "failed"]);
    expect(SETUP_NOTHING_FOUND_WORDS).toEqual({ row: "Nothing found", tooltip: "The search ran and matched nothing. That is an answer, not a failure." });
  });
});

describe("isPureSearchCommand", () => {
  it("is false for anything it cannot read whole and never throws", () => {
    for (const command of ["", " ", "|", "&&", "'", '"', "\\", "grep \\", "$(", "`", "grep x 2>", "grep x 2>&", "grep x 3>&1", "grep x >&2"]) expect(isPureSearchCommand(command), command).toBe(false);
  });
  it("reads quoted operators as plain text and escaped characters as plain", () => {
    expect(isPureSearchCommand("grep -r 'a;b' .")).toBe(true);
    expect(isPureSearchCommand('grep -r "a $HOME b" .')).toBe(true);
    expect(isPureSearchCommand("grep -r a\\;b .")).toBe(true);
    expect(isPureSearchCommand("find . \\( -name a -o -name b \\) | grep x")).toBe(true);
  });
});

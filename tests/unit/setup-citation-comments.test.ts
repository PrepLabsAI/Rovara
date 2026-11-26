// SETUP-CITATION-LINES pre-review S2: a command that is only in a comment is not a command the project uses. The comment rules are a small table by file type (citation-comments.ts); where they are unsure
// the citation fails toward unverified. Each case is a one-file repository whose only copy of the command is (or is not) in a comment.
import { describe, expect, it } from "vitest";
import type { SetupProposal } from "@agentx/contracts";
import { codeLinesOf, COMMENT_LINE, MAX_LINE_CHARS, type ScanMeter } from "../../packages/broker/src/core/setup-agent/citation-comments.js";
import { verifyProposalDetailed } from "../../packages/broker/src/core/setup-agent/proposal-verify.js";

const SHA = "a".repeat(40);
const COMMAND = "npm ci --silent";
const proposalFor = (path: string, quote: string): SetupProposal => ({
  version: 1, basedOnRevision: 1, repositories: [], setup: [{ id: "s", value: { repo: "demo", commands: [COMMAND] }, confidence: "high", risk: "low", from: [{ kind: "file", repo: "demo", path, commit: SHA, quote }] }], tests: [], checks: [],
  testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], foundNotUsed: [], notes: "",
}) as unknown as SetupProposal;
const verdict = async (path: string, text: string, quote = COMMAND): Promise<string> => (await verifyProposalDetailed(async () => text, proposalFor(path, quote), { now: () => 1_000 })).items["s"]!;

describe.each([
  // [name, path, text where the command is only in a comment, text where it is real code]
  ["a shell comment in a Markdown code fence", "README.md", "Install:\n```sh\n# npm ci --silent\nmake\n```\n", "Install:\n```sh\nnpm ci --silent\n```\n"],
  ["a Markdown comment over several lines", "README.md", "text\n<!--\nnpm ci --silent\n-->\nmore", "text\n<!--\nold\n-->\nnpm ci --silent\n"],
  ["a Markdown comment on one line", "README.md", "<!-- npm ci --silent -->\n", "<!-- note -->\nnpm ci --silent\n"],
  ["a trailing shell comment", "build.sh", "make build # was: npm ci --silent\n", "npm ci --silent # the quiet one\n"],
  ["a shell heredoc body", "build.sh", "cat <<EOF\nnpm ci --silent\nEOF\n", "cat <<EOF\nnote\nEOF\nnpm ci --silent\n"],
  ["a quoted shell heredoc body", "build.sh", "cat <<'END'\nnpm ci --silent\nEND\n", "cat <<'END'\nnote\nEND\nnpm ci --silent\n"],
  ["a Python docstring", "tool.py", "def f():\n    \"\"\"\n    npm ci --silent\n    \"\"\"\n", "def f():\n    \"\"\"doc\"\"\"\n    run(\"npm ci --silent\")\n"],
  ["a block comment's middle line", "build.ts", "/*\n npm ci --silent\n*/\n", "/* note */\nrun(\"npm ci --silent\");\n"],
  ["a trailing // comment", "build.ts", "const a = 1; // npm ci --silent\n", "const a = 1; // note\nrun(\"npm ci --silent\");\n"],
  ["a batch REM line", "build.bat", "REM npm ci --silent\n", "call npm ci --silent\n"],
  ["a batch :: line", "build.cmd", ":: npm ci --silent\n", "call npm ci --silent\n"],
  ["a YAML comment line", "ci.yml", "steps:\n  # npm ci --silent\n  - run: make\n", "steps:\n  - run: npm ci --silent # quiet\n"],
  ["an INI comment", "setup.cfg", "; npm ci --silent\n", "install = npm ci --silent\n"],
  ["a comment in a file of a type nobody listed", "notes.xyz", "// npm ci --silent\n", "run npm ci --silent\n"],
  ["a shell comment after a semicolon", "build.sh", "true;# npm ci --silent\n", "true; npm ci --silent\n"],
  ["a C-like comment after a semicolon", "build.ts", "foo();// npm ci --silent\n", "foo(); run(\"npm ci --silent\");\n"],
  ["a PowerShell block comment", "build.ps1", "<#\nnpm ci --silent\n#>\n", "<# note #>\nnpm ci --silent\n"],
  ["a PowerShell line comment", "build.ps1", "# npm ci --silent\n", "npm ci --silent # quiet\n"],
  ["a Ruby =begin block", "build.rb", "=begin\nnpm ci --silent\n=end\n", "=begin\nnote\n=end\nsystem(\"npm ci --silent\")\n"],
  ["a Makefile @-prefixed comment", "Makefile", "all:\n\t@# npm ci --silent\n", "all:\n\tnpm ci --silent\n"],
  ["a Markdown indented code comment", "README.md", "Run:\n\n    # npm ci --silent\n    make\n", "Run:\n\n    npm ci --silent\n"],
  ["a Jenkinsfile // comment", "Jenkinsfile", "// npm ci --silent\n", "sh 'npm ci --silent'\n"],
  ["a Jenkinsfile trailing comment", "Jenkinsfile", "stage('x') // npm ci --silent\n", "stage('x') // note\nsh 'npm ci --silent'\n"],
  ["a Gradle block comment", "build.gradle", "/*\n npm ci --silent\n*/\n", "/* note */\nexec { commandLine 'npm ci --silent' }\n"],
  ["a Dockerfile.dev comment", "Dockerfile.dev", "# npm ci --silent\nFROM node\n", "FROM node\nRUN npm ci --silent # quiet\n"],
  ["a Dockerfile.dev trailing comment", "Dockerfile.dev", "FROM node # npm ci --silent\n", "FROM node # note\nRUN npm ci --silent\n"],
  ["a CMakeLists.txt comment", "CMakeLists.txt", "# npm ci --silent\n", "execute_process(COMMAND npm ci --silent)\n"],
  ["a Terraform // comment", "main.tf", "// npm ci --silent\n", "provisioner \"local-exec\" { command = \"npm ci --silent\" }\n"],
  ["a Terraform block comment", "main.tf", "/*\n npm ci --silent\n*/\n", "/* note */\ncommand = \"npm ci --silent\"\n"],
  ["a PHP # comment", "build.php", "# npm ci --silent\n", "exec('npm ci --silent');\n"],
  ["a Vue HTML comment over lines", "App.vue", "<!--\nnpm ci --silent\n-->\n", "<!-- note -->\nnpm ci --silent\n"],
  ["a trailing comment in a file of a type nobody listed", "notes.xyz", "make # was: npm ci --silent\n", "make # note\nrun npm ci --silent\n"],
  ["a block comment's middle in a file of a type nobody listed", "notes.xyz", "/*\nnpm ci --silent\n*/\n", "/* note */\nrun npm ci --silent\n"],
  ["an HTML comment over lines in a file of a type nobody listed", "notes.xyz", "<!--\nnpm ci --silent\n-->\n", "<!-- note -->\nrun npm ci --silent\n"],
])("%s", (_name, path, commented, real) => {
  it("is refused when the only copy is in the comment", async () => { expect(await verdict(path, commented)).toBe("unverified"); });
  it("is accepted when the command is real code", async () => { expect(await verdict(path, real)).toBe("verified"); });
});

describe("what stays", () => {
  it("SQL: `--` comments out the rest of a line, so a command with a flag in a .sql file is refused (the cautious way)", async () => {
    expect(await verdict("seed.sql", "select 'npm ci --silent';\n")).toBe("unverified");
  });
  it("a Markdown heading that is not in a fence is text, not a comment", async () => {
    expect(await verdict("README.md", "# npm ci --silent\n")).toBe("verified");
  });
  it("a `#` inside a word or a URL fragment is not a comment marker", async () => {
    expect(await verdict("build.sh", "curl http://x/a#b && npm ci --silent\n", "curl http://x/a#b && npm ci --silent")).toBe("verified");
  });
  it("a comment that closes lets the next line be code again", async () => {
    expect(await verdict("build.ts", "/* a\n b */ run(\"npm ci --silent\");\n", "run(\"npm ci --silent\");")).toBe("verified");
  });
  it("a fence that closes ends the shell rules", async () => {
    expect(await verdict("README.md", "```\nmake\n```\n# npm ci --silent\n")).toBe("verified");
  });
});

describe("a long line is bounded work (Opus M1: a line of block comments was quadratic)", () => {
  const timed = (work: () => void): number => { const started = performance.now(); work(); return performance.now() - started; };

  it("a line over the cap is a comment line, and a 1 MB line of /**/ or of a minified bundle costs next to nothing", () => {
    expect(codeLinesOf(["x".repeat(MAX_LINE_CHARS + 1)], "a.ts")).toEqual([COMMENT_LINE]);
    expect(timed(() => codeLinesOf(["/**/".repeat(250_000)], "a.ts"))).toBeLessThan(200);
    expect(timed(() => codeLinesOf(["/*#__PURE__*/ call(\"https://example.com/x\");".repeat(25_000)], "bundle.js"))).toBeLessThan(200);
  });

  it("a line at the cap made of 4000 block comments is read in linear time (a 160 KB one used to take 16 s)", () => {
    const line = "/**/".repeat(MAX_LINE_CHARS / 4);
    expect(line.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    for (const path of ["a.ts", "a.sql", "a.php", "a.vue", "notes.xyz", "a.ps1", "README.md"]) expect(timed(() => codeLinesOf([line], path)), path).toBeLessThan(200);
  });

  it("a long line never carries a command: a quote on it is unverified, and the next line is read as usual", async () => {
    const long = `${"x".repeat(MAX_LINE_CHARS)} npm ci --silent`;
    expect(await verdict("build.sh", `${long}\n`)).toBe("unverified");
    expect(await verdict("build.sh", `${long}\nnpm ci --silent\n`)).toBe("verified");
  });
});

describe("the comment scan of a file is one pass (Opus delta M1: lines just under the cap, each full of block comments, took 73 s)", () => {
  // Opus's input: lines of "/* */ " repeated up to just under the cap, about 20 MB in all (1280 lines).
  const piece = "/* */ ";
  const line = piece.repeat(Math.floor((MAX_LINE_CHARS - 1) / piece.length));
  const wholeFile = Array.from({ length: 1_280 }, () => line);
  const timed = (work: () => void): number => { const started = performance.now(); work(); return performance.now() - started; };

  // The bound is relative, not an absolute cap: a loaded CI runner took 1.6 s for the 20 MB scan (an absolute 1.5 s cap flaked).
  // Linear scanning costs about 10x for 10x the input; a quadratic scan costs about 100x, so 20x plus a constant still catches it.
  const small = wholeFile.slice(0, 128); // about 2 MB of the same lines
  it.each(["a.ts", "a.tf", "a.vue", "notes.xyz", "a.sql", "a.php", "a.ps1", "README.md"])("a 20 MB file of those lines in %s is scanned in under 20 times the time of a 2 MB file of them", (path) => {
    expect(line.length).toBeLessThan(MAX_LINE_CHARS);
    const smallMs = timed(() => codeLinesOf(small, path));
    const bigMs = timed(() => { const code = codeLinesOf(wholeFile, path); expect(code).toHaveLength(wholeFile.length); });
    expect(bigMs, `${path} 20 MB ${bigMs.toFixed(0)} ms, 2 MB ${smallMs.toFixed(0)} ms`).toBeLessThan(20 * smallMs + 200);
  });

  it("the characters the scanner goes over stay within twice the file's size, for every kind of comment and whatever the line holds", () => {
    const shapes = [piece, "/**/", "<!-- x --> ", "// a ", "x # y ", "a/*b*/", "-- a ", "<# z #> "];
    for (const path of ["a.ts", "a.tf", "a.vue", "notes.xyz", "a.sql", "a.php", "a.ps1", "a.sh", "README.md", "a.html"]) {
      for (const shape of shapes) {
        const lines = Array.from({ length: 20 }, () => shape.repeat(Math.floor(8_000 / shape.length)));
        const meter: ScanMeter = { scanned: 0 };
        codeLinesOf(lines, path, { meter });
        expect(meter.scanned, `${path} ${shape}`).toBeLessThanOrEqual(2 * lines.reduce((total, one) => total + one.length, 0));
      }
    }
  });

  it("a file past the scan budget reads as comment from there on (fail closed), and a line over the cap is a comment whatever the budget", () => {
    const lines = ["npm ci", "npm test", "npm run build", "npm run lint"];
    expect(codeLinesOf(lines, "a.sh", { budget: { left: 15 } })).toEqual(["npm ci", "npm test", COMMENT_LINE, COMMENT_LINE]);
    expect(codeLinesOf(lines, "a.sh", { budget: { left: 1_000 } })).toEqual(lines);
  });
});

// Plan quality for Rovara Code version 2 (graded runs scored plans low for the same four gaps): loose input validation, no test of a new option
// combined with the existing ones or above the item count, a Checks section that listed lint but not the `npm test` the repository's CI requires, and a pull request that did not name the
// commit it was tested on. This file pins the guidance the planner, the plan critic and the builder are given (exact text, so a rewording is a deliberate change), and the deterministic
// part: the checks the repository's CI workflow files require are read, merged into the plan's proposed checks and shown in its Checks section whether they are proposed or already run as
// project checks. The pull request line is tested in rovara-code-pr-body.test.ts, and the digests in rovara-code-golden.test.ts.
import { describe, expect, it } from "vitest";
import { builtinRecipe, ROVARA_CODE_BUILD_GUIDANCE, ROVARA_CODE_PLAN_GUIDANCE } from "../../packages/contracts/src/agent-templates.js";
import { PLAN_DOCUMENT_INFO_STRING, parsePlanDocument, planAnswerProposesChecks, planDocumentMarkdown, withCiChecks, type CiCheckInput } from "../../packages/contracts/src/workflow-plan-document.js";
import { PLAN_CRITIC_QUALITY_CHECKLIST, planCritiquePrompt } from "../../packages/core/src/rovara-code/critic.js";
import { CI_CHECKS_MAX, ciChecksFromWorkflows, readCiChecks } from "../../packages/core/src/rovara-code/ci-checks.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

// ---- the guidance, word for word

const PLAN_GUIDANCE = [
  "Plan the input rules, the tests and the checks as well as the code.",
  "- Input: say exactly which values are accepted and which are rejected (empty, padded with spaces, signed, decimal, exponent, hex, below the minimum, above the maximum), and parse strictly. A loose conversion such as Number() or parseInt() accepts values the rule does not.",
  "- Tests: for each new option, plan a test alone, one combined with each existing option it can meet (such as filters), and one at each boundary: the minimum, the maximum, one past each, and a value above the number of available items.",
  "- Checks: list every check the repository's CI requires. Read its workflow files, and do not stop at lint.",
].join("\n");

const BUILD_GUIDANCE = [
  "Validate input strictly: accept only the documented form and reject everything else with a clear error before doing any work.",
  "Do not rely on a loose conversion such as Number() or parseInt(), which accepts padding, exponents, hex and decimals.",
  "Write tests for each new option alone, combined with the existing options, and at its boundaries (the minimum, the maximum, one past each, and above the number of available items).",
  "Run the plan's checks and the repository's own test command before you finish.",
].join("\n");

const CRITIC_CHECKLIST = "Also hold the plan to this checklist, and report a gap as a blocking point when it would let bad input through or leave the change untested: it validates input strictly, with explicit rejection cases; it tests each new option alone, combined with the existing options and at the boundaries; and its checks include every check the repository's CI requires.";

describe("the guidance Rovara Code version 2 is given", () => {
  it("pins the planner's, the builder's and the plan critic's text", () => {
    expect(ROVARA_CODE_PLAN_GUIDANCE).toBe(PLAN_GUIDANCE);
    expect(ROVARA_CODE_BUILD_GUIDANCE).toBe(BUILD_GUIDANCE);
    expect(PLAN_CRITIC_QUALITY_CHECKLIST).toBe(CRITIC_CHECKLIST);
  });

  it("is general: it names no scenario, file or command of a particular project", () => {
    for (const text of [PLAN_GUIDANCE, BUILD_GUIDANCE, CRITIC_CHECKLIST]) expect(text).not.toMatch(/limit|tasklog|open task|--|\.ts\b|\.json\b/iu);
  });

  it("is kept short", () => {
    for (const text of [PLAN_GUIDANCE, BUILD_GUIDANCE, CRITIC_CHECKLIST]) expect(Buffer.byteLength(text, "utf8")).toBeLessThan(700);
  });

  it("is in version 2's plan and build steps, as the step's own instructions, and nowhere else", () => {
    const v2 = builtinRecipe("rovara-code", 2);
    const byId = Object.fromEntries(v2.steps.map((step) => [step.id, (step.settings as { instructions: unknown[] }).instructions]));
    expect(byId["plan"]).toEqual([{ agentName: "Rovara Code", text: PLAN_GUIDANCE }]);
    expect(byId["build"]).toEqual([{ agentName: "Rovara Code", text: BUILD_GUIDANCE }]);
    // The plan check takes its checklist from Rovara's own prompt, so a company overlay on the step cannot lose it; the other steps are as they were.
    for (const id of ["plan_critic", "check", "review", "pull_request"]) expect(byId[id], id).toEqual([]);
    expect(v2.instructions).toEqual([]);
  });

  it("leaves version 1 exactly as it shipped: no instructions anywhere", () => {
    const v1 = builtinRecipe("rovara-code", 1);
    expect(v1.instructions).toEqual([]);
    for (const step of v1.steps) expect((step.settings as { instructions: unknown[] }).instructions, step.id).toEqual([]);
  });

  it("is on the plan check's checklist, after the problems it already looks for and before the plan it reads", () => {
    const prompt = planCritiquePrompt({ plan: "THE PLAN BODY", request: "do a thing" });
    expect(prompt).toContain(CRITIC_CHECKLIST);
    expect(prompt.indexOf("no way to test it")).toBeLessThan(prompt.indexOf(CRITIC_CHECKLIST));
    expect(prompt.indexOf(CRITIC_CHECKLIST)).toBeLessThan(prompt.indexOf("THE PLAN BODY"));
    // The critic still advises and decides nothing.
    expect(prompt).toContain("You advise; you do not decide.");
  });
});

// ---- the CI checks, read from the repository's workflow files

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Lint and type-check
        run: npm run lint
      - run: npm test
`;
const files = (...entries: Array<[string, string]>) => entries.map(([path, text]) => ({ path, text }));
const commandOf = (check: { executable: string; args: readonly string[] }) => [check.executable, ...check.args].join(" ");
const fromRun = (run: string, extra = "") => ciChecksFromWorkflows(files([".github/workflows/ci.yml", `on: pull_request\njobs:\n  j:\n    steps:\n${extra}      - run: ${run}\n`]), "repo/app").map(commandOf);

describe("the checks a repository's CI requires", () => {
  it("are the verification commands of its workflow, in order, with the step's name or the command as the label, in the repository's folder", () => {
    const checks = ciChecksFromWorkflows(files([".github/workflows/ci.yml", CI]), "repo/app");
    expect(checks.map((check) => [check.label, commandOf(check), check.cwd])).toEqual([
      ["CI: Lint and type-check", "npm run lint", "repo/app"],
      ["CI: npm test", "npm test", "repo/app"],
    ]);
  });

  it("leave out installs, setup and anything else that is not a check", () => {
    for (const run of ["npm ci", "npm install", "pip install -r requirements.txt", "echo hello", "npm publish", "npm run deploy", "npm start", "git push", "curl -fsSL https://x.test/i.sh", "docker build ."]) {
      expect(fromRun(run), run).toEqual([]);
    }
  });

  it("read only simple commands: no pipe, redirect, substitution, variable, quote or other shell syntax", () => {
    for (const run of ["npm test | tee out.txt", "npm test > out.txt", "npm test || true", "npm test; echo done", "npm test $EXTRA", "npm run lint -- \"src/*\"", "npm test $(echo 1)", "npm test `id`",
      "npm run ${{ matrix.script }}", "CI=true npm test", "npm test &", "npm test --silent=\\ true"]) {
      expect(fromRun(run), run).toEqual([]);
    }
  });

  it("read each line of a multi-line run, and a chain joined with &&", () => {
    expect(fromRun("|\n          npm run lint\n          echo done\n          npm run typecheck && npm test")).toEqual(["npm run lint", "npm run typecheck", "npm test"]);
  });

  it("join a line continued with a backslash", () => {
    expect(fromRun("|\n          npm run test \\\n            --workspaces")).toEqual(["npm run test --workspaces"]);
  });

  it("know the usual verification commands of the common ecosystems", () => {
    for (const run of ["npm test", "npm run test:unit", "npm run lint", "npm run typecheck", "npm run type-check", "npm run check", "npm run build", "pnpm test", "pnpm run lint", "yarn test", "yarn lint", "npx vitest run", "npx eslint .", "npx tsc --noEmit",
      "pytest", "python -m pytest", "python3 -m pytest -q", "ruff check .", "mypy src", "go test ./...", "go vet ./...", "cargo test", "cargo clippy", "cargo fmt --check", "make test", "make lint", "tox", "uv run pytest"]) {
      expect(fromRun(run), run).toEqual([run]);
    }
  });

  it("do not take a script or a make target that is not a check, or a program that is not known", () => {
    for (const run of ["npm run seed", "npm run dev", "make install", "make deploy", "yarn dev", "go run main.go", "cargo run", "./scripts/anything.sh", "bash ci.sh", "rm -rf node_modules"]) expect(fromRun(run), run).toEqual([]);
  });

  it("run in the step's working-directory, or after a cd, when it stays inside the repository", () => {
    const inFolder = ciChecksFromWorkflows(files([".github/workflows/ci.yml", `on: [pull_request]\njobs:\n  j:\n    steps:\n      - run: npm test\n        working-directory: web\n      - run: cd api && npm test\n`]), "repo/app");
    expect(inFolder.map((check) => [commandOf(check), check.cwd])).toEqual([["npm test", "repo/app/web"], ["npm test", "repo/app/api"]]);
    const defaults = ciChecksFromWorkflows(files([".github/workflows/ci.yml", `on: [pull_request]\njobs:\n  j:\n    defaults:\n      run:\n        working-directory: ui\n    steps:\n      - run: npm test\n`]), "repo/app");
    expect(defaults.map((check) => check.cwd)).toEqual(["repo/app/ui"]);
    for (const folder of ["..", "../other", "/etc", "a/../..", "web dir", "~", "$HOME", "${{ github.workspace }}"]) {
      const out = ciChecksFromWorkflows(files([".github/workflows/ci.yml", `on: [pull_request]\njobs:\n  j:\n    steps:\n      - run: npm test\n        working-directory: ${JSON.stringify(folder)}\n`]), "repo/app");
      expect(out, folder).toEqual([]);
    }
    expect(fromRun("cd .. && npm test")).toEqual([]);
  });

  it("come only from workflows that run on a push or a pull request", () => {
    const run = "    steps:\n      - run: npm test\n";
    for (const on of ["push", "pull_request", "[push, workflow_dispatch]", "{ pull_request: { branches: [main] } }", "pull_request_target"]) {
      expect(ciChecksFromWorkflows(files([".github/workflows/a.yml", `on: ${on}\njobs:\n  j:\n${run}`]), "r").map(commandOf), on).toEqual(["npm test"]);
    }
    for (const on of ["schedule:\n    - cron: '0 3 * * *'", "workflow_dispatch", "release:\n    types: [published]", "issue_comment"]) {
      expect(ciChecksFromWorkflows(files([".github/workflows/a.yml", `on:\n  ${on}\njobs:\n  j:\n${run}`]), "r"), on).toEqual([]);
    }
  });

  it("are listed once however many workflows run them, workflow files in name order", () => {
    const one = (name: string, run: string) => [`.github/workflows/${name}`, `on: push\njobs:\n  j:\n    steps:\n      - run: ${run}\n`] as [string, string];
    const checks = ciChecksFromWorkflows(files(one("b.yml", "npm test"), one("a.yaml", "npm run lint"), one("c.yml", "npm test")), "r");
    expect(checks.map(commandOf)).toEqual(["npm run lint", "npm test"]);
  });

  it("are bounded, and a label is one plain line of at most 80 characters", () => {
    const many = Array.from({ length: 20 }, (_, index) => `      - run: npm run test:suite${index}`).join("\n");
    expect(ciChecksFromWorkflows(files([".github/workflows/ci.yml", `on: push\njobs:\n  j:\n    steps:\n${many}\n`]), "r")).toHaveLength(CI_CHECKS_MAX);
    const long = ciChecksFromWorkflows(files([".github/workflows/ci.yml", `on: push\njobs:\n  j:\n    steps:\n      - name: "${"x".repeat(200)}\\n second line"\n        run: npm test\n`]), "r");
    expect(long[0]!.label.length).toBeLessThanOrEqual(80);
    expect([...long[0]!.label].every((char) => char.charCodeAt(0) >= 0x20)).toBe(true);
  });

  it("are empty, not an error, for a workflow that is not YAML or is the wrong shape", () => {
    for (const text of ["", ":::: not yaml [", "on: push\njobs: 7\n", "- a\n- b\n", "on: push\njobs:\n  j:\n    steps: nope\n", "on: push\njobs:\n  j:\n    steps:\n      - run: 12\n"]) {
      expect(ciChecksFromWorkflows(files([".github/workflows/ci.yml", text]), "r"), text).toEqual([]);
    }
  });
});

describe("reading a repository's workflow folder", () => {
  const reader = (tree: Record<string, string | { tooLarge: true }>, options: { listFails?: boolean; truncated?: boolean } = {}) => ({
    list: async (path: string) => {
      if (options.listFails === true) throw new Error("GitHub is down");
      const entries = Object.keys(tree).filter((name) => name.startsWith(`${path}/`)).map((name) => ({ name: name.slice(path.length + 1), path: name, type: "file" as const, sha: "a".repeat(40), size: 10 }));
      return entries.length === 0 ? undefined : { entries, truncated: options.truncated === true };
    },
    read: async (path: string) => {
      const value = tree[path];
      if (value === undefined) return undefined;
      return typeof value === "string" ? { sha: "a".repeat(40), size: value.length, text: value } : { sha: "a".repeat(40), size: 9_999_999, tooLarge: true as const };
    },
  });

  it("reads the yml and yaml files of .github/workflows and nothing else", async () => {
    const checks = await readCiChecks(reader({ ".github/workflows/ci.yml": CI, ".github/workflows/README.md": "npm run nothing", ".github/workflows/big.yml": { tooLarge: true } }), "repo/app");
    expect(checks.map(commandOf)).toEqual(["npm run lint", "npm test"]);
  });

  it("is empty when there is no workflow folder or GitHub can't answer: the plan goes on without it", async () => {
    expect(await readCiChecks(reader({}), "repo/app")).toEqual([]);
    expect(await readCiChecks(reader({ ".github/workflows/ci.yml": CI }, { listFails: true }), "repo/app")).toEqual([]);
  });
});

// ---- merging them into the plan's checks

const PLAN = planDocument();
const unit: CiCheckInput = { label: "CI: npm test", cwd: "repo/app", executable: "npm", args: ["test"] };
const lint: CiCheckInput = { label: "CI: Lint", cwd: "repo/app", executable: "npm", args: ["run", "lint"] };
const readChecks = (answer: string, required: Array<{ id: string; label: string; command: { cwd: string; executable: string; args: string[]; timeoutSeconds: number } }> = [], listRequired = false) => {
  const parsed = parsePlanDocument(answer, { kind: "plan", checks: { repositoryPaths: ["repo/app"], required, ...(listRequired ? { listRequired: true } : {}) } });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.plan.checks!;
};

describe("a plan answer with the CI checks merged in", () => {
  it("adds them to the checks member after the planner's own, each proving nothing yet and running for the default time", () => {
    const answer = planAnswer(PLAN, { checks: { checks: [{ label: "Lint", cwd: "repo/app", executable: "npm", args: ["run", "lint"], proves: ["1"] }] } });
    const merged = withCiChecks(answer, [lint, unit]);
    const checks = readChecks(merged);
    expect(checks.proposed.map((check) => [check.label, check.command.executable, ...check.command.args])).toEqual([["Lint", "npm", "run", "lint"], ["CI: npm test", "npm", "test"]]);
    expect(checks.proves).toEqual({ "proposed-1": ["1"], "proposed-2": [] });
    expect(checks.proposed[1]!.command.timeoutSeconds).toBe(600);
  });

  it("starts the checks member when the planner wrote none, and drops its none_reason when checks are added", () => {
    const bare = readChecks(withCiChecks(planAnswer(PLAN), [unit]));
    expect(bare.proposed).toHaveLength(1);
    const none = readChecks(withCiChecks(planAnswer(PLAN, { checks: { checks: [], none_reason: "No tests exist." } }), [unit]));
    expect(none.proposed).toHaveLength(1);
    expect(none.noneReason).toBeUndefined();
  });

  it("does not repeat a command the planner already proposed, and keeps the planner's label and claims", () => {
    const answer = planAnswer(PLAN, { checks: { checks: [{ label: "Unit tests", cwd: "repo/app", executable: "npm", args: ["test"], proves: ["2"] }] } });
    const checks = readChecks(withCiChecks(answer, [unit]));
    expect(checks.proposed.map((check) => check.label)).toEqual(["Unit tests"]);
    expect(checks.proves).toEqual({ "proposed-1": ["2"] });
  });

  it("stops at the most checks a plan may propose, and keeps the planner's first", () => {
    const own = Array.from({ length: 7 }, (_, index) => ({ label: `Own ${index}`, cwd: "repo/app", executable: "npm", args: ["run", `own${index}`], proves: ["1"] }));
    const checks = readChecks(withCiChecks(planAnswer(PLAN, { checks: { checks: own } }), [lint, unit]));
    expect(checks.proposed.map((check) => check.label)).toEqual([...own.map((check) => check.label), "CI: Lint"]);
  });

  it("leaves an answer it can't read exactly as it was", () => {
    for (const answer of ["no block at all", "```agentx-plan\n{not json\n```\n", `\`\`\`${PLAN_DOCUMENT_INFO_STRING}\n[1, 2]\n\`\`\`\n`, `\`\`\`${PLAN_DOCUMENT_INFO_STRING}\n{"checks": "oops"}\n\`\`\`\n`, `\`\`\`${PLAN_DOCUMENT_INFO_STRING}\n{"checks": {"checks": 5}}\n\`\`\`\n`]) {
      expect(withCiChecks(answer, [unit]), answer).toBe(answer);
    }
    const plain = planAnswer(PLAN);
    expect(withCiChecks(plain, [])).toBe(plain);
  });

  it("skips a check the rules for a proposed check would refuse, rather than make every check unreadable", () => {
    const refused: CiCheckInput[] = [{ ...unit, executable: "npm test" }, { ...unit, cwd: "../elsewhere" }, { ...unit, label: "two\nlines" }, { ...unit, args: ["a\nb"] }];
    expect(withCiChecks(planAnswer(PLAN), refused)).toBe(planAnswer(PLAN));
    expect(readChecks(withCiChecks(planAnswer(PLAN), [...refused, unit])).proposed).toHaveLength(1);
  });

  it("makes the answer propose checks, which is why the parts rule is read from the answer as the planner wrote it", () => {
    expect(planAnswerProposesChecks(planAnswer(PLAN))).toBe(false);
    expect(planAnswerProposesChecks(withCiChecks(planAnswer(PLAN), [unit]))).toBe(true);
  });
});

// ---- the Checks section

const required = [{ id: "required-1", label: "npm test", command: { cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 30 } }];
const markdown = (plan: ReturnType<typeof readChecks>) => planDocumentMarkdown({ ...PLAN, checks: plan }, { kind: "plan", version: 1, sha256: "a".repeat(64) });
const section = (text: string) => {
  const start = text.indexOf("## Checks");
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end).trimEnd();
};

describe("the Checks section of a version 2 plan", () => {
  it("lists the project checks that always run beside the proposed ones, so a CI check the project already runs is not hidden", () => {
    const answer = withCiChecks(planAnswer(PLAN, { checks: { checks: [{ label: "Lint", cwd: "repo/app", executable: "npm", args: ["run", "lint"], proves: ["1"] }] } }), [unit]);
    const checks = readChecks(answer, required, true);
    expect(checks.proposed.map((check) => check.label)).toEqual(["Lint"]);
    expect(checks.alsoRun).toEqual(required);
    expect(section(markdown(checks))).toBe([
      "## Checks",
      "- Lint: `npm run lint` in `repo/app` — proves 1",
      "- npm test: `npm test` in `repo/app` (a project check; it always runs)",
    ].join("\n"));
  });

  it("shows the project checks when nothing else is proposed, and does not say none apply", () => {
    const checks = readChecks(planAnswer(PLAN, { checks: { checks: [], none_reason: "Docs only." } }), required, true);
    expect(section(markdown(checks))).toBe("## Checks\n- npm test: `npm test` in `repo/app` (a project check; it always runs)");
  });

  it("is as it was when the project has no checks of its own, or for a version 1 plan (no listing asked for)", () => {
    const answer = planAnswer(PLAN, { checks: { checks: [{ label: "Lint", cwd: "repo/app", executable: "npm", args: ["run", "lint"], proves: ["1"] }] } });
    expect(readChecks(answer, [], true)).not.toHaveProperty("alsoRun");
    expect(readChecks(answer, required, false)).not.toHaveProperty("alsoRun");
    expect(section(markdown(readChecks(answer, required, false)))).toBe("## Checks\n- Lint: `npm run lint` in `repo/app` — proves 1");
    expect(section(markdown(readChecks(planAnswer(PLAN, { checks: { checks: [], none_reason: "Docs only." } }), required, false)))).toBe("## Checks\n- None apply: Docs only.");
  });

  it("shows a project check's text redacted and on one line", () => {
    const secret = [{ id: "required-1", label: "token AKIAIOSFODNN7EXAMPLE\ncheck", command: { cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 30 } }];
    const text = section(markdown(readChecks(planAnswer(PLAN), secret, true)));
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text.split("\n")).toHaveLength(2);
  });
});

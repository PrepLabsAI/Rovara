// SETUP-L2-RUNNABLE (owner Q6): a smoke check the setup agent wrote for a repository with no tests is the agent's, not the project's. It is proposed as a check (never a test, so setup apply never turns it into a test
// command: off until a person turns it on), carries the label "Smoke check written by Rovara" in its name and in a citation note, and the agent's prompt says it must not write anything.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SETUP_AGENT_SMOKE_LINES, setupAgentInstructions } from "../../packages/worker/src/setup-agent-prompt.js";
import { SETUP_SMOKE_CHECK_LABEL, labelSmokeChecks, readSetupProposalAnswer, setupProposalFormatLines } from "../../packages/worker/src/setup-draft.js";

const block = (answer: unknown): string => `Done.\n\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "setup-smoke-"));
  await mkdir(join(root, "app", "src"), { recursive: true });
  await writeFile(join(root, "app", "README.md"), "# app\nsource .venv/bin/activate && pip install -r requirements.txt\n");
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const read = async (answer: unknown) => {
  const result = await readSetupProposalAnswer(block(answer), { basedOnRevision: 1, rootPath: root, repositories: [{ name: "app", path: "app", resolvedCommit: "a".repeat(40) }] });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.proposal;
};
const inferred = (note: string) => [{ kind: "inferred", repo: "app", note }];

describe("smoke checks written by Rovara", () => {
  it("a check the agent named 'Smoke check ...' is labelled in its name and in its citation, and stays a check", async () => {
    const proposal = await read({ checks: [{ name: "Smoke check: import", repo: "app", command: ".venv/bin/python -B -c 'import src'", from: inferred("the repo has no tests") }] });
    expect(proposal.tests).toEqual([]);
    expect(proposal.checks).toHaveLength(1);
    expect(proposal.checks[0]!.value.name).toBe(`${SETUP_SMOKE_CHECK_LABEL}: import`);
    expect(proposal.checks[0]!.from[0]!.note).toBe(`${SETUP_SMOKE_CHECK_LABEL}: the repo has no tests`);
  });
  it("a tests entry the agent marked smokeCheck is moved to checks, one check per command, never a test", async () => {
    const proposal = await read({ tests: [{ repo: "app", commands: ["node -e 'require(1)'", "node --version"], smokeCheck: true, from: inferred("no tests") }] });
    expect(proposal.tests).toEqual([]);
    expect(proposal.checks.map((item) => item.value.command)).toEqual(["node -e 'require(1)'", "node --version"]);
    expect(new Set(proposal.checks.map((item) => item.value.name)).size).toBe(2);
    for (const item of proposal.checks) expect(item.value.name.startsWith(SETUP_SMOKE_CHECK_LABEL)).toBe(true);
  });
  it("a smoke check with no inferred note gets the label as its own place", async () => {
    const proposal = await read({ checks: [{ name: "x", repo: "app", command: "node --version", smokeCheck: true, from: [{ kind: "readme", repo: "app", path: "README.md", quote: "node --version" }] }] });
    expect(proposal.checks[0]!.from.map((place) => place.note)).toContain(SETUP_SMOKE_CHECK_LABEL);
  });
  it("a real test and a real check are left alone", async () => {
    const proposal = await read({
      tests: [{ repo: "app", commands: ["pytest"], from: [{ kind: "readme", repo: "app", path: "README.md", quote: "pytest" }] }],
      checks: [{ name: "lint", repo: "app", command: "ruff check", from: inferred("CI runs it") }],
    });
    expect(proposal.tests.flatMap((item) => item.value.commands)).toEqual(["pytest"]);
    expect(proposal.checks.map((item) => [item.value.name, item.from[0]!.note])).toEqual([["lint", "CI runs it"]]);
  });
  it("labelSmokeChecks does not change the answer it is given, and leaves an answer with no smoke check alone", () => {
    const answer = { tests: [{ repo: "app", commands: ["a"], smokeCheck: true }], checks: [] };
    const copy = structuredClone(answer);
    labelSmokeChecks(answer);
    expect(answer).toEqual(copy);
    expect(labelSmokeChecks({ setup: [] })).toEqual({ setup: [] });
  });
});

describe("what the setup agent is told", () => {
  const prompt = setupAgentInstructions({ repositories: [{ name: "app", path: "app" }], limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 } });
  it("smoke checks go in checks, never tests, are labelled, and must not write", () => {
    for (const line of SETUP_AGENT_SMOKE_LINES) expect(prompt).toContain(line);
    const smoke = SETUP_AGENT_SMOKE_LINES.join("\n");
    expect(smoke).toContain("never in `tests`");
    expect(smoke).toContain(SETUP_SMOKE_CHECK_LABEL);
    expect(smoke).toMatch(/must not write anything/);
    expect(smoke).toContain("-B");
  });
  it("the rules no longer say a step with | or ; must be a script: they say the commands run as shell lines in one session", () => {
    const rules = setupProposalFormatLines(undefined).join("\n");
    expect(rules).not.toContain("No `|` or `;`");
    expect(rules).toContain("shell lines, in order, in one session");
    expect(rules).toContain("npm run lint && npm test");
  });
});

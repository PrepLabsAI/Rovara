// Proposed checks: the planner's `agentx-checks` block, read all or nothing.
import { describe, expect, it } from "vitest";
import { WorkflowCheckPolicySchema, extractProposedChecks, parseProposedChecks, proposedCheckTextIssues, workflowSelectedChecks, type WorkflowCheck } from "@agentx/contracts";

const UNREADABLE = "AgentX could not read the proposed checks";
const repositoryPaths = ["workspace/payments", "workspace/web"];
const required: WorkflowCheck[] = [
  { id: "required-1", label: "npm test", command: { cwd: "workspace/payments", executable: "npm", args: ["test"], timeoutSeconds: 120 } },
];
const input = { repositoryPaths, required };

function planWith(body: unknown, info = "agentx-checks"): string {
  return `# Plan\n\n1. Fix retry handling.\n\n\`\`\`${info}\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}
const check = (overrides: Record<string, unknown> = {}) => ({
  label: "Retry tests", cwd: "workspace/payments", executable: "npx", args: ["vitest", "run", "tests/retry.test.ts"], ...overrides,
});

describe("parseProposedChecks", () => {
  it("reads a valid block, numbers the checks and defaults the timeout to 600 seconds", () => {
    const plan = planWith({ checks: [check(), check({ label: "Web lint", cwd: "workspace/web/app", executable: "./scripts/lint.sh", args: [], timeoutSeconds: 1800 })] });
    expect(parseProposedChecks(plan, input)).toEqual({ proposed: [
      { id: "proposed-1", label: "Retry tests", command: { cwd: "workspace/payments", executable: "npx", args: ["vitest", "run", "tests/retry.test.ts"], timeoutSeconds: 600 } },
      { id: "proposed-2", label: "Web lint", command: { cwd: "workspace/web/app", executable: "./scripts/lint.sh", args: [], timeoutSeconds: 1800 } },
    ] });
  });

  it("uses the last agentx-checks block and ignores blocks with another info string", () => {
    const plan = `${planWith({ checks: [check({ label: "First" })] })}\n${planWith({ checks: [check({ label: "Second" })] })}\n${planWith({ checks: [check({ label: "Other" })] }, "agentx-checks json")}`;
    expect(parseProposedChecks(plan, input).proposed.map((entry) => entry.label)).toEqual(["Second"]);
  });

  it("proposes nothing, with no note, when the plan has no block", () => {
    expect(parseProposedChecks("# Plan\n\n```json\n{\"checks\":[]}\n```\n", input)).toEqual({ proposed: [] });
  });

  it("keeps the plan's reason for proposing no checks", () => {
    expect(parseProposedChecks(planWith({ checks: [], none_reason: "Docs-only change." }), input)).toEqual({ proposed: [], noneReason: "Docs-only change." });
    expect(parseProposedChecks(planWith({ checks: [], none_reason: null }), input)).toEqual({ proposed: [] });
  });

  it("drops a proposal identical to a required project check and numbers the rest", () => {
    const plan = planWith({ checks: [check({ label: "Same as project", executable: "npm", args: ["test"] }), check()] });
    expect(parseProposedChecks(plan, input).proposed).toEqual([expect.objectContaining({ id: "proposed-1", label: "Retry tests" })]);
  });

  it("keeps only the first of identical proposals in the same block", () => {
    const plan = planWith({ checks: [check({ label: "First" }), check({ label: "Again", timeoutSeconds: 60 }), check({ label: "Other", args: ["vitest"] })] });
    expect(parseProposedChecks(plan, input).proposed.map((entry) => [entry.id, entry.label])).toEqual([["proposed-1", "First"], ["proposed-2", "Other"]]);
  });

  const unreadable: Array<[string, string]> = [
    ["malformed JSON", planWith("{ checks: [")],
    ["an unclosed block", "# Plan\n\n```agentx-checks\n{\"checks\":[]}\n"],
    ["more than 8 checks", planWith({ checks: Array.from({ length: 9 }, (_, index) => check({ label: `Check ${index}` })) })],
    ["a cwd outside every repository", planWith({ checks: [check({ cwd: "workspace/other" })] })],
    ["a cwd sharing only a name prefix with a repository", planWith({ checks: [check({ cwd: "workspace/payments-old" })] })],
    ["a cwd with ..", planWith({ checks: [check({ cwd: "workspace/payments/../web" })] })],
    ["an absolute cwd", planWith({ checks: [check({ cwd: "/workspace/payments" })] })],
    ["an executable path not starting with ./", planWith({ checks: [check({ executable: "scripts/test.sh" })] })],
    ["an absolute executable", planWith({ checks: [check({ executable: "/bin/sh" })] })],
    ["an executable path with ..", planWith({ checks: [check({ executable: "./../test.sh" })] })],
    ["an executable with a space", planWith({ checks: [check({ executable: "npm test" })] })],
    ["an executable path with a space", planWith({ checks: [check({ executable: "./run tests.sh" })] })],
    ["an executable with ;", planWith({ checks: [check({ executable: "npm;ls" })] })],
    ["more than 32 args", planWith({ checks: [check({ args: Array.from({ length: 33 }, () => "x") })] })],
    ["an arg over 1,024 characters", planWith({ checks: [check({ args: ["x".repeat(1025)] })] })],
    ["a timeout over 1800 seconds", planWith({ checks: [check({ timeoutSeconds: 1801 })] })],
    ["a fractional timeout", planWith({ checks: [check({ timeoutSeconds: 1.5 })] })],
    ["an empty label", planWith({ checks: [check({ label: " " })] })],
    ["a label over 80 characters", planWith({ checks: [check({ label: "x".repeat(81) })] })],
    ["env", planWith({ checks: [check({ env: { NODE_ENV: "test" } })] })],
    ["a none_reason over 300 characters", planWith({ checks: [], none_reason: "x".repeat(301) })],
    ["no checks list", planWith({ none_reason: "Docs only." })],
  ];
  it.each(unreadable)("proposes nothing, with a note, for %s", (_name, plan) => {
    expect(parseProposedChecks(plan, input)).toEqual({ proposed: [], proposalNote: UNREADABLE });
  });

  it("keeps the checks a task runs within 64: a proposal over what the project leaves room for is unreadable", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ ...required[0]!, id: `required-${index + 1}`, command: { ...required[0]!.command, args: [`t${index}`] } }));
    const proposals = (count: number) => planWith({ checks: Array.from({ length: count }, (_, index) => check({ label: `Check ${index}`, args: [`p${index}`] })) });
    // 60 project checks and 1 optional one leave room for 3.
    expect(parseProposedChecks(proposals(3), { repositoryPaths, required: many, optionalCount: 1 }).proposed).toHaveLength(3);
    expect(parseProposedChecks(proposals(4), { repositoryPaths, required: many, optionalCount: 1 })).toEqual({ proposed: [], proposalNote: UNREADABLE });
  });

  it("accepts the exact limits", () => {
    const plan = planWith({ checks: Array.from({ length: 8 }, (_, index) => check({ label: "x".repeat(80), args: Array.from({ length: 32 }, () => String(index).padEnd(1024, "a")), timeoutSeconds: index + 1 })) });
    expect(parseProposedChecks(plan, input).proposed.map((entry) => entry.id)).toEqual(["proposed-1", "proposed-2", "proposed-3", "proposed-4", "proposed-5", "proposed-6", "proposed-7", "proposed-8"]);
  });
});

describe("extractProposedChecks control characters and Not changing proofs", () => {
  const withProves = { ...input, allowProves: true as const, claimIds: new Set(["1", "2"]), notChangingCount: 2 };
  const proving = (overrides: Record<string, unknown>) => extractProposedChecks({ checks: [{ ...check(), proves: ["1"], ...overrides }] }, withProves);

  it("rejects an argument with a line break, tab, other control character or DEL, and a label with one", () => {
    for (const bad of ["a\nb", "a\tb", "a\rb", "a\u0000b", "a\u001fb", "a\u007fb"]) {
      expect(proving({ args: ["-c", bad] }).proposalNote).toBe(UNREADABLE);
      expect(proving({ label: bad }).proposalNote).toBe(UNREADABLE);
    }
    expect(proving({ args: ["-c", "a b\\nc \u00e9"] }).proposalNote).toBeUndefined();
    expect(extractProposedChecks({ checks: [check({ args: ["a\nb"] })] }, input).proposalNote).toBe(UNREADABLE);
  });

  it("lists the problem checks in plain words, by label", () => {
    expect(proposedCheckTextIssues({ checks: [check({ label: "Probe", args: ["x\ny"] }), check({ label: "Fine" }), check({ label: "Bad\tlabel" })] })).toEqual([
      "check Probe: arguments may not contain line breaks or control characters; write \\n as a two-character escape inside your script if you need it",
      "check Bad label: the label may not contain line breaks or control characters",
    ]);
    expect(proposedCheckTextIssues("nope")).toEqual([]);
    expect(proposedCheckTextIssues({ checks: [1, null, { args: "x" }] })).toEqual([]);
  });

  it("accepts nc1 to ncN for N Not changing entries and nothing else", () => {
    expect(proving({ proves: ["nc1", "nc2", "2"] }).proves).toEqual({ "proposed-1": ["nc1", "nc2", "2"] });
    for (const bad of ["nc3", "nc0", "nc01", "NC1", "nc", "nc1.1", "3"]) expect(proving({ proves: [bad] }).proposalNote).toBe(UNREADABLE);
    expect(extractProposedChecks({ checks: [{ ...check(), proves: ["nc1"] }] }, { ...withProves, notChangingCount: 0 }).proposalNote).toBe(UNREADABLE);
    expect(extractProposedChecks({ checks: [{ ...check(), proves: ["nc1"] }] }, { ...input, allowProves: true, claimIds: new Set(["1"]) }).proposalNote).toBe(UNREADABLE);
  });
});

describe("workflowSelectedChecks", () => {
  it("lists required, then proposed, then the selected optional checks in project order", () => {
    const command = { cwd: "workspace/payments", executable: "npm", args: ["test"], timeoutSeconds: 60 };
    const policy = {
      required: [{ id: "required-1", label: "Required", command }],
      optional: [{ id: "lint", label: "Lint", command }, { id: "e2e", label: "E2E", command }, { id: "docs", label: "Docs", command }],
      selectedOptionalIds: ["docs", "lint"],
      proposed: [{ id: "proposed-1", label: "Proposed", command }],
    };
    expect(workflowSelectedChecks(policy).map((entry) => entry.id)).toEqual(["required-1", "proposed-1", "lint", "docs"]);
    expect(workflowSelectedChecks(undefined)).toEqual([]);
  });

  it("leaves out the proposed checks the owner removed, keeping proposal order", () => {
    const command = { cwd: "workspace/payments", executable: "npm", args: ["test"], timeoutSeconds: 60 };
    const proposed = ["proposed-1", "proposed-2", "proposed-3"].map((id) => ({ id, label: id, command }));
    const policy = { required: [], optional: [], selectedOptionalIds: [], proposed, selectedProposedIds: ["proposed-3", "proposed-1"] };
    expect(workflowSelectedChecks(policy).map((entry) => entry.id)).toEqual(["proposed-1", "proposed-3"]);
    expect(WorkflowCheckPolicySchema.safeParse(policy).success).toBe(true);
    // Only ids from the stored proposal, each once.
    expect(WorkflowCheckPolicySchema.safeParse({ ...policy, selectedProposedIds: ["proposed-9"] }).success).toBe(false);
    expect(WorkflowCheckPolicySchema.safeParse({ ...policy, selectedProposedIds: ["proposed-1", "proposed-1"] }).success).toBe(false);
  });
});

// A setup answer that glued two commands into one (`npm run lint npm test`) is never a valid command: the reader flags it with a fixed reason and keeps it out of every list; the agent is told once and
// can answer again; a well-formed `run` (an `&&` chain, arguments after `--`) is kept as written.
import { describe, expect, it, vi } from "vitest";
import { MALFORMED_RUN_REASON, malformedRunReason, sanitizeSetupProposal, setupProposalAnswerOf } from "@agentx/contracts";
import { askAgainAboutCommands, malformedCommandsOf, setupMalformedCommandPrompt, setupProposalFormatLines } from "../../packages/worker/src/setup-draft.js";

const COMMIT = "a".repeat(40);
const context = { basedOnRevision: 1, repositories: [{ name: "web", commit: COMMIT }] };
const from = [{ kind: "file", repo: "web", path: "package.json", commit: COMMIT, line: 3, quote: "\"lint\"" }];
const proposalOf = (extra: Record<string, unknown>) => {
  const result = sanitizeSetupProposal({ setup: [{ repo: "web", commands: ["npm ci"], from }], ...extra }, context);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.proposal;
};

describe("malformedRunReason", () => {
  it.each([
    "npm run lint npm test", "npm run lint test", "yarn run lint yarn test", "pnpm run lint pnpm test", "pnpm run lint npm test", "yarn run lint npx jest", "npm run-script lint test", "npm run --silent lint npm test", "npm run --prefix web lint npm test",
    "npm ci && npm run lint npm test", "npm run lint npm test && npm ci", "npm run lint npm test | tee out",
  ])("refuses %s with the fixed reason", (command) => {
    expect(malformedRunReason(command)).toBe(MALFORMED_RUN_REASON);
  });
  it.each([
    "npm run lint", "npm test", "yarn run jest path/to/file", "pnpm run test --filter x", "pnpm run test src/a.test.ts", "yarn run lint test", "pnpm run build --filter web yarn", "npm run lint && npm test", "npm run test -- --watch=false", "npm run test --silent", "npm run build --workspace web", "yarn run test -- src/a.test.ts", "pnpm run lint -- --fix",
    "npm run --prefix web lint", "pnpm test", "make lint test", "npm run", "npm run lint -- npm test", "npm run -- lint npm test", "echo npm run lint npm test", "npm install lint test",
  ])("keeps %s", (command) => {
    expect(malformedRunReason(command)).toBeUndefined();
  });
});

describe("the reader keeps a glued run out of every list", () => {
  it("setup, tests, checks and the browser start command: flagged with the fixed reason, never an item", () => {
    const proposal = proposalOf({
      tests: [{ repo: "web", commands: ["npm run lint npm test", "npm run test -- --watch=false", "npm run lint && npm test"], from }],
      checks: [{ name: "lint", repo: "web", command: "pnpm run lint pnpm test", from }],
      browserEvidence: { startCommand: "yarn run dev yarn start", port: 3000, routes: [{ path: "/", files: ["src/**"] }], from },
    });
    expect(proposal.tests[0]!.value.commands).toEqual(["npm run test -- --watch=false", "npm run lint && npm test"]);
    expect(proposal.checks).toEqual([]);
    expect(proposal.browserEvidence).toBeUndefined();
    expect(proposal.flaggedCommands.map((item) => [item.command, item.reason])).toEqual([
      ["npm run lint npm test", MALFORMED_RUN_REASON], ["pnpm run lint pnpm test", MALFORMED_RUN_REASON], ["yarn run dev yarn start", MALFORMED_RUN_REASON],
    ]);
  });
  it("an entry whose only command is glued leaves no item for that repository", () => {
    const proposal = proposalOf({ tests: [{ repo: "web", commands: ["npm run lint npm test"], from }] });
    expect(proposal.tests).toEqual([]);
    expect(proposal.flaggedCommands).toHaveLength(1);
  });
  it("reading what the reader returned gives the same proposal (the broker's second read)", () => {
    const once = proposalOf({ tests: [{ repo: "web", commands: ["npm run lint npm test", "npm test"], from }] });
    expect(sanitizeSetupProposal(JSON.parse(JSON.stringify(once)) as unknown, context)).toEqual({ ok: true, proposal: once });
  });
});

describe("what the agent is told", () => {
  const block = (answer: unknown) => `done\n\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``;
  it("the answer's glued commands are found in setup, tests, checks and the start command, once each", () => {
    const answer = setupProposalAnswerOf(block({
      setup: [{ repo: "web", commands: ["npm ci", "npm run lint npm test"] }], tests: [{ repo: "web", commands: ["npm run build npm test", "npm run lint && npm test"] }],
      checks: [{ name: "x", repo: "web", command: "yarn run a yarn b" }], browserEvidence: { startCommand: "pnpm run dev pnpm start" },
    }));
    expect(malformedCommandsOf(answer)).toEqual(["npm run lint npm test", "npm run build npm test", "yarn run a yarn b", "pnpm run dev pnpm start"]);
    expect(malformedCommandsOf(setupProposalAnswerOf(block({ tests: [{ repo: "web", commands: ["npm run lint && npm test", "npm run test -- --watch=false"] }] })))).toEqual([]);
    expect(malformedCommandsOf(undefined)).toEqual([]);
    expect(malformedCommandsOf([])).toEqual([]);
  });
  it("the note carries the fixed reason and the commands cut short, and asks for one corrected block", () => {
    const note = setupMalformedCommandPrompt(["npm run lint npm test"]);
    expect(note).toContain(MALFORMED_RUN_REASON);
    expect(note).toContain("`npm run lint npm test`");
    expect(note).toContain("agentx-setup-proposal");
    expect(setupMalformedCommandPrompt(["x".repeat(500)])).not.toContain("x".repeat(121));
  });
  it("the proposal rules tell the agent to keep commands apart (one per entry, or joined with &&) and put arguments after --", () => {
    const rules = setupProposalFormatLines(undefined).join("\n");
    expect(rules).toContain("npm run lint npm test");
    expect(rules).toContain("as two entries");
    expect(rules).toContain("npm run lint && npm test");
    expect(rules).toContain("npm run test -- --watch=false");
  });
});

describe("askAgainAboutCommands", () => {
  const block = (answer: unknown) => `\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``;
  const GLUED = block({ tests: [{ repo: "web", commands: ["npm run lint npm test"] }] });
  const setup = (text: string, options: { over?: boolean; reply?: string; throws?: boolean } = {}) => {
    const state = { text, asked: [] as string[], failed: 0, after: 0 };
    const io = {
      over: () => options.over === true, text: () => state.text, restore: vi.fn((value: string) => { state.text = value; }), fail: () => { state.failed += 1; }, after: async () => { state.after += 1; },
      ask: async (note: string) => { state.asked.push(note); if (options.reply !== undefined) state.text = options.reply; if (options.throws === true) throw new Error("model down"); },
    };
    return { state, io };
  };
  it("asks once, with the fixed note, when the answer holds a glued command, then looks at the run's end", async () => {
    const t = setup(GLUED, { reply: block({ tests: [{ repo: "web", commands: ["npm test"] }] }) });
    await askAgainAboutCommands(t.io);
    expect(t.state.asked).toEqual([setupMalformedCommandPrompt(["npm run lint npm test"])]);
    expect(t.io.restore).not.toHaveBeenCalled();
    expect(t.state.after).toBe(1);
  });
  it("asks nothing of a finished or failed run, nor when no command is glued", async () => {
    const over = setup(GLUED, { over: true });
    await askAgainAboutCommands(over.io);
    const fine = setup(block({ tests: [{ repo: "web", commands: ["npm test"] }] }));
    await askAgainAboutCommands(fine.io);
    expect([over.state.asked, fine.state.asked, over.state.after, fine.state.after]).toEqual([[], [], 0, 0]);
  });
  it("a reply with no proposal block gives back the first answer; a model that fails the turn marks the run failed", async () => {
    const lost = setup(GLUED, { reply: "sorry" });
    await askAgainAboutCommands(lost.io);
    expect(lost.state.text).toBe(GLUED);
    const down = setup(GLUED, { throws: true });
    await askAgainAboutCommands(down.io);
    expect(down.state.failed).toBe(1);
    expect(down.state.after).toBe(1);
  });
});

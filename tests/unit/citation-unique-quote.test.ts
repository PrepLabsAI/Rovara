import { describe, expect, it } from "vitest";
import type { SetupProposal } from "@agentx/contracts";
import { verifyProposalDetailed } from "../../packages/broker/src/core/setup-agent/proposal-verify.js";

const SHA = "a".repeat(40);

describe("setup fallback command source edges", () => {
  it("cannot combine clipped evidence from two quotes into one whole command", async () => {
    const lines = Array.from({ length: 50 }, (_, index) => `# filler ${index + 1}`);
    lines[33] = "run: npm cia";
    lines[39] = "step: npm cib";
    const proposal = {
      version: 1, basedOnRevision: 1, repositories: [], tests: [], checks: [], testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [],
      flaggedCommands: [], foundNotUsed: [], notes: "",
      setup: [{ id: "s", value: { repo: "demo", commands: ["npm ci"] }, confidence: "high", risk: "low", from: ["run: npm ci", "step: npm c"].map((quote) => ({
        kind: "ci", repo: "demo", path: "ci.yml", commit: SHA, line: 28, quote,
      })) }],
    } as unknown as SetupProposal;
    const result = await verifyProposalDetailed(async (_repo, _path, _commit, options) => (options.untilLine === undefined ? lines : lines.slice(0, options.untilLine)).join("\n"), proposal);
    expect(result).toEqual({ items: { s: "unverified" }, final: true });
  });
});

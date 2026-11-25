import { describe, expect, it } from "vitest";
import type { SetupProposal } from "@agentx/contracts";
import { verifyProposalDetailed } from "../../packages/broker/src/core/setup-agent/proposal-verify.js";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const proposalOf = (parts: Record<string, unknown>): SetupProposal => ({
  version: 1, basedOnRevision: 1, repositories: [], setup: [], tests: [], checks: [], testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [],
  flaggedCommands: [], foundNotUsed: [], notes: "", ...parts,
}) as unknown as SetupProposal;
const citation = (quote: string, path = "ci.yml", line = 28) => ({ kind: "ci", repo: "demo", path, commit: SHA, line, quote });
const command = (quote: string, path = "ci.yml", line = 28, value = "npm ci") => ({
  id: "s", value: { repo: "demo", commands: [value] }, confidence: "high", risk: "low", from: [citation(quote, path, line)],
});
const source = (...body: string[]) => [...Array.from({ length: 33 }, (_, index) => `filler ${index + 1}`), ...body, ...Array<string>(20).fill("tail")];
const readLines = (lines: string[]) => async (_repo: string, _path: string, _commit: string, options: { untilLine?: number }) =>
  (options.untilLine === undefined ? lines : lines.slice(0, options.untilLine)).join("\n");

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


describe("Lead 4 fallback rulings", () => {
  it.each([
    ["ci.yml", "#"], ["ci.yaml", "#"], ["build.sh", "#"], ["settings.toml", "#"], ["build.py", "#"],
    ["build.ts", "//"], ["build.js", "/*"], ["build.tsx", "*"], ["settings.ini", ";"], ["build.sql", "--"], ["index.html", "<!--"],
  ])("rejects a unique command on a comment line in %s (%s)", async (path, marker) => {
    expect(await verifyProposalDetailed(readLines(source(`  ${marker} run: npm ci`)), proposalOf({ setup: [command("run: npm ci", path)] })))
      .toEqual({ items: { s: "unverified" }, final: true });
  });

  it.each([["ci.yml", "//"], ["build.sh", ";"], ["settings.toml", "--"]])("uses the comment syntax of %s, not %s", async (path, marker) => {
    expect(await verifyProposalDetailed(readLines(source(`${marker} run: npm ci`)), proposalOf({ setup: [command("run: npm ci", path)] })))
      .toEqual({ items: { s: "verified" }, final: true });
  });

  it("a command in a comment is refused wherever the cited line is (there is no line window any more)", async () => {
    expect(await verifyProposalDetailed(readLines(source("# run: npm ci")), proposalOf({ setup: [command("run: npm ci", "ci.yml", 34)] })))
      .toEqual({ items: { s: "unverified" }, final: true });
  });

  it.each([
    { name: "contiguous lines with normalised whitespace", body: ["run:   npm ci", "  next: npm test"], want: "verified" },
    { name: "the quote's line break read as a space in the file", body: ["run: npm ci next: npm test"], want: "verified" },
    { name: "a different line break", body: ["run: npm", "ci next: npm test"], want: "verified" },
    { name: "an intervening line", body: ["run: npm ci", "intervening", "next: npm test"], want: "unverified" },
    { name: "reversed lines", body: ["next: npm test", "run: npm ci"], want: "unverified" },
    { name: "a repeated multiline quote", body: ["run: npm ci", "next: npm test", "run:   npm ci", "next: npm test"], want: "verified" },
    { name: "a comment on the second line", body: ["run: npm ci", "# next: npm test"], quote: "run: npm ci\n# next: npm test", want: "unverified" },
    { name: "a partial command token", body: ["run: pnpm ci", "next: npm test"], quote: "run: pnpm ci\nnext: npm test", want: "unverified" },
  ])("multiline fallback: $name", async ({ body, quote, want }) => {
    expect(await verifyProposalDetailed(readLines(source(...body)), proposalOf({ setup: [command(quote ?? "run: npm ci\nnext: npm test")] })))
      .toEqual({ items: { s: want }, final: true });
  });

  it.each([false, true])("non-command items: the quote anywhere in the file holds, but a name cut out of a longer name in the file (widgets-old, api.example.com for example.com) does not (%s)", async (shared) => {
    const metadata = { confidence: "high", risk: "low" };
    const proposal = proposalOf({
      repositories: [{ id: "r", value: { url: "https://github.com/acme/widgets" }, ...metadata, from: [citation("https://github.com/acme/widgets")] }],
      allowedDomains: [{ id: "d", value: "example.com", ...metadata, from: [citation("example.com")] }],
      knowledge: [{ id: "k", value: { path: "ci.yml" }, ...metadata, from: [citation("run: npm ci")] }],
      setup: shared ? [command("run: npm ci")] : [],
    });
    expect(await verifyProposalDetailed(readLines(source("host: api.example.com", "repository: https://github.com/acme/widgets-old", "run: npm ci")), proposal))
      .toEqual({ items: { r: "unverified", d: "unverified", k: "verified", ...(shared ? { s: "verified" } : {}) }, final: true });
  });

  it("allows the fallback for tests and check commands too", async () => {
    const test = command("run: npm ci");
    const check = { ...test, id: "c", value: { repo: "demo", command: "npm ci" } };
    expect(await verifyProposalDetailed(readLines(source("run: npm ci")), proposalOf({ tests: [test], checks: [check] })))
      .toEqual({ items: { s: "verified", c: "verified" }, final: true });
  });

  it.each([false, true])("pins the read to the cited commit; current commit has the quote = %s", async (present) => {
    const calls: { repo: string; path: string; commit: string; untilLine?: number }[] = [];
    const read = async (repo: string, path: string, commit: string, options: { untilLine?: number }) => {
      calls.push({ repo, path, commit, ...options });
      const files = new Map([[SHA, source(present ? "run: npm ci" : "rewritten")], [OLD, source("run: npm ci")]]);
      const lines = files.get(commit)!;
      return (options.untilLine === undefined ? lines : lines.slice(0, options.untilLine)).join("\n");
    };
    expect(await verifyProposalDetailed(read, proposalOf({ setup: [command("run: npm ci")] })))
      .toEqual({ items: { s: present ? "verified" : "unverified" }, final: true });
    expect(calls.map(({ repo, path, commit, untilLine }) => ({ repo, path, commit, untilLine })))
      .toEqual([{ repo: "demo", path: "ci.yml", commit: SHA, untilLine: undefined }]);
  });

  it.each(["npm", "1234567", "😀😀😀😀"]) ("refuses a trivially short quote %s without reading", async (quote) => {
    let reads = 0;
    const read = async () => { reads += 1; return source(quote).join("\n"); };
    expect(await verifyProposalDetailed(read, proposalOf({ setup: [command(quote, "ci.yml", 28, quote)] })))
      .toEqual({ items: { s: "unchecked" }, final: true });
    expect(reads).toBe(0);
  });

  it("accepts a unique command quote at the eight-character minimum", async () => {
    expect(await verifyProposalDetailed(readLines(source("npm test")), proposalOf({ setup: [command("npm test", "ci.yml", 28, "npm test")] })))
      .toEqual({ items: { s: "verified" }, final: true });
  });
});

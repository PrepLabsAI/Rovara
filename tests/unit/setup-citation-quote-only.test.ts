// Lane SETUP-CITATION-LINES (owner DEC 254zzz537: no line numbers at all). A setup citation is a FILE and an EXACT QUOTE. The broker's re-read holds a citation if and only if the quote is in that file at the
// cited commit (whitespace made single on both sides; for a command, on a line that is not a comment). No line window, no nearest place, no moved line. A line a stored proposal still carries is read and ignored,
// and the proposal reader no longer keeps a line from the model's answer.
import { describe, expect, it } from "vitest";
import { ProvenanceSchema, sanitizeSetupProposal, type SetupProposal } from "@agentx/contracts";
import { verifyProposalDetailed } from "../../packages/broker/src/core/setup-agent/proposal-verify.js";
import { setupAgentInstructions } from "../../packages/worker/src/setup-agent-prompt.js";
import { setupProposalFormatLines } from "../../packages/worker/src/setup-draft.js";
import { SETUP_AGENT_LIMITS_DEFAULT } from "@agentx/contracts";
import type { CitationFileReader } from "../../packages/broker/src/core/citations/citation-check.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const proposalOf = (parts: Record<string, unknown>): SetupProposal => ({
  version: 1, basedOnRevision: 1, repositories: [], setup: [], tests: [], checks: [], testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [],
  flaggedCommands: [], foundNotUsed: [], notes: "", ...parts,
}) as unknown as SetupProposal;
const cite = (path: string, quote: string, extra: Record<string, unknown> = {}) => ({ kind: "readme", repo: "demo", path, commit: SHA, quote, ...extra });
const item = (id: string, commands: string[], from: unknown[]) => ({ id, value: { repo: "demo", commands }, confidence: "high", risk: "low", from });

/** A 284-line README shaped like the one that failed: prose, and the three install commands on lines 93, 97 and 103. */
function readmeFixture(): string[] {
  const lines = Array.from({ length: 284 }, (_, index) => `Line ${index + 1} of the project guide: notes about the scraper and the database.`);
  lines[92] = "python3 -m venv .venv";
  lines[96] = "pip install -r requirements.txt";
  lines[102] = "python3 -m src.db";
  return lines;
}
const readerOf = (files: Record<string, string[]>, eol = "\n"): CitationFileReader => async (_repo, path, commit) => files[`${path}@${commit}`]?.join(eol);
const verify = (files: Record<string, string[]>, proposal: SetupProposal, eol?: string) => verifyProposalDetailed(readerOf(files, eol), proposal, { now: () => 1_000 });

describe("a citation holds when its exact quote is in the file at that commit", () => {
  const files = { [`README.md@${SHA}`]: readmeFixture() };

  it("the beta bug's file: three install commands verify with no line cited", async () => {
    const result = await verify(files, proposalOf({ setup: [
      item("venv", ["python3 -m venv .venv"], [cite("README.md", "python3 -m venv .venv")]),
      item("pip", ["pip install -r requirements.txt"], [cite("README.md", "pip install -r requirements.txt")]),
      item("db", ["python3 -m src.db"], [cite("README.md", "python3 -m src.db")]),
    ] }));
    expect(result).toEqual({ items: { venv: "verified", pip: "verified", db: "verified" }, final: true });
  });

  it("a stored citation that still carries a line (right, wrong, or past the end of the file) is read by the schema and the line is ignored", async () => {
    for (const line of [93, 73, 5, 900_000]) {
      const stored = ProvenanceSchema.parse(cite("README.md", "python3 -m venv .venv", { line }));
      expect(stored.line).toBe(line);
      expect(await verify(files, proposalOf({ setup: [item("s", ["python3 -m venv .venv"], [stored])] }))).toEqual({ items: { s: "verified" }, final: true });
    }
  });

  it("the same command written twice in the file holds", async () => {
    const lines = readmeFixture();
    lines[10] = "python3 -m venv .venv";
    lines[250] = "python3 -m venv .venv";
    expect(await verify({ [`README.md@${SHA}`]: lines }, proposalOf({ setup: [item("s", ["python3 -m venv .venv"], [cite("README.md", "python3 -m venv .venv")])] }))).toEqual({ items: { s: "verified" }, final: true });
  });

  it("reads the file whole, once, whatever it cites", async () => {
    const calls: Array<{ untilLine: number | undefined }> = [];
    const read: CitationFileReader = async (_repo, _path, _commit, options) => { calls.push({ untilLine: options.untilLine }); return readmeFixture().join("\n"); };
    await verifyProposalDetailed(read, proposalOf({ setup: [item("a", ["python3 -m venv .venv"], [cite("README.md", "python3 -m venv .venv", { line: 3 })]), item("b", ["python3 -m src.db"], [cite("README.md", "python3 -m src.db", { line: 9_000 })])] }), { now: () => 1_000 });
    expect(calls).toEqual([{ untilLine: undefined }]);
  });
});

describe("a quote that is not in the file at that commit is never accepted", () => {
  const lines = Array.from({ length: 120 }, (_, index) => `filler ${index + 1} text`);
  lines[60] = "run the install step: make bootstrap-all";
  const one = (quote: string, files: Record<string, string[]>, path = "README.md") => verify(files, proposalOf({ setup: [item("s", ["make bootstrap-all"], [cite(path, quote)])] }));

  it("absent: unverified", async () => {
    expect(await one("run the install step: make bootstrap-everything", { [`README.md@${SHA}`]: lines })).toEqual({ items: { s: "unverified" }, final: true });
  });

  it("present at another commit only: unverified (the re-read is pinned to the cited commit)", async () => {
    const files = { [`README.md@${SHA}`]: lines.map((line) => line.replace("make bootstrap-all", "rewritten")), [`README.md@${OTHER}`]: lines };
    expect(await one("run the install step: make bootstrap-all", files)).toEqual({ items: { s: "unverified" }, final: true });
  });

  it("present in another file only: unverified", async () => {
    const files = { [`README.md@${SHA}`]: lines.map((line) => line.replace("make bootstrap-all", "rewritten")), [`docs/SETUP.md@${SHA}`]: lines };
    expect(await one("run the install step: make bootstrap-all", files)).toEqual({ items: { s: "unverified" }, final: true });
  });

  it("a missing file: unverified", async () => {
    expect(await one("run the install step: make bootstrap-all", {})).toEqual({ items: { s: "unverified" }, final: true });
  });

  it("only a comment line has it: unverified (a command in a comment is not used)", async () => {
    const commented = lines.map((line, index) => (index === 60 ? "# run the install step: make bootstrap-all" : line));
    expect(await one("run the install step: make bootstrap-all", { [`ci.yml@${SHA}`]: commented }, "ci.yml")).toEqual({ items: { s: "unverified" }, final: true });
  });

  it("the quote does not contain the proposed value: unverified even when found", async () => {
    const result = await verify({ [`README.md@${SHA}`]: lines }, proposalOf({ setup: [item("s", ["make something-else"], [cite("README.md", "run the install step: make bootstrap-all")])] }));
    expect(result.items).toEqual({ s: "unverified" });
  });

  it("the value is only part of a longer word on the line: unverified", async () => {
    const longer = lines.map((line, index) => (index === 60 ? "run the install step: make bootstrap-all-forever" : line));
    expect((await one("make bootstrap-all", { [`README.md@${SHA}`]: longer })).items).toEqual({ s: "unverified" });
  });

  it("a glued copy does not hide a clean one", async () => {
    const mixed = lines.map((line, index) => (index === 30 ? "run the install step: make bootstrap-all-forever" : index === 100 ? "run the install step: make bootstrap-all" : line === lines[60] ? "filler 61 text" : line));
    expect((await one("make bootstrap-all", { [`README.md@${SHA}`]: mixed })).items).toEqual({ s: "verified" });
  });

  it("an unreadable file stays unchecked and not final, never verified", async () => {
    const result = await verifyProposalDetailed(async () => { throw new Error("host down"); }, proposalOf({ setup: [item("s", ["make bootstrap-all"], [cite("README.md", "run the install step: make bootstrap-all")])] }), { now: () => 1_000 });
    expect(result).toEqual({ items: { s: "unchecked" }, final: false });
  });
});

describe("whitespace: the only thing made the same on both sides", () => {
  const verifyLine = async (fileLine: string, quote: string, eol = "\n") => {
    const lines = Array.from({ length: 80 }, (_, index) => `filler ${index + 1} text`);
    lines[50] = fileLine;
    return verify({ [`README.md@${SHA}`]: lines }, proposalOf({ setup: [item("s", ["make bootstrap-all"], [cite("README.md", quote)])] }), eol);
  };

  it.each([
    ["trailing spaces", "make bootstrap-all   ", "\n"],
    ["a trailing tab", "make bootstrap-all\t", "\n"],
    ["a CRLF line end", "make bootstrap-all", "\r\n"],
    ["indentation", "      make bootstrap-all", "\n"],
    ["spaces and a tab between words (the proposal reader had already made the quote's runs single spaces)", "make \t  bootstrap-all", "\n"],
  ])("accepts %s", async (_name, fileLine, eol) => {
    expect((await verifyLine(fileLine, "make bootstrap-all", eol)).items).toEqual({ s: "verified" });
  });

  it.each([
    ["a different case", "Make Bootstrap-All"],
    ["a different character", "make bootstrap_all"],
    ["a word run together", "makebootstrap-all"],
  ])("does not accept %s", async (_name, fileLine) => {
    expect((await verifyLine(fileLine, "make bootstrap-all")).items).toEqual({ s: "unverified" });
  });
});

describe("the other item kinds", () => {
  it("a website's quote anywhere in the file holds (it used to need the cited line within 3), and its own name check still decides", async () => {
    const lines = Array.from({ length: 120 }, (_, index) => `filler ${index + 1} text`);
    lines[90] = "host: api.example.com";
    const files = { [`README.md@${SHA}`]: lines };
    const domain = (id: string, value: string) => ({ id, value, confidence: "high", risk: "low", from: [cite("README.md", "host: api.example.com")] });
    const result = await verify(files, proposalOf({ allowedDomains: [domain("d1", "api.example.com"), domain("d2", "example.com")] }));
    expect(result).toEqual({ items: { d1: "verified", d2: "unverified" }, final: true });
  });

  it("a non-command quote that is not in the file is unverified", async () => {
    const files = { [`README.md@${SHA}`]: ["nothing here worth citing at all"] };
    const result = await verify(files, proposalOf({ allowedDomains: [{ id: "d", value: "api.example.com", confidence: "high", risk: "low", from: [cite("README.md", "host: api.example.com")] }] }));
    expect(result).toEqual({ items: { d: "unverified" }, final: true });
  });
});

describe("the proposal reader keeps no line", () => {
  const answer = { setup: [{ repo: "web", commands: ["npm ci"], confidence: "high", from: [{ kind: "file", repo: "web", path: "package.json", line: 12, quote: "\"ci\": \"npm ci\"" }] }] };

  it("a line in the model's answer is dropped; the file and the quote stay", () => {
    const read = sanitizeSetupProposal(answer, { basedOnRevision: 1, repositories: [{ name: "web", commit: SHA }] });
    expect(read.ok).toBe(true);
    const from = read.ok ? (read.proposal.setup[0] as unknown as { from: Array<Record<string, unknown>> }).from : [];
    expect(from).toEqual([{ kind: "file", repo: "web", path: "package.json", commit: SHA, quote: "\"ci\": \"npm ci\"" }]);
  });
});

describe("the setup prompt asks for the file and the exact quote, never a line", () => {
  it("names no line number in the citation rules or the example, and says not to give one", () => {
    const rules = setupProposalFormatLines(undefined).join("\n");
    expect(rules).not.toMatch(/"line"/u);
    expect(rules).not.toMatch(/\bline: \d/u);
    expect(rules).toContain("Do not give a line number");
    expect(rules).toContain("exactly");
    const agent = setupAgentInstructions({ repositories: [{ name: "web", path: "repo/web" }], limits: SETUP_AGENT_LIMITS_DEFAULT });
    expect(agent).not.toMatch(/"line"/u);
    expect(agent).not.toContain("file and line");
  });
});

describe("a quote that runs over two lines of the file (pre-review S4)", () => {
  const verdictOf = async (path: string, text: string, quote: string, command = "npm ci --silent") => (await verify({ [`${path}@${SHA}`]: text.split("\n") }, proposalOf({ setup: [item("s", [command], [cite(path, quote)])] }))).items["s"];

  it("a YAML block scalar quoted as one line holds", async () => {
    expect(await verdictOf("ci.yml", "steps:\n  - run: |\n      npm ci --silent\n", "run: | npm ci --silent")).toBe("verified");
  });

  it("a pretty-printed JSON object quoted as one line holds when the quote is over two lines", async () => {
    expect(await verdictOf("package.json", "{\n  \"scripts\": {\n    \"ci\": \"npm ci --silent\"\n  }\n}\n", "\"scripts\": { \"ci\": \"npm ci --silent\"")).toBe("verified");
  });

  it("a wholly commented line between the two lines breaks the quote", async () => {
    expect(await verdictOf("ci.yml", "steps:\n  - run: |\n      # a note\n      npm ci --silent\n", "run: | npm ci --silent")).toBe("unverified");
  });

  it("the two lines in the other order, or with a different word between, do not hold", async () => {
    expect(await verdictOf("ci.yml", "npm ci --silent\nrun: |\n", "run: | npm ci --silent")).toBe("unverified");
    expect(await verdictOf("ci.yml", "run: |\n  also\n  npm ci --silent\n", "run: | npm ci --silent")).toBe("unverified");
  });

  it("the whole-token rule still applies at the ends of a quote that spans lines", async () => {
    expect(await verdictOf("ci.yml", "run: |\n  pnpm ci --silent\n", "run: | pnpm ci --silent")).toBe("unverified");
  });
});

describe("a big file with many citations (pre-review S5)", () => {
  it("is made into code text once: 30 citations cost about what one does", async () => {
    const lines = Array.from({ length: 120_000 }, (_, index) => `line ${index} of a long generated file with some words in it`);
    for (let n = 0; n < 30; n += 1) lines[1_000 * (n + 1)] = `run step number ${n} with make target${n}`;
    const text = lines.join("\n");
    const one = proposalOf({ setup: [item("c0", ["make target0"], [cite("big.md", "run step number 0 with make target0")])] });
    const many = proposalOf({ setup: Array.from({ length: 30 }, (_, n) => item(`c${n}`, [`make target${n}`], [cite("big.md", `run step number ${n} with make target${n}`)])) });
    const timed = async (proposal: SetupProposal) => { const started = performance.now(); const result = await verifyProposalDetailed(async () => text, proposal, { now: () => 1_000 }); return { ms: performance.now() - started, result }; };
    await timed(one);
    const single = await timed(one);
    const all = await timed(many);
    expect(Object.values(all.result.items).every((verdict) => verdict === "verified")).toBe(true);
    expect(all.ms).toBeLessThan(single.ms * 4 + 300);
  });
});

describe("a name in the file is judged on the characters beside it (pre-review S1: an allowed website is the egress list and is ticked when verified)", () => {
  const repoItem = (quote: string, url = "https://github.com/acme/widgets", path = "README.md") => proposalOf({ repositories: [{ id: "r", value: { url, name: "widgets" }, confidence: "high", risk: "low", from: [cite(path, quote)] }] });
  const domainItem = (quote: string, value = "registry.npmjs.org", path = "README.md") => proposalOf({ allowedDomains: [{ id: "d", value, confidence: "high", risk: "low", from: [cite(path, quote)] }] });
  const run = async (text: string, proposal: SetupProposal, path = "README.md") => (await verify({ [`${path}@${SHA}`]: text.split("\n") }, proposal)).items;

  it.each([
    ["a repository that is the prefix of another (widgets-old)", "clone https://github.com/acme/widgets-old", "https://github.com/acme/widgets"],
    ["a repository that is the prefix of a longer name (widgets2)", "git clone https://github.com/acme/widgets2 now", "https://github.com/acme/widgets"],
  ])("%s is unverified", async (_name, text, quote) => {
    expect(await run(text, repoItem(quote))).toEqual({ r: "unverified" });
  });

  it.each([
    ["a host with another domain after it", "host: registry.npmjs.org.evil.net", "registry.npmjs.org"],
    ["a host with letters glued before it", "host: evilregistry.npmjs.org", "registry.npmjs.org"],
    ["a host that is a subdomain of another name", "host: registry.npmjs.org-mirror.example", "registry.npmjs.org"],
  ])("%s is unverified", async (_name, text, quote) => {
    expect(await run(text, domainItem(quote))).toEqual({ d: "unverified" });
  });

  it("a repository quote only on a comment line is unverified (yaml), but is text in a Markdown README", async () => {
    expect(await run("# https://github.com/acme/widgets\nname: x", repoItem("https://github.com/acme/widgets", "https://github.com/acme/widgets", "ci.yml"), "ci.yml")).toEqual({ r: "unverified" });
    expect(await run("# https://github.com/acme/widgets\n", repoItem("https://github.com/acme/widgets"))).toEqual({ r: "verified" });
  });

  it.each([
    ["the address at the end of a sentence", "See https://github.com/acme/widgets. It is the code."],
    ["the address with .git", "git clone https://github.com/acme/widgets.git"],
    ["the address followed by a slash", "https://github.com/acme/widgets/issues"],
    ["junk before the scheme (the host and path, github.com/acme/widgets, are still exactly there)", "clone xhttps://github.com/acme/widgets"],
    ["a longer name first, then the exact one before a slash (a name, not a shell word)", "old https://github.com/acme/widgets-old\nsee https://github.com/acme/widgets/issues"],
    ["a longer name earlier and the exact one later", "old https://github.com/acme/widgets-old\nnew https://github.com/acme/widgets"],
  ])("%s is verified", async (_name, text) => {
    expect(await run(text, repoItem("https://github.com/acme/widgets"))).toEqual({ r: "verified" });
  });

  it.each([
    ["a host with a port", "registry=https://registry.npmjs.org:443/"],
    ["a host with a path", "registry=https://registry.npmjs.org/"],
    ["a host at the end of a sentence", "Packages come from registry.npmjs.org."],
  ])("%s is verified", async (_name, text) => {
    expect(await run(text, domainItem("registry.npmjs.org"))).toEqual({ d: "verified" });
  });
});

describe("a quote runs over at most two consecutive lines of the file (Opus S1)", () => {
  const verdictOf = async (path: string, text: string, quote: string, command: string) => (await verify({ [`${path}@${SHA}`]: text.split("\n") }, proposalOf({ setup: [item("s", [command], [cite(path, quote)])] }))).items["s"];

  it("a blank line breaks a quote: `npm`, a blank line, `run evil` is not `npm run evil`", async () => {
    expect(await verdictOf("build.sh", "npm\n\nrun evil\n", "npm run evil", "npm run evil")).toBe("unverified");
    expect(await verdictOf("build.sh", "npm\nrun evil\n", "npm run evil", "npm run evil")).toBe("verified");
  });

  it("a quote over three lines is not found", async () => {
    expect(await verdictOf("build.sh", "npm\nrun\nevil-x\n", "npm run evil-x", "npm run evil-x")).toBe("unverified");
    expect(await verdictOf("build.sh", "npm run\nevil-x\n", "npm run evil-x", "npm run evil-x")).toBe("verified");
  });

  it("a code fence line breaks a quote: the text before a fence is not joined to the first line inside it", async () => {
    expect(await verdictOf("README.md", "Then run npm\n```sh\nrun evil\n```\n", "npm run evil", "npm run evil")).toBe("unverified");
  });

  it("a two-line quote in the middle of a longer file holds, and so does one at the first and the last line", async () => {
    expect(await verdictOf("ci.yml", "a: 1\nrun: |\n  npm ci --silent\nb: 2\n", "run: | npm ci --silent", "npm ci --silent")).toBe("verified");
    expect(await verdictOf("ci.yml", "run: |\n  npm ci --silent", "run: | npm ci --silent", "npm ci --silent")).toBe("verified");
  });
});

describe("a search over a huge file stays small (Opus M2)", () => {
  it("20 MB of one repeated character and a 200-character quote of it: one citation answers at once, without a list of 20 million places", async () => {
    const quote = "a".repeat(200);
    const text = "a".repeat(20 * 1024 * 1024);
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = await verifyProposalDetailed(async () => text, proposalOf({ setup: [item("s", ["a".repeat(200)], [cite("big.txt", quote)])] }), { now: () => 1_000 });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(400 * 1024 * 1024);
    // The line is far over the cap, so it is a comment line: nothing is found, nothing is verified.
    expect(result.items["s"]).toBe("unverified");
  });

  it("20 MB in lines of 1000 characters (16 million overlapping places of a 200-character quote): the search gives up at the cap, unverified, without a list of places", async () => {
    const text = Array.from({ length: 20_000 }, () => "a".repeat(1_000)).join("\n");
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = await verifyProposalDetailed(async () => text, proposalOf({ setup: [item("s", ["a".repeat(200)], [cite("big.txt", "a".repeat(200))])] }), { now: () => 1_000 });
    // The search itself takes a few milliseconds with the cap and about two seconds without it; the rest is building the file's code text.
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(600 * 1024 * 1024);
    expect(result.items["s"]).toBe("unverified");
  });

  it("many places that are all cut out of longer words stop at the cap: unverified, quickly", async () => {
    const text = Array.from({ length: 30_000 }, () => "xnpm ci --silentx").join("\n");
    const started = performance.now();
    const result = await verifyProposalDetailed(async () => text, proposalOf({ setup: [item("s", ["npm ci --silent"], [cite("build.sh", "npm ci --silent")])] }), { now: () => 1_000 });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(result.items["s"]).toBe("unverified");
  });

  it("the first clean place ends the search even when thousands of glued ones come first", async () => {
    const text = [...Array.from({ length: 5_000 }, () => "xnpm ci --silentx"), "npm ci --silent"].join("\n");
    const result = await verifyProposalDetailed(async () => text, proposalOf({ setup: [item("s", ["npm ci --silent"], [cite("build.sh", "npm ci --silent")])] }), { now: () => 1_000 });
    expect(result.items["s"]).toBe("verified");
  });
});

describe("a repository is the address on its own host, not the same owner and name on another host (Opus S3)", () => {
  const repo = (quote: string) => proposalOf({ repositories: [{ id: "r", value: { url: "https://github.com/acme/widgets", name: "widgets" }, confidence: "high", risk: "low", from: [cite("README.md", quote)] }] });
  const run = async (quote: string) => (await verify({ [`README.md@${SHA}`]: [quote] }, repo(quote))).items["r"];

  it.each([
    ["another host with the same path", "see https://evil.net/acme/widgets"],
    ["userinfo that makes github.com a user name", "see https://github.com@evil.net/acme/widgets"],
    ["an ssh address of another host", "git clone git@evil.net:acme/widgets.git"],
    ["a path on another host written without a scheme", "see evil.net/acme/widgets"],
  ])("%s is unverified", async (_name, quote) => {
    expect(await run(quote)).toBe("unverified");
  });

  it.each([
    ["the https address", "see https://github.com/acme/widgets"],
    ["the address without a scheme", "see github.com/acme/widgets"],
    ["the ssh address of the same host", "git clone git@github.com:acme/widgets.git"],
    ["a bare owner/name in prose", "the code is in acme/widgets, see below"],
  ])("%s is verified", async (_name, quote) => {
    expect(await run(quote)).toBe("verified");
  });
});

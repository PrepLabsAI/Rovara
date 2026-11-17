// Golden tests for the setup agent's proposal re-read (W1, lead 4): pinned BEFORE the citation check moved into core/citations/citation-check.ts, so the move is proven byte-identical.
// Every verdict, every `final`, and every call the reader receives (repository, path, commit, untilLine, timeoutMs) is pinned for holds / fails / unreadable / limits.
import { describe, expect, it } from "vitest";
import type { SetupProposal } from "@agentx/contracts";
import {
  VERIFY_CONCURRENCY, VERIFY_DEADLINE_MS, VERIFY_LINE_SLACK, VERIFY_QUOTE_MIN_CHARS, VERIFY_READ_TIMEOUT_MS, VERIFY_READS_MAX,
  citationHolds, verifyProposal, verifyProposalDetailed, type CitationFileReader,
} from "../../packages/broker/src/core/setup-agent/proposal-verify.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(64);
const PACKAGE = ["{", '  "scripts": {', '    "ci": "npm ci",', '    "test": "npm test",', "  }", "}"].join("\n");

type Cite = { kind: string; repo?: string; path?: string; commit?: string; line?: number; quote?: string; note?: string };
const cite = (line: number | undefined, quote: string | undefined, extra: Partial<Cite> = {}): Cite => ({ kind: "file", repo: "demo", path: "package.json", commit: SHA, ...(line === undefined ? {} : { line }), ...(quote === undefined ? {} : { quote }), ...extra });
const commandsItem = (id: string, commands: string[], from: Cite[]) => ({ id, value: { repo: "demo", commands }, from, confidence: "high", risk: "low" });

function proposalOf(parts: Partial<Record<"setup" | "tests" | "checks" | "testEnvironment" | "allowedDomains" | "repositories" | "knowledge", unknown[]>>): SetupProposal {
  return {
    version: 1, basedOnRevision: 1, repositories: [], setup: [], tests: [], checks: [], testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [],
    flaggedCommands: [], foundNotUsed: [], notes: "", ...parts,
  } as unknown as SetupProposal;
}

interface Call { repository: string; path: string; commit: string; untilLine: number | undefined; timeoutMs: number }
function fakeReader(files: Record<string, string | undefined | Error>, onCall?: () => void): { read: CitationFileReader; calls: Call[] } {
  const calls: Call[] = [];
  const read: CitationFileReader = async (repository, path, commit, options) => {
    calls.push({ repository, path, commit, untilLine: options.untilLine, timeoutMs: options.timeoutMs });
    onCall?.();
    const found = files[`${repository}:${path}@${commit}`];
    if (found instanceof Error) throw found;
    return found;
  };
  return { read, calls };
}
const fixedNow = () => 1_000;

describe("setup proposal verify (golden, pinned before the W1 move)", () => {
  it("pins the constants", () => {
    expect({ VERIFY_READS_MAX, VERIFY_CONCURRENCY, VERIFY_DEADLINE_MS, VERIFY_READ_TIMEOUT_MS, VERIFY_LINE_SLACK, VERIFY_QUOTE_MIN_CHARS }).toEqual({
      VERIFY_READS_MAX: 40, VERIFY_CONCURRENCY: 4, VERIFY_DEADLINE_MS: 20_000, VERIFY_READ_TIMEOUT_MS: 8_000, VERIFY_LINE_SLACK: 3, VERIFY_QUOTE_MIN_CHARS: 8,
    });
  });

  it("holds: a quote at the cited line that contains the value is verified and final; one read through the line plus the margin", async () => {
    const { read, calls } = fakeReader({ [`demo:package.json@${SHA}`]: PACKAGE });
    const result = await verifyProposalDetailed(read, proposalOf({ setup: [commandsItem("s", ["npm ci"], [cite(3, '"ci": "npm ci"')])] }), { now: fixedNow });
    expect(result).toEqual({ items: { s: "verified" }, final: true });
    expect(calls).toEqual([{ repository: "demo", path: "package.json", commit: SHA, untilLine: 7, timeoutMs: 8_000 }]);
  });

  it("fails: a quote not near the cited line, a missing file, a line past the end, and a quote that does not contain the value are unverified and final", async () => {
    const { read } = fakeReader({ [`demo:package.json@${SHA}`]: PACKAGE });
    const result = await verifyProposalDetailed(read, proposalOf({
      setup: [
        commandsItem("far", ["npm ci"], [cite(3, '"ci": "invented words here"')]),
        commandsItem("gone", ["npm ci"], [cite(3, '"ci": "npm ci"', { path: "missing.json" })]),
        commandsItem("past", ["npm ci"], [cite(99, '"ci": "npm ci"')]),
      ],
      tests: [commandsItem("value", ["npm run lint"], [cite(4, '"test": "npm test"')])],
    }), { now: fixedNow });
    expect(result).toEqual({ items: { far: "unverified", gone: "unverified", past: "unverified", value: "unverified" }, final: true });
  });

  it("the window is exactly 3 lines either side of the cited line", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line number ${index + 1} here`);
    const text = lines.join("\n");
    const at = (line: number, quoteLine: number) => citationHolds(text, { line, quote: `line number ${quoteLine} here` });
    expect([at(10, 7), at(10, 13), at(10, 6), at(10, 14), at(1, 4), at(1, 5), at(20, 17), at(20, 16)]).toEqual([true, true, false, false, true, false, true, false]);
  });

  it("citationHolds: whitespace collapsed, CR/LF and CR line ends, no line = anywhere, a short or absent quote holds nothing, a line past the end holds nothing", () => {
    expect(citationHolds("a\r\nb   c\td\re f g h", { line: 2, quote: "b c d e f" })).toBe(true);
    expect(citationHolds("x\n".repeat(50) + "deep quote text", { quote: "deep   quote text" })).toBe(true);
    expect(citationHolds("short", { line: 1, quote: "short" })).toBe(false);
    expect(citationHolds("1234567", { line: 1, quote: "1234567" })).toBe(false);
    expect(citationHolds("12345678", { line: 1, quote: "12345678" })).toBe(true);
    expect(citationHolds("some text here", { line: 1 })).toBe(false);
    expect(citationHolds("some text here", { line: 2, quote: "some text here" })).toBe(false);
  });

  it("unreadable: a read that throws leaves the item unchecked and the result NOT final", async () => {
    const { read } = fakeReader({ [`demo:package.json@${SHA}`]: new Error("host down") });
    const result = await verifyProposalDetailed(read, proposalOf({ setup: [commandsItem("s", ["npm ci"], [cite(3, '"ci": "npm ci"')])] }), { now: fixedNow });
    expect(result).toEqual({ items: { s: "unchecked" }, final: false });
  });

  it("unreadable beats holds, fails beats unreadable within one item", async () => {
    const { read } = fakeReader({ [`demo:package.json@${SHA}`]: PACKAGE, [`demo:other.json@${SHA}`]: new Error("down"), [`demo:third.json@${SHA}`]: "nothing" });
    const result = await verifyProposalDetailed(read, proposalOf({
      setup: [
        commandsItem("mixed", ["npm ci"], [cite(3, '"ci": "npm ci"'), cite(1, "anything at all", { path: "other.json" })]),
        commandsItem("worse", ["npm ci"], [cite(1, "anything at all", { path: "other.json" }), cite(1, "not in the file", { path: "third.json" })]),
      ],
    }), { now: fixedNow });
    expect(result).toEqual({ items: { mixed: "unchecked", worse: "unverified" }, final: false });
  });

  it("no reader: every readable item is unchecked and NOT final", async () => {
    expect(await verifyProposalDetailed(undefined, proposalOf({ setup: [commandsItem("s", ["npm ci"], [cite(3, '"ci": "npm ci"')])] }), { now: fixedNow })).toEqual({ items: { s: "unchecked" }, final: false });
  });

  it("by design unreadable (short commit, short quote, no quote, non-file citation, unchecked kind) is a FINAL unchecked and never read", async () => {
    const { read, calls } = fakeReader({ [`demo:package.json@${SHA}`]: PACKAGE });
    const result = await verifyProposalDetailed(read, proposalOf({
      setup: [
        commandsItem("shortsha", ["npm ci"], [cite(3, '"ci": "npm ci"', { commit: "abc1234" })]),
        commandsItem("shortquote", ["npm ci"], [cite(3, "npm ci")]),
        commandsItem("noquote", ["npm ci"], [cite(3, undefined)]),
        commandsItem("inferred", ["npm ci"], [{ kind: "inferred", note: "a guess" }]),
      ],
      testEnvironment: [{ id: "hint", value: { hint: "use postgres" }, from: [cite(3, '"ci": "npm ci"')], confidence: "low", risk: "low" }],
    }), { now: fixedNow });
    expect(result).toEqual({ items: { shortsha: "unchecked", shortquote: "unchecked", noquote: "unchecked", inferred: "unchecked", hint: "unchecked" }, final: true });
    expect(calls).toEqual([]);
  });

  it("one read per (repository, commit, path): the deepest line wins; a citation with no line reads the whole file; a 64-character commit is readable", async () => {
    const { read, calls } = fakeReader({ [`demo:package.json@${SHA}`]: PACKAGE, [`demo:package.json@${SHA2}`]: PACKAGE, [`demo:whole.txt@${SHA}`]: "the whole quote text" });
    const result = await verifyProposalDetailed(read, proposalOf({
      setup: [commandsItem("s", ["npm ci"], [cite(3, '"ci": "npm ci"'), cite(2, '"scripts": {')])],
      tests: [commandsItem("t", ["npm test"], [cite(4, '"test": "npm test"'), cite(4, '"test": "npm test"', { commit: SHA2 })])],
      checks: [{ id: "c", value: { name: "n", repo: "demo", command: "whole quote" }, from: [cite(undefined, "the whole quote text", { path: "whole.txt" })], confidence: "high", risk: "low" }],
    }), { now: fixedNow });
    expect(result).toEqual({ items: { s: "verified", t: "verified", c: "verified" }, final: true });
    expect(calls).toEqual([
      { repository: "demo", path: "package.json", commit: SHA, untilLine: 8, timeoutMs: 8_000 },
      { repository: "demo", path: "package.json", commit: SHA2, untilLine: 8, timeoutMs: 8_000 },
      { repository: "demo", path: "whole.txt", commit: SHA, untilLine: undefined, timeoutMs: 8_000 },
    ]);
  });

  it("limits: at most 40 distinct files are read; the rest are a FINAL unchecked; at most 4 reads at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const files: Record<string, string> = {};
    const setup = Array.from({ length: 45 }, (_, index) => {
      files[`demo:f${index}.json@${SHA}`] = PACKAGE;
      return commandsItem(`s${index}`, ["npm ci"], [cite(3, '"ci": "npm ci"', { path: `f${index}.json` })]);
    });
    const read: CitationFileReader = async (repository, path, commit) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return files[`${repository}:${path}@${commit}`];
    };
    const result = await verifyProposalDetailed(read, proposalOf({ setup }), { now: fixedNow });
    const verdicts = Object.values(result.items);
    expect(verdicts.slice(0, 40).every((verdict) => verdict === "verified")).toBe(true);
    expect(verdicts.slice(40)).toEqual(["unchecked", "unchecked", "unchecked", "unchecked", "unchecked"]);
    expect(result.final).toBe(true);
    expect(peak).toBe(4);
  });

  it("deadline: a read is given min(8 s, time left); once the deadline has passed the rest are unchecked and NOT final", async () => {
    const short = fakeReader({ [`demo:a.json@${SHA}`]: PACKAGE });
    await verifyProposalDetailed(short.read, proposalOf({ setup: [commandsItem("a", ["npm ci"], [cite(3, '"ci": "npm ci"', { path: "a.json" })])] }), { now: fixedNow, deadlineMs: 3_000 });
    expect(short.calls.map((call) => call.timeoutMs)).toEqual([3_000]);

    // The first read moves the clock past the deadline before the other workers start: they read nothing.
    let clock = 0;
    const { read, calls } = fakeReader({ [`demo:a.json@${SHA}`]: PACKAGE, [`demo:b.json@${SHA}`]: PACKAGE }, () => { clock += 600; });
    const many = Array.from({ length: 6 }, (_, index) => commandsItem(`m${index}`, ["npm ci"], [cite(3, '"ci": "npm ci"', { path: index === 0 ? "a.json" : "b.json" })]));
    const result = await verifyProposalDetailed(read, proposalOf({ setup: many }), { now: () => clock, deadlineMs: 500 });
    expect(calls).toEqual([{ repository: "demo", path: "a.json", commit: SHA, untilLine: 7, timeoutMs: 500 }]);
    expect(result).toEqual({ items: { m0: "verified", m1: "unchecked", m2: "unchecked", m3: "unchecked", m4: "unchecked", m5: "unchecked" }, final: false });
  });

  it("values: allowed domain and repository names are whole tokens; verifyProposal returns the items only", async () => {
    const { read } = fakeReader({ [`demo:README.md@${SHA}`]: "Deploys to api.example.com and see https://github.com/acme/widgets.git for code" });
    const from = (quote: string) => [cite(1, quote, { path: "README.md", kind: "readme" })];
    const items = await verifyProposal(read, proposalOf({
      allowedDomains: [{ id: "d1", value: "api.example.com", from: from("Deploys to api.example.com and"), confidence: "high", risk: "low" }, { id: "d2", value: "example.com", from: from("Deploys to api.example.com and"), confidence: "high", risk: "low" }],
      repositories: [{ id: "r1", value: { url: "https://github.com/acme/widgets", name: "widgets" }, from: from("https://github.com/acme/widgets.git for"), confidence: "high", risk: "low" }],
    }), { now: fixedNow });
    expect(items).toEqual({ r1: "verified", d1: "verified", d2: "unverified" });
  });
});

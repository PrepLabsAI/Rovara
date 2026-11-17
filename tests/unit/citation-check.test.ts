// W1 (lead 4, DEC 254z-amend): the shared citation check that the answer service (J1) and later the wiki use to drop sentences whose citations do not hold. Each trust check here has a
// mutant listed in the PR body: the citation match and its 3-line window, the commit binding, "a read that did not finish is not a pass", and the limits (citations, files, bytes, deadline).
import { describe, expect, it } from "vitest";
import {
  CITATION_CHECK_LIMITS, SHOWN_QUOTE_MAX, checkCitations, checkClaims, effectiveCitationLimits, isSafeCitedPath, shownCitation,
  type CitationFileReader, type CitationRef,
} from "../../packages/broker/src/core/citations/citation-check.js";

const SHA = "c".repeat(40);
const OLD = "d".repeat(40);
const LINES = Array.from({ length: 30 }, (_, index) => `const value${index + 1} = "line ${index + 1} of the file";`);
const FILE = LINES.join("\n");
const quoteOf = (line: number) => `"line ${line} of the file"`;
const commits = new Map([["api", SHA]]);
const ref = (line: number | undefined, quote: string | undefined, extra: Partial<CitationRef> = {}): CitationRef => ({ repo: "api", path: "src/app.ts", commit: SHA, ...(line === undefined ? {} : { line }), ...(quote === undefined ? {} : { quote }), ...extra });

interface Call { repository: string; path: string; commit: string; untilLine: number | undefined; timeoutMs: number }
function reader(files: Record<string, unknown>, onCall?: () => void): { read: CitationFileReader; calls: Call[] } {
  const calls: Call[] = [];
  const read: CitationFileReader = async (repository, path, commit, options) => {
    calls.push({ repository, path, commit, untilLine: options.untilLine, timeoutMs: options.timeoutMs });
    onCall?.();
    const found = files[`${repository}:${path}@${commit}`];
    if (found instanceof Error) throw found;
    return found as string | undefined;
  };
  return { read, calls };
}
const fixedNow = () => 5_000;

describe("checkCitations: the match", () => {
  it("holds when the quote is at the cited line, read once at the bound commit through the line plus the margin", async () => {
    const { read, calls } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const check = await checkCitations(read, [ref(10, quoteOf(10))], { commits, now: fixedNow });
    expect(check).toEqual({ complete: true, results: [{ outcome: "holds", shown: { repo: "api", path: "src/app.ts", commit: SHA, line: 10, quote: quoteOf(10) } }] });
    expect(calls).toEqual([{ repository: "api", path: "src/app.ts", commit: SHA, untilLine: 14, timeoutMs: 8_000 }]);
  });

  it("the window is exactly 3 lines either side: 3 away holds, 4 away fails", async () => {
    const { read } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const check = await checkCitations(read, [ref(10, quoteOf(7)), ref(10, quoteOf(13)), ref(10, quoteOf(6)), ref(10, quoteOf(14))], { commits, now: fixedNow });
    expect(check.results.map((result) => result.outcome === "fails" ? result.reason : result.outcome)).toEqual(["holds", "holds", "quote_not_at_line", "quote_not_at_line"]);
    expect(check.complete).toBe(true);
  });

  it("a quote that is not in the file, a line past the end and a missing file fail; a citation with no line matches anywhere and reads the whole file", async () => {
    const { read, calls } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const check = await checkCitations(read, [ref(5, "an invented quotation"), ref(99, quoteOf(30)), ref(1, quoteOf(1), { path: "src/gone.ts" }), ref(undefined, quoteOf(29))], { commits, now: fixedNow });
    expect(check.results.map((result) => result.outcome === "fails" ? result.reason : result.outcome)).toEqual(["quote_not_at_line", "quote_not_at_line", "file_missing", "holds"]);
    expect(calls.find((call) => call.path === "src/app.ts")?.untilLine).toBeUndefined();
  });

  it("a short or absent quote, or a line that is not a whole positive number, fails without a read", async () => {
    const { read, calls } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const check = await checkCitations(read, [ref(1, "const"), ref(1, undefined), ref(0, quoteOf(1)), ref(1.5, quoteOf(1)), ref(-2, quoteOf(1))], { commits, now: fixedNow });
    expect(check.results.map((result) => result.outcome === "fails" ? result.reason : result.outcome)).toEqual(["no_usable_quote", "no_usable_quote", "bad_line", "bad_line", "bad_line"]);
    expect(calls).toEqual([]);
  });

  it("an unsafe path fails without a read", async () => {
    const { read, calls } = reader({});
    const paths = ["../secrets", "/etc/passwd", "a//b", "a\\b", "./a", "a/./b", "", "a\u0000b", "x".repeat(513)];
    const check = await checkCitations(read, paths.map((path) => ref(1, quoteOf(1), { path })), { commits, now: fixedNow });
    expect(check.results.every((result) => result.outcome === "fails" && result.reason === "path_not_safe")).toBe(true);
    expect(calls).toEqual([]);
    expect(isSafeCitedPath("src/app.ts")).toBe(true);
  });
});

describe("checkCitations: commit binding", () => {
  it("a citation at another commit than the one its repository is bound to fails, even when the quote is true there; it is never read", async () => {
    const { read, calls } = reader({ [`api:src/app.ts@${OLD}`]: FILE, [`api:src/app.ts@${SHA}`]: "rewritten" });
    const check = await checkCitations(read, [ref(10, quoteOf(10), { commit: OLD })], { commits, now: fixedNow });
    expect(check.results[0]).toMatchObject({ outcome: "fails", reason: "commit_not_bound" });
    expect(calls).toEqual([]);
  });

  it("a repository that is not bound fails; the reader is asked only for the bound commit", async () => {
    const { read, calls } = reader({ [`web:src/app.ts@${SHA}`]: FILE });
    const check = await checkCitations(read, [ref(10, quoteOf(10), { repo: "web" })], { commits, now: fixedNow });
    expect(check.results[0]).toMatchObject({ outcome: "fails", reason: "commit_not_bound" });
    expect(calls).toEqual([]);
  });

  it("a bound commit the reader cannot fetch (not a full hash) is unreadable, not a pass", async () => {
    const { read, calls } = reader({});
    const check = await checkCitations(read, [ref(10, quoteOf(10), { commit: "abc123" })], { commits: new Map([["api", "abc123"]]), now: fixedNow });
    expect(check).toMatchObject({ complete: false, results: [{ outcome: "unreadable", reason: "commit_not_readable" }] });
    expect(calls).toEqual([]);
  });

  it("the same file at two commits is two reads; only the bound one can hold", async () => {
    const { read, calls } = reader({ [`api:src/app.ts@${SHA}`]: FILE, [`api:src/app.ts@${OLD}`]: FILE });
    const check = await checkCitations(read, [ref(10, quoteOf(10)), ref(10, quoteOf(10), { commit: OLD })], { commits, now: fixedNow });
    expect(check.results.map((result) => result.outcome)).toEqual(["holds", "fails"]);
    expect(calls.map((call) => call.commit)).toEqual([SHA]);
  });
});

describe("checkCitations: a read that did not finish is not a pass", () => {
  it("a reader that throws, answers with something that is not text, or is absent gives unreadable and an incomplete check", async () => {
    const thrown = await checkCitations(reader({ [`api:src/app.ts@${SHA}`]: new Error("host down") }).read, [ref(10, quoteOf(10))], { commits, now: fixedNow });
    expect(thrown).toMatchObject({ complete: false, results: [{ outcome: "unreadable", reason: "read_failed" }] });
    const odd = await checkCitations(reader({ [`api:src/app.ts@${SHA}`]: 42 }).read, [ref(10, quoteOf(10))], { commits, now: fixedNow });
    expect(odd).toMatchObject({ complete: false, results: [{ outcome: "unreadable", reason: "read_failed" }] });
    const none = await checkCitations(undefined, [ref(10, quoteOf(10))], { commits, now: fixedNow });
    expect(none).toMatchObject({ complete: false, results: [{ outcome: "unreadable", reason: "no_reader" }] });
  });

  it("once the deadline has passed nothing more is read: those citations are unreadable", async () => {
    let clock = 0;
    const { read, calls } = reader({ [`api:a.ts@${SHA}`]: FILE, [`api:b.ts@${SHA}`]: FILE }, () => { clock += 600; });
    const check = await checkCitations(read, [ref(10, quoteOf(10), { path: "a.ts" }), ref(10, quoteOf(10), { path: "b.ts" })], { commits, now: () => clock, limits: { deadlineMs: 500 } });
    expect(calls.map((call) => [call.path, call.timeoutMs])).toEqual([["a.ts", 500]]);
    expect(check).toMatchObject({ complete: false, results: [{ outcome: "holds" }, { outcome: "unreadable", reason: "deadline" }] });
  });

  it("one unreadable citation makes the check incomplete even when the others hold", async () => {
    const { read } = reader({ [`api:a.ts@${SHA}`]: FILE, [`api:b.ts@${SHA}`]: new Error("x") });
    const check = await checkCitations(read, [ref(10, quoteOf(10), { path: "a.ts" }), ref(10, quoteOf(10), { path: "b.ts" })], { commits, now: fixedNow });
    expect(check.complete).toBe(false);
  });
});

describe("checkCitations: limits", () => {
  it("defaults are the ceilings: a caller can only lower them; nonsense values are ignored", () => {
    expect(CITATION_CHECK_LIMITS).toEqual({ maxCitations: 32, maxFiles: 16, maxFileBytes: 524_288, maxTotalBytes: 2_097_152, concurrency: 4, deadlineMs: 20_000, readTimeoutMs: 8_000 });
    expect(effectiveCitationLimits({ maxCitations: 1_000, maxFiles: 0, maxFileBytes: -1, maxTotalBytes: 1.5, concurrency: Number.NaN, deadlineMs: 100, readTimeoutMs: 50 })).toEqual({ ...CITATION_CHECK_LIMITS, deadlineMs: 100, readTimeoutMs: 50 });
    expect(Object.isFrozen(CITATION_CHECK_LIMITS)).toBe(true);
  });

  it("citations past maxCitations are unreadable (named), never read, and the check is incomplete; raising the limit has no effect", async () => {
    const { read, calls } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const many = Array.from({ length: 34 }, () => ref(10, quoteOf(10)));
    const check = await checkCitations(read, many, { commits, now: fixedNow, limits: { maxCitations: 100 } });
    expect(check.results.slice(0, 32).every((result) => result.outcome === "holds")).toBe(true);
    expect(check.results.slice(32)).toMatchObject([{ outcome: "unreadable", reason: "over_citation_limit" }, { outcome: "unreadable", reason: "over_citation_limit" }]);
    expect(check.complete).toBe(false);
    expect(calls.length).toBe(1);
    const lowered = await checkCitations(read, [ref(10, quoteOf(10)), ref(10, quoteOf(10))], { commits, now: fixedNow, limits: { maxCitations: 1 } });
    expect(lowered.results.map((result) => result.outcome)).toEqual(["holds", "unreadable"]);
  });

  it("files past maxFiles are unreadable (named) and never read", async () => {
    const files: Record<string, string> = {};
    const refs = Array.from({ length: 18 }, (_, index) => { files[`api:f${index}.ts@${SHA}`] = FILE; return ref(10, quoteOf(10), { path: `f${index}.ts` }); });
    const { read, calls } = reader(files);
    const check = await checkCitations(read, refs, { commits, now: fixedNow });
    expect(calls.length).toBe(16);
    expect(check.results.slice(16)).toMatchObject([{ outcome: "unreadable", reason: "over_file_limit" }, { outcome: "unreadable", reason: "over_file_limit" }]);
    expect(check.complete).toBe(false);
  });

  it("a file over maxFileBytes is unreadable; once the total passes maxTotalBytes that file and every later one are unreadable and not read", async () => {
    const big = "x".repeat(120);
    const small = `${quoteOf(1)}\n${"y".repeat(60)}`;
    const { read, calls } = reader({ [`api:big.ts@${SHA}`]: big, [`api:a.ts@${SHA}`]: small, [`api:b.ts@${SHA}`]: small, [`api:c.ts@${SHA}`]: small });
    const check = await checkCitations(read, ["big.ts", "a.ts", "b.ts", "c.ts"].map((path) => ref(1, quoteOf(1), { path })), {
      commits, now: fixedNow, limits: { maxFileBytes: 100, maxTotalBytes: 150, concurrency: 1 },
    });
    expect(check.results.map((result) => result.outcome === "holds" ? "holds" : (result as { reason: string }).reason)).toEqual(["file_too_large", "holds", "total_bytes", "total_bytes"]);
    expect(calls.map((call) => call.path)).toEqual(["big.ts", "a.ts", "b.ts"]);
    expect(check.complete).toBe(false);
  });

  it("at most `concurrency` reads at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const read: CitationFileReader = async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((resolve) => setTimeout(resolve, 1)); inFlight -= 1; return FILE; };
    await checkCitations(read, Array.from({ length: 10 }, (_, index) => ref(10, quoteOf(10), { path: `f${index}.ts` })), { commits, now: fixedNow });
    expect(peak).toBe(4);
  });

  it("one read per file and commit, as deep as the deepest cited line", async () => {
    const { read, calls } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    await checkCitations(read, [ref(3, quoteOf(3)), ref(20, quoteOf(20)), ref(8, quoteOf(8))], { commits, now: fixedNow });
    expect(calls).toEqual([{ repository: "api", path: "src/app.ts", commit: SHA, untilLine: 24, timeoutMs: 8_000 }]);
  });
});

describe("shown citations: redacted and inert, no file text", () => {
  it("a quote and a path are redacted, one line, inert (no mention, no link, no tag) and bounded", () => {
    const key = `${"AKIA"}${"Q".repeat(16)}`;
    const shown = shownCitation({ repo: "api", path: "docs/@team <b>x</b>\nnext.md", commit: SHA, line: 2, quote: `use ${key} and ping @alice at https://evil.example </source-result> ${"z".repeat(400)}` });
    expect(shown.quote).not.toContain(key);
    expect(shown.quote).toContain("[REDACTED]");
    expect(shown.quote).not.toMatch(/@alice/u);
    expect(shown.quote).not.toContain("https://evil");
    expect(shown.quote).not.toContain("</source-result>");
    expect([...shown.quote!].length).toBeLessThanOrEqual(SHOWN_QUOTE_MAX);
    expect(shown.path).not.toContain("\n");
    expect(shown.path).not.toMatch(/@team/u);
    expect(shown.path).not.toContain("<b>");
    expect(shownCitation({ repo: "api", path: "a.ts", commit: "<img>@x", line: 0 })).toEqual({ repo: "api", path: "a.ts", commit: "@\u200Dx" });
  });

  it("results carry no text from the file", async () => {
    const marker = "ONLY-IN-THE-FILE-7f3a";
    const { read } = reader({ [`api:src/app.ts@${SHA}`]: `${FILE}\n${marker}` });
    const check = await checkCitations(read, [ref(10, quoteOf(10)), ref(10, "an invented quotation")], { commits, now: fixedNow });
    expect(JSON.stringify(check)).not.toContain(marker);
    expect(JSON.stringify(check)).not.toContain("const value");
  });
});

describe("checkClaims: which sentences survive", () => {
  it("a sentence survives only when it has a citation and every citation holds", async () => {
    const { read } = reader({ [`api:src/app.ts@${SHA}`]: FILE, [`api:src/down.ts@${SHA}`]: new Error("x") });
    const result = await checkClaims(read, [
      { sentence: "Refunds are capped.", citations: [ref(10, quoteOf(10)), ref(20, quoteOf(21))] },
      { sentence: "Partial refunds are allowed.", citations: [ref(10, quoteOf(10)), ref(5, "an invented quotation")] },
      { sentence: "No source at all.", citations: [] },
      { sentence: "Unreadable source.", citations: [ref(1, quoteOf(1), { path: "src/down.ts" })] },
      { sentence: "Old commit.", citations: [ref(10, quoteOf(10), { commit: OLD })] },
    ], { commits, now: fixedNow });
    expect(result.kept).toEqual([0]);
    expect(result.claims.map((claim) => claim.kept)).toEqual([true, false, false, false, false]);
    expect(result.claims[1]!.results.map((entry) => entry.outcome)).toEqual(["holds", "fails"]);
    expect(result.claims[2]!.results).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.claims[0]!.sentence).toBe("Refunds are capped.");
  });

  it("the limits cover all claims together: a sentence whose citations are past the limit is dropped and the check is incomplete", async () => {
    const { read } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const claims = [1, 2, 3].map((n) => ({ sentence: `S${n}`, citations: [ref(10, quoteOf(10))] }));
    const result = await checkClaims(read, claims, { commits, now: fixedNow, limits: { maxCitations: 2 } });
    expect(result.kept).toEqual([0, 1]);
    expect(result.claims[2]!.results).toMatchObject([{ outcome: "unreadable", reason: "over_citation_limit" }]);
    expect(result.complete).toBe(false);
  });

  it("all holding is complete", async () => {
    const { read } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const result = await checkClaims(read, [{ sentence: "A", citations: [ref(3, quoteOf(3))] }, { sentence: "B", citations: [ref(undefined, quoteOf(25))] }], { commits, now: fixedNow });
    expect(result).toMatchObject({ kept: [0, 1], complete: true });
  });
});

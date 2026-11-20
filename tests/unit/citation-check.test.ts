// W1 (lead 4, DEC 254z-amend): the shared citation check that the answer service (J1) and later the wiki use to drop sentences whose citations do not hold. Each trust check here has a
// mutant listed in the PR body: the citation match and its 3-line window, the commit binding, "a read that did not finish is not a pass", and the limits (citations, files, bytes, deadline).
import { describe, expect, it } from "vitest";
import {
  CITATION_CHECK_LIMITS, PROSE_CODE_NAMES_MAX, PROSE_QUOTE_MIN_CHARS, PROSE_SENTENCE_MAX_CHARS, SHOWN_QUOTE_MAX, checkCitations, checkClaims, codeNamesOf, effectiveCitationLimits, hasCodeToken, isSafeCitedPath, shownCitation,
  type CitationFileReader, type CitationRef,
} from "../../packages/broker/src/core/citations/citation-check.js";

const SHA = "c".repeat(40);
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

  it("a short or absent quote, or a line that is not a whole positive number, fails without a read", async () => {
    const { read, calls } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const check = await checkCitations(read, [ref(1, "const"), ref(1, undefined), ref(0, quoteOf(1)), ref(1.5, quoteOf(1)), ref(-2, quoteOf(1))], { commits, now: fixedNow });
    expect(check.results.map((result) => result.outcome === "source_not_found" ? result.reason : result.outcome)).toEqual(["no_usable_quote", "no_usable_quote", "bad_line", "bad_line", "bad_line"]);
    expect(calls).toEqual([]);
  });

  it("an unsafe path fails without a read", async () => {
    const { read, calls } = reader({});
    const paths = ["../secrets", "/etc/passwd", "a//b", "a\\b", "./a", "a/./b", "", "a\u0000b", "x".repeat(513)];
    const check = await checkCitations(read, paths.map((path) => ref(1, quoteOf(1), { path })), { commits, now: fixedNow });
    expect(check.results.every((result) => result.outcome === "source_not_found" && result.reason === "path_not_safe")).toBe(true);
    expect(calls).toEqual([]);
    expect(isSafeCitedPath("src/app.ts")).toBe(true);
  });
});

describe("checkCitations: commit binding", () => {

  it("a bound commit the reader cannot fetch (not a full hash) is unreadable, not a pass", async () => {
    const { read, calls } = reader({});
    const check = await checkCitations(read, [ref(10, quoteOf(10), { commit: "abc123" })], { commits: new Map([["api", "abc123"]]), now: fixedNow });
    expect(check).toMatchObject({ complete: false, results: [{ outcome: "unreadable", reason: "commit_not_readable" }] });
    expect(calls).toEqual([]);
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
    expect(check).toMatchObject({ complete: false, results: [{ outcome: "source_found" }, { outcome: "unreadable", reason: "deadline" }] });
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
    expect(check.results.slice(0, 32).every((result) => result.outcome === "source_found")).toBe(true);
    expect(check.results.slice(32)).toMatchObject([{ outcome: "unreadable", reason: "over_citation_limit" }, { outcome: "unreadable", reason: "over_citation_limit" }]);
    expect(check.complete).toBe(false);
    expect(calls.length).toBe(1);
    const lowered = await checkCitations(read, [ref(10, quoteOf(10)), ref(10, quoteOf(10))], { commits, now: fixedNow, limits: { maxCitations: 1 } });
    expect(lowered.results.map((result) => result.outcome)).toEqual(["source_found", "unreadable"]);
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

  it("a file over maxFileBytes is unreadable and still counts; once the total passes maxTotalBytes every later file is unreadable and not read", async () => {
    const big = "x".repeat(120);
    const small = `${quoteOf(1)}\n${"y".repeat(60)}`;
    const { read, calls } = reader({ [`api:big.ts@${SHA}`]: big, [`api:a.ts@${SHA}`]: small, [`api:b.ts@${SHA}`]: small, [`api:c.ts@${SHA}`]: small });
    const check = await checkCitations(read, ["a.ts", "big.ts", "b.ts", "c.ts"].map((path) => ref(1, quoteOf(1), { path })), {
      commits, now: fixedNow, limits: { maxFileBytes: 100, maxTotalBytes: 150, concurrency: 1 },
    });
    expect(check.results.map((result) => result.outcome === "source_found" ? "source_found" : (result as { reason: string }).reason)).toEqual(["source_found", "file_too_large", "total_bytes", "total_bytes"]);
    // The oversized file still counts toward the total (81 + 120 > 150): nothing after it is read.
    expect(calls.map((call) => call.path)).toEqual(["a.ts", "big.ts"]);
    expect(check.complete).toBe(false);
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
});

describe("prose mode (DEC 254zh): strict rules for answers and the wiki", () => {
  const CODE = [
    "export function refundLimit(order: Order): number {",
    "  // Partial refunds are capped at the order total in src/payments/refunds.ts",
    "  return Math.min(order.total, MAX_REFUND_CENTS);",
    "}",
  ].join("\n");
  const files = { [`api:src/refunds.ts@${SHA}`]: CODE };
  const at = (line: number, quote: string): CitationRef => ref(line, quote, { path: "src/refunds.ts" });

  it("a quote must be at least PROSE_QUOTE_MIN_CHARS characters (whitespace collapsed); plain mode accepts 8", async () => {
    expect(PROSE_QUOTE_MIN_CHARS).toBe(20);
    const { read } = reader(files);
    const nineteen = "return Math.min(ord";
    const twenty = "return Math.min(orde";
    expect([[...nineteen].length, [...twenty].length]).toEqual([19, 20]);
    const prose = await checkCitations(read, [at(3, nineteen), at(3, twenty), at(3, "return    Math.min(ord")], { commits, now: fixedNow });
    expect(prose.results.map((result) => result.outcome === "source_not_found" ? result.reason : result.outcome)).toEqual(["quote_too_short", "source_found", "quote_too_short"]);
    const plain = await checkCitations(read, [at(3, nineteen)], { commits, now: fixedNow, mode: "plain" });
    expect(plain.results[0]!.outcome).toBe("source_found");
  });

  it("every code name in the sentence must be a whole token in one of its quotes; otherwise the sentence is dropped", async () => {
    const { read } = reader(files);
    const quote = "export function refundLimit(order: Order): number {";
    const capped = "return Math.min(order.total, MAX_REFUND_CENTS);";
    const result = await checkClaims(read, [
      { sentence: "Refunds are limited by `refundLimit`.", citations: [at(1, quote)] },
      { sentence: "refundLimit caps refunds at MAX_REFUND_CENTS.", citations: [at(1, quote), at(3, capped)] },
      { sentence: "The cap lives in `refundLimitV2`.", citations: [at(1, quote)] },
      { sentence: "refundLimit uses MAX_REFUND to cap.", citations: [at(1, quote), at(3, capped)] },
      { sentence: "The function `refund` caps it.", citations: [at(1, quote)] },
      { sentence: "Refunds never exceed the order total.", citations: [at(3, capped)] },
      { sentence: "It is in src/payments/refunds.ts.", citations: [at(2, "Partial refunds are capped at the order total in src/payments/refunds.ts")] },
      { sentence: "It is in src/payments/refund.ts.", citations: [at(2, "Partial refunds are capped at the order total in src/payments/refunds.ts")] },
    ], { commits, now: fixedNow });
    expect(result.claims.map((claim) => claim.dropped ?? "kept")).toEqual([
      "kept", "kept", "code_name_not_in_quote", "code_name_not_in_quote", "code_name_not_in_quote", "kept", "kept", "code_name_not_in_quote",
    ]);
    expect(result.kept).toEqual([0, 1, 5, 6]);
    expect(result.complete).toBe(true);
    // Plain mode does not look at code names.
    const plain = await checkClaims(read, [{ sentence: "The cap lives in `refundLimitV2`.", citations: [at(1, quote)] }], { commits, now: fixedNow, mode: "plain" });
    expect(plain.kept).toEqual([0]);
  });

  it("a sentence with more than PROSE_CODE_NAMES_MAX code names is dropped", async () => {
    const { read } = reader(files);
    const names = Array.from({ length: PROSE_CODE_NAMES_MAX + 1 }, (_, index) => `\`name${index}\``).join(" ");
    const result = await checkClaims(read, [{ sentence: names, citations: [at(1, "export function refundLimit(order: Order): number {")] }], { commits, now: fixedNow });
    expect(result.claims[0]!.dropped).toBe("too_many_code_names");
  });

  it("a sentence longer than PROSE_SENTENCE_MAX_CHARS is dropped; the code-name scan is linear on long word runs", async () => {
    const { read } = reader(files);
    const quote = "export function refundLimit(order: Order): number {";
    const long = `refundLimit ${"a".repeat(PROSE_SENTENCE_MAX_CHARS)}`;
    const result = await checkClaims(read, [{ sentence: long, citations: [at(1, quote)] }], { commits, now: fixedNow });
    expect(result.claims[0]!.dropped).toBe("sentence_too_long");
    const started = Date.now();
    for (const run of ["a-".repeat(20_000), "a".repeat(40_000), "a.".repeat(20_000), "aB".repeat(20_000), "a_".repeat(20_000)]) codeNamesOf(run);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("hasCodeToken matches whole tokens only, case-sensitive", () => {
    expect(hasCodeToken("x = refundLimit(order)", "refundLimit")).toBe(true);
    expect(hasCodeToken("x = refundLimitV2(order)", "refundLimit")).toBe(false);
    expect(hasCodeToken("x = myrefundLimit(order)", "refundLimit")).toBe(false);
    expect(hasCodeToken("x = RefundLimit(order)", "refundLimit")).toBe(false);
    expect(hasCodeToken("see src/app.ts here", "app.ts")).toBe(true);
    expect(hasCodeToken("see src/app.tsx here", "app.ts")).toBe(false);
    expect(hasCodeToken("npm   run build", "npm run build")).toBe(true);
    expect(hasCodeToken("anything", "")).toBe(false);
  });
});

describe("review fixes (REVIEW-1)", () => {
  it("M2: a reader that never answers cannot hang the check: the read gives up at its timeout and is unreadable", async () => {
    const read: CitationFileReader = () => new Promise<string | undefined>(() => undefined);
    const started = Date.now();
    const check = await checkCitations(read, [ref(10, quoteOf(10))], { commits, limits: { readTimeoutMs: 30 } });
    expect(check).toMatchObject({ complete: false, results: [{ outcome: "unreadable", reason: "deadline" }] });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("L2: a quote that is not a string, or a reader that answers with a Buffer, never throws and never passes", async () => {
    const { read } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const odd = await checkCitations(read, [{ ...ref(10, undefined), quote: 42 as unknown as string }, { ...ref(10, undefined), quote: null as unknown as string }], { commits, now: fixedNow });
    expect(odd.results.map((result) => result.outcome === "source_not_found" ? result.reason : result.outcome)).toEqual(["no_usable_quote", "no_usable_quote"]);
    const buffer = await checkCitations(reader({ [`api:src/app.ts@${SHA}`]: Buffer.from(FILE) }).read, [ref(10, quoteOf(10))], { commits, now: fixedNow });
    expect(buffer).toMatchObject({ complete: false, results: [{ outcome: "unreadable", reason: "read_failed" }] });
  });

  it("L5: an unreadable citation drops its sentence as unreadable; an unknown mode is prose; $ is an identifier character; call and camelCase shapes alone are code names", async () => {
    const { read } = reader({ [`api:src/app.ts@${SHA}`]: FILE, [`api:src/down.ts@${SHA}`]: new Error("x") });
    const dropped = await checkClaims(read, [{ sentence: "It is down.", citations: [ref(1, quoteOf(1), { path: "src/down.ts" })] }], { commits, now: fixedNow });
    expect(dropped.claims[0]!.dropped).toBe("unreadable");
    const unknown = await checkCitations(read, [ref(undefined, quoteOf(10))], { commits, now: fixedNow, mode: "loose" as unknown as "plain" });
    expect(unknown.results[0]).toMatchObject({ outcome: "source_not_found", reason: "line_required" });
    expect(hasCodeToken("x = $refundLimit", "refundLimit")).toBe(false);
    expect(hasCodeToken("x = refundLimit$", "refundLimit")).toBe(false);
    expect(codeNamesOf("Then refund() runs.")).toEqual(["refund"]);
    expect(codeNamesOf("Then orderTotal runs.")).toEqual(["orderTotal"]);
  });

  it("REVIEW-2 M-A: a run of name characters longer than the shapes' 200-character bound drops the sentence; a non-string sentence is not a sentence", async () => {
    const { read } = reader({ [`api:src/app.ts@${SHA}`]: FILE });
    const cite10 = [ref(10, quoteOf(10))];
    const claims = [`${"a".repeat(250)}Limit`, `${"a".repeat(250)}_x`, `${"a".repeat(250)}.ts`, `${"a".repeat(250)}()`].map((name) => ({ sentence: `See ${name} here.`, citations: cite10 }));
    const result = await checkClaims(read, [...claims, { sentence: 42 as unknown as string, citations: cite10 }, { sentence: `${"a".repeat(200)} ok`, citations: cite10 }], { commits, now: fixedNow });
    expect(result.claims.map((claim) => claim.dropped ?? "kept")).toEqual(["code_name_too_long", "code_name_too_long", "code_name_too_long", "code_name_too_long", "not_a_sentence", "kept"]);
  });
});

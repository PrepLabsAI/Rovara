// The text of `.rovara/lessons.md`: deterministic order, no dates or links, cleaned text, surgical changes that leave the team's own bytes alone.
import { describe, expect, it } from "vitest";
import {
  FILE_HEADER, WHOLE_REPOSITORY, applyFileChanges, blockOf, cleanLessonLine, compareHeadings, normalizeBlockText, parseLessonsFile, renderLessonsFile, textHash, wrapBullet,
} from "../../../packages/broker/src/lessons/repo-file-format.js";

type B = { id: string; heading: string; text: string };
const blocks: B[] = [
  { id: "les_7f3a", heading: WHOLE_REPOSITORY, text: "Run `pnpm db:migrate` before integration tests; they fail without the schema." },
  { id: "les_91c2", heading: "packages/billing/", text: "Amounts are integer cents; never use floats for money." },
  { id: "les_0aaa", heading: "packages/billing/", text: "Round half to even." },
  { id: "les_b001", heading: "apps/web/, packages/ui/", text: "Use the design tokens." },
];

/** A seeded shuffle, so the order tests are the same on every run. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("the canonical file", () => {
  it("has the header, the whole repository first, then paths in byte order, blocks by id", () => {
    const text = renderLessonsFile(blocks);
    expect(text).toBe([
      ...FILE_HEADER, "", "## Whole repository", "", "<!-- rovara:les_7f3a -->", "- Run `pnpm db:migrate` before integration tests; they fail without the schema.",
      "", "## apps/web/, packages/ui/", "", "<!-- rovara:les_b001 -->", "- Use the design tokens.",
      "", "## packages/billing/", "", "<!-- rovara:les_0aaa -->", "- Round half to even.", "", "<!-- rovara:les_91c2 -->", "- Amounts are integer cents; never use floats for money.", "",
    ].slice(0, -1).join("\n") + "\n");
  });

  it("is the same bytes for any order of the same set, and ends with one line feed and no date, link or count", () => {
    const first = renderLessonsFile(blocks);
    for (let seed = 1; seed <= 25; seed += 1) expect(renderLessonsFile(shuffled(blocks, seed))).toBe(first);
    expect(first.endsWith("\n") && !first.endsWith("\n\n")).toBe(true);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}|https?:|\b\d+ lessons\b/u);
  });

  it("is reached by adding one at a time in any order, and by removing from a bigger file", () => {
    const target = renderLessonsFile(blocks);
    for (let seed = 1; seed <= 25; seed += 1) {
      let text: string | undefined;
      for (const block of shuffled(blocks, seed)) text = applyFileChanges(text, { remove: [], replace: [], add: [block] });
      expect(text).toBe(target);
    }
    const extra: B = { id: "les_zzzz", heading: "docs/", text: "Docs are generated." };
    for (let seed = 1; seed <= 10; seed += 1) {
      let text = renderLessonsFile([...blocks, extra]);
      for (const block of shuffled(blocks, seed)) text = applyFileChanges(text, { remove: [], replace: [{ id: block.id, text: block.text }], add: [] });
      expect(applyFileChanges(text, { remove: ["les_zzzz"], replace: [], add: [] })).toBe(target);
    }
  });

  it("a single removal, in any position, leaves exactly the canonical file of the rest (empty sections go)", () => {
    for (const gone of blocks) expect(applyFileChanges(renderLessonsFile(blocks), { remove: [gone.id], replace: [], add: [] })).toBe(renderLessonsFile(blocks.filter((b) => b.id !== gone.id)));
    expect(applyFileChanges(renderLessonsFile(blocks), { remove: blocks.map((b) => b.id), replace: [], add: [] })).toBe(`${FILE_HEADER.join("\n")}\n`);
  });

  it("round trips through the parser: ids, sections and normalised text", () => {
    const parsed = parseLessonsFile(renderLessonsFile(blocks));
    expect(parsed.blocks.map((b) => [b.id, b.heading, b.text])).toEqual([
      ["les_7f3a", WHOLE_REPOSITORY, normalizeBlockText(blocks[0]!.text)],
      ["les_b001", "apps/web/, packages/ui/", "Use the design tokens."],
      ["les_0aaa", "packages/billing/", "Round half to even."],
      ["les_91c2", "packages/billing/", "Amounts are integer cents; never use floats for money."],
    ]);
    expect(parsed.duplicates).toEqual([]);
  });

  it("sorts headings by bytes, not by locale", () => {
    expect(compareHeadings("Zeta/", "alpha/")).toBeLessThan(0);
    expect(compareHeadings(WHOLE_REPOSITORY, "")).toBe(0);
    expect(compareHeadings(WHOLE_REPOSITORY, "a/")).toBeLessThan(0);
  });
});

describe("the text of a lesson", () => {
  it("is cleaned: NFC, line breaks and U+2028/9 to spaces, bidi and zero-width characters removed, no comment marks", () => {
    const dirty = "Café \u202eevil\u202c\nline two\u2028three\u200bfour <!-- rovara:les_fake --> end --> x";
    const clean = cleanLessonLine(dirty);
    expect(clean).toBe("Café evil line two threefour rovara:les_fake end x");
    expect(clean).not.toMatch(/[\u202a-\u202e\u2028\u2029\u200b\n\r]|<!--|-->/u);
  });

  it("is cut at 600 code points on a grapheme boundary and never splits a surrogate pair or an emoji sequence", () => {
    // "x" with a combining accent has no single-character form: it is one grapheme of two code points, and is dropped whole rather than left as a bare "x".
    expect(cleanLessonLine(`${"a".repeat(599)}x\u0301`)).toBe("a".repeat(599));
    expect(cleanLessonLine(`${"a".repeat(598)}x\u0301`)).toBe(`${"a".repeat(598)}x\u0301`);
    expect(cleanLessonLine("x".repeat(900)).length).toBe(600);
  });

  it("wraps at 80 columns with a hanging indent and never starts a line with a list marker, heading, rule or fence", () => {
    const text = `${"word ".repeat(14)}- not a list ${"more ".repeat(8)}# nor a heading ${"x ".repeat(20)}1. nor a number ${"y ".repeat(20)}--- ${"z ".repeat(10)}> quote`;
    const lines = wrapBullet(cleanLessonLine(text));
    expect(lines[0]!.startsWith("- ")).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line.slice(2)).not.toMatch(/^(?:[-+*#>=<|~]|\d{1,9}[.)])/u);
    }
    for (const line of lines) expect(line.length <= 80 || !line.slice(2).includes(" ") || /^\s*-?\s*\S+\s\S+/u.test(line)).toBe(true);
    expect(normalizeBlockText(lines.join(" "))).toBe(cleanLessonLine(text));
  });

  it("a hand reflow, other bullet markers and CRLF read back as the same text", () => {
    const lines = wrapBullet("Amounts are integer cents; never use floats for money, anywhere in the billing code or its tests.");
    const reflowed = parseLessonsFile(`<!-- rovara:les_1234 -->\r\n* ${lines.join(" ").replace(/^- /u, "")}\r\n`);
    expect(reflowed.eol).toBe("\r\n");
    expect(reflowed.blocks[0]!.text).toBe("Amounts are integer cents; never use floats for money, anywhere in the billing code or its tests.");
    expect(textHash(reflowed.blocks[0]!.text)).toBe(textHash(normalizeBlockText(lines.join(" "))));
  });
});

describe("a file the team has also written in", () => {
  const team = [
    "# Our lessons", "", "Intro the team wrote.", "", "## Whole repository", "", "<!-- rovara:les_7f3a -->", "- Old text of the lesson.", "",
    "- A bullet the team wrote with no id line.", "", "Some paragraph between blocks.", "", "## Team notes", "", "Free text.", "",
  ].join("\n");

  it("keeps every byte it does not change (the team's bullet, paragraphs and sections)", () => {
    const out = applyFileChanges(team, { remove: [], replace: [{ id: "les_7f3a", text: "New text." }], add: [] });
    expect(out).toBe(team.replace("- Old text of the lesson.", "- New text."));
  });

  it("removes only the named block and the blank line that went with it", () => {
    const out = applyFileChanges(team, { remove: ["les_7f3a"], replace: [], add: [] });
    expect(out).toBe(team.replace("<!-- rovara:les_7f3a -->\n- Old text of the lesson.\n\n", ""));
    expect(out).toContain("- A bullet the team wrote with no id line.");
  });

  it("adds a block under its section, in id order, without disturbing the team's text", () => {
    const out = applyFileChanges(team, { remove: [], replace: [], add: [{ id: "les_0000", heading: WHOLE_REPOSITORY, text: "Added." }, { id: "les_8000", heading: WHOLE_REPOSITORY, text: "Added later." }] });
    const parsed = parseLessonsFile(out);
    expect(parsed.blocks.map((b) => b.id)).toEqual(["les_0000", "les_7f3a", "les_8000"]);
    expect(out).toContain("Some paragraph between blocks.");
    expect(out).toContain("## Team notes");
  });

  it("keeps CRLF, and a file with no final newline gets one", () => {
    const crlf = team.replace(/\n/gu, "\r\n");
    const out = applyFileChanges(crlf, { remove: [], replace: [{ id: "les_7f3a", text: "New text." }], add: [] });
    expect(out).toBe(crlf.replace("- Old text of the lesson.", "- New text."));
    expect(applyFileChanges(team.trimEnd(), { remove: [], replace: [], add: [] }).endsWith("\n")).toBe(true);
  });

  it("never touches a duplicated id, a missing id, or an id inside the header's own example", () => {
    const dup = `${renderLessonsFile([{ id: "les_aaaa", heading: WHOLE_REPOSITORY, text: "One." }])}\n<!-- rovara:les_aaaa -->\n- Two.\n`;
    const parsed = parseLessonsFile(dup);
    expect(parsed.duplicates).toEqual(["les_aaaa"]);
    expect(blockOf(parsed, "les_aaaa")).toBeUndefined();
    expect(applyFileChanges(dup, { remove: ["les_aaaa"], replace: [{ id: "les_aaaa", text: "x" }], add: [] })).toBe(dup);
    expect(applyFileChanges(dup, { remove: ["les_nope"], replace: [], add: [] })).toBe(dup);
    expect(parseLessonsFile(renderLessonsFile([])).blocks).toEqual([]);
  });
});

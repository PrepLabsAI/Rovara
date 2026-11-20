import { describe, expect, it } from "vitest";
import {
  CONFUSABLE_FOLD,
  COMMAND_COMMENT_PATTERNS,
  HTML_TAG_NAMES,
  KNOWN_BOT_ACCOUNTS,
  TRIGGER_LABEL_PATTERNS,
  cleanText,
  commentSignal,
  normalizeForMatching,
  stripMentions,
} from "../../packages/contracts/src/index.js";
import { expectLinearScaling } from "../support/scaling.js";

const opts = { allowMentions: false, labelPaths: [] as string[] };
const signal = (args: unknown, more: Partial<Parameters<typeof commentSignal>[1]> = {}) => commentSignal(args, { ...opts, ...more });
const textIsConsequential = (text: string, more: Partial<Parameters<typeof commentSignal>[1]> = {}) => signal({ body: text }, more).consequential;

describe("normalizeForMatching and cleanText", () => {

  it("removes every Unicode Cf character, including the ranges the brief lists", () => {
    const listed = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0x00ad, 0x061c, 0x180e];
    for (const point of listed) {
      const char = String.fromCodePoint(point);
      expect(normalizeForMatching(`/${char}deploy`)).toBe("/deploy");
      expect(cleanText(`/${char}deploy`)).toBe("/deploy");
    }
    // Every Cf code point in the Unicode database, inserted at the worst places.
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const char = String.fromCodePoint(point);
      if (!/^\p{Cf}$/u.test(char)) continue;
      expect(textIsConsequential(`/${char}deploy`), `U+${point.toString(16)} in /deploy`).toBe(true);
      expect(textIsConsequential(`bo${char}rs r+`), `U+${point.toString(16)} in bors`).toBe(true);
      expect(textIsConsequential(`@merg${char}ifyio queue`), `U+${point.toString(16)} in mergify`).toBe(true);
    }
  });

  it("documents its confusable table: Cyrillic, Greek, small capitals, digits and slash look-alikes", () => {
    const expectFold = (chars: string, ascii: string) => { for (const char of chars) expect(CONFUSABLE_FOLD[char], `${char} U+${char.codePointAt(0)?.toString(16)}`).toBe(ascii); };
    expectFold("аА", "a"); expectFold("сСϲ", "c"); expectFold("еЕ", "e"); expectFold("оОοΟ", "o"); expectFold("рРρΡ", "p");
    expectFold("хХχΧ", "x"); expectFold("уУ", "y"); expectFold("іІιΙ", "i"); expectFold("јЈ", "j"); expectFold("ѕЅ", "s");
    expectFold("һ", "h"); expectFold("ԁ", "d"); expectFold("ԛ", "q"); expectFold("ԝ", "w"); expectFold("ӏ", "l");
    expectFold("βВ", "b"); expectFold("кКκΚ", "k"); expectFold("мМΜ", "m"); expectFold("нНΗ", "h"); expectFold("тТτΤ", "t");
    expectFold("αΑ", "a"); expectFold("ν", "v"); expectFold("Ν", "n"); expectFold("υ", "u"); expectFold("Ζ", "z"); expectFold("Υ", "y");
    expectFold("ᴀ", "a"); expectFold("ʙ", "b"); expectFold("ᴄ", "c"); expectFold("ᴅ", "d"); expectFold("ᴇ", "e"); expectFold("ɢ", "g");
    expectFold("ɪ", "i"); expectFold("ᴊ", "j"); expectFold("ᴋ", "k"); expectFold("ʟ", "l"); expectFold("ᴍ", "m"); expectFold("ɴ", "n");
    expectFold("ᴏ", "o"); expectFold("ᴘ", "p"); expectFold("ʀ", "r"); expectFold("ꜱ", "s"); expectFold("ᴛ", "t"); expectFold("ᴜ", "u");
    expectFold("ᴠ", "v"); expectFold("ᴡ", "w"); expectFold("ʏ", "y"); expectFold("ᴢ", "z"); expectFold("ɑ", "a"); expectFold("ı", "i");
    expectFold("٠۰०", "0"); expectFold("١۱१", "1"); expectFold("٥۵५", "5"); expectFold("٩۹९", "9");
    expectFold("∕⁄⧸╱⟋", "/"); expectFold("＠﹫", "@");
  });

});

describe("commentSignal: consequential text", () => {

  it("lists a maintained pattern set with a name each", () => {
    expect(COMMAND_COMMENT_PATTERNS.length).toBeGreaterThanOrEqual(6);
    for (const entry of COMMAND_COMMENT_PATTERNS) {
      expect(entry.name).toMatch(/\w/);
      expect(entry.pattern.flags).toContain("i");
      expect(entry.pattern.flags).not.toContain("g"); // a /g RegExp keeps lastIndex between calls
    }
    for (const bot of ["mergifyio", "kodiakhq", "dependabot", "renovate", "bors", "github-actions"]) expect(KNOWN_BOT_ACCOUNTS).toContain(bot);
  });

});

describe("commentSignal: consequential in structured arguments", () => {
  it("scans a Jira addCommentToJiraIssue commentBody", () => {
    expect(signal({ issueIdOrKey: "ABC-1", commentBody: "/deploy" }, { skipPaths: ["issueIdOrKey"] }).consequential).toBe(true);
  });

  it("treats arguments nested beyond the walk limit as consequential", () => {
    let deep: unknown = "fine";
    for (let level = 0; level < 200; level += 1) deep = { next: deep };
    const result = signal(deep);
    expect(result.consequential).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/nested/);
  });

});

describe("commentSignal: mentions", () => {
  it.each([["@renovate[bot] rebase"]])(
    "a bot mention is consequential when allowMentions keeps it: %j", (text) => {
      expect(textIsConsequential(text, { allowMentions: true })).toBe(true);
    },
  );

});

describe("commentSignal: safe strings stay safe", () => {

  it("exempts the HTML tag form only for the listed tags", () => {
    expect(HTML_TAG_NAMES).toEqual(expect.arrayContaining(["details", "summary", "sub", "sup", "br", "b", "i", "em", "strong", "code", "pre", "p", "div", "span", "kbd", "table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]));
    expect(HTML_TAG_NAMES).toHaveLength(33);
    for (const tag of HTML_TAG_NAMES) expect(textIsConsequential(`</${tag}>`), tag).toBe(false);
    for (const tag of ["deploy", "merge", "retest", "ship", "script", "style", "iframe", "detailsx", "details-x"]) expect(textIsConsequential(`</${tag}>`), tag).toBe(true);
    // the exemption needs the `<` directly before the slash
    expect(textIsConsequential("< /details>")).toBe(true);
    expect(textIsConsequential("</details> /merge")).toBe(true);
    expect(textIsConsequential("</details>/merge")).toBe(true);
    expect(textIsConsequential(" /details")).toBe(true);
  });
});

describe("commentSignal: labels", () => {



  it("has the listed pattern set", () => {
    expect(TRIGGER_LABEL_PATTERNS.length).toBeGreaterThanOrEqual(9);
    for (const entry of TRIGGER_LABEL_PATTERNS) {
      expect(entry.pattern.flags).toContain("i");
      expect(entry.pattern.flags).not.toContain("g");
    }
  });
});

describe("commentSignal: extraCommandWords", () => {
  it("makes paths and bare words consequential only when listed", () => {
    for (const text of ["scripts/deploy.sh", "./deploy", "src/deploy/x.ts", "please deploy", "the deployment is slow"]) {
      expect(textIsConsequential(text), text).toBe(false);
    }
    for (const text of ["scripts/deploy.sh", "./deploy", "src/deploy/x.ts", "please DEPLOY", "d\u200Beploy", "dерloy"]) {
      expect(textIsConsequential(text, { extraCommandWords: ["deploy"] }), text).toBe(true);
    }
    expect(textIsConsequential("Looks fine.", { extraCommandWords: ["deploy"] })).toBe(false);
  });

});

describe("stripMentions", () => {

  it("strips nested strings too", () => {
    const { args } = stripMentions({ event: "COMMENT", comments: [{ path: "a.ts", body: "ask @alice" }], adf: { type: "doc", content: [{ type: "text", text: "@bob" }] } });
    expect(args).toEqual({ event: "COMMENT", comments: [{ path: "a.ts", body: "ask alice" }], adf: { type: "doc", content: [{ type: "text", text: "bob" }] } });
  });

  it("leaves skipped paths and non-strings as they are", () => {
    const { args } = stripMentions({ owner: "@x", issue_number: 4, flag: true, nothing: null, body: "@x" }, { skipPaths: ["owner"] });
    expect(args).toEqual({ owner: "@x", issue_number: 4, flag: true, nothing: null, body: "x" });
  });

  it("refuses arguments nested beyond the walk limit instead of leaving a mention", () => {
    let deep: unknown = "@alice";
    for (let level = 0; level < 200; level += 1) deep = { next: deep };
    expect(() => stripMentions(deep)).toThrow(/nested/);
  });

});

describe("fix round 1: bors is matched without \\b and across a line break", () => {
  it.each([ ["bors\n\nr+"],
  ])("%j", (text) => {
    expect(textIsConsequential(text)).toBe(true);
  });

});

describe("fix round 1: object keys are scanned too", () => {

  it("treats keys under a label path as labels", () => {
    expect(signal({ labels: { automerge: true } }, { labelPaths: ["labels"] }).consequential).toBe(true);
    expect(signal({ labels: { Deploy: true } }, { labelPaths: ["labels"] }).consequential).toBe(true);
    expect(signal({ labels: { bug: true } }, { labelPaths: ["labels"] }).consequential).toBe(false);
    expect(signal({ automerge: true }, { labelPaths: ["labels"] }).consequential).toBe(false);
  });

});

describe("fix round 1: matching stays linear on agent text", () => {
  // Each case is timed at SIZE/8 and at SIZE (the original 100 KB): linear work grows about 8x, quadratic about 64x.
  const SIZE = 100_000;
  const scaled = (label: string, build: (size: number) => () => unknown, base = SIZE / 8) => {
    expectLinearScaling(build, { n: base, label });
  };
  const inputs: Array<[string, (size: number) => string]> = [
    ["@a then dots then b", (size) => `@a${".".repeat(size)}b`],
    ["many @ then a", (size) => `${"@".repeat(size)}a`],
    ["@a repeated", (size) => "@a".repeat(size / 2)],
    ["email-like @ run", (size) => `x${"@".repeat(size)}a`],
    ["@name with slashes", (size) => `@a${"/a".repeat(size / 2)}`],
    ["slashes", (size) => "/".repeat(size)],
    ["/a repeated", (size) => "/a".repeat(size / 2)],
    ["/a/ repeated", (size) => "/a/".repeat(size / 3)],
    ["spaces then x", (size) => `${" ".repeat(size)}x`],
    ["bors then spaces", (size) => `bors${" ".repeat(size)}`],
    ["bors then punctuation", (size) => `bors${"!".repeat(size)}`],
    ["bors repeated", (size) => "bors ".repeat(size / 5)],
    ["bors. repeated", (size) => "bors.".repeat(size / 5)],
    ["bors newline repeated", (size) => "bors\n".repeat(size / 5)],
    ["newlines", (size) => "\n".repeat(size)],
    ["short lines", (size) => "a\n".repeat(size / 2)],
    ["zero-width", (size) => "\u200b".repeat(size)],
    ["combining marks", (size) => `a${"\u0301".repeat(size)}`],
    ["controls", (size) => "\u0001".repeat(size)],
    ["tag starts", (size) => "</".repeat(size / 2)],
    ["hyphens", (size) => "a-".repeat(size / 2)],
    ["hyphens then @a", (size) => `${"-".repeat(size)}@a`],
    ["atlantis spaces", (size) => `atlantis${" ".repeat(size)}`],
    ["kodiak spaces", (size) => `kodiak${" ".repeat(size)}`],
    ["test this", (size) => "test ".repeat(size / 5)],
    ["non-ASCII letters", (size) => "й".repeat(size)],
    ["lone surrogates", (size) => "\uD800".repeat(size)],
  ];

  // One timed unit per input runs all three paths (body, label and stripMentions), so a super-linear cost in any of them shows.
  it.each(inputs)("commentSignal and stripMentions scale linearly on up to 100 KB: %s", (label, input) => {
    scaled(label, (size) => {
      const text = input(size);
      return () => {
        signal({ body: text }, { allowMentions: true, extraCommandWords: ["deploy", "ship it", "release now"], extraTriggerLabels: ["prod-*"] });
        signal({ labels: [text] }, { labelPaths: ["labels"] });
        stripMentions({ body: text });
      };
    });
  });

  it("matches globs as prefix, suffix and ordered middle parts", () => {
    const labelled = (label: string, globs: string[]) => signal({ labels: [label] }, { labelPaths: ["labels"], extraTriggerLabels: globs }).consequential;
    expect(labelled("prod-eu", ["prod-*"])).toBe(true);
    expect(labelled("prod-", ["prod-*"])).toBe(true);
    expect(labelled("prod", ["prod-*"])).toBe(false);
    expect(labelled("eu-prod", ["*-prod"])).toBe(true);
    expect(labelled("go-eu-live", ["go-*-live"])).toBe(true);
    expect(labelled("go-live", ["go-*-live"])).toBe(false);
    expect(labelled("a-b-c-d", ["a*b*c*d"])).toBe(true);
    expect(labelled("a-c-b-d", ["a*b*c*d"])).toBe(false);
    expect(labelled("anything", ["*"])).toBe(true);
    expect(labelled("exact", ["EXACT"])).toBe(true);
    expect(labelled("abab", ["ab*ab"])).toBe(true);
    expect(labelled("aba", ["ab*ab"])).toBe(false);
  });

});

describe("fix round 1: Cherokee, Lisu and Coptic look-alikes", () => {
  const letters: Array<[number, string]> = [
    [0x13aa, "a"], [0x13f4, "b"], [0x13cf, "b"], [0x13df, "c"], [0x13a0, "d"], [0x13ac, "e"], [0x13c0, "g"], [0x13bb, "h"], [0x13d6, "i"], [0x13ab, "j"],
    [0x13e6, "k"], [0x13de, "l"], [0x13b7, "m"], [0x13e2, "p"], [0x13a1, "r"], [0x13d2, "r"], [0x13da, "s"], [0x13a2, "t"], [0x13d9, "v"], [0x13b3, "w"], [0x13c3, "z"],
    [0xab7a, "a"], [0xab9f, "b"], [0xabaf, "c"], [0x13fc, "b"],
    [0xa4ee, "a"], [0xa4d0, "b"], [0xa4da, "c"], [0xa4d3, "d"], [0xa4f0, "e"], [0xa4d6, "g"], [0xa4e7, "h"], [0xa4f2, "i"], [0xa4d9, "j"], [0xa4d7, "k"],
    [0xa4df, "m"], [0xa4f3, "o"], [0xa4d1, "p"], [0xa4e3, "r"], [0xa4e2, "s"], [0xa4d4, "t"], [0xa4f4, "u"], [0xa4e6, "v"], [0xa4ea, "w"], [0xa4eb, "x"], [0xa4ec, "y"], [0xa4dc, "z"],
    [0x2c80, "a"], [0x2c82, "b"], [0x2c88, "e"], [0x2c8e, "h"], [0x2c92, "i"], [0x2c94, "k"], [0x2c98, "m"], [0x2c9a, "n"], [0x2c9e, "o"], [0x2ca2, "p"], [0x2ca4, "c"], [0x2ca6, "t"], [0x2ca8, "y"], [0x2cac, "x"],
  ];

  it.each(letters)("U+%s folds to %s", (point, ascii) => {
    expect(CONFUSABLE_FOLD[String.fromCodePoint(point)]).toBe(ascii);
  });

});

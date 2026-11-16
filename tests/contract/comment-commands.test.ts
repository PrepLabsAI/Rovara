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

const opts = { allowMentions: false, labelPaths: [] as string[] };
const signal = (args: unknown, more: Partial<Parameters<typeof commentSignal>[1]> = {}) => commentSignal(args, { ...opts, ...more });
const textIsConsequential = (text: string, more: Partial<Parameters<typeof commentSignal>[1]> = {}) => signal({ body: text }, more).consequential;

describe("normalizeForMatching and cleanText", () => {
  it("removes zero-width and bidi control characters and folds look-alikes", () => {
    expect(normalizeForMatching("\u200B/deploy")).toBe("/deploy");
    expect(normalizeForMatching("\u202E/merge")).toBe("/merge");
    expect(normalizeForMatching("／merge")).toBe("/merge");
    expect(normalizeForMatching("＠mergifyio queue")).toBe("@mergifyio queue");
    expect(normalizeForMatching("bors r+")).toBe("bors r+");
    expect(normalizeForMatching("bоrs r+")).toBe("bors r+");
  });

  it("sends the cleaned text, which keeps the visible characters and drops only NFKC differences and Cf characters", () => {
    expect(cleanText("caf\u00E9 \u200B/\u2060merge \u202Eok\u202C ＠alice")).toBe("café /merge ok @alice");
    expect(cleanText("Привет, мир")).toBe("Привет, мир");
    expect(cleanText("bоrs r+")).toBe("bоrs r+");
    for (const text of ["\u200B/deploy", "a\uFEFFb", "plain"]) expect(cleanText(cleanText(text))).toBe(cleanText(text));
  });

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

  it("removes other invisible default-ignorable characters and combining marks from the matching copy only", () => {
    expect(normalizeForMatching("/de\u034Fploy")).toBe("/deploy");
    expect(normalizeForMatching("/dep\u0336loy")).toBe("/deploy");
    expect(normalizeForMatching("/deploy\uFE0F")).toBe("/deploy");
    expect(normalizeForMatching("\u3164/merge")).toBe("/merge");
    expect(cleanText("\u2764\uFE0F")).toBe("\u2764\uFE0F");
  });

  it("also reads an invisible character as the gap between a command and its argument", () => {
    for (const gap of ["\u200B", "\u2060", "\uFEFF", "\u00AD", "\u202E", "\u180E", "\u200D"]) {
      expect(textIsConsequential(`bors${gap}r+`), JSON.stringify(gap)).toBe(true);
      expect(textIsConsequential(`atlantis${gap}apply`), JSON.stringify(gap)).toBe(true);
      expect(textIsConsequential(`kodiak${gap}merge`), JSON.stringify(gap)).toBe(true);
    }
    expect(textIsConsequential("Looks fine\u200B to me", { allowMentions: true })).toBe(false);
  });

  it("folds spaces of every kind and C0 separators to a plain space, keeping line separators", () => {
    expect(normalizeForMatching("bors\u00A0r+")).toBe("bors r+");
    expect(normalizeForMatching("bors\u1680r+")).toBe("bors r+");
    expect(normalizeForMatching("bors\u2003r+")).toBe("bors r+");
    expect(normalizeForMatching("bors\u001Fr+")).toBe("bors r+");
    expect(normalizeForMatching("bors\tr+")).toBe("bors r+");
    expect(normalizeForMatching("a\nb")).toBe("a\nb");
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

  it("folds look-alike letters, digits and slashes inside commands", () => {
    expect(textIsConsequential("bоrs r+")).toBe(true); // Cyrillic o
    expect(textIsConsequential("borѕ r+")).toBe(true); // Cyrillic s
    expect(textIsConsequential("bοrs r+")).toBe(true); // Greek omicron
    expect(textIsConsequential("bors r＋")).toBe(true);
    expect(textIsConsequential("∕deploy production")).toBe(true);
    expect(textIsConsequential("⁄merge")).toBe(true);
    expect(textIsConsequential("⧸ship")).toBe(true);
    expect(textIsConsequential("/dерloy")).toBe(true); // Cyrillic e and p
    expect(textIsConsequential("/ᴅᴇᴘʟᴏʏ")).toBe(true); // small capitals
    expect(textIsConsequential("/ｄｅｐｌｏｙ")).toBe(true); // full-width
    expect(textIsConsequential("/𝐝𝐞𝐩𝐥𝐨𝐲")).toBe(true); // mathematical bold
    expect(textIsConsequential("/de\u0301ploy")).toBe(true); // combining acute
    expect(textIsConsequential("аtlаntis аррlу")).toBe(true); // Cyrillic a and p
  });
});

describe("commentSignal: consequential text", () => {
  it.each([
    ["bors r+"], ["ok, bors r+"], ["bors try"], ["bors r=alice"], ["bors delegate+"], ["bors ping"], ["BORS R+"], ["bors:  r+"], ["bors, r+"],
    ["@kodiakhq merge"], ["kodiak merge"], ["atlantis apply"], ["atlantis plan -d infra"], ["atlantis unlock"], ["Atlantis  Apply"],
    ["/deploy production"], ["please /deploy production"], ["> /merge"], ["`/merge`"], ['"/ship"'], ["(/retest)"], ["see:\n/retest\nthanks"],
    ["Looks good.\r\n/merge"], ["a\u2028/deploy"], ["a\u2029/deploy"], ["a\u0085/deploy"], ["a\r/deploy"],
    ["\u200B/deploy"], ["/\u2060merge"], ["\u202E/merge\u202C"], ["／merge"], ["＠mergifyio queue"], ["bоrs r+"],
    ["</deploy>"], ["</merge>"], ["</details-x>"], ["x</detail>"], ["<a href=\"/merge\">go</a>"], ["<b>/merge</b>"],
    ["/deploy.sh"], ["/retest"], ["/ok-to-test"], ["/lgtm"], ["/部署"],
    ["@dependabot rebase"], ["@renovate rebase"], ["@copilot fix this"], ["@claude fix this"], ["retest this please"], ["ok to test"],
  ])("%j", (text) => {
    const result = textIsConsequential(text, { allowMentions: true });
    expect(result).toBe(true);
    expect(textIsConsequential(text)).toBe(true);
  });

  it("matches in a line of a multi-line comment, not only the first", () => {
    expect(textIsConsequential("Nice work.\n\nThe test passes.\n/retest")).toBe(true);
    expect(textIsConsequential("Nice work.\n\nThe test passes.\nbors r+\nthanks")).toBe(true);
  });

  it("reports why", () => {
    const result = signal({ body: "please /deploy production, then bors r+" });
    expect(result.consequential).toBe(true);
    expect(result.reasons.join("\n")).toMatch(/slash command \/deploy/);
    expect(result.reasons.join("\n")).toMatch(/bors/);
  });

  it("lists a maintained pattern set with a name each", () => {
    expect(COMMAND_COMMENT_PATTERNS.length).toBeGreaterThanOrEqual(6);
    for (const entry of COMMAND_COMMENT_PATTERNS) {
      expect(entry.name).toMatch(/\w/);
      expect(entry.pattern.flags).toContain("i");
      expect(entry.pattern.flags).not.toContain("g"); // a /g RegExp keeps lastIndex between calls
    }
    for (const bot of ["mergifyio", "kodiakhq", "dependabot", "renovate", "bors", "github-actions"]) expect(KNOWN_BOT_ACCOUNTS).toContain(bot);
  });

  it("gives the same answer when asked twice (no RegExp state is kept)", () => {
    for (let round = 0; round < 3; round += 1) {
      expect(textIsConsequential("bors r+")).toBe(true);
      expect(textIsConsequential("/deploy")).toBe(true);
      expect(textIsConsequential("src/deploy/x.ts")).toBe(false);
    }
  });
});

describe("commentSignal: consequential in structured arguments", () => {
  it("scans a Jira addCommentToJiraIssue commentBody", () => {
    expect(signal({ issueIdOrKey: "ABC-1", commentBody: "/deploy" }, { skipPaths: ["issueIdOrKey"] }).consequential).toBe(true);
  });

  it("scans the text nodes of Jira ADF", () => {
    const adf = { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "please bors r+" }] }] };
    expect(signal({ issueIdOrKey: "ABC-1", description: adf }).consequential).toBe(true);
    const safe = { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Looks right to me." }] }] };
    expect(signal({ description: safe }).consequential).toBe(false);
  });

  it("scans a review's comments[].body at any depth", () => {
    expect(signal({ event: "COMMENT", comments: [{ path: "a.ts", body: "fine" }, { path: "b.ts", body: "/merge" }] }).consequential).toBe(true);
    expect(signal({ a: { b: { c: [{ d: [{ e: "/merge" }] }] } } }).consequential).toBe(true);
  });

  it("scans an MCP tool's arbitrary string argument", () => {
    expect(signal({ note: "/deploy" }).consequential).toBe(true);
    expect(signal({ nested: ["ok", ["/deploy"]] }).consequential).toBe(true);
  });

  it("skips only the item-reference and enum values it is told about", () => {
    const args = { issueIdOrKey: "/deploy", tasks: [{ task: "/deploy", note: "fine" }], event: "approve" };
    expect(signal(args).consequential).toBe(true);
    expect(signal(args, { skipPaths: ["issueIdOrKey", "tasks[].task"] }).consequential).toBe(false);
    // skipping one path does not skip its neighbours
    expect(signal({ issueIdOrKey: "ABC-1", body: "/deploy" }, { skipPaths: ["issueIdOrKey"] }).consequential).toBe(true);
    expect(signal({ tasks: [{ task: "ok", note: "/deploy" }] }, { skipPaths: ["tasks[].task"] }).consequential).toBe(true);
    expect(signal({ ids: ["/a", "/b"] }, { skipPaths: ["ids"] }).consequential).toBe(false);
  });

  it("treats arguments nested beyond the walk limit as consequential", () => {
    let deep: unknown = "fine";
    for (let level = 0; level < 200; level += 1) deep = { next: deep };
    const result = signal(deep);
    expect(result.consequential).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/nested/);
  });

  it("is not fooled by a key that mimics a path or a prototype key", () => {
    expect(signal(JSON.parse('{"__proto__": {"body": "/deploy"}}')).consequential).toBe(true);
    expect(signal({ constructor: "/deploy" }).consequential).toBe(true);
  });

  it("sees no text in numbers, booleans, null and undefined", () => {
    expect(signal({ n: 1, b: true, z: null, u: undefined, issue_number: 12 }).consequential).toBe(false);
    expect(signal(undefined).consequential).toBe(false);
    expect(signal("bors r+").consequential).toBe(true);
  });
});

describe("commentSignal: mentions", () => {
  it.each([["@renovate[bot] rebase"], ["@acme-bot go"], ["@mergifyio"], ["@dependabot"], ["@bors"], ["@github-actions[bot]"], ["@kodiakhq"], ["@Renovate"], ["cc @acme/dependabot"], ["＠acme-bot go"]])(
    "a bot mention is consequential when allowMentions keeps it: %j", (text) => {
      expect(textIsConsequential(text, { allowMentions: true })).toBe(true);
    },
  );

  it("a bot mention is consequential even when mentions are normally stripped", () => {
    expect(textIsConsequential("@renovate[bot] rebase")).toBe(true);
    expect(textIsConsequential("thanks @acme-bot")).toBe(true);
  });

  it("any mention is consequential when allowMentions keeps it, and a human mention is not otherwise", () => {
    expect(textIsConsequential("cc @alice", { allowMentions: true })).toBe(true);
    expect(textIsConsequential("cc @acme/reviewers", { allowMentions: true })).toBe(true);
    expect(textIsConsequential("cc @alice")).toBe(false);
  });

  it("does not treat an email address as a mention", () => {
    expect(textIsConsequential("mail a@b.com", { allowMentions: true })).toBe(false);
    expect(textIsConsequential("mail dependabot@example.com", { allowMentions: true })).toBe(false);
    expect(textIsConsequential("mail x@renovate.com or y@mergifyio.io", { allowMentions: true })).toBe(false);
  });
});

describe("commentSignal: safe strings stay safe", () => {
  it.each([
    ["Looks right to me. The failing test is in auth.spec.ts."], ["src/deploy/x.ts"], ["see /usr/bin in the log"], ["https://example.com/merge/notes"],
    ["a@b.com"], ["https://x/y"], ["file:///etc/passwd"], ["../deploy/x"], ["./src/merge/x.ts"], ["and/or"], ["yes/no"], ["1/2 done"], ["10/Oct"],
    ["<details><summary>Logs</summary>\n\nlong output\n\n</details>"], ["<br/>"], ["<br />"], ["<img src=\"x\"/>"], ["</a></b></i></em></strong></code></pre></p></div></span></kbd></table></thead></tbody></tr></td></th></ul></ol></li></blockquote></sub></sup>"],
    ["</h1></h2></h3></h4></h5></h6>"], ["neighbors are nice"], ["The labors of love"], ["I fixed it, see /etc/hosts/ for details"],
    ["https://github.com/acme/app/pull/12/files"], ["C:/dev/merge/a.ts"], ["path/to/file"], ["http://localhost:3000/deploy/now"],
  ])("%j", (text) => {
    expect(textIsConsequential(text)).toBe(false);
    expect(textIsConsequential(text, { allowMentions: true })).toBe(false);
  });

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
  const labelled = (labels: unknown, more: Partial<Parameters<typeof commentSignal>[1]> = {}) => signal({ title: "x", labels }, { labelPaths: ["labels"], ...more });

  it.each([["automerge"], ["Deploy-prod"], ["auto-merge"], ["merge"], ["ready-to-merge"], ["merge-queue"], ["deploy"], ["deploy-"], ["release"], ["Release-1.2"], ["ship"], ["ship-it"], ["rollback"], ["hotfix-deploy"],
    ["AutoMerge"], ["auto_merge"], ["auto merge"], ["Ready To Merge"], ["deploy:prod"], ["deploy/prod"], ["autоmerge"], ["  deploy  "], ["ＤＥＰＬＯＹ"], ["bug,automerge"]])("trigger label %j", (label) => {
    expect(labelled([label]).consequential).toBe(true);
    expect(labelled(label).consequential).toBe(true);
    expect(labelled([{ name: label }]).consequential).toBe(true);
  });

  it.each([["bug"], ["enhancement"], ["good first issue"], ["documentation"], ["merge-conflict"], ["deployment"], ["released"], ["shipping"], ["rollbacks"], ["premerge"]])("ordinary label %j", (label) => {
    expect(labelled([label]).consequential).toBe(false);
  });

  it("matches labels only at the label paths, and still scans label text", () => {
    expect(signal({ title: "automerge" }, { labelPaths: ["labels"] }).consequential).toBe(false);
    expect(signal({ labels: ["automerge"] }, { labelPaths: ["fields.labels"] }).consequential).toBe(false);
    expect(signal({ fields: { labels: ["automerge"] } }, { labelPaths: ["fields.labels"] }).consequential).toBe(true);
    expect(signal({ issues: [{ labels: ["automerge"] }] }, { labelPaths: ["issues[].labels"] }).consequential).toBe(true);
    expect(labelled(["/deploy"]).consequential).toBe(true);
  });

  it("includes an org's extra trigger labels, with * globs", () => {
    expect(labelled(["go-live"]).consequential).toBe(false);
    expect(labelled(["go-live"], { extraTriggerLabels: ["go-live"] }).consequential).toBe(true);
    expect(labelled(["prod-eu"], { extraTriggerLabels: ["prod-*"] }).consequential).toBe(true);
    expect(labelled(["preprod-eu"], { extraTriggerLabels: ["prod-*"] }).consequential).toBe(false);
  });

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

  it("applies to every string at any depth, with or without a slash in the word", () => {
    expect(signal({ a: [{ b: "run deploy.sh" }] }, { extraCommandWords: ["deploy"] }).consequential).toBe(true);
    expect(signal({ a: "x /deploy" }, { extraCommandWords: ["/deploy"] }).consequential).toBe(true);
    expect(signal({ a: "src/deploy/x" }, { extraCommandWords: ["/deploy"] }).consequential).toBe(true);
    expect(signal({ a: "fine" }, { extraCommandWords: ["", "  "] }).consequential).toBe(false);
  });

  it("reports the word", () => {
    expect(signal({ a: "scripts/deploy.sh" }, { extraCommandWords: ["deploy"] }).reasons.join(" ")).toMatch(/deploy/);
  });
});

describe("stripMentions", () => {
  it("turns mentions into plain text", () => {
    expect(stripMentions({ body: "@alice please look" }).args).toEqual({ body: "alice please look" });
    expect(stripMentions({ body: "cc @acme/reviewers" }).args).toEqual({ body: "cc acme/reviewers" });
    expect(stripMentions({ body: "@mergifyio queue" }).args).toEqual({ body: "mergifyio queue" });
    expect(stripMentions({ body: "(@alice) and [@bob]" }).args).toEqual({ body: "(alice) and [bob]" });
    expect(stripMentions({ body: "@alice\n@bob" }).args).toEqual({ body: "alice\nbob" });
  });

  it("strips nested strings too", () => {
    const { args } = stripMentions({ event: "COMMENT", comments: [{ path: "a.ts", body: "ask @alice" }], adf: { type: "doc", content: [{ type: "text", text: "@bob" }] } });
    expect(args).toEqual({ event: "COMMENT", comments: [{ path: "a.ts", body: "ask alice" }], adf: { type: "doc", content: [{ type: "text", text: "bob" }] } });
  });

  it("leaves an email address alone", () => {
    expect(stripMentions({ body: "mail a@b.com or user_1@example.org" }).args).toEqual({ body: "mail a@b.com or user_1@example.org" });
    expect(stripMentions({ body: "a@b.com" }).stripped).toEqual([]);
  });

  it("lists what was removed", () => {
    expect(stripMentions({ body: "@alice and @acme/reviewers, not a@b.com" }).stripped).toEqual(["@alice", "@acme/reviewers"]);
    expect(stripMentions({ body: "nothing here" }).stripped).toEqual([]);
  });

  it("cannot be defeated by doubling the @, hiding it in zero-width characters or using a full-width @", () => {
    expect(stripMentions({ body: "@@alice" }).args).toEqual({ body: "alice" });
    expect(stripMentions({ body: "@@@@alice" }).args).toEqual({ body: "alice" });
    expect(stripMentions({ body: "@\u200Balice" }).args).toEqual({ body: "alice" });
    expect(stripMentions({ body: "＠alice" }).args).toEqual({ body: "alice" });
    expect(stripMentions({ body: "@\u202Ealice" }).args).toEqual({ body: "alice" });
    expect(stripMentions({ body: "\u2060@alice" }).args).toEqual({ body: "alice" });
    expect(stripMentions({ body: "é@alice" }).args).toEqual({ body: "éalice" });
  });

  it("sends the cleaned text for every string it keeps", () => {
    expect(stripMentions({ body: "/\u2060deploy ＠alice" }).args).toEqual({ body: "/deploy alice" });
  });

  it("leaves skipped paths and non-strings as they are", () => {
    const { args } = stripMentions({ owner: "@x", issue_number: 4, flag: true, nothing: null, body: "@x" }, { skipPaths: ["owner"] });
    expect(args).toEqual({ owner: "@x", issue_number: 4, flag: true, nothing: null, body: "x" });
  });

  it("does not change its input", () => {
    const input = { body: "@alice", list: ["@bob"] };
    stripMentions(input);
    expect(input).toEqual({ body: "@alice", list: ["@bob"] });
  });

  it("refuses arguments nested beyond the walk limit instead of leaving a mention", () => {
    let deep: unknown = "@alice";
    for (let level = 0; level < 200; level += 1) deep = { next: deep };
    expect(() => stripMentions(deep)).toThrow(/nested/);
  });

  it("makes a comment safe from mentions: the stripped text carries no mention for the matcher", () => {
    for (const text of ["@mergifyio queue", "@@dependabot rebase", "@renovate[bot] go"]) {
      const { args } = stripMentions({ body: text });
      expect(textIsConsequential((args as { body: string }).body, { allowMentions: true })).toBe(false);
    }
  });
});

describe("fix round 1: a line that starts with a slash word is always a command", () => {
  it.each([
    ["/deploy/production"], ["/merge/"], ["//deploy"], ["  /deploy/x"], ["\t/merge/"], ["> /merge/"], ["`/merge/`"], ["ok\n/deploy/prod"], ["ok\r\n  /deploy/prod/"],
    ["\u200b/deploy/x"], ["／deploy／x"], ["/usr/bin"], ["///deploy"], ["\"/ship/it\""], ["*/deploy/x"], ["a\u2028/merge/"],
  ])("%j", (text) => {
    expect(textIsConsequential(text)).toBe(true);
  });

  it("keeps the path exemption in the middle of a line", () => {
    for (const text of ["see /usr/bin in the log", "text\n  see /usr/bin", "ok //deploy", "x//merge", "./merge/x", "1/merge/", "https://x.test/merge/", "// not a command", "/ deploy", "/123/456", "//"]) {
      expect(textIsConsequential(text), text).toBe(false);
    }
  });
});

describe("fix round 1: control characters leave a gap", () => {
  it.each([
    ["x\u0001/merge"], ["x\u007f/merge"], ["bors\u0001r+"], ["bo\u0000rs r+"], ["x\u0080/deploy"], ["x\u009f/deploy"], ["atlantis\u0002apply"], ["x\u001b/merge"], ["/de\u0000ploy"],
  ])("%j", (text) => {
    expect(textIsConsequential(text)).toBe(true);
  });

  it("normalizeForMatching still deletes them from the joined copy", () => {
    expect(normalizeForMatching("/de\u0000ploy")).toBe("/deploy");
  });
});

describe("fix round 1: bors is matched without \\b and across a line break", () => {
  it.each([
    ["_bors r+_"], ["*bors r+*"], ["**bors** r+"], ["~bors~ r+"], ["bors\nr+"], ["bors\n\nr+"], ["bors\r\nr+"], ["[bors]\nr+"], ["bors:\ntry"], ["> bors\n> r+"], ["bors\u2028r+"], ["(bors) r+"], ["_kodiak_ merge"], ["_atlantis_ apply"],
  ])("%j", (text) => {
    expect(textIsConsequential(text)).toBe(true);
  });

  it("stays quiet for words that only contain bors, and for a last line", () => {
    for (const text of ["neighbors\nr+", "labors\ntry", "Thanks, ok", "borscht is good", "bors"]) expect(textIsConsequential(text), text).toBe(false);
  });
});

describe("fix round 1: object keys are scanned too", () => {
  it("scans keys as text", () => {
    expect(signal(JSON.parse('{"/merge": "x"}')).consequential).toBe(true);
    expect(signal({ fields: { "bors r+": true } }).consequential).toBe(true);
    expect(signal({ list: [{ "/deploy": 1 }] }).consequential).toBe(true);
    expect(signal({ body: "fine", title: "also fine", issue_number: 4 }).consequential).toBe(false);
  });

  it("treats keys under a label path as labels", () => {
    expect(signal({ labels: { automerge: true } }, { labelPaths: ["labels"] }).consequential).toBe(true);
    expect(signal({ labels: { Deploy: true } }, { labelPaths: ["labels"] }).consequential).toBe(true);
    expect(signal({ labels: { bug: true } }, { labelPaths: ["labels"] }).consequential).toBe(false);
    expect(signal({ automerge: true }, { labelPaths: ["labels"] }).consequential).toBe(false);
  });

  it("does not scan the key of a skipped path", () => {
    expect(signal({ "/merge": "x" }, { skipPaths: ["/merge"] }).consequential).toBe(false);
  });
});

describe("fix round 1: matching stays linear on agent text", () => {
  const SIZE = 100_000;
  const timed = (label: string, run: () => void) => {
    const start = performance.now();
    run();
    const took = performance.now() - start;
    expect(took, `${label} took ${Math.round(took)} ms`).toBeLessThan(200);
  };
  const inputs: Array<[string, string]> = [
    ["@a then dots then b", `@a${".".repeat(SIZE)}b`],
    ["many @ then a", `${"@".repeat(SIZE)}a`],
    ["@a repeated", "@a".repeat(SIZE / 2)],
    ["email-like @ run", `x${"@".repeat(SIZE)}a`],
    ["@name with slashes", `@a${"/a".repeat(SIZE / 2)}`],
    ["slashes", "/".repeat(SIZE)],
    ["/a repeated", "/a".repeat(SIZE / 2)],
    ["/a/ repeated", "/a/".repeat(SIZE / 3)],
    ["spaces then x", `${" ".repeat(SIZE)}x`],
    ["bors then spaces", `bors${" ".repeat(SIZE)}`],
    ["bors then punctuation", `bors${"!".repeat(SIZE)}`],
    ["bors repeated", "bors ".repeat(SIZE / 5)],
    ["bors. repeated", "bors.".repeat(SIZE / 5)],
    ["bors newline repeated", "bors\n".repeat(SIZE / 5)],
    ["newlines", "\n".repeat(SIZE)],
    ["short lines", "a\n".repeat(SIZE / 2)],
    ["zero-width", "\u200b".repeat(SIZE)],
    ["combining marks", `a${"\u0301".repeat(SIZE)}`],
    ["controls", "\u0001".repeat(SIZE)],
    ["tag starts", "</".repeat(SIZE / 2)],
    ["hyphens", "a-".repeat(SIZE / 2)],
    ["hyphens then @a", `${"-".repeat(SIZE)}@a`],
    ["atlantis spaces", `atlantis${" ".repeat(SIZE)}`],
    ["kodiak spaces", `kodiak${" ".repeat(SIZE)}`],
    ["test this", "test ".repeat(SIZE / 5)],
    ["non-ASCII letters", "й".repeat(SIZE)],
    ["lone surrogates", "\uD800".repeat(SIZE)],
  ];

  it.each(inputs)("commentSignal on 100 KB: %s", (label, input) => {
    timed(label, () => signal({ body: input }, { allowMentions: true, extraCommandWords: ["deploy", "ship it", "release now"], extraTriggerLabels: ["prod-*"] }));
    timed(`${label} (as a label)`, () => signal({ labels: [input] }, { labelPaths: ["labels"] }));
  });

  it.each(inputs)("stripMentions on 100 KB: %s", (label, input) => {
    timed(label, () => stripMentions({ body: input }));
  });

  it("matches org label globs without backtracking", () => {
    const label = "-".repeat(200);
    timed("multi-star glob", () => signal({ labels: [`${label}x`] }, { labelPaths: ["labels"], extraTriggerLabels: ["*-*-*-*-*-y", "*-*-*-*-*-*-*-*-*-*-*-*-z", "a*b*c*d*e*f*g*h*i*j*k"] }));
    timed("long label", () => signal({ labels: ["deploy-".repeat(SIZE / 7)] }, { labelPaths: ["labels"], extraTriggerLabels: ["*-*-*-*-*-y"] }));
    timed("many labels", () => signal({ labels: Array.from({ length: 2000 }, (_, index) => `label-${index}`) }, { labelPaths: ["labels"], extraTriggerLabels: ["a*-*-*-y"] }));
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

  it("flags a label too long to check", () => {
    const result = signal({ labels: ["x".repeat(2000)] }, { labelPaths: ["labels"] });
    expect(result.consequential).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/too long/);
  });
});

describe("fix round 1: mergify", () => {
  it("lists mergify as a bot account", () => {
    expect(KNOWN_BOT_ACCOUNTS).toContain("mergify");
    expect(KNOWN_BOT_ACCOUNTS).toContain("mergifyio");
  });

  it.each([["@mergify queue"], ["@mergify"], ["@Mergify[bot] rebase"], ["＠mergify queue"]])("%j", (text) => {
    expect(textIsConsequential(text)).toBe(true);
    expect(textIsConsequential(text, { allowMentions: true })).toBe(true);
  });

  it("does not flag an email at a mergify domain", () => {
    expect(textIsConsequential("mail x@mergify.com", { allowMentions: true })).toBe(false);
  });

  it("strips the mention", () => {
    expect(stripMentions({ body: "@mergify queue" }).args).toEqual({ body: "mergify queue" });
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

  it("catches a command written with them", () => {
    expect(textIsConsequential("\u13CFors r+")).toBe(true); // Cherokee b
    expect(textIsConsequential("\u13CFo\u13A1s r+")).toBe(true); // Cherokee b, o, Cherokee R, s
    expect(textIsConsequential("\u13AAtlantis apply")).toBe(true);
    expect(textIsConsequential("@\u13B7ergifyio queue")).toBe(true);
    expect(textIsConsequential("@\u2C98ergify queue")).toBe(true);
    expect(textIsConsequential("\u13A1 is not a command")).toBe(false);
  });
});
